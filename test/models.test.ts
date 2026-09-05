import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimateCost,
  getEnabledModels,
  listProviderDrafts,
  modelReference,
  readJsonc,
  saveModelsAndSettings,
  setEnabledModels,
  toUsd,
  upsertProvider,
  validateModelsConfig,
} from "../src/models.ts";

const SAVE_ERROR = /Could not save Pi configuration/;
describe("model configuration data", () => {
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
    const settings: Record<string, unknown> = {};
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

  it("normalizes a CNY pricing input (72.4 CNY at fixed 7.24) to 10 USD per 1M tokens", () => {
    expect(toUsd(72.4, "CNY", 7.24)).toBeCloseTo(10, 10);
  });

  it("converts CNY rates to Pi's USD billing rates", () => {
    expect(toUsd(7.24, "CNY", 7.24)).toBe(1);
    expect(toUsd(1, "USD", 7.24)).toBe(1);
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
      name: "Local",
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
});
