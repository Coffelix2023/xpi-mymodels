import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ApiName,
  addProvider,
  deleteProvider,
  type InputCapability,
  type JsonObject,
  listProviderDrafts,
  type ModelDraft,
  modelReference,
  type ProviderDraft,
  readJsonc,
  renameProvider,
  saveModelsAndSettings,
  updateEnabledModelReference,
  upsertProvider,
} from "./models.ts";

const MODELS_PATH = join(homedir(), ".pi/agent/models.json");
const SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");
const API_OPTIONS: ApiName[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

interface GlimpsePromptOptions {
  height: number;
  title: string;
  width: number;
}

interface GlimpseWindow {
  close(): void;
  on(event: "closed" | "error" | "message", listener: (value?: unknown) => void): void;
  send(js: string): void;
}

interface GlimpseModule {
  open(html: string, options: GlimpsePromptOptions): GlimpseWindow;
}

interface ModelPanelValues {
  contextWindow: unknown;
  costCacheRead: unknown;
  costCacheWrite: unknown;
  costInput: unknown;
  costOutput: unknown;
  id: unknown;
  input: unknown;
  maxTokens: unknown;
  name: unknown;
  reasoning: unknown;
}

interface SaveValues {
  api: unknown;
  apiKey: unknown;
  baseUrl: unknown;
  id: unknown;
  models: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadGlimpse(): Promise<GlimpseModule | null> {
  const candidates = [
    "glimpseui/src/glimpse.mjs",
    join(homedir(), ".pi/agent/npm/node_modules/glimpseui/src/glimpse.mjs"),
  ];
  for (const spec of candidates) {
    try {
      // SAFETY: this is the Glimpse adapter selected by the loader; its open method is used below.
      // biome-ignore lint/performance/noAwaitInLoops: fallback hosts must be tried in order.
      return (await import(
        spec.startsWith("/") ? pathToFileURL(spec).href : spec
      )) as unknown as GlimpseModule;
    } catch {
      // Try the next host installation.
    }
  }
  return null;
}

export async function openGlimpseModelConfig(): Promise<boolean> {
  const glimpse = await loadGlimpse();
  if (!glimpse) throw new Error("Glimpse is unavailable in this Pi installation");

  const models = await readJsonc(MODELS_PATH);
  const settings = await readJsonc(SETTINGS_PATH);
  const providers = listProviderDrafts(models);
  const window = glimpse.open(panelHtml(providers), {
    height: 780,
    title: "Pi model configuration",
    width: 980,
  });

  return new Promise((resolve, reject) => {
    let applied = false;
    let settled = false;
    const finish = (saved: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(saved || applied);
    };
    const reportError = (error: unknown): void => {
      sendStatus(
        window,
        false,
        error instanceof Error ? error.message : "Could not update configuration",
      );
    };

    window.on("message", (value) => {
      if (!isObject(value) || typeof value.action !== "string") return;
      if (value.action === "cancel") {
        finish(applied);
        window.close();
        return;
      }
      try {
        if (value.action === "add-provider") {
          const draft = addProvider(models, nonEmptyString(value.id, "provider id"));
          persistProviders({
            window,
            models,
            settings,
            providers,
            message: "Provider added",
            selectedId: draft.id,
            onSaved: () => {
              applied = true;
            },
          });
          return;
        }
        if (value.action === "delete-provider") {
          const provider = providers[indexValue(value.providerIndex, "provider")];
          if (!provider) throw new Error("The selected provider no longer exists");
          deleteProvider(models, settings, provider.id);
          persistProviders({
            window,
            models,
            settings,
            providers,
            message: "Provider deleted",
            selectedId: undefined,
            onSaved: () => {
              applied = true;
            },
          });
          return;
        }
        if (value.action === "delete") {
          deleteModel(models, settings, providers, value);
          persistProviders({
            window,
            models,
            settings,
            providers,
            message: "Model deleted",
            selectedId: providers[indexValue(value.providerIndex, "provider")]?.id,
            onSaved: () => {
              applied = true;
            },
          });
          return;
        }
        if (value.action !== "apply") return;

        applyMessage(models, settings, providers, value);
        void saveModelsAndSettings(MODELS_PATH, models, SETTINGS_PATH, settings)
          .then(() => {
            applied = true;
            const next = listProviderDrafts(models);
            providers.splice(0, providers.length, ...next);
            const providerIndex = indexValue(value.providerIndex, "provider");
            sendProviders(
              window,
              next,
              Math.min(providerIndex, Math.max(0, next.length - 1)),
            );
            sendStatus(window, true, "Applied");
          })
          .catch(reportError);
      } catch (error) {
        reportError(error);
      }
    });
    window.on("closed", () => finish(applied));
    window.on("error", (error) => {
      if (!settled)
        reject(error instanceof Error ? error : new Error("Glimpse window failed"));
    });
  });
}

function applyMessage(
  models: JsonObject,
  settings: JsonObject,
  providers: ProviderDraft[],
  message: JsonObject,
): void {
  const providerIndex = indexValue(message.providerIndex, "provider");
  const currentProvider = providers[providerIndex];
  if (!currentProvider) throw new Error("The selected Pi provider no longer exists");
  if (!isObject(message.values))
    throw new Error("The Glimpse form returned invalid values");

  // SAFETY: the enclosing object check confirms JSON data; every field is validated below.
  const values = message.values as unknown as SaveValues;
  if (!Array.isArray(values.models))
    throw new Error("The models list must be an array");

  const nextModels: ModelDraft[] = values.models.map((item, index) => {
    if (!isObject(item)) throw new Error(`Invalid model at column ${index + 1}`);
    const candidateId = typeof item.id === "string" ? item.id.trim() : "";
    const existing =
      (candidateId
        ? currentProvider.models.find((model) => model.id === candidateId)
        : undefined) ?? currentProvider.models[index];
    return modelFromValues(
      // SAFETY: isObject(item) verifies the JSON object shape; modelFromValues validates every field before use.
      item as unknown as ModelPanelValues,
      existing ?? defaultModel(),
    );
  });
  const seenIds = new Set<string>();
  for (const model of nextModels) {
    if (seenIds.has(model.id)) throw new Error(`Duplicate model id "${model.id}"`);
    seenIds.add(model.id);
  }

  for (const previousModel of currentProvider.models) {
    if (!nextModels.some((model) => model.id === previousModel.id))
      updateEnabledModelReference(
        settings,
        modelReference(currentProvider.id, previousModel.id),
      );
  }

  nextModels.forEach((nextModel, index) => {
    const previousModel = currentProvider.models[index];
    if (
      previousModel &&
      previousModel.id !== nextModel.id &&
      !currentProvider.models.some((model) => model.id === nextModel.id)
    ) {
      preserveRenamedModelFields(
        models,
        currentProvider.id,
        previousModel.id,
        nextModel.id,
        index,
      );
      updateEnabledModelReference(
        settings,
        modelReference(currentProvider.id, previousModel.id),
        modelReference(currentProvider.id, nextModel.id),
      );
    }
  });

  const nextId = nonEmptyString(values.id, "provider id");
  const nextProvider: ProviderDraft = {
    ...currentProvider,
    api: apiValue(values.api, "provider API"),
    apiKey: secretValue(values.apiKey, currentProvider.apiKey),
    authHeader: true,
    baseUrl: nonEmptyString(values.baseUrl, "provider base URL"),
    id: nextId,
    models: nextModels,
  };
  if (nextId !== currentProvider.id)
    renameProvider(models, settings, currentProvider.id, nextId);
  upsertProvider(models, nextProvider);
  providers[providerIndex] = nextProvider;
}

function modelFromValues(values: ModelPanelValues, base: ModelDraft): ModelDraft {
  return {
    ...base,
    contextWindow: positiveNumber(values.contextWindow, "context window"),
    id: nonEmptyString(values.id, "model id"),
    input: inputCapabilities(values.input),
    maxTokens: positiveNumber(values.maxTokens, "max output tokens"),
    name: nonEmptyString(values.name, "model name"),
    reasoning: booleanValue(values.reasoning, "reasoning"),
    cost: {
      cacheRead: nonNegativeNumber(values.costCacheRead, "cache read price"),
      cacheWrite: nonNegativeNumber(values.costCacheWrite, "cache write price"),
      input: nonNegativeNumber(values.costInput, "input price"),
      output: nonNegativeNumber(values.costOutput, "output price"),
    },
  };
}
function inputCapabilities(value: unknown): ModelDraft["input"] {
  if (!Array.isArray(value)) throw new Error("Invalid input capabilities");
  const capabilities: InputCapability[] = value.filter(
    (item): item is InputCapability => item === "text" || item === "image",
  );
  if (capabilities.length === 0)
    throw new Error("At least one input capability is required");
  return capabilities;
}

function deleteModel(
  models: JsonObject,
  settings: JsonObject,
  providers: ProviderDraft[],
  message: JsonObject,
): void {
  const providerIndex = indexValue(message.providerIndex, "provider");
  const modelIndex = indexValue(message.modelIndex, "model");
  const provider = providers[providerIndex];
  const model = provider?.models[modelIndex];
  if (!provider || !model) throw new Error("The selected Pi model no longer exists");

  upsertProvider(models, {
    ...provider,
    models: provider.models.filter((_item, index) => index !== modelIndex),
  });
  updateEnabledModelReference(settings, modelReference(provider.id, model.id));
}

function preserveRenamedModelFields(
  models: JsonObject,
  providerId: string,
  previousId: string,
  nextId: string,
  modelIndex: number,
): void {
  if (previousId === nextId || !isObject(models.providers)) return;
  const provider = models.providers[providerId];
  if (!isObject(provider) || !Array.isArray(provider.models)) return;
  const rawModel = provider.models[modelIndex];
  if (!isObject(rawModel)) return;
  provider.models[modelIndex] = {
    ...rawModel,
    id: nextId,
  };
}

function defaultModel(): ModelDraft {
  return {
    contextWindow: 300_000,
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
      "image",
    ],
  };
}

function indexValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`Invalid ${label} selection`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value.trim();
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!result) throw new Error(`${label} must not be empty`);
  return result;
}

