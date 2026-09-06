import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
  type ApiName,
  type Currency,
  estimateCost,
  getEnabledModels,
  type JsonObject,
  listProviderDrafts,
  type ModelDraft,
  modelReference,
  type ProviderDraft,
  readJsonc,
  renameProvider,
  saveModelsAndSettings,
  setEnabledModels,
  toUsd,
  upsertProvider,
} from "./models.ts";

const MODELS_PATH = join(getAgentDir(), "models.json");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");
// ponytail: fixed exchange rate per plan (docs/plan-notes/notes.md); make user-configurable when live rates are requested
const CNY_PER_USD = 7;
const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

interface Status {
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

export async function openModelConfig(ctx: ExtensionCommandContext): Promise<void> {
  const models = await readJsonc(MODELS_PATH);
  const settings = await readJsonc(SETTINGS_PATH);
  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _keybindings, done) => {
      const panel = new ModelConfigPanel(ctx, tui, theme, models, settings, done);
      return panel;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        maxHeight: "85%",
        minWidth: 60,
        width: "78%",
        margin: {
          bottom: 4,
        },
      },
    },
  );
  if (result)
    ctx.ui.notify(
      "xpi-mymodels saved. Reopen /model to refresh the model picker.",
      "info",
    );
}

class ModelConfigPanel implements Component {
  private providers: ProviderDraft[];
  private providerIndex = 0;
  private modelIndex = 0;
  private status: Status = {
    kind: "info",
    text: "Choose a model. Enter edits, Space toggles Ctrl+P, S saves.",
  };
  private cachedLines?: string[];

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly tui: TUI,
    private readonly theme: {
      fg(
        color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text",
        text: string,
      ): string;
      bg(color: "selectedBg", text: string): string;
      bold(text: string): string;
    },
    private readonly models: JsonObject,
    private readonly settings: JsonObject,
    private readonly done: (saved: boolean) => void,
  ) {
    this.providers = listProviderDrafts(models);
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const provider = this.providers[this.providerIndex];
    const model = provider?.models[this.modelIndex];
    const cycle = new Set(getEnabledModels(this.settings));
    const lines = [
      this.theme.bold(
        this.theme.fg("accent", "xpi-mymodels  /  Pi model configuration"),
      ),
      this.theme.fg("muted", `models.json  ${MODELS_PATH}`),
      "",
      this.section(
        "BASIC",
        provider
          ? `${provider.id}  ·  ${provider.api}  ·  ${provider.baseUrl || "no baseUrl"}`
          : "No provider configured",
      ),
      this.section(
        "MODELS",
        provider
          ? `${provider.models.length} model(s)  ·  selected ${model?.id ?? "none"}`
          : "Press N to add a provider",
      ),
      ...this.modelLines(provider, cycle),
      "",
      this.section(
        "QUICK CYCLE",
        `${cycle.size} model(s)  ·  Ctrl+P only, not a whitelist`,
      ),
      this.theme.fg(
        "muted",
        cycle.size
          ? [
              ...cycle,
            ].join("  →  ")
          : "none; Pi cycles all available models when unset",
      ),
      "",
      this.section(
        "ADVANCED",
        model
          ? `${model.reasoning ? "reasoning" : "standard"}  ·  ${model.input.join(",")}  ·  ${model.contextWindow.toLocaleString()} context`
          : "Enter a model to edit all fields",
      ),
      this.theme.fg(
        this.status.kind === "info" ? "text" : this.status.kind,
        this.status.text,
      ),
      "",
      this.theme.fg(
        "dim",
        "←/→ provider · ↑/↓ model · Enter edit · N new provider · A add model · P provider · Space cycle · T test · S save · Esc close",
      ),
    ];
    this.cachedLines = lines.map((line) =>
      line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line,
    );
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.moveModel(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveModel(1);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.moveProvider(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveProvider(1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCycle();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "e") {
      void this.editModel();
      return;
    }
    if (data === "a") return void this.addModel();
    if (data === "p") return void this.editProvider();
    if (data === "t") return void this.testConnection();
    if (data === "s") return void this.save();
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  private section(label: string, detail: string): string {
    return `${this.theme.fg("accent", `▼ ${label}`)}  ${this.theme.fg("muted", detail)}`;
  }

  private modelLines(
    provider: ProviderDraft | undefined,
    cycle: Set<string>,
  ): string[] {
    if (!provider)
      return [
        this.theme.fg("dim", "  No models"),
      ];
    return provider.models.slice(0, 12).map((model, index) => {
      const selected = index === this.modelIndex;
      const ref = modelReference(provider.id, model.id);
      const row = `${selected ? "›" : " "} ${model.id}  ${model.reasoning ? "thinking" : ""}  ${cycle.has(ref) ? "[cycle]" : ""}`;
      return selected ? this.theme.bg("selectedBg", row) : row;
    });
  }

  private moveModel(delta: number): void {
    const count = this.providers[this.providerIndex]?.models.length ?? 0;
    if (count === 0) return;
    this.modelIndex = (this.modelIndex + delta + count) % count;
    this.invalidate();
    this.tui.requestRender();
  }

  private moveProvider(delta: number): void {
    if (this.providers.length === 0) return;
    this.providerIndex =
      (this.providerIndex + delta + this.providers.length) % this.providers.length;
    this.modelIndex = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  private toggleCycle(): void {
    const provider = this.providers[this.providerIndex];
    const model = provider?.models[this.modelIndex];
    if (!provider || !model) return;
    const ref = modelReference(provider.id, model.id);
    const patterns = getEnabledModels(this.settings);
    const next = patterns.includes(ref)
      ? patterns.filter((item) => item !== ref)
      : [
          ...patterns,
          ref,
        ];
    setEnabledModels(this.settings, next);
    this.status = {
      kind: "success",
      text: `${next.includes(ref) ? "Added to" : "Removed from"} Ctrl+P cycle: ${ref}`,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private async newProvider(): Promise<void> {
    const id = await this.ctx.ui.input("Provider id", "e.g. local-llm");
    if (!id?.trim()) return;
    const provider: ProviderDraft = {
      api: "openai-completions",
      apiKey: "",
      authHeader: true,
      baseUrl: "",
      id: id.trim(),
      models: [],
    };
    this.providers.push(provider);
    this.providerIndex = this.providers.length - 1;
    this.modelIndex = 0;
    await this.editProviderFields(provider, false);
    this.invalidate();
    this.tui.requestRender();
  }

  private async editProvider(): Promise<void> {
    const provider = this.providers[this.providerIndex];
    if (!provider) return this.newProvider();
    await this.editProviderFields(provider);
    this.invalidate();
    this.tui.requestRender();
  }

  private async editProviderFields(
    provider: ProviderDraft,
    allowRename = true,
  ): Promise<void> {
    const id = await this.ctx.ui.input("Provider id", provider.id);
    const nextId = id?.trim();
    if (allowRename && nextId && nextId !== provider.id) {
      try {
        renameProvider(this.models, this.settings, provider.id, nextId);
        provider.id = nextId;
      } catch (error) {
        this.setStatus("error", error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const baseUrl = await this.ctx.ui.input(
      "Base URL",
      provider.baseUrl || "https://api.example.com/v1",
    );
    if (baseUrl !== undefined) provider.baseUrl = baseUrl.trim();
    const api = await this.ctx.ui.select("API type", [
      ...API_OPTIONS,
    ]);
    if (api && API_OPTIONS.includes(api as (typeof API_OPTIONS)[number]))
      provider.api = api as ProviderDraft["api"];
    const apiKey = await this.ctx.ui.input(
      "API key or $ENV_VAR (leave blank to keep current)",
      "secret values are never displayed",
    );
    if (apiKey?.trim()) provider.apiKey = apiKey.trim();
    provider.authHeader = true;
  }

  private async addModel(): Promise<void> {
    const provider = this.providers[this.providerIndex];
    if (!provider) return this.newProvider();
    const model = await this.modelEditor({
      contextWindow: 128_000,
      id: "",
      maxTokens: 16_384,
      name: "",
      reasoning: false,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
      },
      input: [
        "text",
      ],
    });
    if (!model) return;
    provider.models.push(model);
    this.modelIndex = provider.models.length - 1;
    this.status = {
      kind: "success",
      text: `Added model ${model.id}`,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private async editModel(): Promise<void> {
    const provider = this.providers[this.providerIndex];
    const current = provider?.models[this.modelIndex];
    if (!provider || !current) return this.addModel();
    const model = await this.modelEditor(current);
    if (!model) return;
    provider.models[this.modelIndex] = model;
    this.status = {
      kind: "success",
      text: `Updated model ${model.id}`,
    };
    this.invalidate();
    this.tui.requestRender();
  }

  private async modelEditor(source: ModelDraft): Promise<ModelDraft | undefined> {
    const model = structuredClone(source);
    const id = await this.ctx.ui.input("Model id", model.id || "provider-model-id");
    if (!id?.trim()) return undefined;
    model.id = id.trim();
    const name = await this.ctx.ui.input("Model display name", model.name || model.id);
    if (name?.trim()) model.name = name.trim();
    model.reasoning = await this.ctx.ui.confirm(
      "Reasoning",
      "Does this model support extended thinking?",
      {
        timeout: 30_000,
      },
    );
    const input = await this.ctx.ui.select(
      "Input types",
      model.input.includes("image")
        ? [
            "text + image",
            "text only",
          ]
        : [
            "text only",
            "text + image",
          ],
    );
    model.input =
      input === "text + image"
        ? [
            "text",
            "image",
          ]
        : [
            "text",
          ];
    model.contextWindow = await numberInput(
      "Context window",
      model.contextWindow,
      this.ctx,
    );
    model.maxTokens = await numberInput("Max output tokens", model.maxTokens, this.ctx);
    const currency = await this.ctx.ui.select(
      "Pricing currency (fixed rate 7 CNY/USD)",
      [
        "USD",
        "CNY",
      ],
    );
    const pricingCurrency: Currency = currency === "CNY" ? "CNY" : "USD";
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ] as const) {
      // ponytail: sequential prompts are the intended UX (ordered form flow), not a parallelizable loop
      const shown =
        pricingCurrency === "CNY" ? model.cost[key] * CNY_PER_USD : model.cost[key];
      // biome-ignore lint/performance/noAwaitInLoops: interactive form prompts must run sequentially, not in parallel
      const entered = await numberInput(
        `${key} ${pricingCurrency} / 1M tokens (fixed rate)`,
        shown,
        this.ctx,
        true,
      );
      model.cost[key] = toUsd(entered, pricingCurrency, CNY_PER_USD);
    }
    const advanced = await this.ctx.ui.editor(
      "Advanced JSON fields (thinkingLevelMap, samplingParams, headers, compat)",
      JSON.stringify(
        {
          compat: model.compat,
          headers: model.headers,
          samplingParams: model.samplingParams,
          thinkingLevelMap: model.thinkingLevelMap,
        },
        null,
        2,
      ),
    );
    if (advanced?.trim()) {
      try {
        const value = JSON.parse(advanced) as JsonObject;
        model.thinkingLevelMap = objectOrUndefined(value.thinkingLevelMap);
        model.samplingParams = objectOrUndefined(value.samplingParams);
        model.headers = stringMapOrUndefined(value.headers);
        model.compat = objectOrUndefined(value.compat);
      } catch {
        this.status = {
          kind: "error",
          text: "Advanced JSON was invalid; basic fields were kept.",
        };
      }
    }
    return model;
  }

  private async save(): Promise<void> {
    if (this.providers.length === 0)
      return this.setStatus("warning", "Add a provider before saving.");
    for (const provider of this.providers) {
      if (
        !provider.id ||
        !provider.baseUrl ||
        provider.models.some((model) => !model.id)
      ) {
        return this.setStatus(
          "error",
          "Every provider needs an id, baseUrl, and valid model ids.",
        );
      }
      upsertProvider(this.models, provider);
    }
    try {
      await saveModelsAndSettings(
        MODELS_PATH,
        this.models,
        SETTINGS_PATH,
        this.settings,
      );
      this.done(true);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  private async testConnection(): Promise<void> {
    const provider = this.providers[this.providerIndex];
    const model = provider?.models[this.modelIndex];
    if (!provider || !model) return this.setStatus("warning", "Select a model first.");
    this.setStatus("info", `Testing ${provider.id}/${model.id}…`);
    const started = performance.now();
    try {
      const key = resolveSecret(provider.apiKey);
      if (provider.apiKey.startsWith("!"))
        throw new Error("shell-command API keys cannot be tested from the UI");
      const headers = {
        "content-type": "application/json",
        ...(provider.authHeader && key
          ? {
              authorization: `Bearer ${key}`,
            }
          : {}),
        ...provider.headers,
      };
      const endpoint = `${provider.baseUrl.replace(TRAILING_SLASH, "")}${apiPath(provider.api)}`;
      const body = pingBody(provider.api, model.id);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const elapsed = Math.round(performance.now() - started);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.setStatus(
        "success",
        `Connection OK · inference probe · ${elapsed} ms · response discarded`,
      );
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      this.setStatus(
        "error",
        `Connection failed · ${elapsed} ms · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private setStatus(kind: Status["kind"], text: string): void {
    this.status = {
      kind,
      text,
    };
    this.invalidate();
    this.tui.requestRender();
  }
}

const TRAILING_SLASH = /\/$/;

function apiPath(api: ApiName): string {
  if (api === "anthropic-messages") return "/messages";
  if (api === "openai-responses") return "/responses";
  return "/chat/completions";
}

function pingBody(api: ApiName, modelId: string): Record<string, unknown> {
  if (api === "anthropic-messages") {
    return {
      max_tokens: 1,
      model: modelId,
      messages: [
        {
          content: "ping",
          role: "user",
        },
      ],
    };
  }
  if (api === "openai-responses") {
    return {
      input: "ping",
      max_output_tokens: 1,
      model: modelId,
    };
  }
  return {
    max_tokens: 1,
    model: modelId,
    messages: [
      {
        content: "ping",
        role: "user",
      },
    ],
  };
}

async function numberInput(
  title: string,
  current: number,
  ctx: ExtensionCommandContext,
  allowZero = false,
): Promise<number> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined || value.trim() === "") return current;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0)
    ? parsed
    : current;
}

const ENV_SECRET = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/;

export function resolveSecret(value: string): string {
  const match = value.match(ENV_SECRET);
  return match ? (process.env[match[1]] ?? "") : value;
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringMapOrUndefined(value: unknown): Record<string, string> | undefined {
  if (!objectOrUndefined(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (
      item,
    ): item is [
      string,
      string,
    ] => typeof item[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function costPreview(model: ModelDraft): number {
  return estimateCost(
    {
      cacheRead: 38_000,
      cacheWrite: 4_000,
      input: 12_000,
      output: 2_400,
    },
    model.cost,
  );
}
