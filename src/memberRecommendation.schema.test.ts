import { describe, expect, it } from "vitest";
import {
  buildMemberRecommendationUserPrompt,
  parseCandidateResponse,
  validateCandidateResponse,
} from "./shared/memberRecommendation.js";
import type { ModelProfile } from "./shared/types.js";

const models: ModelProfile[] = [
  {
    id: "p1:glm",
    providerId: "p1",
    modelId: "glm-5.3",
    label: "GLM 5.3",
    supportsImages: false,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    thinkingEnabled: true,
    thinkingEffort: "medium",
  },
];

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    name: "Builder",
    role: "engineer",
    responsibilities: "实现前端",
    reason: "任务需要",
    suggestedModelProfileId: "p1:glm",
    permission: "read_only",
    skills: ["React"],
    risks: ["需要评审"],
    ...overrides,
  };
}

describe("t272 recommendation schema", () => {
  it("accepts 1-3 candidates and maps model label", () => {
    const result = validateCandidateResponse(
      { candidates: [candidate(), candidate({ name: "QA", role: "qa" })] },
      models,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.suggestedModelLabel).toBe("GLM 5.3");
    expect(result.candidates[0]!.permission).toBe("read_only");
  });

  it("rejects unknown fields, wrong permission, unknown model and duplicate names", () => {
    expect(
      validateCandidateResponse({ candidates: [candidate({ apiKey: "sk-x" })] }, models).ok,
    ).toBe(false);
    expect(
      validateCandidateResponse({ candidates: [candidate({ permission: "full_access" })] }, models)
        .ok,
    ).toBe(false);
    expect(
      validateCandidateResponse(
        { candidates: [candidate({ suggestedModelProfileId: "p2:other" })] },
        models,
      ).ok,
    ).toBe(false);
    expect(
      validateCandidateResponse(
        { candidates: [candidate(), candidate({ name: "builder" })] },
        models,
      ).ok,
    ).toBe(false);
  });

  it("rejects Router name, too many, bad shape, and accepts empty candidates", () => {
    expect(
      validateCandidateResponse({ candidates: [candidate({ name: "Router" })] }, models).ok,
    ).toBe(false);
    expect(
      validateCandidateResponse(
        { candidates: [1, 2, 3, 4].map((n) => candidate({ name: `M${n}` })) },
        models,
      ).ok,
    ).toBe(false);
    expect(validateCandidateResponse({ candidates: [{ name: 1 }] }, models).ok).toBe(false);
    const empty = validateCandidateResponse({ candidates: [] }, models);
    expect(empty).toEqual({ ok: true, candidates: [] });
  });

  it("parses fenced JSON and rejects malformed JSON without fallback", () => {
    const ok = parseCandidateResponse(
      "```json\n" + JSON.stringify({ candidates: [candidate()] }) + "\n```",
      models,
    );
    expect(ok.ok).toBe(true);
    expect(parseCandidateResponse("not json", models).ok).toBe(false);
    expect(parseCandidateResponse('{"candidates": [}', models).ok).toBe(false);
  });

  it("prompt contains only allowed facts and never existing hidden prompts/secrets", () => {
    const prompt = buildMemberRecommendationUserPrompt({
      mode: "description",
      description: "需要 QA",
      workspaceName: "Demo",
      workspacePath: "C:\\demo",
      overview: "overview",
      members: [{ name: "Builder", role: "engineer", modelLabel: "GLM 5.3" }],
      tasks: [{ title: "Fix", status: "ready", ownerName: "Builder" }],
      recentContext: [
        {
          role: "user",
          content:
            "sk-live-ABC123456 Authorization: Bearer abc.def token=secret123 https://api.internal.corp/v1?token=querysecret",
        },
      ],
      allowedModels: [{ id: "p1:glm", label: "GLM 5.3" }],
    });
    expect(prompt).toContain("ALLOWED_PERMISSION: read_only");
    expect(prompt).toContain("p1:glm");
    expect(prompt).not.toContain("sk-");
    expect(prompt).not.toContain("Bearer abc.def");
    expect(prompt).not.toContain("secret123");
    expect(prompt).not.toContain("querysecret");
    expect(prompt).not.toContain("api.internal.corp");
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("system prompt:");
    expect(prompt).not.toContain("baseUrl");
  });
});