function secretValue(value: unknown, fallback: string): string {
  const result = stringValue(value, "API key");
  return result || fallback;
}

function apiValue(value: unknown, label: string): ApiName {
  const result = stringValue(value, label);
  if (!API_OPTIONS.includes(result as ApiName)) throw new Error(`Invalid ${label}`);
  return result as ApiName;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = numberValue(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = numberValue(value, label);
  if (result < 0) throw new Error(`${label} must not be negative`);
  return result;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

interface PersistOptions {
  message: string;
  models: JsonObject;
  onSaved: () => void;
  providers: ProviderDraft[];
  selectedId: string | undefined;
  settings: JsonObject;
  window: GlimpseWindow;
}

function persistProviders({
  window,
  models,
  settings,
  providers,
  selectedId,
  message,
  onSaved,
}: PersistOptions): void {
  void saveModelsAndSettings(MODELS_PATH, models, SETTINGS_PATH, settings)
    .then(() => {
      onSaved();
      const next = listProviderDrafts(models);
      providers.splice(0, providers.length, ...next);
      const providerIndex = selectedId
        ? Math.max(
            0,
            next.findIndex((item) => item.id === selectedId),
          )
        : 0;
      sendProviders(window, next, providerIndex);
      sendStatus(window, true, message);
    })
    .catch((error: unknown) => {
      sendStatus(
        window,
        false,
        error instanceof Error ? error.message : "Could not update configuration",
      );
    });
}

function sendProviders(
  window: GlimpseWindow,
  providers: ProviderDraft[],
  providerIndex: number,
): void {
  window.send(
    `window.applyProviders(${JSON.stringify({
      providerIndex,
      providers: panelProviders(providers),
    })})`,
  );
}

function sendStatus(window: GlimpseWindow, ok: boolean, message: string): void {
  window.send(
    `window.setPanelStatus(${JSON.stringify({
      ok,
      message,
    })})`,
  );
}

function panelProviders(providers: ProviderDraft[]) {
  return providers.map((provider) => ({
    api: provider.api,
    baseUrl: provider.baseUrl,
    id: provider.id,
    models: provider.models.map((model) => ({
      contextWindow: model.contextWindow,
      cost: model.cost,
      id: model.id,
      input: model.input,
      maxTokens: model.maxTokens,
      name: model.name,
      reasoning: model.reasoning,
    })),
  }));
}

export function panelHtml(providers: ProviderDraft[]): string {
  const data = JSON.stringify({
    apiOptions: API_OPTIONS,
    providers: panelProviders(providers),
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
 :root{--surface:rgba(30,30,32,.85);--control:rgba(255,255,255,.07);--card-bg:rgba(255,255,255,.04);--input-bg:rgba(0,0,0,.22);--ink:#f2f2f4;--muted:#a3a3ad;--rule:rgba(255,255,255,.13);--primary:var(--sys-accent,#0a84ff);--error:#ff5f57;--success:#32d74b}
[data-theme=light]{--surface:rgba(246,246,248,.92);--control:rgba(0,0,0,.05);--card-bg:rgba(0,0,0,.03);--input-bg:#fff;--ink:#222226;--muted:#676770;--rule:rgba(0,0,0,.13)}
*{box-sizing:border-box}html,body{height:100%;min-width:960px;margin:0}body{background:var(--surface);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}input,select{font:inherit;color:inherit}.shell{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--surface)}
 .nav{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--rule)}.tabs{flex:1;display:flex;gap:4px;overflow-x:auto;min-width:0}.tab{border:1px solid transparent;background:transparent;color:var(--muted);border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap;font-size:13px;font-weight:500}.tab.active{background:var(--control);color:var(--ink);border-color:var(--rule);font-size:14px;font-weight:700}.tools{display:flex;gap:6px;align-items:center;flex-shrink:0}.tool,.btn{border:1px solid var(--rule);background:var(--control);color:var(--ink);border-radius:7px;cursor:pointer}.tool{width:28px;height:26px;font-size:11px}.segmented{display:flex;gap:2px;padding:2px;border:1px solid var(--rule);border-radius:7px;background:var(--control)}.segment{border:0;background:transparent;color:var(--muted);border-radius:5px;padding:3px 7px;cursor:pointer;font-size:11px}.segment.active{background:var(--primary);color:#fff}
 .content{flex:1;min-height:0;overflow:hidden;padding:14px 18px}form{height:100%;display:flex;flex-direction:column}.section-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding-bottom:6px;margin:6px 0 12px}.section-title{font-size:15px;font-weight:700;color:var(--ink)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.provider-grid{grid-template-columns:minmax(0,1fr);margin-bottom:10px}.field{margin-bottom:10px}.field label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.field input,.field select{width:100%;padding:6px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--input-bg)}
 .models-layout{flex:1;min-height:0;display:flex;gap:14px;border:1px solid var(--rule);border-radius:8px;background:var(--card-bg);padding:14px;overflow:hidden;align-items:stretch}.models-sidebar{width:240px;min-width:240px;display:flex;flex-direction:column;border-right:1px solid var(--rule);padding-right:14px}.models-sidebar-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.models-count{font-size:12px;font-weight:600;color:var(--muted)}.btn-sm{min-height:26px;padding:3px 10px;font-size:11px;font-weight:600;border-radius:5px}.models-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:5px;padding-right:2px}.model-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;text-align:left;transition:all .15s ease}.model-item:hover{background:var(--control)}.model-item.active{background:var(--control);border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}.model-item-title{font-size:12px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-item.active .model-item-title{color:var(--primary)}.model-item-id{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-item-badges{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}.badge{font-size:9px;padding:1px 4px;border-radius:3px;background:var(--rule);color:var(--muted);font-weight:600}.badge.accent{color:var(--primary);background:rgba(10,132,255,.15)}
 .models-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding-left:4px}.model-detail-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid var(--rule)}.model-detail-title-wrap{display:flex;align-items:center;gap:8px;min-width:0}.model-detail-title{font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-detail-id-badge{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);background:var(--control);padding:2px 6px;border-radius:4px}.pricing-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px;margin-bottom:8px}.input-tags{display:flex;gap:6px;flex-wrap:wrap}.input-tag{border:1px solid var(--rule);background:var(--control);color:var(--muted);border-radius:5px;padding:5px 10px;cursor:pointer}.input-tag.active{border-color:var(--primary);background:rgba(10,132,255,.15);color:var(--primary)}.features-row{display:flex;gap:20px;align-items:center;min-height:30px}.check{display:flex;align-items:center;gap:7px;min-height:30px}.field.check input[type=checkbox]{width:auto;flex:0 0 auto}.check label{margin:0;color:var(--ink);font-size:12px;white-space:nowrap}.models-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:12px;padding:40px 0}.models-empty-icon{font-size:32px;line-height:1;opacity:.6}.footer{display:flex;align-items:center;gap:8px;padding:10px 18px;border-top:1px solid var(--rule);background:var(--control)}.status{flex:1;color:var(--muted);font-size:11px}.status.error{color:var(--error)}.status.success{color:var(--success)}.btn{min-height:32px;padding:6px 16px;font-size:13px}.primary{background:var(--primary);border-color:transparent;color:#fff}.danger{color:var(--error)}.tool:focus-visible,.btn:focus-visible,.tab:focus-visible,.segment:focus-visible,.input-tag:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:1px}[data-reduce-motion=true] *{transition:none!important}
</style></head><body><div class="shell"><header class="nav"><div class="tabs" id="tabs" role="tablist"></div><div class="tools"><div class="segmented" id="currency" role="group" aria-label="Pricing currency"><button class="segment active" id="currencyCny" type="button">CNY</button><button class="segment" id="currencyUsd" type="button">USD</button></div><button class="tool" id="lang" data-i18n="lang" data-i18n-title="langTitle"></button><button class="tool" id="zoomOut">A-</button><button class="tool" id="zoomIn">A+</button><button class="tool" id="zoomReset">&#8635;</button></div></header><main class="content"><form id="form"><div class="section-head"><span class="section-title" data-i18n="providerSection"></span></div><div class="grid provider-grid"><div class="field"><label for="providerId" data-i18n="providerId"></label><input id="providerId" required></div><div class="field"><label for="api" data-i18n="api"></label><select id="api"></select></div><div class="field"><label for="baseUrl" data-i18n="baseUrl"></label><input id="baseUrl" required></div><div class="field"><label for="apiKey" data-i18n="apiKey"></label><input id="apiKey" type="password" autocomplete="new-password" data-i18n-placeholder="apiKeyPlaceholder"></div></div><button class="btn btn-sm danger" id="deleteProvider" type="button" data-i18n="deleteProviderTitle"></button><div class="section-head"><span class="section-title" data-i18n="modelSection"></span></div><div class="models-layout"><aside class="models-sidebar"><div class="models-sidebar-header"><span class="models-count" id="modelsCount"></span><button class="btn btn-sm" id="addModelBtn" type="button" data-i18n="addModel"></button></div><div class="models-list" id="modelsList" role="tablist"></div></aside><section class="models-detail" id="modelsDetail"></section></div></form></main><footer class="footer"><span class="status" id="status" role="status"></span><button class="btn" id="cancel" type="button" data-i18n="cancel"></button><button class="btn primary" id="apply" type="submit" form="form" data-i18n="apply"></button></footer></div><script>
const DATA=${data};const CNY_PER_USD=7;const INPUT_CAPABILITIES=["text","image"];let lang="zh",currency="CNY",zoom=1,providerIndex=0,selectedModelIndex=0,busy=false;const text={zh:{lang:"EN",langTitle:"切换语言",providerSection:"Provider 配置",modelSection:"模型列表",providerId:"Provider ID",api:"API 类型",baseUrl:"Base URL",apiKey:"API Key",apiKeyPlaceholder:"留空以保留当前值",addModel:"添加模型",deleteModel:"删除模型",deleteConfirm:"确认删除模型「{name}」？此操作将在点击应用后生效。",deleteProviderTitle:"删除 Provider",confirmDelete:"再次点击确认",cancel:"取消",apply:"应用",empty:"没有可用的 Provider",emptyModels:"当前 Provider 暂无模型，点击「添加模型」创建一个",modelCountLabel:"个模型",newModelTitle:"新模型",pName:"模型名称",pId:"模型 ID",pContext:"上下文窗口",pMaxTokens:"最大输出 tokens",pCostInput:"输入价格/1M",pCostOutput:"输出价格/1M",pCostCacheRead:"读缓存/1M",pCostCacheWrite:"写缓存/1M",pReasoning:"支持 reasoning",inputCapabilities:"输入能力",zoomOutTitle:"缩小",zoomInTitle:"放大",zoomResetTitle:"重置缩放",zoomStatus:"缩放"},en:{lang:"中文",langTitle:"Switch language",providerSection:"Provider settings",modelSection:"Models",providerId:"Provider ID",api:"API type",baseUrl:"Base URL",apiKey:"API key",apiKeyPlaceholder:"Leave blank to keep current value",addModel:"Add model",deleteModel:"Delete provider",deleteProviderTitle:"Delete provider",confirmDelete:"Click again to confirm",cancel:"Cancel",apply:"Apply",empty:"No providers available",emptyModels:"No models in this provider. Click 'Add model' to create one.",modelCountLabel:"model(s)",newModelTitle:"New model",pName:"Model name",pId:"Model ID",pContext:"Context window",pMaxTokens:"Max output tokens",pCostInput:"Input price/1M",pCostOutput:"Output price/1M",pCostCacheRead:"Cache read/1M",pCostCacheWrite:"Cache write/1M",pReasoning:"Supports reasoning",inputCapabilities:"Input capabilities",zoomOutTitle:"Zoom out",zoomInTitle:"Zoom in",zoomResetTitle:"Reset zoom",zoomStatus:"Zoom"}};const el=id=>document.getElementById(id),t=key=>text[lang][key]??key;function applyText(){document.querySelectorAll("[data-i18n]").forEach(node=>node.textContent=t(node.dataset.i18n));document.querySelectorAll("[data-i18n-placeholder]").forEach(node=>node.placeholder=t(node.dataset.i18nPlaceholder));el("lang").title=t("langTitle");el("deleteProvider").title=t("deleteProviderTitle");el("zoomOut").title=t("zoomOutTitle");el("zoomIn").title=t("zoomInTitle");el("zoomReset").title=t("zoomResetTitle")+" ("+Math.round(zoom*100)+"%)";renderCurrency()}function setPanelStatus(result){busy=false;render();const status=el("status");status.textContent=result.message;status.className="status"+(result.ok?" success":" error")}function applyProviders(payload){DATA.providers=payload.providers;providerIndex=Math.max(0,Math.min(payload.providerIndex??0,Math.max(0,DATA.providers.length-1)));selectedModelIndex=0;busy=false;render()}function selectOptions(select,values){select.textContent="";values.forEach(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option)})}function blankModel(){return{id:"",name:"",contextWindow:128000,maxTokens:16384,reasoning:false,input:["text","image"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}}function money(value){return currency==="CNY"?value*CNY_PER_USD:value}function toUsd(value){return currency==="CNY"?value/CNY_PER_USD:value}function renderCurrency(){el("currencyCny").className="segment"+(currency==="CNY"?" active":"");el("currencyUsd").className="segment"+(currency==="USD"?" active":"")}function setCurrency(next){const provider=DATA.providers[providerIndex];syncActiveModel(provider);currency=next;renderCurrency();renderModels(provider)}function renderTabs(){const tabs=el("tabs");tabs.textContent="";DATA.providers.forEach((item,index)=>{const button=document.createElement("button");button.type="button";button.className="tab"+(index===providerIndex?" active":"");button.textContent=item.id;button.title=item.id;button.addEventListener("click",()=>{syncActiveModel(DATA.providers[providerIndex]);providerIndex=index;selectedModelIndex=0;render()});tabs.appendChild(button)});const add=document.createElement("button");add.type="button";add.className="tab";add.textContent="+";add.title=t("addProviderTitle");add.addEventListener("click",()=>{if(busy)return;const used=new Set(DATA.providers.map(item=>item.id));let id="provider",suffix=1;while(used.has(id))id="provider-"+(++suffix);lock();window.glimpse.send({action:"add-provider",id:id})});tabs.appendChild(add)}function createField(labelText,inputEl){const field=document.createElement("div");field.className="field";const label=document.createElement("label");label.textContent=labelText;label.setAttribute("for",inputEl.id||"");field.appendChild(label);field.appendChild(inputEl);return field}function createCheckField(labelText,inputEl){const field=document.createElement("div");field.className="field check";field.appendChild(inputEl);const label=document.createElement("label");label.textContent=labelText;label.setAttribute("for",inputEl.id||"");field.appendChild(label);return field}function renderModelList(provider){const list=el("modelsList");list.textContent="";const countEl=el("modelsCount");if(!provider||provider.models.length===0){countEl.textContent="0 "+t("modelCountLabel");return}countEl.textContent=provider.models.length+" "+t("modelCountLabel");provider.models.forEach((model,index)=>{const item=document.createElement("button");item.type="button";item.className="model-item"+(index===selectedModelIndex?" active":"");item.id="modelItem_"+index;const title=document.createElement("span");title.className="model-item-title";title.textContent=model.name||model.id||t("newModelTitle");const subId=document.createElement("span");subId.className="model-item-id";subId.textContent=model.id||"-";const badges=document.createElement("div");badges.className="model-item-badges";if(model.reasoning){const badge=document.createElement("span");badge.className="badge accent";badge.textContent="R";badge.title="Reasoning";badges.appendChild(badge)}(model.input||[]).forEach(type=>{const badge=document.createElement("span");badge.className="badge";badge.textContent=type.toUpperCase();badges.appendChild(badge)});item.append(title,subId);if(badges.children.length)item.appendChild(badges);item.addEventListener("click",()=>{syncActiveModel(provider);selectedModelIndex=index;renderModels(provider)});list.appendChild(item)})}function renderInputTags(model,tags){tags.textContent="";INPUT_CAPABILITIES.forEach(type=>{const button=document.createElement("button");button.type="button";button.className="input-tag"+((model.input||[]).includes(type)?" active":"");button.textContent=type;button.addEventListener("click",()=>{const current=model.input||[];if(current.includes(type)){if(current.length===1)return;model.input=current.filter(item=>item!==type)}else{model.input=INPUT_CAPABILITIES.filter(item=>current.includes(item)||item===type)}renderInputTags(model,tags);renderModelList(DATA.providers[providerIndex])});tags.appendChild(button)})}function addNumberField(parent,id,label,key,model){const input=document.createElement("input");input.id=id;input.type="number";input.min="0";input.step="any";input.value=String(money(model.cost?.[key]??0));input.required=true;input.addEventListener("input",event=>{if(!model.cost)model.cost={input:0,output:0,cacheRead:0,cacheWrite:0};model.cost[key]=toUsd(Number(event.target.value)||0)});parent.appendChild(createField(t(label),input))}function renderModelDetail(provider){const detail=el("modelsDetail");detail.textContent="";if(!provider||provider.models.length===0){const empty=document.createElement("div");empty.className="models-empty";const icon=document.createElement("div");icon.className="models-empty-icon";icon.textContent="✦";const msg=document.createElement("span");msg.textContent=t("emptyModels");const addBtn=document.createElement("button");addBtn.type="button";addBtn.className="btn btn-sm primary";addBtn.textContent=t("addModel");addBtn.addEventListener("click",()=>addModelAction(provider));empty.append(icon,msg,addBtn);detail.appendChild(empty);return}const model=provider.models[selectedModelIndex];const header=document.createElement("div");header.className="model-detail-header";const titleWrap=document.createElement("div");titleWrap.className="model-detail-title-wrap";const title=document.createElement("span");title.className="model-detail-title";title.id="detailTitle";title.textContent=model.name||model.id||t("newModelTitle");const idBadge=document.createElement("span");idBadge.className="model-detail-id-badge";idBadge.id="detailIdBadge";idBadge.textContent=model.id||"-";titleWrap.append(title,idBadge);const delBtn=document.createElement("button");delBtn.type="button";delBtn.className="btn btn-sm danger";delBtn.textContent=t("deleteModel");delBtn.title=t("deleteModel");delBtn.addEventListener("click",()=>{confirmTwice(delBtn,()=>{provider.models.splice(selectedModelIndex,1);selectedModelIndex=Math.max(0,Math.min(selectedModelIndex,provider.models.length-1));renderModels(provider)})});header.append(titleWrap,delBtn);detail.appendChild(header);const mainGrid=document.createElement("div");mainGrid.className="grid model-grid";const nameInput=document.createElement("input");nameInput.id="modelName";nameInput.value=model.name;nameInput.required=true;nameInput.addEventListener("input",event=>{model.name=event.target.value;const detailTitle=el("detailTitle");if(detailTitle)detailTitle.textContent=model.name||model.id||t("newModelTitle");const itemTitle=document.querySelector("#modelItem_"+selectedModelIndex+" .model-item-title");if(itemTitle)itemTitle.textContent=model.name||model.id||t("newModelTitle")});mainGrid.appendChild(createField(t("pName"),nameInput));const idInput=document.createElement("input");idInput.id="modelId";idInput.value=model.id;idInput.required=true;idInput.addEventListener("input",event=>{model.id=event.target.value;const badge=el("detailIdBadge");if(badge)badge.textContent=model.id||"-";const itemId=document.querySelector("#modelItem_"+selectedModelIndex+" .model-item-id");if(itemId)itemId.textContent=model.id||"-";if(!model.name){const detailTitle=el("detailTitle");if(detailTitle)detailTitle.textContent=model.id||t("newModelTitle")}});mainGrid.appendChild(createField(t("pId"),idInput));const cwInput=document.createElement("input");cwInput.id="modelCw";cwInput.type="number";cwInput.min="1";cwInput.step="1";cwInput.value=String(model.contextWindow);cwInput.required=true;cwInput.addEventListener("input",event=>{model.contextWindow=Number(event.target.value)||128000});mainGrid.appendChild(createField(t("pContext"),cwInput));const mtInput=document.createElement("input");mtInput.id="modelMt";mtInput.type="number";mtInput.min="1";mtInput.step="1";mtInput.value=String(model.maxTokens);mtInput.required=true;mtInput.addEventListener("input",event=>{model.maxTokens=Number(event.target.value)||16384});mainGrid.appendChild(createField(t("pMaxTokens"),mtInput));detail.appendChild(mainGrid);const pricingGrid=document.createElement("div");pricingGrid.className="pricing-grid";addNumberField(pricingGrid,"modelCi","pCostInput","input",model);addNumberField(pricingGrid,"modelCo","pCostOutput","output",model);addNumberField(pricingGrid,"modelCr","pCostCacheRead","cacheRead",model);addNumberField(pricingGrid,"modelCwk","pCostCacheWrite","cacheWrite",model);detail.appendChild(pricingGrid);const inputField=document.createElement("div");inputField.className="field";const inputLabel=document.createElement("label");inputLabel.textContent=t("inputCapabilities");inputField.appendChild(inputLabel);const tags=document.createElement("div");tags.className="input-tags";inputField.appendChild(tags);renderInputTags(model,tags);detail.appendChild(inputField);const featuresRow=document.createElement("div");featuresRow.className="features-row";const reasoning=document.createElement("input");reasoning.id="modelReasoning";reasoning.type="checkbox";reasoning.checked=Boolean(model.reasoning);reasoning.addEventListener("change",event=>{model.reasoning=event.target.checked;renderModelList(provider)});featuresRow.appendChild(createCheckField(t("pReasoning"),reasoning));detail.appendChild(featuresRow)}function renderModels(provider){renderModelList(provider);renderModelDetail(provider)}function addModelAction(provider){if(!provider)return;syncActiveModel(provider);provider.models.push(blankModel());selectedModelIndex=provider.models.length-1;renderModels(provider)}function syncActiveModel(provider){if(!provider||!provider.models[selectedModelIndex])return;const model=provider.models[selectedModelIndex],nameInput=el("modelName"),idInput=el("modelId"),cwInput=el("modelCw"),mtInput=el("modelMt");if(nameInput)model.name=nameInput.value;if(idInput)model.id=idInput.value;if(cwInput)model.contextWindow=Number(cwInput.value)||128000;if(mtInput)model.maxTokens=Number(mtInput.value)||16384}function render(){const provider=DATA.providers[providerIndex];renderTabs();renderCurrency();const hasProvider=Boolean(provider);["providerId","api","baseUrl","apiKey"].forEach(id=>el(id).disabled=!hasProvider||busy);el("apply").disabled=!hasProvider||busy;el("deleteProvider").disabled=!hasProvider||busy;el("addModelBtn").disabled=!hasProvider||busy;if(!hasProvider){el("status").textContent=t("empty");el("status").className="status";el("modelsList").textContent="";el("modelsDetail").textContent="";return}el("providerId").value=provider.id;selectOptions(el("api"),DATA.apiOptions);el("api").value=provider.api;el("baseUrl").value=provider.baseUrl;el("apiKey").value="";renderModels(provider)}function collect(){const provider=DATA.providers[providerIndex];syncActiveModel(provider);const models=provider?provider.models.map(model=>({name:(model.name||"").trim(),id:(model.id||"").trim(),contextWindow:Number(model.contextWindow)||128000,maxTokens:Number(model.maxTokens)||16384,costInput:Number(model.cost?.input??0),costOutput:Number(model.cost?.output??0),costCacheRead:Number(model.cost?.cacheRead??0),costCacheWrite:Number(model.cost?.cacheWrite??0),reasoning:Boolean(model.reasoning),input:Array.isArray(model.input)&&model.input.length?model.input:["text"]})):[];return{id:el("providerId").value.trim(),api:el("api").value,baseUrl:el("baseUrl").value.trim(),apiKey:el("apiKey").value,models:models}}function lock(){busy=true;el("apply").disabled=true;el("deleteProvider").disabled=true;el("addModelBtn").disabled=true}function confirmTwice(button,action){if(button.dataset.confirming==="true"){clearTimeout(Number(button.dataset.confirmTimer));button.dataset.confirming="false";button.textContent=t("deleteModel");action();return}button.dataset.confirming="true";button.textContent=t("confirmDelete");button.dataset.confirmTimer=String(window.setTimeout(()=>{button.dataset.confirming="false";button.textContent=t("deleteModel")},3000))}function send(action){if(busy)return;lock();window.glimpse.send({action:action,providerIndex:providerIndex,values:collect()})}el("currencyCny").addEventListener("click",()=>setCurrency("CNY"));el("currencyUsd").addEventListener("click",()=>setCurrency("USD"));el("addModelBtn").addEventListener("click",()=>{if(!busy)addModelAction(DATA.providers[providerIndex])});el("deleteProvider").addEventListener("click",()=>{if(busy||!DATA.providers[providerIndex])return;confirmTwice(el("deleteProvider"),()=>{lock();window.glimpse.send({action:"delete-provider",providerIndex:providerIndex})})});el("cancel").addEventListener("click",()=>window.glimpse.send({action:"cancel"}));el("form").addEventListener("submit",event=>{event.preventDefault();const provider=DATA.providers[providerIndex];if(provider){for(let i=0;i<provider.models.length;i++){const model=provider.models[i];if(!model.id||!model.id.trim()||!model.name||!model.name.trim()||!Array.isArray(model.input)||model.input.length===0){selectedModelIndex=i;renderModels(provider);const targetField=!model.name||!model.name.trim()?el("modelName"):el("modelId");if(targetField){targetField.focus();targetField.reportValidity()}return}}}if(el("form").reportValidity())send("apply")});el("lang").addEventListener("click",()=>{lang=lang==="zh"?"en":"zh";applyText();render()});el("zoomOut").addEventListener("click",()=>setZoom(zoom-.1));el("zoomIn").addEventListener("click",()=>setZoom(zoom+.1));el("zoomReset").addEventListener("click",()=>setZoom(1));function setZoom(value){zoom=Math.min(1.5,Math.max(.8,Math.round(value*10)/10));document.body.style.zoom=String(zoom);const status=el("status");if(status){status.textContent=t("zoomStatus")+": "+Math.round(zoom*100)+"%";status.className="status"}el("zoomReset").title=t("zoomResetTitle")+" ("+Math.round(zoom*100)+"%)"}document.addEventListener("keydown",event=>{const mod=event.metaKey||event.ctrlKey;if(mod&&(event.key==="+"||event.key==="=")){event.preventDefault();setZoom(zoom+.1)}else if(mod&&event.key==="-"){event.preventDefault();setZoom(zoom-.1)}else if(mod&&event.key==="0"){event.preventDefault();setZoom(1)}});applyText();render();
</script></body></html>`;
}
