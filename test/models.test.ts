import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addProvider,
  deleteProvider,
  estimateCost,
  getEnabledModels,
  type JsonObject,
  listProviderDrafts,
  modelReference,
  readJsonc,
  renameProvider,
  saveModelsAndSettings,
  setEnabledModels,
  toUsd,
  updateEnabledModelReference,
  upsertProvider,
  validateModelsConfig,
} from "../src/models.ts";
import { resolveSecret } from "../src/ui.ts";

const SAVE_ERROR = /Could not save Pi configuration/;
const PROVIDER_EXISTS = /already exists/;
const PROVIDER_EMPTY_ID = /must not be empty/;
const PROVIDER_MISSING = /no longer exists/;
describe("model configuration data", () => {
  it("resolves both supported API key environment variable forms", () => {
    const previous = process.env.TKM_KEY_GPT_PLUS;
    process.env.TKM_KEY_GPT_PLUS = "resolved-value";

    try {
      expect(resolveSecret("$TKM_KEY_GPT_PLUS")).toBe("resolved-value");
      expect(resolveSecret("$" + "{TKM_KEY_GPT_PLUS}")).toBe("resolved-value");
      expect(resolveSecret("$TKM_KEY_MISSING")).toBe("");
    } finally {
      if (previous === undefined) delete process.env.TKM_KEY_GPT_PLUS;
      else process.env.TKM_KEY_GPT_PLUS = previous;
    }
  });

  it("defaults the authorization header to true for legacy providers", () => {
    const [provider] = listProviderDrafts({
      providers: {
        local: {
          authHeader: false,
        },
      },
    });

    expect(provider.authHeader).toBe(true);
  });

  it("reads JSONC with comments and trailing commas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xpi-mymodels-"));
    const path = join(dir, "models.json");
    await writeFile(
      path,
      '{"providers": {"local": {"models": [{"id": "qwen",}],},}, // note\n}',
      "utf8",
    );

    expect(await readJsonc(path)).toEqual({
      providers: {
        local: {
          models: [
            {
              id: "qwen",
            },
          ],
        },
      },
    });
  });

  it("keeps quick-cycle patterns separate from model availability", () => {
    const settings: JsonObject = {};
    setEnabledModels(settings, [
      "local/qwen",
      "cloud/*",
    ]);

    expect(getEnabledModels(settings)).toEqual([
      "local/qwen",
      "cloud/*",
    ]);
    expect(settings).not.toHaveProperty("providers");
  });
  it("migrates and removes exact enabled model references", () => {
    const settings = {
      theme: "dark",
      enabledModels: [
        "local/qwen",
        "local/*",
        "other/qwen",
      ],
      nested: {
        keep: true,
      },
    };

    updateEnabledModelReference(settings, "local/qwen", "local/qwen3");
    expect(settings).toEqual({
      theme: "dark",
      enabledModels: [
        "local/qwen3",
        "local/*",
        "other/qwen",
      ],
      nested: {
        keep: true,
      },
    });

    updateEnabledModelReference(settings, "local/qwen3");
    expect(settings).toEqual({
      theme: "dark",
      enabledModels: [
        "local/*",
        "other/qwen",
      ],
      nested: {
        keep: true,
      },
    });
  });

  it("renames a provider and migrates every model reference", () => {
    const models: JsonObject = {
      providers: {
        cloud: {
          models: [
            {
              id: "opus",
            },
          ],
        },
        local: {
          baseUrl: "https://local.example/v1",
          models: [
            {
              id: "qwen",
            },
          ],
        },
      },
    };
    const settings: JsonObject = {
      enabledModels: [
        "local/qwen",
        "local/*",
        "cloud/opus",
      ],
    };

    renameProvider(models, settings, "local", "remote");

    expect(models.providers).toEqual({
      cloud: {
        models: [
          {
            id: "opus",
          },
        ],
      },
      remote: {
        baseUrl: "https://local.example/v1",
        models: [
          {
            id: "qwen",
          },
        ],
      },
    });
    expect(getEnabledModels(settings)).toEqual([
      "remote/qwen",
      "remote/*",
      "cloud/opus",
    ]);
  });

  it("rejects provider renames to an existing or empty id", () => {
    const models: JsonObject = {
      providers: {
        cloud: {},
        local: {},
      },
    };
    const settings: JsonObject = {};

    expect(() => renameProvider(models, settings, "local", "cloud")).toThrow(
      PROVIDER_EXISTS,
    );
    expect(() => renameProvider(models, settings, "local", "  ")).toThrow(
      PROVIDER_EMPTY_ID,
    );
  });

  it("applies safe defaults when core model fields are absent", () => {
    const [provider] = listProviderDrafts({
      providers: {
        local: {
          models: [
            {
              id: "qwen",
            },
          ],
        },
      },
    });
    const [model] = provider.models;

    expect(model).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 16_384,
      name: "qwen",
      reasoning: false,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
      },
      input: [
        "text",
        "image",
      ],
    });
    expect(model).not.toHaveProperty("apiKey");
  });
  it("supports text and image input capabilities", () => {
    const [provider] = listProviderDrafts({
      providers: {
        local: {
          models: [
            {
              id: "multimodal",
              input: [
                "text",
                "image",
              ],
            },
          ],
        },
      },
    });

    expect(provider.models[0].input).toEqual([
      "text",
      "image",
    ]);
    expect(
      validateModelsConfig({
        providers: {
          local: {
            models: [
              {
                id: "bad",
                input: [
                  "audio",
                ],
              },
            ],
          },
        },
      }),
    ).toContain("providers.local.models.0.input must contain supported capabilities");
  });

  it("rejects duplicate model ids and invalid numeric fields", () => {
    expect(
      validateModelsConfig({
        providers: {
          local: {
            models: [
              {
                contextWindow: 0,
                id: "qwen",
              },
              {
                id: "qwen",
                cost: {
                  input: -1,
                },
              },
            ],
          },
        },
      }),
    ).toEqual([
      "providers.local.models.0.contextWindow must be a positive number",
      "providers.local.models.1.cost.input must be a non-negative number",
      "providers.local.models.1.id must be unique within provider",
    ]);
  });

  it("preserves unknown fields while keeping secrets out of validation errors", () => {
    const config: JsonObject = {
      providers: {
        local: {
          apiKey: "super-secret",
          models: [
            {
              id: "qwen",
              vendorField: "keep-me",
              samplingParams: {
                temperature: 0.2,
              },
            },
          ],
        },
      },
    };
    const [provider] = listProviderDrafts(config);
    upsertProvider(config, {
      ...provider,
      models: [
        {
          ...provider.models[0],
          name: "Qwen 3",
        },
      ],
    });

    expect(config.providers).toMatchObject({
      local: {
        apiKey: "super-secret",
        models: [
          expect.objectContaining({
            id: "qwen",
            name: "Qwen 3",
            vendorField: "keep-me",
            samplingParams: {
              temperature: 0.2,
            },
          }),
        ],
      },
    });
    expect(validateModelsConfig(config)).not.toContain("super-secret");
  });
  it("hides and removes legacy provider and model overrides", () => {
    const config: JsonObject = {
      providers: {
        local: {
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
          name: "Legacy local",
          models: [
            {
              api: "anthropic-messages",
              baseUrl: "https://model.example/v1",
              id: "qwen",
            },
          ],
        },
      },
    };

    const [provider] = listProviderDrafts(config);
    expect(provider).not.toHaveProperty("name");
    expect(provider.models[0]).not.toHaveProperty("api");
    expect(provider.models[0]).not.toHaveProperty("baseUrl");

    upsertProvider(config, provider);

    expect(config.providers.local).not.toHaveProperty("name");
    expect(config.providers.local).toHaveProperty(
      "baseUrl",
      "https://provider.example/v1",
    );
    expect(config.providers.local.models?.[0]).not.toHaveProperty("api");
    expect(config.providers.local.models?.[0]).not.toHaveProperty("baseUrl");
  });

  it("normalizes a CNY pricing input at the fixed 7 CNY/USD rate", () => {
    expect(toUsd(70, "CNY", 7)).toBeCloseTo(10, 10);
  });

  it("converts CNY rates to Pi's USD billing rates", () => {
    expect(toUsd(7, "CNY", 7)).toBe(1);
    expect(toUsd(1, "USD", 7)).toBe(1);
    expect(
      estimateCost(
        {
          cacheRead: 200_000,
          cacheWrite: 50_000,
          input: 1_000_000,
          output: 100_000,
        },
        {
          cacheRead: 0.5,
          cacheWrite: 3,
          input: 1,
          output: 2,
        },
      ),
    ).toBe(1.45);
  });

  it("round-trips provider and model drafts without dropping Pi fields", () => {
    const config = {
      providers: {},
    };
    upsertProvider(config, {
      api: "openai-completions",
      apiKey: "local",
      authHeader: false,
      baseUrl: "http://localhost:8080/v1",
      id: "local",
      models: [
        {
          contextWindow: 128_000,
          id: "qwen",
          maxTokens: 8_192,
          name: "Qwen",
          reasoning: true,
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0.4,
            input: 1,
            output: 2,
          },
          input: [
            "text",
            "image",
          ],
        },
      ],
    });

    const [provider] = listProviderDrafts(config);
    expect(provider.models[0].cost.cacheRead).toBe(0.2);
    expect(modelReference(provider.id, provider.models[0].id)).toBe("local/qwen");
  });

  it("rejects malformed model configuration before writing", () => {
    expect(
      validateModelsConfig({
        providers: {
          local: {
            models: [
              {
                id: 42,
              },
            ],
          },
        },
      }),
    ).toContain("providers.local.models.0.id must be a non-empty string");
  });

  it("backs up an existing models.json before saving and keeps it 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xpi-mymodels-"));
    const modelsPath = join(dir, "models.json");
    const settingsPath = join(dir, "settings.json");
    await writeFile(modelsPath, '{"providers": {"old": {}}}', {
      mode: 0o600,
    });

    await saveModelsAndSettings(
      modelsPath,
      {
        providers: {},
      },
      settingsPath,
      {},
    );

    const backup = await readFile(`${modelsPath}.bak`, "utf8");
    expect(JSON.parse(backup)).toEqual({
      providers: {
        old: {},
      },
    });
    expect((await stat(`${modelsPath}.bak`)).mode & 0o777).toBe(0o600);
  });

  it("restores the backup when the second write fails, leaving models.json intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xpi-mymodels-"));
    const modelsPath = join(dir, "models.json");
    // settingsPath is a directory: writeFile() of the temp settings file fails, aborting the save
    const settingsPath = join(dir, "settings");
    await writeFile(modelsPath, '{"providers": {"old": {}}}', {
      mode: 0o600,
    });
    await mkdir(settingsPath);

    await expect(
      saveModelsAndSettings(
        modelsPath,
        {
          providers: {},
        },
        settingsPath,
        {},
      ),
    ).rejects.toThrow(SAVE_ERROR);

    // models.json was restored from the .bak copy, not left half-written
    const restored = JSON.parse(await readFile(modelsPath, "utf8"));
    expect(restored).toEqual({
      providers: {
        old: {},
      },
    });
    expect(await readFile(modelsPath, "utf8")).not.toContain("tmp");
  });

  it("adds a provider and deletes it with exact enabledModels cleanup", () => {
    const models: JsonObject = {
      providers: {
        local: {
          api: "openai-completions",
          baseUrl: "http://localhost:8080/v1",
          models: [
            {
              id: "qwen",
            },
          ],
        },
      },
    };
    const settings: JsonObject = {
      theme: "dark",
      enabledModels: [
        "local/qwen",
        "cloud/opus",
        "cloud/*",
      ],
    };

    const added = addProvider(models, "cloud");
    expect(added).toMatchObject({
      api: "openai-completions",
      authHeader: true,
      baseUrl: "https://api.example.com/v1",
      id: "cloud",
      models: [],
    });
    expect(() => addProvider(models, "cloud")).toThrow(PROVIDER_EXISTS);
    expect(() => addProvider(models, "  ")).toThrow(PROVIDER_EMPTY_ID);

    deleteProvider(models, settings, "local");
    expect(models.providers).toEqual({
      cloud: expect.objectContaining({
        api: "openai-completions",
        authHeader: true,
        baseUrl: "https://api.example.com/v1",
        models: [],
      }),
    });
    expect(models.providers).not.toHaveProperty("local");
    expect(settings).toEqual({
      theme: "dark",
      enabledModels: [
        "cloud/opus",
        "cloud/*",
      ],
    });
    expect(() => deleteProvider(models, settings, "missing")).toThrow(PROVIDER_MISSING);
  });
});
