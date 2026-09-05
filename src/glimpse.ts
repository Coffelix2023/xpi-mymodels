import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ApiName,
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
  frameless: boolean;
  height: number;
  title: string;
  transparent: boolean;
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

interface PanelValues {
  api: unknown;
  apiKey: unknown;
  authHeader: unknown;
  baseUrl: unknown;
  contextWindow: unknown;
  costCacheRead: unknown;
  costCacheWrite: unknown;
  costInput: unknown;
  costOutput: unknown;
  imageInput: unknown;
  maxTokens: unknown;
  modelApi: unknown;
  modelBaseUrl: unknown;
  modelId: unknown;
  modelName: unknown;
  name: unknown;
  reasoning: unknown;
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
    frameless: true,
    height: 640,
    title: "Pi model configuration",
    transparent: true,
    width: 560,
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
  const modelIndex = indexValue(message.modelIndex, "model");
  const currentProvider = providers[providerIndex];
  const currentModel = currentProvider?.models[modelIndex];
  const adding = message.mode === "add";
  if (!currentProvider || (!adding && !currentModel))
    throw new Error("The selected Pi model no longer exists");
  if (!isObject(message.values))
    throw new Error("The Glimpse form returned invalid values");

  // SAFETY: the enclosing isObject check confirms a JSON object; every field is validated below before use.
  const values = message.values as unknown as PanelValues;
  const nextProvider = {
    ...currentProvider,
    api: apiValue(values.api, "provider API"),
    apiKey: secretValue(values.apiKey, currentProvider.apiKey),
    authHeader: booleanValue(values.authHeader, "authorization header"),
    baseUrl: nonEmptyString(values.baseUrl, "provider base URL"),
    name: nonEmptyString(values.name, "provider name"),
  } satisfies ProviderDraft;
  const nextModel = modelFromValues(values, currentModel ?? defaultModel());

  if (!adding && currentModel) {
    preserveRenamedModelFields(
      models,
      currentProvider.id,
      currentModel.id,
      nextModel.id,
      modelIndex,
    );
  }
  if (adding) {
    nextProvider.models = [
      ...currentProvider.models,
      nextModel,
    ];
  } else {
    nextProvider.models = currentProvider.models.map((model, index) =>
      index === modelIndex ? nextModel : model,
    );
  }
  upsertProvider(models, nextProvider);
  if (!adding && currentModel) {
    updateEnabledModelReference(
      settings,
      modelReference(currentProvider.id, currentModel.id),
      modelReference(currentProvider.id, nextModel.id),
    );
  }
}

