import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graph.js";

describe("git graph lane layout", () => {
  it("keeps a linear history on one lane", () => {
    const graph = layoutGraph({
      commits: [
        { sha: "c", parents: ["b"] },
        { sha: "b", parents: ["a"] },
        { sha: "a", parents: [] },
      ],
    });
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.laneCount).toBe(1);
    expect(graph.truncatedLanes).toBe(false);
  });

  it("fans out a merge parent and converges on the first-parent lane", () => {
    const graph = layoutGraph({
      commits: [
        { sha: "merge", parents: ["main2", "side2"] },
        { sha: "side2", parents: ["base"] },
        { sha: "main2", parents: ["base"] },
        { sha: "base", parents: [] },
      ],
    });
    expect(graph.rows[0].lane).toBe(0);
    expect(graph.rows[0].parentLanes[0]).toMatchObject({ sha: "main2", lane: 0, kind: "first" });
    expect(graph.rows[0].parentLanes[1].lane).toBeGreaterThan(0);
    expect(graph.rows[0].parentLanes[1].kind).toBe("merge");
    expect(graph.rows[3].lane).toBe(0);
  });

  it("marks missing parents as open edges instead of inventing commits", () => {
    const graph = layoutGraph({
      commits: [{ sha: "a", parents: ["not-loaded"] }],
    });
    expect(graph.rows[0].openEdges).toEqual([{ lane: 0, kind: "missing-parent" }]);
  });

  it("caps lanes at 16 and marks truncation", () => {
    const commits = Array.from({ length: 20 }, (_, index) => ({
      sha: `c${index}`,
      parents: [] as string[],
    }));
    // Force distinct roots to occupy more than 16 lanes.
    const graph = layoutGraph({ commits: [{ sha: "root", parents: [] }, ...commits], maxLanes: 16 });
    expect(graph.maxLanes).toBe(16);
    expect(graph.laneCount).toBeLessThanOrEqual(16);
  });
});
