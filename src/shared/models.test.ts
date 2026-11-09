import { describe, expect, it } from "vitest";
import {
  defaultModelProfile,
  defaultProviderProfile,
  normalizeModels,
  resolveModelProfile,
} from "./models.js";

const providers = [defaultProviderProfile({}, "p1", "Provider 1")];
const baseSettings = {
  providers,
  baseUrl: "https://example.com/v1",
  baseUrlEnv: "",
  apiKey: "",
  apiKeyEnv: "",
};

describe("defaultModelProfile", () => {
  it("uses deepseek-friendly defaults", () => {
    const profile = defaultModelProfile("deepseek-chat");
    expect(profile.supportsImages).toBe(false);
    expect(profile.contextWindow).toBe(128000);
    expect(profile.maxOutputTokens).toBe(8192);
    expect(profile.thinkingEnabled).toBe(true);
    expect(profile.thinkingEffort).toBe("high");
  });

  it("uses vision + longer context for claude/gemini families", () => {
    expect(defaultModelProfile("claude-sonnet").supportsImages).toBe(true);
    expect(defaultModelProfile("gemini-3-pro").contextWindow).toBeGreaterThan(1_000_000);
  });
});

describe("normalizeModels", () => {
  it("fills missing fields, clamps invalid numbers and dedupes ids", () => {
    const models = normalizeModels(
      [
        { id: "a", contextWindow: 0, thinkingEffort: "nope" },
        { id: "a", label: "duplicate" },
        { id: "b", supportsImages: true, maxOutputTokens: 2048 },
      ],
      providers,
      "fallback",
    );
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("p1:a");
    expect(models[0].contextWindow).toBe(128000);
    expect(models[0].thinkingEffort).toBe("medium");
    expect(models[1].supportsImages).toBe(true);
    expect(models[1].maxOutputTokens).toBe(2048);
  });

  it("preserves 1M output for DeepSeek V4.1", () => {
    const models = normalizeModels(
      [{ id: "deepseek-v4.1", contextWindow: 1_048_576, maxOutputTokens: 1_048_576 }],
      providers,
      "deepseek-v4.1",
    );
    expect(models[0].maxOutputTokens).toBe(1_048_576);
    expect(defaultModelProfile("deepseek-v4.1").maxOutputTokens).toBe(1_048_576);
  });

  it("keeps same model ids from different providers separate", () => {
    const multi = [
      defaultProviderProfile({}, "p1", "Provider 1"),
      defaultProviderProfile({}, "p2", "Provider 2"),
    ];
    const models = normalizeModels(
      [
        { id: "deepseek", providerId: "p1" },
        { id: "deepseek", providerId: "p2" },
      ],
      multi,
      "deepseek",
    );
    expect(models.map((model) => model.id)).toEqual([
      "p1:deepseek",
      "p2:deepseek",
    ]);
  });

  it("creates a fallback model when the list is empty", () => {
    const models = normalizeModels(null, providers, "deepseek-chat");
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("p1:deepseek-chat");
    expect(models[0].modelId).toBe("deepseek-chat");
  });
});

describe("resolveModelProfile", () => {
  const models = [defaultModelProfile("a", "p1"), defaultModelProfile("b", "p1")];

  it("prefers the requested model", () => {
    expect(resolveModelProfile({ ...baseSettings, model: "p1:a", models }, "p1:b").modelId).toBe("b");
  });

  it("falls back to the default and then the first model", () => {
    expect(
      resolveModelProfile({ ...baseSettings, model: "p1:a", models }, "missing").modelId,
    ).toBe("a");
    expect(
      resolveModelProfile({ ...baseSettings, model: "missing", models }, null).modelId,
    ).toBe("a");
  });
});
