import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import { FixedClock } from "./clock.js";
import { MemoryStore } from "./store.js";
import type { MemoryResult } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(ftsEnabled = true) {
  const store = new Store(":memory:");
  const clock = new FixedClock("2026-02-01T00:00:00.000Z");
  const memory = new MemoryStore(store, { clock, ftsEnabled });
  memory.db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "ws",
    "retrieval",
    "/tmp/deer-retrieval",
    clock.now(),
  );
  memory.db.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, role, created_at) VALUES ('a', 'ws', 'a', 'member', ?)",
  ).run(clock.now());
  cleanups.push(() => store.close());
  return { memory, clock, ws: "ws" };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function board(memory: MemoryStore, ws: string, content: string, kind: "fact" | "decision" = "fact") {
  return memory.createBoard({ workspaceId: ws, board: "backend", author: "agent:ray", kind, content, source: "agent" });
}

function memo(memory: MemoryStore, ws: string, agentId: string, content: string, tags: string[] = []) {
  return memory.createMemo({ workspaceId: ws, agentId, kind: "lesson", content, tags, source: "agent" });
}

describe("memory retrieval", () => {
  it("maps bm25 monotonically: three hits beat one hit and keeps a breakdown", () => {
    const { memory, ws } = setup();
    const one = memory.createBoard({ workspaceId: ws, board: "backend", author: "agent:one", kind: "fact", content: "alpha beta gamma delta", source: "agent" });
    const three = memory.createBoard({ workspaceId: ws, board: "backend", author: "agent:three", kind: "fact", content: "alpha alpha alpha beta gamma delta", source: "agent" });
    const result = memory.search({ workspaceId: ws, query: "alpha" });
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.id).toBe(three.id);
    expect(result.hits[0]?.breakdown.normalization).toBe("minmax");
    expect(result.hits[0]?.breakdown.rawRank).toBeLessThan(0);
    expect(result.hits[0]?.breakdown.relevance).toBeGreaterThan(result.hits[1]?.breakdown.relevance ?? 0);
    expect(result.hits[0]?.breakdown.rawRank).toBeLessThan(result.hits[1]?.breakdown.rawRank ?? 0);
    expect(one.id).not.toBe(three.id);
  });

  it("uses six bm25 weights so tag hits beat body noise", () => {
    const { memory, ws } = setup();
    const tagged = memo(memory, ws, "a", "noise xyz", ["alpha"]);
    const body = memory.createMemo({ workspaceId: ws, agentId: "a", kind: "failure", content: "alpha xyz", source: "agent" });
    const result = memory.search({ workspaceId: ws, agentId: "a", scopes: ["memo"], query: "alpha" });
    expect(result.hits[0]?.id).toBe(tagged.id);
    expect(result.hits[1]?.id).toBe(body.id);
  });

  it("orders FTS candidates before LIMIT so the best item is not cut at >200 hits", () => {
    const { memory, ws } = setup();
    const noise = "alpha filler text";
    for (let i = 0; i < 204; i += 1) {
      memory.createBoard({ workspaceId: ws, board: "backend", author: `agent:noise-${i}`, kind: "fact", content: `${noise} ${i}`, source: "agent" });
    }
    const best = memory.createBoard({ workspaceId: ws, board: "backend", author: "agent:best", kind: "fact", content: `${"alpha ".repeat(40)}best`, source: "agent" });
    const result = memory.search({ workspaceId: ws, query: "alpha", limit: 50 });
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]?.id).toBe(best.id);
  });

  it("falls back to LIKE for two-character Chinese queries and when FTS is disabled", () => {
    const { memory, ws } = setup(false);
    expect(memory.ftsAvailable).toBe(false);
    const entry = board(memory, ws, "中文检索能力");
    const result = memory.search({ workspaceId: ws, query: "中文" });
    expect(result.hits[0]?.id).toBe(entry.id);
    expect(result.hits[0]?.breakdown.normalization).toBe("like");
  });

  it("supports FTS for three-character Chinese and escapes hostile MATCH input", () => {
    const { memory, ws } = setup();
    const entry = board(memory, ws, "中文检索能力");
    const hit = memory.search({ workspaceId: ws, query: "中文检" });
    expect(hit.hits[0]?.id).toBe(entry.id);
    expect(() => memory.search({ workspaceId: ws, query: '" OR 1=1 --' })).not.toThrow();
    expect(() => memory.search({ workspaceId: ws, query: "NEAR(" })).not.toThrow();
  });

  it("deduplicates identical content fingerprints while preserving citations", () => {
    const { memory, ws } = setup();
    const first = board(memory, ws, "duplicate alpha content");
    const second = board(memory, ws, "duplicate alpha content");
    const result = memory.search({ workspaceId: ws, query: "duplicate" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.contentHash).toBe(first.contentHash);
    expect(new Set(result.hits[0]?.citations)).toEqual(new Set([`board:${first.id}`, `board:${second.id}`]));
  });

  it("keeps relevance explainable and deterministic across repeated calls", () => {
    const { memory, ws } = setup();
    board(memory, ws, "alpha one");
    board(memory, ws, "alpha alpha two", "decision");
    const one = memory.search({ workspaceId: ws, query: "alpha" });
    const two = memory.search({ workspaceId: ws, query: "alpha" });
    expect(one.hits.map((hit) => hit.id)).toEqual(two.hits.map((hit) => hit.id));
    expect(one.hits.map((hit) => hit.breakdown.score)).toEqual(two.hits.map((hit) => hit.breakdown.score));
    for (const hit of one.hits) {
      expect(hit.breakdown.normalization).toBe("minmax");
      expect(hit.citations).toEqual([`board:${hit.id}`]);
    }
  });
});
