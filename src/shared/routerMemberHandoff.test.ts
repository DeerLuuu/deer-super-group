import { describe, expect, it, vi } from "vitest";
import { dispatchChatSubmission, extractRecommendationCandidates, parseTeamCommand } from "./routerMemberHandoff.js";

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

  it("dispatches App-level send/team boundaries without inserting commands", () => {
    const handlers = () => ({
      clear: vi.fn(),
      compact: vi.fn(),
      team: vi.fn(),
      send: vi.fn(),
    });
    for (const input of ["/unknown", "/teamfoo", "推荐成员，招人"]) {
      const h = handlers();
      expect(dispatchChatSubmission(input, h)).toBe("send");
      expect(h.send).toHaveBeenCalledWith(input);
      expect(h.team).not.toHaveBeenCalled();
    }
    const team = handlers();
    expect(dispatchChatSubmission("  /TEAM  缺一个可访问性评审 ", team)).toBe("team");
    expect(team.team).toHaveBeenCalledWith("缺一个可访问性评审");
    expect(team.send).not.toHaveBeenCalled();
    const clear = handlers();
    expect(dispatchChatSubmission("/clear", clear)).toBe("clear");
    expect(clear.clear).toHaveBeenCalled();
    const compact = handlers();
    expect(dispatchChatSubmission("/compact", compact)).toBe("compact");
    expect(compact.compact).toHaveBeenCalled();
  });
});
