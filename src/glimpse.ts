import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ApiName,
  addProvider,
  deleteProvider,
  type JsonObject,
  listProviderDrafts,
  type ModelDraft,
  modelReference,
  type ProviderDraft,
  readJsonc,
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
  api: unknown;
  baseUrl: unknown;
  contextWindow: unknown;
  costCacheRead: unknown;
  costCacheWrite: unknown;
  costInput: unknown;
  costOutput: unknown;
  id: unknown;
  imageInput: unknown;
  maxTokens: unknown;
  name: unknown;
  reasoning: unknown;
}

interface SaveValues {
  api: unknown;
  apiKey: unknown;
  authHeader: unknown;
  baseUrl: unknown;
  models: unknown;
  name: unknown;
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
      // SAFETY: the loaded host is the Glimpse adapter selected by this loader; its open method is checked by the runtime call below.
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
    let settled = false;
    const finish = (saved: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(saved);
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
        finish(false);
        window.close();
        return;
      }
      try {
        if (value.action === "add-provider") {
          const draft = addProvider(models, nonEmptyString(value.id, "provider id"));
          persistProviders(
            window,
            models,
            settings,
            providers,
            draft.id,
            "Provider added",
          );
          return;
        }
        if (value.action === "delete-provider") {
          const provider = providers[indexValue(value.providerIndex, "provider")];
          if (!provider) throw new Error("The selected provider no longer exists");
          deleteProvider(models, settings, provider.id);
          persistProviders(
            window,
            models,
            settings,
            providers,
            undefined,
            "Provider deleted",
          );
          return;
        }
        if (value.action === "delete") {
          deleteModel(models, settings, providers, value);
        } else if (value.action === "save") {
          applyMessage(models, settings, providers, value);
        } else {
          return;
        }
        void saveModelsAndSettings(MODELS_PATH, models, SETTINGS_PATH, settings)
          .then(() => {
            finish(true);
            window.close();
          })
          .catch(reportError);
      } catch (error) {
        reportError(error);
      }
    });
    window.on("closed", () => finish(false));
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

  // SAFETY: the enclosing isObject check confirms a JSON object; every field is validated below before use.
  const values = message.values as unknown as SaveValues;
  if (!Array.isArray(values.models))
    throw new Error("The models list must be an array");

  const rawModelValues = values.models;
  const nextModels: ModelDraft[] = rawModelValues.map((item, idx) => {
    if (!isObject(item)) throw new Error(`Invalid model at column ${idx + 1}`);
    const candidateId = typeof item.id === "string" ? item.id.trim() : "";
    const existing =
      (candidateId
        ? currentProvider.models.find((m) => m.id === candidateId)
        : undefined) ?? currentProvider.models[idx];
    // SAFETY: the enclosing isObject check confirms an object; every field is validated inside modelFromValues.
    return modelFromValues(
      item as unknown as ModelPanelValues,
      existing ?? defaultModel(),
    );
  });
  const seenIds = new Set<string>();
  for (const model of nextModels) {
    if (seenIds.has(model.id)) {
      throw new Error(`Duplicate model id "${model.id}"`);
    }
    seenIds.add(model.id);
  }

  // Track deleted models to update enabledModelReference in settings
  for (const prevModel of currentProvider.models) {
    const stillExists = nextModels.some((m) => m.id === prevModel.id);
    if (!stillExists) {
      updateEnabledModelReference(
        settings,
        modelReference(currentProvider.id, prevModel.id),
      );
    }
  }

  // Track renamed models
  nextModels.forEach((nextM, idx) => {
    const prevM = currentProvider.models[idx];
    if (
      prevM &&
      prevM.id !== nextM.id &&
      !currentProvider.models.some((m) => m.id === nextM.id)
    ) {
      preserveRenamedModelFields(models, currentProvider.id, prevM.id, nextM.id, idx);
      updateEnabledModelReference(
        settings,
        modelReference(currentProvider.id, prevM.id),
        modelReference(currentProvider.id, nextM.id),
      );
    }
  });

  const nextProvider = {
    ...currentProvider,
    api: apiValue(values.api, "provider API"),
    apiKey: secretValue(values.apiKey, currentProvider.apiKey),
    authHeader: booleanValue(values.authHeader, "authorization header"),
    baseUrl: nonEmptyString(values.baseUrl, "provider base URL"),
    models: nextModels,
    name: nonEmptyString(values.name, "provider name"),
  } satisfies ProviderDraft;

  upsertProvider(models, nextProvider);
}

