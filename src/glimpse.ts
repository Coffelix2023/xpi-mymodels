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
:root{--surface:rgba(30,30,32,.85);--control:rgba(255,255,255,.07);--card-bg:rgba(255,255,255,.04);--input-bg:rgba(0,0,0,.22);--ink:#f2f2f4;--muted:#a3a3ad;--rule:rgba(255,255,255,.13);--primary:var(--sys-accent,#0a84ff);--error:#ff5f57;--success:#32d74b}[data-theme=light]{--surface:rgba(246,246,248,.92);--control:rgba(0,0,0,.05);--card-bg:rgba(0,0,0,.03);--input-bg:#ffffff;--ink:#222226;--muted:#676770;--rule:rgba(0,0,0,.13)}*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--surface);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}input,select{font:inherit;color:inherit}.shell{height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--surface)}.nav{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--rule)}.tabs{flex:1;display:flex;gap:4px;overflow-x:auto;min-width:0}.tab{border:1px solid transparent;background:transparent;color:var(--muted);border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap;font-size:13px;font-weight:500}.tab.active{background:var(--control);color:var(--ink);border-color:var(--rule);font-size:14px;font-weight:700}.tools{display:flex;gap:6px;flex-shrink:0}.tool,.btn{border:1px solid var(--rule);background:var(--control);color:var(--ink);border-radius:7px;cursor:pointer}.tool{width:28px;height:26px;font-size:11px}.content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 18px}.section-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding-bottom:6px;margin:6px 0 12px}.section-title{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-0.2px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.provider-grid{margin-bottom:16px}.field{margin-bottom:10px}.field label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.field input,.field select{width:100%;padding:6px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--input-bg)}.check{display:flex;align-items:center;gap:7px;min-height:30px}.check label{margin:0;color:var(--ink);font-size:12px}.models-deck{display:flex;gap:12px;overflow-x:auto;padding:4px 2px 14px 2px;align-items:stretch}.model-col{width:300px;min-width:300px;flex-shrink:0;border:1px solid var(--rule);border-radius:8px;background:var(--card-bg);padding:12px;display:flex;flex-direction:column;box-sizing:border-box}.model-col-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid var(--rule)}.model-col-title{font-size:13px;font-weight:700;color:var(--primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}.col-del{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0}.col-del:hover{background:rgba(255,95,87,.15);color:var(--error);border-color:var(--error)}.param-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;min-height:26px}.param-key{width:90px;flex-shrink:0;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.param-val{flex:1;min-width:0;padding:4px 7px;font-size:12px;color:var(--ink);background:var(--input-bg);border:1px solid var(--rule);border-radius:5px;box-sizing:border-box;outline:none}.param-val:focus{border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}.param-val[data-field=name]{font-weight:600}.check-val{display:flex;align-items:center;height:26px;flex:1;background:transparent;border:none}.check-val input{margin:0;cursor:pointer}.add-col{width:140px;min-width:140px;border:1px dashed var(--rule);border-radius:8px;cursor:pointer;background:transparent;display:flex;align-items:center;justify-content:center;transition:all .15s ease;flex-shrink:0}.add-col:hover{border-color:var(--primary);background:var(--control)}.add-col-inner{text-align:center;color:var(--muted)}.add-col:hover .add-col-inner{color:var(--primary)}.add-icon{font-size:26px;line-height:1;margin-bottom:4px}.add-text{font-size:12px;font-weight:600}.footer{display:flex;align-items:center;gap:8px;padding:10px 18px;border-top:1px solid var(--rule);background:var(--control)}.status{flex:1;color:var(--muted);font-size:11px}.status.error{color:var(--error)}.status.success{color:var(--success)}.btn{min-height:32px;padding:6px 16px;font-size:13px}.primary{background:var(--primary);border-color:transparent;color:#fff}.danger{color:var(--error)}.tool:focus-visible,.btn:focus-visible,.tab:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:1px}input:read-only{opacity:.72}[data-reduce-motion=true] *{transition:none!important}
</style></head><body><div class="shell"><header class="nav"><div class="tabs" id="tabs" role="tablist"></div><div class="tools"><button class="tool" id="addProvider" type="button">+</button><button class="tool danger" id="deleteProvider" type="button">-</button><button class="tool" id="lang" data-i18n="lang" data-i18n-title="langTitle"></button><button class="tool" id="zoomOut">A-</button><button class="tool" id="zoomIn">A+</button><button class="tool" id="zoomReset">⟲</button></div></header><main class="content"><form id="form"><div class="section-head"><span class="section-title" data-i18n="providerSection"></span></div><div class="grid provider-grid"><div class="field"><label for="providerName" data-i18n="providerName"></label><input id="providerName" required></div><div class="field"><label for="providerId" data-i18n="providerId"></label><input id="providerId" readonly></div><div class="field"><label for="api" data-i18n="api"></label><select id="api"></select></div><div class="field"><label for="baseUrl" data-i18n="baseUrl"></label><input id="baseUrl" required></div><div class="field"><label for="apiKey" data-i18n="apiKey"></label><input id="apiKey" type="password" autocomplete="new-password" data-i18n-placeholder="apiKeyPlaceholder"></div><div class="field check"><input id="authHeader" type="checkbox"><label for="authHeader" data-i18n="authHeader"></label></div></div><div class="section-head"><span class="section-title" data-i18n="modelSection"></span></div><div class="models-deck" id="modelsDeck"></div></form></main><footer class="footer"><span class="status" id="status" role="status"></span><button class="btn" id="cancel" type="button" data-i18n="cancel"></button><button class="btn primary" id="save" type="submit" form="form" data-i18n="save"></button></footer></div><script>
const DATA=JSON.parse(${JSON.stringify(data)});let lang="zh",zoom=1,providerIndex=0,busy=false;const text={zh:{title:"Pi 模型配置",lang:"EN",langTitle:"切换语言",providerSection:"Provider 配置",modelSection:"模型列表 (分栏配置)",providerName:"显示名称",providerId:"Provider ID",api:"API 类型",baseUrl:"Base URL",apiKey:"API Key",apiKeyPlaceholder:"留空以保留当前值",authHeader:"自动发送 Authorization",addModel:"添加模型",deleteModel:"删除模型",deleteConfirm:"确认删除该模型？",deleteProviderConfirm:"确认删除当前 Provider 及其全部模型？",addProviderPrompt:"新 Provider ID",addProviderTitle:"新增 Provider",deleteProviderTitle:"删除 Provider",cancel:"取消",save:"保存修改",empty:"没有可用的 Provider",saved:"已保存",newModelTitle:"新模型",pName:"模型名称",pId:"模型 ID",pApi:"API 覆盖",pBaseUrl:"Base URL 覆盖",pContext:"上下文窗口",pMaxTokens:"最大输出 tokens",pCostInput:"输入价格/1M",pCostOutput:"输出价格/1M",pCostCacheRead:"读缓存/1M",pCostCacheWrite:"写缓存/1M",pReasoning:"支持 reasoning",pImage:"支持图片输入"},en:{title:"Pi model configuration",lang:"中文",langTitle:"Switch language",providerSection:"Provider settings",modelSection:"Models (column view)",providerName:"Display name",providerId:"Provider ID",api:"API type",baseUrl:"Base URL",apiKey:"API key",apiKeyPlaceholder:"Leave blank to keep current value",authHeader:"Send Authorization automatically",addModel:"Add model",deleteModel:"Delete model",deleteConfirm:"Delete this model?",deleteProviderConfirm:"Delete this provider and all of its models?",addProviderPrompt:"New provider ID",addProviderTitle:"Add provider",deleteProviderTitle:"Delete provider",cancel:"Cancel",save:"Save changes",empty:"No providers available",saved:"Saved",newModelTitle:"New model",pName:"Model name",pId:"Model ID",pApi:"API override",pBaseUrl:"Base URL override",pContext:"Context window",pMaxTokens:"Max output tokens",pCostInput:"Input price/1M",pCostOutput:"Output price/1M",pCostCacheRead:"Cache read/1M",pCostCacheWrite:"Cache write/1M",pReasoning:"Supports reasoning",pImage:"Supports image input"}};const el=id=>document.getElementById(id),t=key=>text[lang][key]??key;function applyText(){document.querySelectorAll("[data-i18n]").forEach(node=>node.textContent=t(node.dataset.i18n));document.querySelectorAll("[data-i18n-placeholder]").forEach(node=>node.placeholder=t(node.dataset.i18nPlaceholder));el("lang").title=t("langTitle");el("addProvider").title=t("addProviderTitle");el("deleteProvider").title=t("deleteProviderTitle")}function setPanelStatus(result){busy=false;render();const status=el("status");status.textContent=result.message;status.className="status"+(result.ok?" success":" error")}function applyProviders(payload){DATA.providers=payload.providers;providerIndex=Math.max(0,Math.min(payload.providerIndex??0,Math.max(0,DATA.providers.length-1)));busy=false;render()}function selectOptions(select,values,empty){select.textContent="";if(empty){const first=document.createElement("option");first.value="";first.textContent=lang==="zh"?"使用 Provider 默认":"Use provider default";select.appendChild(first)}values.forEach(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option)})}function blankModel(){return{id:"",name:"",api:"",baseUrl:"",contextWindow:128000,maxTokens:16384,reasoning:false,imageInput:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}}function renderTabs(){const tabs=el("tabs");tabs.textContent="";DATA.providers.forEach((item,index)=>{const button=document.createElement("button");button.type="button";button.className="tab"+(index===providerIndex?" active":"");button.textContent=item.name||item.id;button.title=item.id;button.addEventListener("click",()=>{providerIndex=index;render()});tabs.appendChild(button)})}function createParamRow(keyText,inputEl,isCheck){const row=document.createElement("div");row.className="param-row"+(isCheck?" check-row":"");const label=document.createElement("span");label.className="param-key";label.textContent=keyText;label.title=keyText;row.appendChild(label);row.appendChild(inputEl);return row}function renderModels(provider){const deck=el("modelsDeck");deck.textContent="";if(!provider)return;provider.models.forEach((model,mIdx)=>{const col=document.createElement("div");col.className="model-col";col.dataset.index=String(mIdx);const header=document.createElement("div");header.className="model-col-header";const title=document.createElement("span");title.className="model-col-title";title.textContent=model.name||model.id||t("newModelTitle");title.title=title.textContent;const delBtn=document.createElement("button");delBtn.type="button";delBtn.className="col-del";delBtn.textContent="×";delBtn.title=t("deleteModel");delBtn.addEventListener("click",()=>{if(window.confirm(t("deleteConfirm"))){provider.models.splice(mIdx,1);renderModels(provider)}});header.appendChild(title);header.appendChild(delBtn);col.appendChild(header);const nameInput=document.createElement("input");nameInput.className="param-val";nameInput.dataset.field="name";nameInput.value=model.name;nameInput.required=true;nameInput.addEventListener("input",e=>{model.name=e.target.value;title.textContent=model.name||model.id||t("newModelTitle");title.title=title.textContent});col.appendChild(createParamRow(t("pName"),nameInput,false));const idInput=document.createElement("input");idInput.className="param-val";idInput.dataset.field="id";idInput.value=model.id;idInput.required=true;idInput.addEventListener("input",e=>{model.id=e.target.value;if(!model.name){title.textContent=model.id||t("newModelTitle");title.title=title.textContent}});col.appendChild(createParamRow(t("pId"),idInput,false));const apiSelect=document.createElement("select");apiSelect.className="param-val";apiSelect.dataset.field="api";selectOptions(apiSelect,DATA.apiOptions,true);apiSelect.value=model.api||"";apiSelect.addEventListener("change",e=>{model.api=e.target.value});col.appendChild(createParamRow(t("pApi"),apiSelect,false));const baseUrlInput=document.createElement("input");baseUrlInput.className="param-val";baseUrlInput.dataset.field="baseUrl";baseUrlInput.value=model.baseUrl||"";baseUrlInput.placeholder=t("apiKeyPlaceholder");baseUrlInput.addEventListener("input",e=>{model.baseUrl=e.target.value});col.appendChild(createParamRow(t("pBaseUrl"),baseUrlInput,false));const cwInput=document.createElement("input");cwInput.className="param-val";cwInput.type="number";cwInput.min="1";cwInput.step="1";cwInput.dataset.field="contextWindow";cwInput.value=String(model.contextWindow);cwInput.required=true;cwInput.addEventListener("input",e=>{model.contextWindow=Number(e.target.value)});col.appendChild(createParamRow(t("pContext"),cwInput,false));const mtInput=document.createElement("input");mtInput.className="param-val";mtInput.type="number";mtInput.min="1";mtInput.step="1";mtInput.dataset.field="maxTokens";mtInput.value=String(model.maxTokens);mtInput.required=true;mtInput.addEventListener("input",e=>{model.maxTokens=Number(e.target.value)});col.appendChild(createParamRow(t("pMaxTokens"),mtInput,false));const ciInput=document.createElement("input");ciInput.className="param-val";ciInput.type="number";ciInput.min="0";ciInput.step="any";ciInput.dataset.field="costInput";ciInput.value=String(model.cost?.input??0);ciInput.required=true;ciInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.input=Number(e.target.value)});col.appendChild(createParamRow(t("pCostInput"),ciInput,false));const coInput=document.createElement("input");coInput.className="param-val";coInput.type="number";coInput.min="0";coInput.step="any";coInput.dataset.field="costOutput";coInput.value=String(model.cost?.output??0);coInput.required=true;coInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.output=Number(e.target.value)});col.appendChild(createParamRow(t("pCostOutput"),coInput,false));const crInput=document.createElement("input");crInput.className="param-val";crInput.type="number";crInput.min="0";crInput.step="any";crInput.dataset.field="costCacheRead";crInput.value=String(model.cost?.cacheRead??0);crInput.required=true;crInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.cacheRead=Number(e.target.value)});col.appendChild(createParamRow(t("pCostCacheRead"),crInput,false));const cwkInput=document.createElement("input");cwkInput.className="param-val";cwkInput.type="number";cwkInput.min="0";cwkInput.step="any";cwkInput.dataset.field="costCacheWrite";cwkInput.value=String(model.cost?.cacheWrite??0);cwkInput.required=true;cwkInput.addEventListener("input",e=>{if(!model.cost)model.cost={};model.cost.cacheWrite=Number(e.target.value)});col.appendChild(createParamRow(t("pCostCacheWrite"),cwkInput,false));const rWrap=document.createElement("div");rWrap.className="check-val";const rInput=document.createElement("input");rInput.type="checkbox";rInput.dataset.field="reasoning";rInput.checked=Boolean(model.reasoning);rInput.addEventListener("change",e=>{model.reasoning=e.target.checked});rWrap.appendChild(rInput);col.appendChild(createParamRow(t("pReasoning"),rWrap,true));const imgWrap=document.createElement("div");imgWrap.className="check-val";const imgInput=document.createElement("input");imgInput.type="checkbox";imgInput.dataset.field="imageInput";imgInput.checked=Boolean(model.imageInput);imgInput.addEventListener("change",e=>{model.imageInput=e.target.checked});imgWrap.appendChild(imgInput);col.appendChild(createParamRow(t("pImage"),imgWrap,true));deck.appendChild(col)});const addCard=document.createElement("div");addCard.className="model-col add-col";addCard.id="addModelCard";addCard.setAttribute("role","button");addCard.setAttribute("tabindex","0");const addInner=document.createElement("div");addInner.className="add-col-inner";const addIcon=document.createElement("div");addIcon.className="add-icon";addIcon.textContent="+";const addLabel=document.createElement("div");addLabel.className="add-text";addLabel.textContent=t("addModel");addInner.appendChild(addIcon);addInner.appendChild(addLabel);addCard.appendChild(addInner);addCard.addEventListener("click",()=>{provider.models.push(blankModel());renderModels(provider);const newCol=deck.querySelector(".model-col:nth-last-child(2)");if(newCol){newCol.scrollIntoView({behavior:"smooth",inline:"nearest"});const firstInput=newCol.querySelector("input");if(firstInput)firstInput.focus()}});addCard.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();addCard.click()}});deck.appendChild(addCard)}function render(){const provider=DATA.providers[providerIndex];renderTabs();const hasProvider=Boolean(provider);["providerName","api","baseUrl"].forEach(id=>el(id).disabled=!hasProvider||busy);el("save").disabled=!hasProvider||busy;el("addProvider").disabled=busy;el("deleteProvider").disabled=!hasProvider||busy;if(!hasProvider){el("status").textContent=t("empty");el("status").className="status";el("modelsDeck").textContent="";return}el("providerName").value=provider.name;el("providerId").value=provider.id;selectOptions(el("api"),DATA.apiOptions,false);el("api").value=provider.api;el("baseUrl").value=provider.baseUrl;el("apiKey").value="";el("authHeader").checked=provider.authHeader;renderModels(provider)}function collect(){const cols=document.querySelectorAll("#modelsDeck .model-col:not(.add-col)");const models=[];cols.forEach(col=>{const get=name=>col.querySelector("[data-field='" + name + "']");models.push({name:get("name").value.trim(),id:get("id").value.trim(),api:get("api").value,baseUrl:get("baseUrl").value.trim(),contextWindow:Number(get("contextWindow").value),maxTokens:Number(get("maxTokens").value),costInput:Number(get("costInput").value),costOutput:Number(get("costOutput").value),costCacheRead:Number(get("costCacheRead").value),costCacheWrite:Number(get("costCacheWrite").value),reasoning:get("reasoning").checked,imageInput:get("imageInput").checked})});return{name:el("providerName").value.trim(),api:el("api").value,baseUrl:el("baseUrl").value.trim(),apiKey:el("apiKey").value,authHeader:el("authHeader").checked,models}}function lock(){busy=true;el("save").disabled=true;el("addProvider").disabled=true;el("deleteProvider").disabled=true}function send(action){if(busy)return;lock();window.glimpse.send({action,providerIndex,values:collect()})}el("addProvider").addEventListener("click",()=>{if(busy)return;const id=window.prompt(t("addProviderPrompt"));if(!id||!id.trim())return;lock();window.glimpse.send({action:"add-provider",id:id.trim()})});el("deleteProvider").addEventListener("click",()=>{if(busy||!DATA.providers[providerIndex])return;if(!window.confirm(t("deleteProviderConfirm")))return;lock();window.glimpse.send({action:"delete-provider",providerIndex})});el("cancel").addEventListener("click",()=>window.glimpse.send({action:"cancel"}));el("form").addEventListener("submit",event=>{event.preventDefault();if(el("form").reportValidity())send("save")});el("lang").addEventListener("click",()=>{lang=lang==="zh"?"en":"zh";applyText();render()});el("zoomOut").addEventListener("click",()=>{zoom=Math.max(.8,zoom-.1);document.body.style.zoom=zoom});el("zoomIn").addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);document.body.style.zoom=zoom});el("zoomReset").addEventListener("click",()=>{zoom=1;document.body.style.zoom=zoom});document.addEventListener("keydown",event=>{if(event.key==="Escape")window.glimpse.send({action:"cancel"})});applyText();render();
</script></body></html>`;
}
