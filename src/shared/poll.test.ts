import { describe, expect, it } from "vitest";
import {
  PollError,
  decisionSummary,
  evaluatePoll,
  isPollExpired,
  normalizeCreatePoll,
  validateSelections,
} from "./poll.js";

describe("t136 poll rules", () => {
  it("normalizes single/multi, defaults threshold and validates maxSelections", () => {
    const normalized = normalizeCreatePoll({
      workspaceId: "w",
      scope: "team",
      title: " Pick ",
      mode: "multi",
      thresholdRule: "gt",
      thresholdValue: 3,
      options: [{ label: " A " }, { label: "B" }],
      createdBy: "user",
    });
    expect(normalized.title).toBe("Pick");
    expect(normalized.options[0].label).toBe("A");
    expect(normalized.maxSelections).toBeNull();
    expect(normalized.thresholdValue).toBe(3);
    const forcedSingle = normalizeCreatePoll({
      workspaceId: "w",
      scope: "team",
      title: "x",
      mode: "single",
      maxSelections: 2,
      options: [{ label: "A" }, { label: "B" }],
      createdBy: "user",
    });
    expect(forcedSingle.maxSelections).toBe(1);
    expect(() =>
      normalizeCreatePoll({
        workspaceId: "w",
        scope: "team",
        title: "x",
        mode: "multi",
        maxSelections: 3,
        options: [{ label: "A" }, { label: "B" }],
        createdBy: "user",
      }),
    ).toThrow(PollError);
  });

  it("validates abstain and single/multi selections", () => {
    const base = {
      mode: "multi" as const,
      maxSelections: 2,
      allowAbstain: false,
      options: [{ id: "a" }, { id: "b" }, { id: "c" }],
    };
    expect(validateSelections(base, ["a", "a"])).toEqual(["a"]);
    expect(() => validateSelections(base, [])).toThrow(PollError);
    expect(validateSelections({ ...base, allowAbstain: true }, [])).toEqual([]);
    expect(() => validateSelections({ ...base, mode: "single", maxSelections: 1 }, ["a", "b"])).toThrow(PollError);
    expect(() => validateSelections(base, ["a", "b", "c"])).toThrow(PollError);
    expect(() => validateSelections(base, ["missing"])).toThrow(PollError);
  });

  it("applies gt/majority/percent thresholds and quorum", () => {
    const poll = {
      id: "p",
      mode: "multi" as const,
      maxSelections: 3,
      allowAbstain: false,
      thresholdRule: "gt" as const,
      thresholdValue: 3,
      quorum: 0,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    };
    const ballots = [
      { selections: ["a"] },
      { selections: ["a"] },
      { selections: ["a"] },
      { selections: ["a", "b"] },
    ];
    const gt = evaluatePoll(poll, ballots);
    expect(gt.options.find((option) => option.optionId === "a")?.adopted).toBe(true);
    expect(gt.options.find((option) => option.optionId === "b")?.adopted).toBe(false);

    const majority = evaluatePoll({ ...poll, thresholdRule: "majority", thresholdValue: 0 }, ballots);
    expect(majority.options.find((option) => option.optionId === "a")?.count).toBe(4);
    expect(majority.options.find((option) => option.optionId === "a")?.adopted).toBe(true);
    const percent = evaluatePoll({ ...poll, thresholdRule: "percent", thresholdValue: 50 }, ballots);
    expect(percent.options.find((option) => option.optionId === "a")?.adopted).toBe(true);

    const quorum = evaluatePoll({ ...poll, quorum: 5 }, ballots);
    expect(quorum.quorumMet).toBe(false);
    expect(quorum.adoptedOptionIds).toEqual([]);
    expect(decisionSummary({ title: "T" }, quorum)).toContain("quorum");
  });

  it("detects deadline expiry and produces an empty decision when no option passes", () => {
    expect(isPollExpired({ status: "open", closesAt: "2026-01-01T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(isPollExpired({ status: "closed", closesAt: "2026-01-01T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z")).toBe(false);
    const empty = evaluatePoll(
      {
        id: "p",
        mode: "single",
        maxSelections: 1,
        allowAbstain: false,
        thresholdRule: "gt",
        thresholdValue: 3,
        quorum: 0,
        options: [{ id: "a", label: "A" }],
      },
      [{ selections: ["a"] }],
    );
    expect(empty.adoptedOptionIds).toEqual([]);
    expect(decisionSummary({ title: "T" }, empty)).toContain("没有候选");
  });
});
