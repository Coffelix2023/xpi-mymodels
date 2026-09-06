import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Currency = "USD" | "CNY";
export type ApiName =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type InputCapability = "text" | "image";
const INPUT_CAPABILITIES: readonly InputCapability[] = [
  "text",
  "image",
];
export interface CostRates {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

export interface ModelDraft {
  compat?: JsonObject;
  contextWindow: number;
  cost: CostRates;
  headers?: Record<string, string>;
  id: string;
  input: InputCapability[];
  maxTokens: number;
  name: string;
  reasoning: boolean;
  samplingParams?: JsonObject;
  thinkingLevelMap?: JsonObject;
}

export interface ProviderDraft {
  api: ApiName;
  apiKey: string;
  authHeader: boolean;
  baseUrl: string;
  compat?: JsonObject;
  headers?: Record<string, string>;
  id: string;
  models: ModelDraft[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_COST: CostRates = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T extends JsonValue>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function parseJsonc(text: string): JsonValue {
  const withoutComments = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
    match.startsWith('"') ? match : "",
  );
  const withoutTrailingCommas = withoutComments.replace(
    /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
    (match, tail: string) => tail ?? (match.startsWith('"') ? match : ""),
  );
  try {
    return JSON.parse(withoutTrailingCommas) as JsonValue;
  } catch (error) {
    throw new Error(
      `Invalid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readJsonc(path: string): Promise<JsonObject> {
  try {
    const text = await readFile(path, "utf8");
    const value = parseJsonc(text);
    if (!isObject(value)) throw new Error("root must be an object");
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateModelsConfig(value: JsonObject): string[] {
  const errors: string[] = [];
  const providers = value.providers;
  if (providers === undefined) return [];
  if (!isObject(providers))
    return [
      "providers must be an object",
    ];

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isObject(rawProvider)) {
      errors.push(`providers.${providerId} must be an object`);
      continue;
    }
    if (rawProvider.baseUrl !== undefined && !isNonEmptyString(rawProvider.baseUrl)) {
      errors.push(`providers.${providerId}.baseUrl must be a non-empty string`);
    }
    if (rawProvider.api !== undefined && !isNonEmptyString(rawProvider.api)) {
      errors.push(`providers.${providerId}.api must be a non-empty string`);
    }
    if (rawProvider.models !== undefined) {
      if (!Array.isArray(rawProvider.models)) {
        errors.push(`providers.${providerId}.models must be an array`);
      } else {
        const modelIds = new Set<string>();
        rawProvider.models.forEach((model, index) => {
          validateModel(model, `providers.${providerId}.models.${index}`, errors);
          if (!isObject(model) || !isNonEmptyString(model.id)) return;
          if (modelIds.has(model.id)) {
            errors.push(
              `providers.${providerId}.models.${index}.id must be unique within provider`,
            );
          } else {
            modelIds.add(model.id);
          }
        });
      }
    }
    validateHeaders(rawProvider.headers, `providers.${providerId}.headers`, errors);
  }
  return errors;
}

function validateModel(value: JsonValue, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string`);
  if (value.name !== undefined && !isNonEmptyString(value.name))
    errors.push(`${path}.name must be a non-empty string`);
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean")
    errors.push(`${path}.reasoning must be boolean`);
  if (value.contextWindow !== undefined && !isPositiveNumber(value.contextWindow)) {
    errors.push(`${path}.contextWindow must be a positive number`);
  }
  if (value.maxTokens !== undefined && !isPositiveNumber(value.maxTokens)) {
    errors.push(`${path}.maxTokens must be a positive number`);
  }
  if (
    value.input !== undefined &&
    (!Array.isArray(value.input) ||
      value.input.some((item) => !isInputCapability(item)))
  ) {
    errors.push(`${path}.input must contain supported capabilities`);
  }
  if (value.cost !== undefined) validateCost(value.cost, `${path}.cost`, errors);
  validateHeaders(value.headers, `${path}.headers`, errors);
}

function validateCost(value: JsonValue, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
  ] as const) {
    if (value[key] !== undefined && !isNonNegativeNumber(value[key]))
      errors.push(`${path}.${key} must be a non-negative number`);
  }
  if (
    value.tiers !== undefined &&
    (!Array.isArray(value.tiers) || value.tiers.some((tier) => !isObject(tier)))
  ) {
    errors.push(`${path}.tiers must be an array of objects`);
  }
}

function validateHeaders(
  value: JsonValue | undefined,
  path: string,
  errors: string[],
): void {
  if (value === undefined) return;
  if (
    !isObject(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    errors.push(`${path} must be a string map`);
  }
}

function isNonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInputCapability(value: JsonValue): value is InputCapability {
  return typeof value === "string" && INPUT_CAPABILITIES.some((item) => item === value);
}

function isPositiveNumber(value: JsonValue): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: JsonValue): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getProvider(value: JsonObject, providerId: string): JsonObject {
  if (!isObject(value.providers)) value.providers = {};
  const providers = value.providers;
  if (!isObject(providers[providerId])) providers[providerId] = {};
  return providers[providerId] as JsonObject;
}

function getModels(provider: JsonObject): JsonObject[] {
  if (!Array.isArray(provider.models)) provider.models = [];
  return provider.models.filter(isObject);
}

export function listProviderDrafts(value: JsonObject): ProviderDraft[] {
  if (!isObject(value.providers)) return [];
  return Object.entries(value.providers).flatMap(([id, rawProvider]) => {
    if (!isObject(rawProvider)) return [];
    const provider = rawProvider;
    return [
      {
        id,
        api: apiValue(provider.api),
        apiKey: stringValue(provider.apiKey, ""),
        authHeader: true,
        baseUrl: stringValue(provider.baseUrl, ""),
        compat: isObject(provider.compat) ? clone(provider.compat) : undefined,
        headers: stringMap(provider.headers),
        models: getModels(provider).map((model) => modelDraftFromJson(model)),
      },
    ];
  });
}

function modelDraftFromJson(model: JsonObject): ModelDraft {
  const input: InputCapability[] = Array.isArray(model.input)
    ? model.input.filter(isInputCapability)
    : [
        "text",
        "image",
      ];
  const cost = isObject(model.cost) ? model.cost : {};
  return {
    compat: isObject(model.compat) ? clone(model.compat) : undefined,
    contextWindow: numberValue(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
    headers: stringMap(model.headers),
    id: stringValue(model.id, ""),
    input:
      input.length > 0
        ? input
        : [
            "text",
            "image",
          ],
    maxTokens: numberValue(model.maxTokens, DEFAULT_MAX_TOKENS),
    name: stringValue(model.name, stringValue(model.id, "")),
    reasoning: model.reasoning === true,
    samplingParams: isObject(model.samplingParams)
      ? clone(model.samplingParams)
      : undefined,
    thinkingLevelMap: isObject(model.thinkingLevelMap)
      ? clone(model.thinkingLevelMap)
      : undefined,
    cost: {
      cacheRead: numberValue(cost.cacheRead, 0),
      cacheWrite: numberValue(cost.cacheWrite, 0),
      input: numberValue(cost.input, 0),
      output: numberValue(cost.output, 0),
    },
  };
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function apiValue(value: JsonValue | undefined): ApiName {
  return value === "openai-responses" ||
    value === "anthropic-messages" ||
    value === "google-generative-ai"
    ? value
    : "openai-completions";
}

function stringMap(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries: [
    string,
    string,
  ][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string")
      entries.push([
        key,
        item,
      ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function omitKey(target: JsonObject, key: string): void {
  const { [key]: _omitted, ...rest } = target;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, rest);
}

export function upsertProvider(value: JsonObject, draft: ProviderDraft): void {
  const provider = getProvider(value, draft.id);
  const existingModels = getModels(provider);
  omitKey(provider, "name");
  provider.baseUrl = draft.baseUrl;
  provider.api = draft.api;
  provider.authHeader = true;
  if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim();
  else omitKey(provider, "apiKey");
  setOptionalObject(provider, "headers", draft.headers);
  setOptionalObject(provider, "compat", draft.compat);
  provider.models = draft.models.map((model) => {
    const nextModel = {
      ...(existingModels.find((item) => item.id === model.id) ?? {}),
      ...modelToJson(model),
    };
    omitKey(nextModel, "api");
    omitKey(nextModel, "baseUrl");
    return nextModel;
  });
}

export function renameProvider(
  value: JsonObject,
  settings: JsonObject,
  previousId: string,
  rawNextId: string,
): void {
  const from = previousId.trim();
  const to = rawNextId.trim();
  if (!to) throw new Error("provider id must not be empty");
  if (!isObject(value.providers) || value.providers[from] === undefined)
    throw new Error("The selected provider no longer exists");
  if (from === to) return;
  if (value.providers[to] !== undefined)
    throw new Error(`provider ${to} already exists`);

  const providers: JsonObject = {};
  for (const [id, provider] of Object.entries(value.providers))
    providers[id === from ? to : id] = provider;
  value.providers = providers;

  const prefix = `${from}/`;
  setEnabledModels(
    settings,
    getEnabledModels(settings).map((pattern) =>
      pattern.startsWith(prefix) ? `${to}/${pattern.slice(prefix.length)}` : pattern,
    ),
  );
}

export function addProvider(value: JsonObject, rawId: string): ProviderDraft {
  const id = rawId.trim();
  if (!id) throw new Error("provider id must not be empty");
  if (!isObject(value.providers)) value.providers = {};
  if (value.providers[id] !== undefined)
    throw new Error(`provider ${id} already exists`);
  const draft: ProviderDraft = {
    api: "openai-completions",
    apiKey: "",
    authHeader: true,
    baseUrl: "https://api.example.com/v1",
    id,
    models: [],
  };
  upsertProvider(value, draft);
  return draft;
}

export function deleteProvider(
  value: JsonObject,
  settings: JsonObject,
  providerId: string,
): void {
  if (!isObject(value.providers) || value.providers[providerId] === undefined)
    throw new Error("The selected provider no longer exists");
  const rawProvider = value.providers[providerId];
  const models = isObject(rawProvider) ? getModels(rawProvider) : [];
  for (const model of models) {
    const modelId = stringValue(model.id, "");
    if (modelId)
      updateEnabledModelReference(settings, modelReference(providerId, modelId));
  }
  omitKey(value.providers, providerId);
}

function modelToJson(draft: ModelDraft): JsonObject {
  const model: JsonObject = {
    contextWindow: draft.contextWindow,
    id: draft.id,
    maxTokens: draft.maxTokens,
    name: draft.name,
    reasoning: draft.reasoning,
    cost: {
      ...draft.cost,
    },
    input: [
      ...draft.input,
    ],
  };
  setOptionalObject(model, "thinkingLevelMap", draft.thinkingLevelMap);
  setOptionalObject(model, "samplingParams", draft.samplingParams);
  setOptionalObject(model, "headers", draft.headers);
  setOptionalObject(model, "compat", draft.compat);
  return model;
}

function setOptionalObject(
  target: JsonObject,
  key: string,
  value: JsonObject | Record<string, string> | undefined,
): void {
  if (value && Object.keys(value).length > 0) target[key] = clone(value as JsonObject);
  else if (key in target) delete target[key];
}

export function setEnabledModels(settings: JsonObject, patterns: string[]): void {
  if (patterns.length === 0) omitKey(settings, "enabledModels");
  else settings.enabledModels = patterns;
}

export function getEnabledModels(settings: JsonObject): string[] {
  return Array.isArray(settings.enabledModels)
    ? settings.enabledModels.filter((item): item is string => typeof item === "string")
    : [];
}

export function updateEnabledModelReference(
  settings: JsonObject,
  previousReference: string,
  nextReference?: string,
): void {
  if (previousReference === nextReference) return;

  const patterns = getEnabledModels(settings);
  if (!patterns.includes(previousReference)) return;

  const targetAlreadyExists =
    nextReference !== undefined && patterns.includes(nextReference);
  let replacementAdded = false;
  const updated = patterns.flatMap((pattern) => {
    if (pattern !== previousReference)
      return [
        pattern,
      ];
    if (nextReference === undefined || targetAlreadyExists || replacementAdded)
      return [];
    replacementAdded = true;
    return [
      nextReference,
    ];
  });
  setEnabledModels(settings, updated);
}

export function modelReference(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function toUsd(value: number, currency: Currency, cnyPerUsd: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("price must be a non-negative number");
  if (currency === "USD") return value;
  if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0)
    throw new Error("exchange rate must be positive");
  return value / cnyPerUsd;
}

export function estimateCost(
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
  rates: CostRates,
): number {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}

export async function saveModelsAndSettings(
  modelsPath: string,
  models: JsonObject,
  settingsPath: string,
  settings: JsonObject,
): Promise<void> {
  const errors = validateModelsConfig(models);
  if (errors.length > 0)
    throw new Error(`Invalid models.json: ${errors.slice(0, 5).join("; ")}`);

  await mkdir(dirname(modelsPath), {
    mode: 0o700,
    recursive: true,
  });
  await mkdir(dirname(settingsPath), {
    mode: 0o700,
    recursive: true,
  });
  const backupPath = `${modelsPath}.bak`;
  let hadModels = true;
  try {
    await copyFile(modelsPath, backupPath);
    await chmod(backupPath, 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    hadModels = false;
  }

  try {
    await atomicWrite(modelsPath, models);
    await atomicWrite(settingsPath, settings);
  } catch (error) {
    if (hadModels) await rename(backupPath, modelsPath).catch(() => undefined);
    else await unlink(modelsPath).catch(() => undefined);
    throw new Error(
      `Could not save Pi configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function atomicWrite(path: string, value: JsonObject): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${path.split("/").pop() ?? "config"}.${process.pid}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

export const defaults = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  cost: DEFAULT_COST,
  maxTokens: DEFAULT_MAX_TOKENS,
};