function modelFromValues(values: ModelPanelValues, base: ModelDraft): ModelDraft {
  return {
    ...base,
    api: optionalApiValue(values.api, "model API override"),
    baseUrl: optionalString(values.baseUrl, "model base URL override"),
    contextWindow: positiveNumber(values.contextWindow, "context window"),
    id: nonEmptyString(values.id, "model id"),
    input: booleanValue(values.imageInput, "image input")
      ? [
          "text",
          "image",
        ]
      : [
          "text",
        ],
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
  if (!isObject(models.providers))
    throw new Error("Pi providers configuration is invalid");
  const rawProvider = models.providers[provider.id];
  if (!isObject(rawProvider) || !Array.isArray(rawProvider.models))
    throw new Error("The selected Pi model no longer exists");

  rawProvider.models.splice(modelIndex, 1);
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

function optionalString(value: unknown, label: string): string | undefined {
  const result = stringValue(value, label);
  return result || undefined;
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

function optionalApiValue(value: unknown, label: string): ApiName | undefined {
  const result = stringValue(value, label);
  return result ? apiValue(result, label) : undefined;
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

function persistProviders(
  window: GlimpseWindow,
  models: JsonObject,
  settings: JsonObject,
  providers: ProviderDraft[],
  selectedId: string | undefined,
  message: string,
): void {
  void saveModelsAndSettings(MODELS_PATH, models, SETTINGS_PATH, settings)
    .then(() => {
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
    authHeader: provider.authHeader,
    baseUrl: provider.baseUrl,
    id: provider.id,
    models: provider.models.map((model) => ({
      api: model.api ?? "",
      baseUrl: model.baseUrl ?? "",
      contextWindow: model.contextWindow,
      cost: model.cost,
      id: model.id,
      imageInput: model.input.includes("image"),
      maxTokens: model.maxTokens,
      name: model.name,
      reasoning: model.reasoning,
    })),
    name: provider.name,
  }));
}

function panelHtml(providers: ProviderDraft[]): string {
  const data = JSON.stringify({
    apiOptions: API_OPTIONS,
    providers: panelProviders(providers),
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--surface:rgba(30,30,32,.85);--control:rgba(255,255,255,.07);--card-bg:rgba(255,255,255,.04);--input-bg:rgba(0,0,0,.22);--ink:#f2f2f4;--muted:#a3a3ad;--rule:rgba(255,255,255,.13);--primary:var(--sys-accent,#0a84ff);--error:#ff5f57;--success:#32d74b}[data-theme=light]{--surface:rgba(246,246,248,.92);--control:rgba(0,0,0,.05);--card-bg:rgba(0,0,0,.03);--input-bg:#ffffff;--ink:#222226;--muted:#676770;--rule:rgba(0,0,0,.13)}*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--surface);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}input,select{font:inherit;color:inherit}.shell{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--surface)}.nav{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--rule)}.tabs{flex:1;display:flex;gap:4px;overflow-x:auto;min-width:0}.tab{border:1px solid transparent;background:transparent;color:var(--muted);border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap;font-size:13px;font-weight:500}.tab.active{background:var(--control);color:var(--ink);border-color:var(--rule);font-size:14px;font-weight:700}.tools{display:flex;gap:6px;flex-shrink:0}.tool,.btn{border:1px solid var(--rule);background:var(--control);color:var(--ink);border-radius:7px;cursor:pointer}.tool{width:28px;height:26px;font-size:11px}.content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 18px}.section-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding-bottom:6px;margin:6px 0 12px}.section-title{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-0.2px}.grid{display:grid;grid-template-columns:1fr;gap:0 12px}.provider-grid{margin-bottom:16px}.field{margin-bottom:10px}.field label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.field input,.field select{width:100%;padding:6px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--input-bg)}.check{display:flex;align-items:center;gap:7px;min-height:30px}.field.check input[type=checkbox]{width:auto;flex:0 0 auto}.check label{margin:0;color:var(--ink);font-size:12px;white-space:nowrap}.models-layout{display:flex;gap:14px;border:1px solid var(--rule);border-radius:8px;background:var(--card-bg);padding:14px;height:calc(100vh - 250px);min-height:430px;overflow:hidden;align-items:stretch}.models-sidebar{width:240px;min-width:240px;display:flex;flex-direction:column;border-right:1px solid var(--rule);padding-right:14px}.models-sidebar-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.models-count{font-size:12px;font-weight:600;color:var(--muted)}.btn-sm{min-height:26px;padding:3px 10px;font-size:11px;font-weight:600;border-radius:5px}.models-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:5px;padding-right:2px}.model-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;text-align:left;transition:all .15s ease}.model-item:hover{background:var(--control)}.model-item.active{background:var(--control);border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}.model-item-title{font-size:12px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-item.active .model-item-title{color:var(--primary)}.model-item-id{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-item-badges{display:flex;gap:4px;margin-top:3px}.badge{font-size:9px;padding:1px 4px;border-radius:3px;background:var(--rule);color:var(--muted);font-weight:600}.badge.accent{color:var(--primary);background:rgba(10,132,255,.15)}.models-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow-y:auto;padding-left:4px}.model-detail-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid var(--rule)}.model-detail-title-wrap{display:flex;align-items:center;gap:8px;min-width:0}.model-detail-title{font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-detail-id-badge{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);background:var(--control);padding:2px 6px;border-radius:4px}.pricing-grid{display:grid;grid-template-columns:1fr;gap:0 10px;margin-bottom:12px}.features-row{display:flex;gap:20px;align-items:center;min-height:30px}.models-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:12px;padding:40px 0}.models-empty-icon{font-size:32px;line-height:1;opacity:.6}.footer{display:flex;align-items:center;gap:8px;padding:10px 18px;border-top:1px solid var(--rule);background:var(--control)}.status{flex:1;color:var(--muted);font-size:11px}.status.error{color:var(--error)}.status.success{color:var(--success)}.btn{min-height:32px;padding:6px 16px;font-size:13px}.primary{background:var(--primary);border-color:transparent;color:#fff}.danger{color:var(--error)}.tool:focus-visible,.btn:focus-visible,.tab:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:1px}input:read-only{opacity:.72}[data-reduce-motion=true] *{transition:none!important}
</style></head><body><div class="shell"><header class="nav"><div class="tabs" id="tabs" role="tablist"></div><div class="tools"><button class="tool" id="lang" data-i18n="lang" data-i18n-title="langTitle"></button><button class="tool" id="zoomOut">A-</button><button class="tool" id="zoomIn">A+</button><button class="tool" id="zoomReset">⟲</button></div></header><main class="content"><form id="form"><div class="section-head"><span class="section-title" data-i18n="providerSection"></span></div><div class="grid provider-grid"><div class="field"><label for="providerName" data-i18n="providerName"></label><input id="providerName" required></div><div class="field"><label for="providerId" data-i18n="providerId"></label><input id="providerId" readonly></div><div class="field"><label for="api" data-i18n="api"></label><select id="api"></select></div><div class="field"><label for="baseUrl" data-i18n="baseUrl"></label><input id="baseUrl" required></div><div class="field"><label for="apiKey" data-i18n="apiKey"></label><input id="apiKey" type="password" autocomplete="new-password" data-i18n-placeholder="apiKeyPlaceholder"></div><div class="field check"><input id="authHeader" type="checkbox"><label for="authHeader" data-i18n="authHeader"></label></div></div><button class="btn btn-sm danger" id="deleteProvider" type="button" data-i18n="deleteProviderTitle"></button><div class="section-head"><span class="section-title" data-i18n="modelSection"></span></div><div class="models-layout"><aside class="models-sidebar"><div class="models-sidebar-header"><span class="models-count" id="modelsCount"></span><button class="btn btn-sm" id="addModelBtn" type="button" data-i18n="addModel"></button></div><div class="models-list" id="modelsList" role="tablist"></div></aside><section class="models-detail" id="modelsDetail"></section></div></form></main><footer class="footer"><span class="status" id="status" role="status"></span><button class="btn" id="cancel" type="button" data-i18n="cancel"></button><button class="btn primary" id="save" type="submit" form="form" data-i18n="save"></button></footer></div><script>
const DATA=JSON.parse(${JSON.stringify(data)});let lang="zh",zoom=1,providerIndex=0,selectedModelIndex=0,busy=false;const text={zh:{title:"Pi 模型配置",lang:"EN",langTitle:"切换语言",providerSection:"Provider 配置",modelSection:"模型列表 (主从分栏)",providerName:"显示名称",providerId:"Provider ID",api:"API 类型",baseUrl:"Base URL",apiKey:"API Key",apiKeyPlaceholder:"留空以保留当前值",authHeader:"自动发送 Authorization",addModel:"添加模型",deleteModel:"删除模型",deleteConfirm:"确认删除模型「{name}」？此操作将在点击保存修改后生效。",deleteProviderConfirm:"确认删除当前 Provider「{name}」及其全部模型？此操作无法撤销。",addProviderPrompt:"新 Provider ID",addProviderTitle:"新增 Provider",deleteProviderTitle:"删除 Provider",confirmDelete:"再次点击确认",cancel:"取消",save:"保存修改",empty:"没有可用的 Provider",emptyModels:"当前 Provider 暂无模型，点击「添加模型」创建",modelCountLabel:"个模型",saved:"已保存",newModelTitle:"新模型",pName:"模型名称",pId:"模型 ID",pApi:"API 覆盖",pBaseUrl:"Base URL 覆盖",pContext:"上下文窗口",pMaxTokens:"最大输出 tokens",pCostInput:"输入价格/1M",pCostOutput:"输出价格/1M",pCostCacheRead:"读缓存/1M",pCostCacheWrite:"写缓存/1M",pReasoning:"支持 reasoning",pImage:"支持图片输入",zoomOutTitle:"缩小 (⌘-)",zoomInTitle:"放大 (⌘+)",zoomResetTitle:"重置缩放 (⌘0)",zoomStatus:"缩放"},en:{title:"Pi model configuration",lang:"中文",langTitle:"Switch language",providerSection:"Provider settings",modelSection:"Models (Master-Detail view)",providerName:"Display name",providerId:"Provider ID",api:"API type",baseUrl:"Base URL",apiKey:"API key",apiKeyPlaceholder:"Leave blank to keep current value",authHeader:"Send Authorization automatically",addModel:"Add model",deleteModel:"Delete model",deleteConfirm:"Delete model '{name}'? This change takes effect after saving.",deleteProviderConfirm:"Delete provider '{name}' and all of its models? This cannot be undone.",addProviderPrompt:"New provider ID",addProviderTitle:"Add provider",deleteProviderTitle:"Delete provider",confirmDelete:"Click again to confirm",cancel:"Cancel",save:"Save changes",empty:"No providers available",emptyModels:"No models in this provider. Click 'Add model' to create one.",modelCountLabel:"model(s)",saved:"Saved",newModelTitle:"New model",pName:"Model name",pId:"Model ID",pApi:"API override",pBaseUrl:"Base URL override",pContext:"Context window",pMaxTokens:"Max output tokens",pCostInput:"Input price/1M",pCostOutput:"Output price/1M",pCostCacheRead:"Cache read/1M",pCostCacheWrite:"Cache write/1M",pReasoning:"Supports reasoning",pImage:"Supports image input",zoomOutTitle:"Zoom out (⌘-)",zoomInTitle:"Zoom in (⌘+)",zoomResetTitle:"Reset zoom (⌘0)",zoomStatus:"Zoom"}};const el=id=>document.getElementById(id),t=key=>text[lang][key]??key;function applyText(){document.querySelectorAll("[data-i18n]").forEach(node=>node.textContent=t(node.dataset.i18n));document.querySelectorAll("[data-i18n-placeholder]").forEach(node=>node.placeholder=t(node.dataset.i18nPlaceholder));el("lang").title=t("langTitle");el("deleteProvider").title=t("deleteProviderTitle");el("zoomOut").title=t("zoomOutTitle");el("zoomIn").title=t("zoomInTitle");el("zoomReset").title=t("zoomResetTitle")+" ("+Math.round(zoom*100)+"%)"}function setPanelStatus(result){busy=false;render();const status=el("status");status.textContent=result.message;status.className="status"+(result.ok?" success":" error")}function applyProviders(payload){DATA.providers=payload.providers;providerIndex=Math.max(0,Math.min(payload.providerIndex??0,Math.max(0,DATA.providers.length-1)));selectedModelIndex=0;busy=false;render()}function selectOptions(select,values,empty){select.textContent="";if(empty){const first=document.createElement("option");first.value="";first.textContent=lang==="zh"?"使用 Provider 默认":"Use provider default";select.appendChild(first)}values.forEach(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option)})}function blankModel(){return{id:"",name:"",api:"",baseUrl:"",contextWindow:128000,maxTokens:16384,reasoning:false,imageInput:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}}function renderTabs(){const tabs=el("tabs");tabs.textContent="";DATA.providers.forEach((item,index)=>{const button=document.createElement("button");button.type="button";button.className="tab"+(index===providerIndex?" active":"");button.textContent=item.name||item.id;button.title=item.id;button.addEventListener("click",()=>{providerIndex=index;selectedModelIndex=0;render()});tabs.appendChild(button)});const add=document.createElement("button");add.type="button";add.className="tab";add.textContent="+";add.title=t("addProviderTitle");add.addEventListener("click",()=>{if(busy)return;const used=new Set(DATA.providers.map(item=>item.id));let id="provider",suffix=1;while(used.has(id)){id="provider-"+ ++suffix}lock();window.glimpse.send({action:"add-provider",id})});tabs.appendChild(add)}function createField(labelText,inputEl){const field=document.createElement("div");field.className="field";const label=document.createElement("label");label.textContent=labelText;label.setAttribute("for",inputEl.id||"");field.appendChild(label);field.appendChild(inputEl);return field}function createCheckField(labelText,inputEl){const field=document.createElement("div");field.className="field check";field.appendChild(inputEl);const label=document.createElement("label");label.textContent=labelText;label.setAttribute("for",inputEl.id||"");label.style.cursor="pointer";field.appendChild(label);return field}function syncActiveModel(provider){if(!provider||!provider.models[selectedModelIndex])return;const model=provider.models[selectedModelIndex];const nameIn=el("modelName"),idIn=el("modelId"),apiIn=el("modelApi"),baseIn=el("modelBaseUrl"),cwIn=el("modelCw"),mtIn=el("modelMt"),ciIn=el("modelCi"),coIn=el("modelCo"),crIn=el("modelCr"),cwkIn=el("modelCwk"),rIn=el("modelReasoning"),imgIn=el("modelImage");if(nameIn)model.name=nameIn.value;if(idIn)model.id=idIn.value;if(apiIn)model.api=apiIn.value;if(baseIn)model.baseUrl=baseIn.value;if(cwIn)model.contextWindow=Number(cwIn.value)||128000;if(mtIn)model.maxTokens=Number(mtIn.value)||16384;if(!model.cost)model.cost={input:0,output:0,cacheRead:0,cacheWrite:0};if(ciIn)model.cost.input=Number(ciIn.value)||0;if(coIn)model.cost.output=Number(coIn.value)||0;if(crIn)model.cost.cacheRead=Number(crIn.value)||0;if(cwkIn)model.cost.cacheWrite=Number(cwkIn.value)||0;if(rIn)model.reasoning=rIn.checked;if(imgIn)model.imageInput=imgIn.checked}function renderModelList(provider){const list=el("modelsList");list.textContent="";const countEl=el("modelsCount");if(!provider||provider.models.length===0){countEl.textContent="0 "+t("modelCountLabel");return}countEl.textContent=provider.models.length+" "+t("modelCountLabel");provider.models.forEach((m,idx)=>{const item=document.createElement("button");item.type="button";item.className="model-item"+(idx===selectedModelIndex?" active":"");item.id="modelItem_"+idx;const title=document.createElement("span");title.className="model-item-title";title.textContent=m.name||m.id||t("newModelTitle");const subId=document.createElement("span");subId.className="model-item-id";subId.textContent=m.id||"-";const badges=document.createElement("div");badges.className="model-item-badges";if(m.reasoning){const rBadge=document.createElement("span");rBadge.className="badge accent";rBadge.textContent="R";rBadge.title="Reasoning";badges.appendChild(rBadge)}if(m.imageInput){const vBadge=document.createElement("span");vBadge.className="badge";vBadge.textContent="IMG";vBadge.title="Image input";badges.appendChild(vBadge)}item.appendChild(title);item.appendChild(subId);if(badges.children.length>0)item.appendChild(badges);item.addEventListener("click",()=>{syncActiveModel(provider);selectedModelIndex=idx;renderModels(provider)});list.appendChild(item)})}function renderModelDetail(provider){const detail=el("modelsDetail");detail.textContent="";if(!provider||provider.models.length===0){const empty=document.createElement("div");empty.className="models-empty";const icon=document.createElement("div");icon.className="models-empty-icon";icon.textContent="✦";const msg=document.createElement("span");msg.textContent=t("emptyModels");const addBtn=document.createElement("button");addBtn.type="button";addBtn.className="btn btn-sm primary";addBtn.textContent=t("addModel");addBtn.addEventListener("click",()=>addModelAction(provider));empty.appendChild(icon);empty.appendChild(msg);empty.appendChild(addBtn);detail.appendChild(empty);return}const model=provider.models[selectedModelIndex];const header=document.createElement("div");header.className="model-detail-header";const titleWrap=document.createElement("div");titleWrap.className="model-detail-title-wrap";const title=document.createElement("span");title.className="model-detail-title";title.id="detailTitle";title.textContent=model.name||model.id||t("newModelTitle");const idBadge=document.createElement("span");idBadge.className="model-detail-id-badge";idBadge.id="detailIdBadge";idBadge.textContent=model.id||"-";titleWrap.appendChild(title);titleWrap.appendChild(idBadge);const delBtn=document.createElement("button");delBtn.type="button";delBtn.className="btn btn-sm danger";delBtn.textContent=t("deleteModel");delBtn.title=t("deleteModel");delBtn.addEventListener("click",()=>{const displayName=model.name||model.id||t("newModelTitle");const confirmMsg=t("deleteConfirm").replace("{name}",displayName);confirmTwice(delBtn,()=>{provider.models.splice(selectedModelIndex,1);selectedModelIndex=Math.max(0,Math.min(selectedModelIndex,provider.models.length-1));renderModels(provider)})});header.appendChild(titleWrap);header.appendChild(delBtn);detail.appendChild(header);const mainGrid=document.createElement("div");mainGrid.className="grid model-grid";const nameInput=document.createElement("input");nameInput.id="modelName";nameInput.value=model.name;nameInput.required=true;nameInput.addEventListener("input",e=>{model.name=e.target.value;const dTitle=el("detailTitle");if(dTitle)dTitle.textContent=model.name||model.id||t("newModelTitle");const itemTitle=document.querySelector("#modelItem_"+selectedModelIndex+" .model-item-title");if(itemTitle)itemTitle.textContent=model.name||model.id||t("newModelTitle")});mainGrid.appendChild(createField(t("pName"),nameInput));const idInput=document.createElement("input");idInput.id="modelId";idInput.value=model.id;idInput.required=true;idInput.addEventListener("input",e=>{model.id=e.target.value;const dBadge=el("detailIdBadge");if(dBadge)dBadge.textContent=model.id||"-";const itemId=document.querySelector("#modelItem_"+selectedModelIndex+" .model-item-id");if(itemId)itemId.textContent=model.id||"-";if(!model.name){const dTitle=el("detailTitle");if(dTitle)dTitle.textContent=model.id||t("newModelTitle");const itemTitle=document.querySelector("#modelItem_"+selectedModelIndex+" .model-item-title");if(itemTitle)itemTitle.textContent=model.id||t("newModelTitle")}});mainGrid.appendChild(createField(t("pId"),idInput));const apiSelect=document.createElement("select");apiSelect.id="modelApi";selectOptions(apiSelect,DATA.apiOptions,true);apiSelect.value=model.api||"";apiSelect.addEventListener("change",e=>{model.api=e.target.value});mainGrid.appendChild(createField(t("pApi"),apiSelect));const baseUrlInput=document.createElement("input");baseUrlInput.id="modelBaseUrl";baseUrlInput.value=model.baseUrl||"";baseUrlInput.placeholder=t("apiKeyPlaceholder");baseUrlInput.addEventListener("input",e=>{model.baseUrl=e.target.value});mainGrid.appendChild(createField(t("pBaseUrl"),baseUrlInput));const cwInput=document.createElement("input");cwInput.id="modelCw";cwInput.type="number";cwInput.min="1";cwInput.step="1";cwInput.value=String(model.contextWindow);cwInput.required=true;cwInput.addEventListener("input",e=>{model.contextWindow=Number(e.target.value)||128000});mainGrid.appendChild(createField(t("pContext"),cwInput));const mtInput=document.createElement("input");mtInput.id="modelMt";mtInput.type="number";mtInput.min="1";mtInput.step="1";mtInput.value=String(model.maxTokens);mtInput.required=true;mtInput.addEventListener("input",e=>{model.maxTokens=Number(e.target.value)||16384});mainGrid.appendChild(createField(t("pMaxTokens"),mtInput));detail.appendChild(mainGrid);const pricingGrid=document.createElement("div");pricingGrid.className="pricing-grid";const ciInput=document.createElement("input");ciInput.id="modelCi";ciInput.type="number";ciInput.min="0";ciInput.step="any";ciInput.value=String(model.cost?.input??0);ciInput.required=true;ciInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.input=Number(e.target.value)||0});pricingGrid.appendChild(createField(t("pCostInput"),ciInput));const coInput=document.createElement("input");coInput.id="modelCo";coInput.type="number";coInput.min="0";coInput.step="any";coInput.value=String(model.cost?.output??0);coInput.required=true;coInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.output=Number(e.target.value)||0});pricingGrid.appendChild(createField(t("pCostOutput"),coInput));const crInput=document.createElement("input");crInput.id="modelCr";crInput.type="number";crInput.min="0";crInput.step="any";crInput.value=String(model.cost?.cacheRead??0);crInput.required=true;crInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.cacheRead=Number(e.target.value)||0});pricingGrid.appendChild(createField(t("pCostCacheRead"),crInput));const cwkInput=document.createElement("input");cwkInput.id="modelCwk";cwkInput.type="number";cwkInput.min="0";cwkInput.step="any";cwkInput.value=String(model.cost?.cacheWrite??0);cwkInput.required=true;cwkInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.cacheWrite=Number(e.target.value)||0});pricingGrid.appendChild(createField(t("pCostCacheWrite"),cwkInput));detail.appendChild(pricingGrid);const featuresRow=document.createElement("div");featuresRow.className="features-row";const rInput=document.createElement("input");rInput.id="modelReasoning";rInput.type="checkbox";rInput.checked=Boolean(model.reasoning);rInput.addEventListener("change",e=>{model.reasoning=e.target.checked;renderModelList(provider)});featuresRow.appendChild(createCheckField(t("pReasoning"),rInput));const imgInput=document.createElement("input");imgInput.id="modelImage";imgInput.type="checkbox";imgInput.checked=Boolean(model.imageInput);imgInput.addEventListener("change",e=>{model.imageInput=e.target.checked;renderModelList(provider)});featuresRow.appendChild(createCheckField(t("pImage"),imgInput));detail.appendChild(featuresRow)}function renderModels(provider){renderModelList(provider);renderModelDetail(provider)}function addModelAction(provider){if(!provider)return;syncActiveModel(provider);provider.models.push(blankModel());selectedModelIndex=provider.models.length-1;renderModels(provider);const nameIn=el("modelName");if(nameIn)nameIn.focus()}function render(){const provider=DATA.providers[providerIndex];renderTabs();const hasProvider=Boolean(provider);["providerName","api","baseUrl"].forEach(id=>el(id).disabled=!hasProvider||busy);el("save").disabled=!hasProvider||busy;el("deleteProvider").disabled=!hasProvider||busy;el("addModelBtn").disabled=!hasProvider||busy;if(!hasProvider){el("status").textContent=t("empty");el("status").className="status";el("modelsList").textContent="";el("modelsDetail").textContent="";return}el("providerName").value=provider.name;el("providerId").value=provider.id;selectOptions(el("api"),DATA.apiOptions,false);el("api").value=provider.api;el("baseUrl").value=provider.baseUrl;el("apiKey").value="";el("authHeader").checked=provider.authHeader;renderModels(provider)}function collect(){const provider=DATA.providers[providerIndex];syncActiveModel(provider);const models=provider?provider.models.map(m=>({name:(m.name||"").trim(),id:(m.id||"").trim(),api:m.api||"",baseUrl:(m.baseUrl||"").trim(),contextWindow:Number(m.contextWindow)||128000,maxTokens:Number(m.maxTokens)||16384,costInput:Number(m.cost?.input??0),costOutput:Number(m.cost?.output??0),costCacheRead:Number(m.cost?.cacheRead??0),costCacheWrite:Number(m.cost?.cacheWrite??0),reasoning:Boolean(m.reasoning),imageInput:Boolean(m.imageInput)})):[];return{name:el("providerName").value.trim(),api:el("api").value,baseUrl:el("baseUrl").value.trim(),apiKey:el("apiKey").value,authHeader:el("authHeader").checked,models}}function lock(){busy=true;el("save").disabled=true;el("deleteProvider").disabled=true}function confirmTwice(button,action){if(button.dataset.confirming==="true"){clearTimeout(Number(button.dataset.confirmTimer));button.dataset.confirming="false";button.textContent=button.id==="deleteProvider"?t("deleteProviderTitle"):t("deleteModel");action();return}button.dataset.confirming="true";button.textContent=t("confirmDelete");button.dataset.confirmTimer=String(window.setTimeout(()=>{button.dataset.confirming="false";button.textContent=button.id==="deleteProvider"?t("deleteProviderTitle"):t("deleteModel")},3000))}function send(action){if(busy)return;lock();window.glimpse.send({action,providerIndex,values:collect()})}function setZoom(v){zoom=Math.min(1.5,Math.max(.8,Math.round(v*10)/10));document.body.style.zoom=String(zoom);const pct=Math.round(zoom*100)+"%";el("zoomReset").title=t("zoomResetTitle")+" ("+pct+")";const status=el("status");if(status){status.textContent=(t("zoomStatus")||"Zoom")+": "+pct;status.className="status"}}el("addModelBtn").addEventListener("click",()=>{if(busy)return;addModelAction(DATA.providers[providerIndex])});el("deleteProvider").addEventListener("click",()=>{if(busy||!DATA.providers[providerIndex])return;confirmTwice(el("deleteProvider"),()=>{lock();window.glimpse.send({action:"delete-provider",providerIndex})})});el("cancel").addEventListener("click",()=>window.glimpse.send({action:"cancel"}));el("form").addEventListener("submit",event=>{event.preventDefault();const provider=DATA.providers[providerIndex];if(provider){for(let i=0;i<provider.models.length;i++){const m=provider.models[i];if(!m.id||!m.id.trim()||!m.name||!m.name.trim()){selectedModelIndex=i;renderModels(provider);const targetField=(!m.name||!m.name.trim())?el("modelName"):el("modelId");if(targetField){targetField.focus();targetField.reportValidity()}return}}}if(el("form").reportValidity())send("save")});el("lang").addEventListener("click",()=>{lang=lang==="zh"?"en":"zh";applyText();render()});el("zoomOut").addEventListener("click",()=>setZoom(zoom-.1));el("zoomIn").addEventListener("click",()=>setZoom(zoom+.1));el("zoomReset").addEventListener("click",()=>setZoom(1));document.addEventListener("keydown",event=>{if(event.key==="Escape"){window.glimpse.send({action:"cancel"});return}const mod=event.metaKey||event.ctrlKey;if(mod&&(event.key==="+"||event.key==="=")){event.preventDefault();setZoom(zoom+.1)}else if(mod&&event.key==="-"){event.preventDefault();setZoom(zoom-.1)}else if(mod&&event.key==="0"){event.preventDefault();setZoom(1)}});applyText();render();
</script></body></html>`;
}
