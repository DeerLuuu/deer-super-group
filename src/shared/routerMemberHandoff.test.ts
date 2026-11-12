import { describe, expect, it } from "vitest";
import { extractRecommendationCandidates, parseTeamCommand } from "./routerMemberHandoff.js";

const candidate = {
  candidateId: "c1",
  name: "A11y Reviewer",
  role: "reviewer",
  responsibilities: "Accessibility review",
  reason: "No a11y specialist",
  suggestedModelProfileId: null,
  suggestedModelLabel: null,
  permission: "read_only" as const,
  skills: [],
  risks: [],
};

describe("t415 router member handoff boundaries", () => {
  it("only parses explicit /team commands", () => {
    expect(parseTeamCommand("/team")).toEqual({ description: null });
    expect(parseTeamCommand("  /TEAM   ")).toEqual({ description: null });
    expect(parseTeamCommand("/team 缺一个可访问性评审")).toEqual({ description: "缺一个可访问性评审" });
    expect(parseTeamCommand("/teamfoo")).toBeNull();
    expect(parseTeamCommand("推荐成员/招人")).toBeNull();
    expect(parseTeamCommand("推荐成员")).toBeNull();
    expect(parseTeamCommand("hello")).toBeNull();
    expect(parseTeamCommand("")).toBeNull();
  });

  it("extracts structured candidates from a recommendation response", () => {
    expect(extractRecommendationCandidates({ ok: true, result: { candidates: [candidate] } })).toEqual([candidate]);
    expect(extractRecommendationCandidates({ ok: false, code: "MOCK_UNSUPPORTED", message: "mock" })).toBeNull();
    expect(extractRecommendationCandidates(null)).toBeNull();
    expect(extractRecommendationCandidates({ ok: true, result: { candidates: [] } })).toBeNull();
  });
});
