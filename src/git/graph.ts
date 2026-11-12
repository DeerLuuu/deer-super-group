import type { GitCommitNode } from "./readTypes.js";

export type LayoutInput = {
  commits: Array<{ sha: string; parents: string[] }>;
  maxLanes?: number;
};

export type LayoutRow = {
  sha: string;
  lane: number;
  color: number;
  parentLanes: Array<{ sha: string; lane: number; kind: "first" | "merge" }>;
  lanesBefore: Array<string | null>;
  openEdges: Array<{ lane: number; kind: "missing-parent" }>;
};

export type GraphLayout = {
  rows: LayoutRow[];
  laneCount: number;
  maxLanes: number;
  truncatedLanes: boolean;
};

/**
 * Pure newest→oldest lane layout. Parent rows may be outside the loaded page;
 * those edges are kept as openEdges instead of inventing commits.
 */
export function layoutGraph(input: LayoutInput): GraphLayout {
  const maxLanes = Math.max(1, Math.min(16, input.maxLanes ?? 16));
  const lanes: Array<string | null> = [];
  const rows: LayoutRow[] = [];
  const all = new Set(input.commits.map((commit) => commit.sha));
  let truncatedLanes = false;
  let laneCount = 0;

  const firstFree = (start: number): number => {
    for (let index = start; index < lanes.length; index += 1) {
      if (lanes[index] == null) return index;
    }
    return lanes.length;
  };

  for (const commit of input.commits) {
    const hits: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] === commit.sha) hits.push(index);
    }
    let lane: number;
    if (hits.length > 0) {
      lane = Math.min(...hits);
      for (const extra of hits) {
        if (extra !== lane) lanes[extra] = null;
      }
    } else {
      lane = firstFree(0);
      if (lane >= maxLanes) {
        lane = maxLanes - 1;
        truncatedLanes = true;
      }
      lanes[lane] = commit.sha;
    }
    if (lane >= maxLanes) {
      lane = maxLanes - 1;
      truncatedLanes = true;
    }
    const lanesBefore = [...lanes];
    const parentLanes: LayoutRow["parentLanes"] = [];
    const openEdges: LayoutRow["openEdges"] = [];
    const parents = commit.parents;
    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = parents[0] ?? null;
      parentLanes.push({
        sha: parents[0],
        lane: parents[0] && all.has(parents[0]) ? avoidCollision(lanes, lane, parents[0], maxLanes, () => {
          truncatedLanes = true;
        }) : lane,
        kind: "first",
      });
      for (let index = 1; index < parents.length; index += 1) {
        const parent = parents[index];
        let target = lanes.findIndex((value, laneIndex) => laneIndex > lane && value === parent);
        if (target < 0) target = lanes.findIndex((value, laneIndex) => laneIndex > lane && value == null);
        if (target < 0) target = lanes.length;
        if (target >= maxLanes) {
          target = maxLanes - 1;
          truncatedLanes = true;
        }
        if (target === lane) target = Math.min(maxLanes - 1, lane + 1);
        lanes[target] = parent;
        parentLanes.push({ sha: parent, lane: target, kind: "merge" });
      }
    }
    for (const parent of parents) {
      if (!all.has(parent)) openEdges.push({ lane, kind: "missing-parent" });
    }
    laneCount = Math.max(laneCount, lane + 1, ...lanes.map((_, index) => (lanes[index] ? index + 1 : 0)));
    rows.push({
      sha: commit.sha,
      lane,
      color: lane % 10,
      parentLanes,
      lanesBefore,
      openEdges,
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] == null) lanes.pop();
  }

  return { rows, laneCount: Math.min(maxLanes, laneCount), maxLanes, truncatedLanes };
}

function avoidCollision(
  lanes: Array<string | null>,
  lane: number,
  parent: string,
  maxLanes: number,
  markTruncated: () => void,
): number {
  const existing = lanes.findIndex((value, index) => index !== lane && value === parent);
  if (existing >= 0) {
    const target = Math.min(lane, existing);
    if (target === lane) {
      lanes[lane] = parent;
      lanes[existing] = null;
    } else {
      lanes[lane] = null;
      lanes[existing] = parent;
    }
    return target;
  }
  if (lanes[lane] === parent) return lane;
  if (lane < maxLanes) {
    lanes[lane] = parent;
    return lane;
  }
  markTruncated();
  return maxLanes - 1;
}

export function attachLayout(
  commits: Array<Omit<GitCommitNode, "lane" | "color" | "parentLanes" | "openEdges">>,
  maxLanes = 16,
): { commits: GitCommitNode[]; layout: Omit<GraphLayout, "rows"> } {
  const graph = layoutGraph({ commits: commits.map(({ sha, parents }) => ({ sha, parents })), maxLanes });
  return {
    commits: commits.map((commit, index) => ({
      ...commit,
      lane: graph.rows[index]?.lane ?? 0,
      color: graph.rows[index]?.color ?? 0,
      parentLanes: graph.rows[index]?.parentLanes ?? [],
      openEdges: graph.rows[index]?.openEdges ?? [],
    })),
    layout: {
      laneCount: graph.laneCount,
      maxLanes: graph.maxLanes,
      truncatedLanes: graph.truncatedLanes,
    },
  };
}
