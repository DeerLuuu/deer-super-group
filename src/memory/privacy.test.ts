import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import { FixedClock } from "./clock.js";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";
import type { MemoryActor, MemoryResult } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const store = new Store(":memory:");
  const clock = new FixedClock("2026-03-01T00:00:00.000Z");
  const memory = new MemoryStore(store, { clock });
  memory.db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "ws",
    "privacy",
    "/tmp/deer-privacy",
    clock.now(),
  );
  cleanups.push(() => store.close());
  return { store, memory, service: new MemoryService(memory), ws: "ws" };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const human: MemoryActor = { kind: "human", id: "human", name: "user" };
const agentA: MemoryActor = { kind: "agent", id: "agent-a", name: "a" };
const agentB: MemoryActor = { kind: "agent", id: "agent-b", name: "b" };

describe("MemoryService privacy and governance", () => {
  it("filters memo owner at every service/read/context layer", () => {
    const { memory, service, ws } = setup();
    const a = unwrap(service.createMemo(agentA, { workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "alpha secret a" }));
    const b = unwrap(service.createMemo(agentB, { workspaceId: ws, agentId: "agent-b", kind: "lesson", content: "alpha secret b" }));

    const aSearch = service.search(agentA, { workspaceId: ws, query: "secret" });
    expect(aSearch.hits.map((hit) => hit.id)).toEqual([a.id]);
    expect(aSearch.hits.some((hit) => hit.id === b.id)).toBe(false);

    const forced = service.search(agentA, { workspaceId: ws, agentId: "agent-b", query: "secret" });
    expect(forced.hits.some((hit) => hit.id === b.id)).toBe(false);

    expect(service.listMemos(agentA, ws, "agent-b")).toEqual([]);
    expect(service.listMemos(human, ws, "agent-b").map((memo) => memo.id)).toEqual([b.id]);
    expect(memory.search({ workspaceId: ws, query: "secret" }).hits.some((hit) => hit.entityType === "memo")).toBe(false);

    const aSnapshot = service.snapshot(agentA, ws);
    expect(aSnapshot.memos.map((memo) => memo.id)).toEqual([a.id]);
    expect(aSnapshot.proposals).toEqual([]);
    const humanSnapshot = service.snapshot(human, ws, { agentId: "agent-b" });
    expect(humanSnapshot.memos.map((memo) => memo.id)).toEqual([b.id]);
  });

  it("makes pin/verify/archive/decide/promote human-only with canonical errors", () => {
    const { store, memory, service, ws } = setup();
    const entry = unwrap(service.postBoard(human, {
      workspaceId: ws,
      board: "backend",
      kind: "fact",
      content: "governed fact",
    }));
    const memo = unwrap(service.createMemo(agentA, { workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "private memo" }));

    const forbidden = [
      service.setBoardPinned(agentA, ws, entry.id, true),
      service.verifyBoardEntry(agentA, ws, entry.id),
      service.proposeBoardArchive(agentA, ws, entry.id),
      service.promoteBoardEntry(agentA, ws, entry.id),
      service.archiveMemo(agentA, ws, "agent-a", memo.id),
      service.promoteMemo(agentA, ws, "agent-a", memo.id, "backend"),
      service.sweep(agentA, ws),
    ];
    for (const result of forbidden) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MEMORY_FORBIDDEN");
    }
    expect(memory.getBoard(ws, entry.id)?.pinned).toBe(false);
    expect(memory.getMemo(ws, "agent-a", memo.id)?.status).toBe("active");

    expect(unwrap(service.setBoardPinned(human, ws, entry.id, true)).pinned).toBe(true);
    const events = store.listEvents({ aggregateType: "memory" }).filter((event) => event.type === "memory.command_rejected");
    expect(events.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain("governed fact");
  });

  it("does not let an agent write another member's memo or include archived board data", () => {
    const { memory, service, ws } = setup();
    const foreign = service.createMemo(agentA, { workspaceId: ws, agentId: "agent-b", kind: "lesson", content: "nope" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("MEMORY_PRIVATE_SCOPE");

    const entry = unwrap(service.postBoard(human, { workspaceId: ws, board: "backend", kind: "fact", content: "archive me" }));
    memory.decideArchive({
      workspaceId: ws,
      proposalId: memory.proposeArchive({ workspaceId: ws, entryId: entry.id, proposedBy: "user" }).id,
      decision: "approve",
      actor: "user",
    });
    expect(service.listBoard(agentA, { workspaceId: ws, includeArchived: true })).toEqual([]);
    expect(service.listBoard(human, { workspaceId: ws, includeArchived: true })).toHaveLength(1);
  });
});
