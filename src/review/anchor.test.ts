import { describe, expect, it } from "vitest";
import { matchThread } from "./anchor.js";

const thread = {
  lineStart: 3,
  lineEnd: 3,
  contextBefore: ["a", "b"],
  contextAfter: ["d", "e"],
};

describe("review thread re-anchor", () => {
  it("moves to the unique line with the same context", () => {
    expect(matchThread(thread, ["a", "b", "c", "d", "e"], ["x", "a", "b", "c", "d", "e"])).toEqual({
      result: "moved",
      line: 4,
    });
  });

  it("marks duplicate context ambiguous instead of guessing", () => {
    const result = matchThread(thread, ["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e", "a", "b", "c", "d", "e"]);
    expect(result.result).toBe("outdated");
    expect(result.reason).toBe("ambiguous_context");
  });

  it("marks deleted/changed lines outdated", () => {
    const result = matchThread(thread, ["a", "b", "c", "d", "e"], ["a", "x", "c", "d", "e"]);
    expect(result.result).toBe("outdated");
    expect(result.reason).toBe("line_changed");
  });
});
