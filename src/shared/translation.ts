import type { TranslationProvider, TranslationSettings } from "./types.js";

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  enabled: true,
  provider: "bing",
  modelProfileId: null,
  target: "zh-Hans",
};

export function normalizeTranslationSettings(value: unknown): TranslationSettings {
  const source = (value ?? {}) as Partial<TranslationSettings>;
  const provider: TranslationProvider =
    source.provider === "model" ? "model" : source.provider === "bing" ? "bing" : "bing";
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    provider,
    modelProfileId:
      typeof source.modelProfileId === "string" && source.modelProfileId.trim()
        ? source.modelProfileId.trim()
        : null,
    target:
      typeof source.target === "string" && source.target.trim()
        ? source.target.trim()
        : DEFAULT_TRANSLATION_SETTINGS.target,
  };
}

export function parseTranslationSettings(value: string | null): TranslationSettings {
  if (!value) return { ...DEFAULT_TRANSLATION_SETTINGS };
  try {
    return normalizeTranslationSettings(JSON.parse(value));
  } catch {
    return { ...DEFAULT_TRANSLATION_SETTINGS };
  }
}

export function translationProviderLabel(provider: TranslationProvider): string {
  return provider === "model" ? "已配置模型" : "Bing";
}
