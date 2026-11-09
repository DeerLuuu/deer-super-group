import type {
  LlmSettings,
  ModelPricing,
  ModelProfile,
  ProviderProfile,
  ThinkingEffort,
} from "./types.js";

const EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "max"];

function asNonNegativeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeModelPricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const inputPer1M = asNonNegativeNumber(record.inputPer1M);
  const outputPer1M = asNonNegativeNumber(record.outputPer1M);
  if (inputPer1M === null || outputPer1M === null) return null;
  const cachedInputPer1M = asNonNegativeNumber(record.cachedInputPer1M);
  const reasoningPer1M = asNonNegativeNumber(record.reasoningPer1M);
  return {
    currency: "USD",
    inputPer1M,
    outputPer1M,
    ...(cachedInputPer1M !== null ? { cachedInputPer1M } : {}),
    ...(reasoningPer1M !== null ? { reasoningPer1M } : {}),
    source: record.source === "catalog" ? "catalog" : "manual",
    version:
      typeof record.version === "string" && record.version.trim()
        ? record.version.trim()
        : `manual:${inputPer1M}/${outputPer1M}`,
  };
}

export interface LegacyProviderFields {
  baseUrl: string;
  baseUrlEnv: string;
  apiKey: string;
  apiKeyEnv: string;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asEffort(value: unknown, fallback: ThinkingEffort): ThinkingEffort {
  return typeof value === "string" && EFFORTS.includes(value as ThinkingEffort)
    ? (value as ThinkingEffort)
    : fallback;
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function defaultProviderProfile(
  legacy: Partial<LegacyProviderFields> = {},
  id = "provider_default",
  name = "Default",
): ProviderProfile {
  return {
    id,
    name,
    baseUrl: legacy.baseUrl?.trim() || "https://api.deepseek.com/v1",
    baseUrlEnv: legacy.baseUrlEnv?.trim() || "",
    apiKey: legacy.apiKey ?? "",
    apiKeyEnv: legacy.apiKeyEnv?.trim() || "",
  };
}

function normalizeProvider(value: unknown, index: number): ProviderProfile {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallback = defaultProviderProfile({}, `provider_${index + 1}`, `Provider ${index + 1}`);
  const id = String(record.id ?? fallback.id).trim() || fallback.id;
  return {
    id,
    name:
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : fallback.name,
    baseUrl:
      typeof record.baseUrl === "string" && record.baseUrl.trim()
        ? record.baseUrl.trim()
        : fallback.baseUrl,
    baseUrlEnv:
      typeof record.baseUrlEnv === "string" ? record.baseUrlEnv.trim() : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    apiKeyEnv:
      typeof record.apiKeyEnv === "string" ? record.apiKeyEnv.trim() : "",
  };
}

/** Normalize providers; when none are persisted, migrate the legacy single provider. */
export function normalizeProviders(
  value: unknown,
  legacy: LegacyProviderFields,
): ProviderProfile[] {
  const input = Array.isArray(value) ? value : [];
  if (input.length === 0) {
    return [defaultProviderProfile(legacy)];
  }

  const seen = new Set<string>();
  const providers: ProviderProfile[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const provider = normalizeProvider(input[index], index);
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers.length > 0 ? providers : [defaultProviderProfile(legacy)];
}

/**
 * Sensible, editable defaults per model family.
 * These are intentionally approximate; the Settings UI lets you override them.
 */
export function defaultModelProfile(
  modelId: string,
  providerId = "provider_default",
): ModelProfile {
  const normalizedModelId = modelId.trim() || "deepseek-chat";
  const normalizedProviderId = providerId.trim() || "provider_default";
  const lower = normalizedModelId.toLowerCase();

  const base = {
    id: modelKey(normalizedProviderId, normalizedModelId),
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    label: normalizedModelId,
    supportsImages: false,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    thinkingEnabled: false,
    thinkingEffort: "medium" as ThinkingEffort,
  };

  if (lower.includes("claude")) {
    return {
      ...base,
      supportsImages: true,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      thinkingEnabled: true,
      thinkingEffort: "high",
    };
  }
  if (lower.includes("gemini")) {
    return {
      ...base,
      supportsImages: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 8192,
    };
  }
  if (lower.includes("deepseek")) {
    const isV41 =
      lower.includes("v4.1") || lower.includes("v4-1") || lower.includes("v4_1");
    const isV4Pro = lower.includes("v4-pro") || lower.includes("v4_pro");
    if (isV41) {
      return {
        ...base,
        supportsImages: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 1_048_576,
        thinkingEnabled: true,
        thinkingEffort: "high",
      };
    }
    if (isV4Pro) {
      return {
        ...base,
        supportsImages: true,
        contextWindow: 262144,
        maxOutputTokens: 1_048_576,
        thinkingEnabled: true,
        thinkingEffort: "high",
      };
    }
    return {
      ...base,
      supportsImages: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      thinkingEnabled: true,
      thinkingEffort: "high",
    };
  }
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return {
      ...base,
      supportsImages: true,
      contextWindow: 128000,
      maxOutputTokens: 16384,
      thinkingEnabled: false,
      thinkingEffort: "medium",
    };
  }
  if (lower.includes("kimi")) {
    return {
      ...base,
      supportsImages: true,
      contextWindow: 262144,
      maxOutputTokens: 8192,
    };
  }
  if (lower.includes("qwen")) {
    return {
      ...base,
      supportsImages: false,
      contextWindow: 131072,
      maxOutputTokens: 8192,
    };
  }
  if (lower.includes("glm")) {
    return {
      ...base,
      supportsImages: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    };
  }
  return base;
}

export function normalizeModelProfile(
  value: unknown,
  providers: ProviderProfile[],
  fallbackModelId = "deepseek-chat",
): ModelProfile {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const providerIds = new Set(providers.map((provider) => provider.id));
  const providerId = providerIds.has(String(record.providerId ?? ""))
    ? String(record.providerId)
    : providers[0]?.id ?? "provider_default";

  let modelId = String(
    record.modelId ?? record.id ?? fallbackModelId ?? "deepseek-chat",
  ).trim();
  if (!record.modelId && modelId.includes(":")) {
    modelId = modelId.split(":").slice(1).join(":") || modelId;
  }
  if (!modelId) modelId = fallbackModelId || "deepseek-chat";

  const base = defaultModelProfile(modelId, providerId);
  const contextWindow = asPositiveInt(record.contextWindow, base.contextWindow);
  const requestedMaxOutput = asPositiveInt(
    record.maxOutputTokens,
    base.maxOutputTokens,
  );
  // Do not impose an arbitrary provider cap here: some models (for example
  // DeepSeek V4.1) support 1M output tokens. Only reset clearly invalid values.
  const maxOutputTokens =
    requestedMaxOutput > 4_000_000 ? base.maxOutputTokens : requestedMaxOutput;

  return {
    id: modelKey(providerId, modelId),
    providerId,
    modelId,
    label:
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : base.label,
    supportsImages:
      typeof record.supportsImages === "boolean"
        ? record.supportsImages
        : base.supportsImages,
    contextWindow,
    maxOutputTokens,
    thinkingEnabled:
      typeof record.thinkingEnabled === "boolean"
        ? record.thinkingEnabled
        : base.thinkingEnabled,
    thinkingEffort: asEffort(record.thinkingEffort, base.thinkingEffort),
    pricing: normalizeModelPricing(record.pricing),
  };
}

/** Normalize persisted models across all providers, dedupe by profile id. */
export function normalizeModels(
  value: unknown,
  providers: ProviderProfile[],
  fallbackModelId: string,
): ModelProfile[] {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const models: ModelProfile[] = [];

  for (const item of input) {
    const profile = normalizeModelProfile(item, providers, fallbackModelId);
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    models.push(profile);
  }

  if (models.length === 0) {
    models.push(defaultModelProfile(fallbackModelId || "deepseek-chat", providers[0]?.id));
  }
  return models;
}

export function legacyProviderFields(
  settings: Pick<LlmSettings, "baseUrl" | "baseUrlEnv" | "apiKey" | "apiKeyEnv">,
): LegacyProviderFields {
  return {
    baseUrl: settings.baseUrl,
    baseUrlEnv: settings.baseUrlEnv,
    apiKey: settings.apiKey,
    apiKeyEnv: settings.apiKeyEnv,
  };
}

export function resolveProvider(
  settings: Pick<LlmSettings, "providers" | "baseUrl" | "baseUrlEnv" | "apiKey" | "apiKeyEnv">,
  providerId?: string | null,
): ProviderProfile {
  const providers = normalizeProviders(settings.providers, legacyProviderFields(settings));
  return (
    (providerId ? providers.find((provider) => provider.id === providerId) : undefined) ??
    providers[0]
  );
}

/** Resolve an agent's preferred model, falling back to the default configured model. */
export function resolveModelProfile(
  settings: Pick<
    LlmSettings,
    | "providers"
    | "model"
    | "models"
    | "baseUrl"
    | "baseUrlEnv"
    | "apiKey"
    | "apiKeyEnv"
  >,
  preferred?: string | null,
): ModelProfile {
  const providers = normalizeProviders(settings.providers, legacyProviderFields(settings));
  const models = normalizeModels(settings.models, providers, settings.model || "deepseek-chat");
  return (
    (preferred ? models.find((model) => model.id === preferred) : undefined) ??
    (preferred ? models.find((model) => model.modelId === preferred) : undefined) ??
    models.find((model) => model.id === settings.model) ??
    models.find((model) => model.modelId === settings.model) ??
    models[0]
  );
}

export function providerName(
  settings: Pick<LlmSettings, "providers" | "baseUrl" | "baseUrlEnv" | "apiKey" | "apiKeyEnv">,
  providerId: string,
): string {
  return resolveProvider(settings, providerId).name;
}

export function modelsForProvider(models: ModelProfile[], providerId: string): ModelProfile[] {
  return models.filter((model) => model.providerId === providerId);
}