function modelFromValues(values: PanelValues, base: ModelDraft): ModelDraft {
  return {
    ...base,
    api: optionalApiValue(values.modelApi, "model API override"),
    baseUrl: optionalString(values.modelBaseUrl, "model base URL override"),
    contextWindow: positiveNumber(values.contextWindow, "context window"),
    id: nonEmptyString(values.modelId, "model id"),
    input: booleanValue(values.imageInput, "image input")
      ? [
          "text",
          "image",
        ]
      : [
          "text",
        ],
    maxTokens: positiveNumber(values.maxTokens, "max output tokens"),
    name: nonEmptyString(values.modelName, "model name"),
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

function sendStatus(window: GlimpseWindow, ok: boolean, message: string): void {
  window.send(
    `window.setPanelStatus(${JSON.stringify({
      ok,
      message,
    })})`,
  );
}

function panelHtml(providers: ProviderDraft[]): string {
  const safeProviders = providers.map((provider) => ({
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
  const data = JSON.stringify({
    apiOptions: API_OPTIONS,
    providers: safeProviders,
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--surface:rgba(30,30,32,.82);--control:rgba(255,255,255,.07);--ink:#f2f2f4;--muted:#a3a3ad;--rule:rgba(255,255,255,.13);--primary:var(--sys-accent,#0a84ff);--error:#ff5f57;--success:#32d74b}[data-theme=light]{--surface:rgba(246,246,248,.9);--control:rgba(0,0,0,.05);--ink:#222226;--muted:#676770;--rule:rgba(0,0,0,.13)}*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:transparent!important;color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}input,select{font:inherit;color:inherit}.shell{height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--surface);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);border:1px solid var(--rule);border-radius:14px}.titlebar{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--rule)}h1{font-size:14px;margin:0;font-weight:650;flex:1}.tools{display:flex;gap:6px}.tool,.btn{border:1px solid var(--rule);background:var(--control);color:var(--ink);border-radius:7px;cursor:pointer}.tool{width:28px;height:24px}.content{flex:1;min-height:0;overflow:auto;padding:18px 20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.field{margin-bottom:12px}.wide{grid-column:1/-1}.field label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.field input,.field select{width:100%;padding:7px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--control)}.check{display:flex;align-items:center;gap:7px;min-height:32px}.check label{margin:0;color:var(--ink);font-size:13px}.section{font-size:11px;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:5px;margin:8px 0 12px}.footer{display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:1px solid var(--rule);background:var(--control)}.status{flex:1;color:var(--muted);font-size:11px}.status.error{color:var(--error)}.status.success{color:var(--success)}.btn{min-height:32px;padding:7px 15px}.primary{background:var(--primary);border-color:transparent;color:#fff}.danger{color:var(--error)}.tool:focus-visible,.btn:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:1px}input:read-only{opacity:.72}[data-reduce-motion=true] *{transition:none!important}
</style></head><body><div class="shell"><header class="titlebar"><h1 data-i18n="title"></h1><div class="tools"><button class="tool" id="lang" data-i18n="lang" data-i18n-title="langTitle"></button><button class="tool" id="zoomOut">A−</button><button class="tool" id="zoomIn">A+</button><button class="tool" id="zoomReset">⟲</button></div></header><main class="content"><form id="form"><div class="field wide"><label for="provider" data-i18n="provider"></label><select id="provider"></select></div><div class="field wide"><label for="model" data-i18n="model"></label><select id="model"></select></div><div class="section wide" data-i18n="providerSection"></div><div class="grid"><div class="field"><label for="providerName" data-i18n="providerName"></label><input id="providerName" required></div><div class="field"><label for="providerId" data-i18n="providerId"></label><input id="providerId" readonly></div><div class="field"><label for="api" data-i18n="api"></label><select id="api"></select></div><div class="field"><label for="baseUrl" data-i18n="baseUrl"></label><input id="baseUrl" required></div><div class="field"><label for="apiKey" data-i18n="apiKey"></label><input id="apiKey" type="password" autocomplete="new-password" data-i18n-placeholder="apiKeyPlaceholder"></div><div class="field check"><input id="authHeader" type="checkbox"><label for="authHeader" data-i18n="authHeader"></label></div></div><div class="section wide" data-i18n="modelSection"></div><div class="grid"><div class="field"><label for="modelName" data-i18n="modelName"></label><input id="modelName" required></div><div class="field"><label for="modelId" data-i18n="modelId"></label><input id="modelId" required></div><div class="field"><label for="modelApi" data-i18n="modelApi"></label><select id="modelApi"></select></div><div class="field"><label for="modelBaseUrl" data-i18n="modelBaseUrl"></label><input id="modelBaseUrl"></div><div class="field"><label for="contextWindow" data-i18n="contextWindow"></label><input id="contextWindow" type="number" min="1" step="1" required></div><div class="field"><label for="maxTokens" data-i18n="maxTokens"></label><input id="maxTokens" type="number" min="1" step="1" required></div><div class="field check"><input id="reasoning" type="checkbox"><label for="reasoning" data-i18n="reasoning"></label></div><div class="field check"><input id="imageInput" type="checkbox"><label for="imageInput" data-i18n="imageInput"></label></div><div class="field"><label for="costInput" data-i18n="costInput"></label><input id="costInput" type="number" min="0" step="any" required></div><div class="field"><label for="costOutput" data-i18n="costOutput"></label><input id="costOutput" type="number" min="0" step="any" required></div><div class="field"><label for="costCacheRead" data-i18n="costCacheRead"></label><input id="costCacheRead" type="number" min="0" step="any" required></div><div class="field"><label for="costCacheWrite" data-i18n="costCacheWrite"></label><input id="costCacheWrite" type="number" min="0" step="any" required></div></div></form></main><footer class="footer"><span class="status" id="status" role="status"></span><button class="btn" id="add" type="button" data-i18n="add"></button><button class="btn danger" id="delete" type="button" data-i18n="delete"></button><button class="btn" id="cancel" type="button" data-i18n="cancel"></button><button class="btn primary" id="save" type="submit" form="form" data-i18n="save"></button></footer></div><script>
const DATA=JSON.parse(${JSON.stringify(data)});let lang="zh",zoom=1,providerIndex=0,modelIndex=0,mode="edit",busy=false,draft=null;const text={zh:{title:"Pi 模型配置",lang:"EN",langTitle:"切换语言",provider:"Provider",model:"Model",providerSection:"Provider",modelSection:"Model",providerName:"显示名称",providerId:"Provider ID",api:"API 类型",baseUrl:"Base URL",apiKey:"API Key",apiKeyPlaceholder:"留空以保留当前值",authHeader:"自动发送 Authorization",modelName:"模型名称",modelId:"模型 ID",modelApi:"模型 API 覆盖",modelBaseUrl:"模型 Base URL 覆盖",contextWindow:"上下文窗口",maxTokens:"最大输出 tokens",reasoning:"支持 reasoning",imageInput:"支持图片输入",costInput:"输入价格 / 1M tokens",costOutput:"输出价格 / 1M tokens",costCacheRead:"缓存读取价格 / 1M tokens",costCacheWrite:"缓存写入价格 / 1M tokens",add:"添加模型",delete:"删除模型",cancel:"取消",save:"保存",empty:"没有可用的 Provider",deleteConfirm:"确认删除当前模型？",added:"新模型草稿",saved:"已保存"},en:{title:"Pi model configuration",lang:"中文",langTitle:"Switch language",provider:"Provider",model:"Model",providerSection:"Provider",modelSection:"Model",providerName:"Display name",providerId:"Provider ID",api:"API type",baseUrl:"Base URL",apiKey:"API key",apiKeyPlaceholder:"Leave blank to keep current value",authHeader:"Send Authorization automatically",modelName:"Model name",modelId:"Model ID",modelApi:"Model API override",modelBaseUrl:"Model Base URL override",contextWindow:"Context window",maxTokens:"Max output tokens",reasoning:"Supports reasoning",imageInput:"Supports image input",costInput:"Input price / 1M tokens",costOutput:"Output price / 1M tokens",costCacheRead:"Cache read price / 1M tokens",costCacheWrite:"Cache write price / 1M tokens",add:"Add model",delete:"Delete model",cancel:"Cancel",save:"Save",empty:"No providers available",deleteConfirm:"Delete the current model?",added:"New model draft",saved:"Saved"}};const el=id=>document.getElementById(id),t=key=>text[lang][key]??key;function applyText(){document.querySelectorAll("[data-i18n]").forEach(node=>node.textContent=t(node.dataset.i18n));document.querySelectorAll("[data-i18n-placeholder]").forEach(node=>node.placeholder=t(node.dataset.i18nPlaceholder));el("lang").title=t("langTitle")}function setPanelStatus(result){busy=false;el("save").disabled=false;el("add").disabled=DATA.providers.length===0;el("delete").disabled=mode==="add"||DATA.providers.length===0;const status=el("status");status.textContent=result.message;status.className="status"+(result.ok?" success":" error")}function selectOptions(select,values,empty){select.textContent="";if(empty){const first=document.createElement("option");first.value="";first.textContent=lang==="zh"?"使用 Provider 默认":"Use provider default";select.appendChild(first)}values.forEach(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option)})}function blankModel(){return{id:"",name:"",api:"",baseUrl:"",contextWindow:128000,maxTokens:16384,reasoning:false,imageInput:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}}function currentModel(){return mode==="add"?draft:DATA.providers[providerIndex]?.models[modelIndex]}function render(){const provider=DATA.providers[providerIndex];selectOptions(el("provider"),DATA.providers.map(item=>item.name+" ("+item.id+")"),false);el("provider").selectedIndex=provider?providerIndex:-1;selectOptions(el("model"),provider?provider.models.map(item=>item.name+" ("+item.id+")"):[],false);el("model").selectedIndex=mode==="add"?-1:modelIndex;const model=currentModel();const disabled=!provider||!model;["providerName","api","baseUrl","modelName","modelId","modelApi","modelBaseUrl","contextWindow","maxTokens","costInput","costOutput","costCacheRead","costCacheWrite"].forEach(id=>el(id).disabled=disabled);el("save").disabled=disabled||busy;el("delete").disabled=disabled||mode==="add"||busy;el("add").disabled=!provider||busy;if(!provider||!model){el("status").textContent=t("empty");return}el("providerName").value=provider.name;el("providerId").value=provider.id;selectOptions(el("api"),DATA.apiOptions,false);el("api").value=provider.api;el("baseUrl").value=provider.baseUrl;el("apiKey").value="";el("authHeader").checked=provider.authHeader;el("modelName").value=model.name;el("modelId").value=model.id;selectOptions(el("modelApi"),DATA.apiOptions,true);el("modelApi").value=model.api;el("modelBaseUrl").value=model.baseUrl;el("contextWindow").value=String(model.contextWindow);el("maxTokens").value=String(model.maxTokens);el("reasoning").checked=model.reasoning;el("imageInput").checked=model.imageInput;el("costInput").value=String(model.cost.input);el("costOutput").value=String(model.cost.output);el("costCacheRead").value=String(model.cost.cacheRead);el("costCacheWrite").value=String(model.cost.cacheWrite);if(mode==="add")el("status").textContent=t("added")}function collect(){return{api:el("api").value,apiKey:el("apiKey").value,authHeader:el("authHeader").checked,baseUrl:el("baseUrl").value,contextWindow:Number(el("contextWindow").value),costCacheRead:Number(el("costCacheRead").value),costCacheWrite:Number(el("costCacheWrite").value),costInput:Number(el("costInput").value),costOutput:Number(el("costOutput").value),imageInput:el("imageInput").checked,maxTokens:Number(el("maxTokens").value),modelApi:el("modelApi").value,modelBaseUrl:el("modelBaseUrl").value,modelId:el("modelId").value,modelName:el("modelName").value,name:el("providerName").value,reasoning:el("reasoning").checked}}function send(action){if(busy)return;busy=true;el("save").disabled=true;el("add").disabled=true;el("delete").disabled=true;window.glimpse.send({action,mode,providerIndex,modelIndex,values:collect()})}el("provider").addEventListener("change",event=>{providerIndex=event.target.selectedIndex;modelIndex=0;mode="edit";draft=null;render()});el("model").addEventListener("change",event=>{modelIndex=event.target.selectedIndex;mode="edit";draft=null;render()});el("add").addEventListener("click",()=>{if(!DATA.providers[providerIndex])return;mode="add";draft=blankModel();render()});el("delete").addEventListener("click",()=>{if(mode!=="add"&&window.confirm(t("deleteConfirm")))send("delete")});el("cancel").addEventListener("click",()=>window.glimpse.send({action:"cancel"}));el("form").addEventListener("submit",event=>{event.preventDefault();if(el("form").reportValidity())send("save")});el("lang").addEventListener("click",()=>{lang=lang==="zh"?"en":"zh";applyText();render()});el("zoomOut").addEventListener("click",()=>{zoom=Math.max(.8,zoom-.1);document.body.style.zoom=zoom});el("zoomIn").addEventListener("click",()=>{zoom=Math.min(1.5,zoom+.1);document.body.style.zoom=zoom});el("zoomReset").addEventListener("click",()=>{zoom=1;document.body.style.zoom=zoom});document.addEventListener("keydown",event=>{if(event.key==="Escape")window.glimpse.send({action:"cancel"})});applyText();render();
</script></body></html>`;
}
