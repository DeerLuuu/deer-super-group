import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import { FixedClock } from "./clock.js";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";
import { compareIds } from "./retrieval.js";
import { DAY_MS, MemoryError, type MemoryActor, type MemoryResult } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const human: MemoryActor = { kind: "human", name: "user" };
const agentA: MemoryActor = { kind: "agent", id: "agent-a", name: "a" };
const agentB: MemoryActor = { kind: "agent", id: "agent-b", name: "b" };

function seedWorkspace(store: Store, id: string, now: string) {
  store.db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    id,
    `/tmp/${id}`,
    now,
  );
}

function seedAgent(store: Store, ws: string, id: string, name: string, now: string) {
  store.db.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, role, created_at) VALUES (?, ?, ?, 'member', ?)",
  ).run(id, ws, name, now);
}

function seedTaskRun(store: Store, ws: string, taskId: string, runId: string, agentId: string, now: string) {
  store.db.prepare(
    "INSERT OR IGNORE INTO tasks (id, workspace_id, title, description, acceptance, status, owner_id, depends_on, created_at) VALUES (?, ?, ?, '', '[]', 'done', ?, '[]', ?)",
  ).run(taskId, ws, taskId, agentId, now);
  store.db.prepare(
    "INSERT OR IGNORE INTO runs (id, task_id, agent_id, status, started_at, token_in, token_out) VALUES (?, ?, ?, 'completed', ?, 0, 0)",
  ).run(runId, taskId, agentId, now);
}

function setup(clockIso = "2026-05-01T00:00:00.000Z") {
  const store = new Store(":memory:");
  const clock = new FixedClock(clockIso);
  const memory = new MemoryStore(store, { clock });
  seedWorkspace(store, "ws", clockIso);
  seedAgent(store, "ws", "agent-a", "a", clockIso);
  seedAgent(store, "ws", "agent-b", "b", clockIso);
  cleanups.push(() => store.close());
  return { store, clock, memory, service: new MemoryService(memory), ws: "ws" };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function board(memory: MemoryStore, ws: string, content: string, extra: { author?: string; kind?: "fact" | "decision"; ttlDays?: number | null; pinned?: boolean; confidence?: "low" | "medium" | "high" } = {}) {
  return memory.createBoard({
    workspaceId: ws,
    board: "backend",
    author: extra.author ?? "agent:ray",
    kind: extra.kind ?? "fact",
    content,
    ttlDays: extra.ttlDays,
    pinned: extra.pinned,
    confidence: extra.confidence,
    source: "agent",
  });
}

describe("t105 repair: source/agent migration", () => {
  it("infers user/agent source and source_ref during migration and for old Store paths", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deer-repair-source-"));
    const store = new Store(path.join(dir, "deer.db"));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const now = "2026-05-01T00:00:00.000Z";
    seedWorkspace(store, "ws", now);
    seedAgent(store, "ws", "agent-ray", "Ray", now);
    const userBoard = store.postBoard({ workspaceId: "ws", board: "backend", author: "user", kind: "fact", content: "user fact" });
    const agentBoard = store.postBoard({ workspaceId: "ws", board: "backend", author: "Ray", kind: "fact", content: "agent fact" });
    const memo = store.addMemo({ workspaceId: "ws", agentId: "agent-ray", kind: "lesson", content: "memo" });
    const memory = new MemoryStore(store, { clock: new FixedClock(now) });
    expect(memory.getBoard("ws", userBoard.id)?.source).toBe("user");
    expect(memory.getBoard("ws", userBoard.id)?.sourceRef).toBeNull();
    expect(memory.getBoard("ws", agentBoard.id)?.source).toBe("agent");
    expect(memory.getBoard("ws", agentBoard.id)?.sourceRef).toBe("agent-ray");
    expect(memory.listMemos("ws", "agent-ray")[0]?.sourceRef).toBe("agent-ray");
    expect(memory.listMemos("ws", "agent-ray")[0]?.id).toBe(memo.id);

    // Legacy Store paths after migration are covered by triggers.
    const legacyUser = store.postBoard({ workspaceId: "ws", board: "backend", author: "user", kind: "fact", content: "legacy user" });
    const legacyAgent = store.postBoard({ workspaceId: "ws", board: "backend", author: "Ray", kind: "fact", content: "legacy agent" });
    const legacyMemo = store.addMemo({ workspaceId: "ws", agentId: "agent-ray", kind: "lesson", content: "legacy memo" });
    expect(memory.getBoard("ws", legacyUser.id)?.source).toBe("user");
    expect(memory.getBoard("ws", legacyAgent.id)?.sourceRef).toBe("agent-ray");
    expect(memory.getMemo("ws", "agent-ray", legacyMemo.id)?.sourceRef).toBe("agent-ray");

    // Upgrade path: a v2 database has name-based source_ref and old triggers.
    store.db.prepare("UPDATE board_entries SET source_ref = 'Ray' WHERE id = ?").run(agentBoard.id);
    store.db.exec("DROP TRIGGER IF EXISTS trg_board_source_user; DROP TRIGGER IF EXISTS trg_board_source_ref; DROP TRIGGER IF EXISTS trg_memo_source_ref;");
    store.db.exec("UPDATE memory_schema SET version = 2 WHERE version = 3");
    const upgraded = new MemoryStore(store, { clock: new FixedClock(now) });
    expect(upgraded.schemaVersion).toBe(3);
    expect(upgraded.getBoard("ws", agentBoard.id)?.sourceRef).toBe("agent-ray");
    const triggers = store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>;
    expect(triggers.map((row) => row.name)).toEqual(expect.arrayContaining(["trg_board_source_user", "trg_board_source_ref", "trg_memo_source_ref"]));
  });

  it("guards early board_archive_proposals tables without entry_snapshot", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    seedWorkspace(store, "ws", "2026-05-01T00:00:00.000Z");
    store.db.exec(`
      CREATE TABLE board_archive_proposals (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, board TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', proposed_by TEXT NOT NULL,
        proposed_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, note TEXT
      );
      INSERT INTO board_archive_proposals
        (id, workspace_id, entry_id, board, reason, status, proposed_by, proposed_at)
      VALUES ('old-prop', 'ws', 'old-entry', 'backend', 'manual', 'pending', 'user', '2026-05-01T00:00:00.000Z');
    `);
    const memory = new MemoryStore(store, { clock: new FixedClock("2026-05-01T00:00:00.000Z") });
    const columns = store.db.prepare("PRAGMA table_info(board_archive_proposals)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "entry_snapshot")).toBe(true);
    expect(memory.listProposals("ws", "pending")[0]?.entrySnapshot).toBeNull();
  });

  it("backfills and writes summaries.agent_id from task.owner_id/run.agent_id", () => {
    const store = new Store(":memory:");
    const clock = new FixedClock("2026-05-01T00:00:00.000Z");
    cleanups.push(() => store.close());
    seedWorkspace(store, "ws", clock.now());
    seedAgent(store, "ws", "agent-a", "a", clock.now());
    seedTaskRun(store, "ws", "task-a", "run-a", "agent-a", clock.now());
    const legacy = store.saveSummary({
      taskId: "task-a",
      runId: "run-a",
      goal: "legacy",
      changes: [],
      files: [],
      tests: [],
      decisions: [],
      risks: [],
      openQuestions: [],
    });
    const migratedStore = new MemoryStore(store, { clock });
    expect(migratedStore.getSummaryForTask("task-a")?.agentId).toBe("agent-a");
    expect(migratedStore.getSummaryForTask("task-a")?.id).toBe(legacy.id);
    const fresh = migratedStore.saveSummary({
      taskId: "task-a",
      runId: "run-a",
      workspaceId: "ws",
      goal: "fresh",
      agentId: "agent-a",
    });
    expect(fresh.agentId).toBe("agent-a");
  });
});

describe("t105 repair: context budget and working layers", () => {
  it("uses the min(window*15%, remaining, mode cap) formula and skips under 200", () => {
    const { store, service, ws } = setup();
    const small = service.buildContext({ workspaceId: ws, actor: agentA, mode: "worker", contextWindow: 1000, remainingTokens: 150 });
    expect(small.maxTokens).toBe(150);
    expect(small.text).toBe("");
    expect(small.skippedReason).toBe("budget");
    expect(store.listEvents({ aggregateType: "memory" }).some((event) => event.type === "memory.context_skipped")).toBe(true);

    const explicit = service.buildContext({ workspaceId: ws, actor: agentA, mode: "worker", budgetTokens: 100 });
    expect(explicit.maxTokens).toBe(100);
    expect(explicit.text).toBe("");

    const remaining = service.buildContext({ workspaceId: ws, actor: agentA, mode: "router", contextWindow: 2000, remainingTokens: 400 });
    expect(remaining.maxTokens).toBe(300);
  });

  it("catches injection errors and returns an empty degraded context", () => {
    const { store, memory, ws } = setup();
    const faulty = new MemoryService(memory, { contextFault: "throw" });
    const context = faulty.buildContext({ workspaceId: ws, actor: agentA, mode: "worker" });
    expect(context.text).toBe("");
    expect(context.degradedReason).toBe("CONTEXT_FAILED");
    expect(store.listEvents({ aggregateType: "memory" }).some((event) => event.type === "memory.context_failed")).toBe(true);
  });

  it("assembles dependency summaries, pinned/decision prelude, working cap and budget", () => {
    const { store, memory, service, clock, ws } = setup();
    for (let i = 0; i < 4; i += 1) {
      seedTaskRun(store, ws, `dep-${i}`, `run-dep-${i}`, "agent-a", clock.now());
      memory.saveSummary({
        taskId: `dep-${i}`,
        runId: `run-dep-${i}`,
        workspaceId: ws,
        goal: `dependency ${i} summary`,
        outcome: "completed",
      });
    }
    for (let i = 0; i < 4; i += 1) {
      board(memory, ws, `pinned decision ${i}`, { kind: "decision", pinned: true, confidence: "high", author: `agent:pinned-${i}` });
    }
    const context = service.buildContext({
      workspaceId: ws,
      actor: agentA,
      mode: "worker",
      taskId: "task-main",
      taskTitle: "main",
      dependencies: ["dep-0", "dep-1", "dep-2", "dep-3"],
      budgetTokens: 1200,
      contextWindow: 20_000,
      remainingTokens: 1200,
    });
    const working = context.sections.find((section) => section.layer === "working");
    expect(working?.lines.filter((line) => line.includes("dependency")).length).toBe(3);
    expect(working?.lines.length).toBeLessThanOrEqual(4);
    expect(context.hits.filter((hit) => hit.entityType === "board").length).toBeLessThanOrEqual(3);
    expect(context.usedTokens).toBeLessThanOrEqual(context.maxTokens);
    expect(context.text).toContain("Working memory");

    const tight = service.buildContext({
      workspaceId: ws,
      actor: agentA,
      mode: "worker",
      taskId: "task-main",
      taskTitle: "main",
      dependencies: ["dep-0", "dep-1", "dep-2", "dep-3"],
      budgetTokens: 400,
      contextWindow: 20_000,
      remainingTokens: 400,
    });
    expect(tight.usedTokens).toBeLessThanOrEqual(400);
    if (tight.text.length === 0) expect(tight.degradedReason ?? tight.skippedReason).toBeTruthy();
  });

  it("filters task-scoped decisions by refs so task A does not see task B decisions", () => {
    const { memory, service, ws } = setup();
    memory.createBoard({
      workspaceId: ws,
      board: "backend",
      author: "agent:ray",
      kind: "decision",
      content: "alpha decision task A",
      confidence: "high",
      refs: ["task:task-a"],
      source: "agent",
    });
    memory.createBoard({
      workspaceId: ws,
      board: "backend",
      author: "agent:ray2",
      kind: "decision",
      content: "alpha decision task B",
      confidence: "high",
      refs: ["task:task-b"],
      source: "agent",
    });
    const context = service.buildContext({
      workspaceId: ws,
      actor: agentA,
      mode: "router",
      taskId: "task-a",
      query: "alpha",
    });
    expect(context.text).toContain("decision task A");
    expect(context.text).not.toContain("decision task B");
  });
});

describe("t105 repair: validation, state matrix, sweep and privacy", () => {
  it("validates workspace/agent/task/run ownership at the store and service", () => {
    const { store, memory, service, clock, ws } = setup();
    seedWorkspace(store, "other", clock.now());
    seedAgent(store, "other", "agent-other", "other", clock.now());
    seedTaskRun(store, "other", "task-other", "run-other", "agent-other", clock.now());
    seedTaskRun(store, ws, "task-a", "run-a", "agent-a", clock.now());
    seedTaskRun(store, ws, "task-b", "run-b", "agent-b", clock.now());
    expect(() => memory.createBoard({ workspaceId: "missing", board: "b", author: "user", kind: "fact", content: "x" })).toThrow(MemoryError);
    expect(() => memory.createMemo({ workspaceId: ws, agentId: "agent-other", kind: "lesson", content: "x" })).toThrow(MemoryError);
    expect(() => memory.search({ workspaceId: "missing" })).toThrow(MemoryError);
    expect(() => memory.snapshot("missing")).toThrow(MemoryError);
    expect(() => memory.saveSummary({ taskId: "task-other", runId: "run-other", workspaceId: ws, goal: "x" })).toThrow(MemoryError);
    expect(service.postBoard({ kind: "agent", id: "agent-other", name: "other" }, { workspaceId: ws, board: "b", kind: "fact", content: "x" }).ok).toBe(false);
    expect(() => service.search(agentA, { workspaceId: "other" })).toThrow(MemoryError);
    const summary = service.saveSummary(agentA, { taskId: "task-other", runId: "run-other", workspaceId: "other", goal: "x" });
    expect(summary.ok).toBe(false);
    const foreignRun = service.saveSummary(agentA, { taskId: "task-b", runId: "run-b", workspaceId: ws, goal: "x" });
    expect(foreignRun.ok).toBe(false);
    const ownRun = service.saveSummary(agentA, { taskId: "task-a", runId: "run-a", workspaceId: ws, goal: "ok" });
    expect(ownRun.ok).toBe(true);
    if (ownRun.ok) expect(ownRun.value.agentId).toBe("agent-a");
    expect(service.onRunCompleted(agentB, "task-a", "run-a", ws).ok).toBe(false);

    const humanBoard = unwrap(service.postBoard(human, { workspaceId: ws, board: "backend", kind: "fact", content: "human board" }));
    expect(humanBoard.source).toBe("user");
    expect(humanBoard.sourceRef).toBeNull();
    const humanMemo = unwrap(service.createMemo(human, { workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "human memo" }));
    expect(humanMemo.sourceRef).toBe("agent-a");
  });

  it("blocks verify/promote on expired/archived entries and archive approval on non-active", () => {
    const { memory, clock, ws } = setup();
    const expired = board(memory, ws, "expired", { ttlDays: 1 });
    clock.advanceDays(2);
    expect(() => memory.verifyBoard(ws, expired.id, "user")).toThrow(MemoryError);
    expect(() => memory.promoteBoard(ws, expired.id, "user")).toThrow(MemoryError);
    const proposal = memory.proposeArchive({ workspaceId: ws, entryId: expired.id, proposedBy: "user" });
    expect(memory.decideArchive({ workspaceId: ws, proposalId: proposal.id, decision: "approve", actor: "user" }).status).toBe("approved");
    expect(() => memory.decideArchive({ workspaceId: ws, proposalId: proposal.id, decision: "approve", actor: "user" })).toThrow(MemoryError);
    expect(() => memory.verifyBoard(ws, expired.id, "user")).toThrow(MemoryError);
    expect(() => memory.promoteBoard(ws, expired.id, "user")).toThrow(MemoryError);

    const memo = memory.createMemo({ workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "expiring memo", expiresInDays: 1 });
    clock.advanceDays(2);
    expect(() => memory.verifyMemo(ws, "agent-a", memo.id, "user")).toThrow(MemoryError);
    expect(() => memory.promoteMemo(ws, "agent-a", memo.id, "user", "backend")).toThrow(MemoryError);
  });

  it("isolates sweep per workspace, emits failure/expiry events and counts only 0->1 stale", () => {
    const { store, memory, clock, ws } = setup();
    seedWorkspace(store, "ws2", clock.now());
    seedAgent(store, "ws2", "agent-a", "a", clock.now());
    board(memory, ws, "ws1 stale");
    board(memory, "ws2", "ws2 stale");
    clock.advanceDays(31);
    const failed = memory.sweep(undefined, { faultWorkspace: "ws2" });
    expect(failed.failedWorkspaces).toBe(1);
    expect(store.listEvents({ aggregateType: "memory" }).some((event) => event.type === "memory.sweep_failed")).toBe(true);
    const second = memory.sweep(ws);
    expect(second.staleMarked).toBe(0);

    const memo = memory.createMemo({ workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "expiry event", expiresInDays: 1 });
    const propEntry = board(memory, ws, "proposal expiry", { ttlDays: 1 });
    clock.advanceDays(2);
    memory.sweep(ws);
    const proposal = memory.listProposals(ws, "pending").find((item) => item.entryId === propEntry.id);
    expect(proposal).toBeTruthy();
    clock.advanceDays(31);
    memory.sweep(ws);
    expect(store.listEvents({ aggregateType: "memo" }).some((event) => event.type === "memo.expired" && event.aggregateId === memo.id)).toBe(true);
    expect(store.listEvents({ aggregateType: "board" }).some((event) => event.type === "board.proposal_expired")).toBe(true);
  });

  it("does not merge local sweep counts when a fault rolls back after stale or proposal", () => {
    const { memory, clock, ws } = setup();
    const staleBoard = board(memory, ws, "stale fault board");
    clock.advanceDays(31);
    const staleFault = memory.sweep(ws, { faultAfter: "stale" });
    expect(staleFault.failedWorkspaces).toBe(1);
    expect(staleFault.staleMarked).toBe(0);
    const rawStale = memory.db.prepare("SELECT stale FROM board_entries WHERE id = ?").get(staleBoard.id) as { stale: number };
    expect(Number(rawStale.stale)).toBe(0);

    const ttl = board(memory, ws, "proposal fault board", { ttlDays: 1 });
    clock.advanceDays(2);
    const proposalFault = memory.sweep(ws, { faultAfter: "proposal" });
    expect(proposalFault.failedWorkspaces).toBe(1);
    expect(proposalFault.ttlProposed).toBe(0);
    expect(memory.listProposals(ws, "pending").some((proposal) => proposal.entryId === ttl.id)).toBe(false);
  });

  it("filters memos at SQL/load and counts only the agent's own memo stats", () => {
    const { store, service, memory, clock, ws } = setup();
    service.createMemo(agentA, { workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "alpha a" });
    service.createMemo(agentB, { workspaceId: ws, agentId: "agent-b", kind: "lesson", content: "alpha b" });
    const aSnap = service.snapshot(agentA, ws);
    const humanSnap = service.snapshot(human, ws);
    expect(aSnap.memos).toHaveLength(1);
    expect(aSnap.counts.memosActive).toBe(1);
    expect(humanSnap.memos).toHaveLength(0);
    expect(humanSnap.counts.memosActive).toBe(0);
    const search = memory.search({ workspaceId: ws, agentId: "agent-b", query: "alpha" });
    expect(search.hits.every((hit) => hit.entityType !== "memo" || hit.agentId === "agent-b")).toBe(true);
    expect(clock.now()).toBeTruthy();
  });
});

describe("t105 repair: dedupe/diversity and comparator", () => {
  it("merges same-source citations and caps each board/agent to three hits", () => {
    const { memory, ws } = setup();
    const first = board(memory, ws, "alpha same source one");
    const second = board(memory, ws, "alpha same source two");
    const sameSource = memory.search({ workspaceId: ws, query: "alpha", limit: 50 });
    expect(sameSource.hits).toHaveLength(1);
    expect(sameSource.hits[0]?.sourceRef).toBe("agent:ray");
    expect(new Set(sameSource.hits[0]?.citations)).toEqual(new Set([`board:${first.id}`, `board:${second.id}`]));

    for (let i = 0; i < 5; i += 1) {
      board(memory, ws, `alpha diversity ${i}`, { author: `agent-${i}` });
    }
    const capped = memory.search({ workspaceId: ws, query: "alpha", limit: 50 });
    expect(capped.hits.filter((hit) => hit.entityType === "board").length).toBeLessThanOrEqual(3);
  });

  it("uses a locale-independent id comparator", () => {
    expect(compareIds("a", "B")).toBeGreaterThan(0);
    expect(compareIds("B", "a")).toBeLessThan(0);
    expect(compareIds("same", "same")).toBe(0);
    expect(compareIds("盲", "z")).toBeGreaterThan(0);
    expect([..."b,a,B,盲,z".split(",")].sort(compareIds)).toEqual(["B", "a", "b", "z", "盲"]);
  });
});

describe("t105 repair: limits and short content", () => {
  it("enforces 2000 chars, 10 tags, 24-char tags and kind/confidence enums", () => {
    const { memory, ws } = setup();
    expect(board(memory, ws, "x".repeat(2000)).id).toBeTruthy();
    expect(() => board(memory, ws, "x".repeat(2001))).toThrow(MemoryError);
    expect(() => memory.createMemo({ workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "x", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toThrow(MemoryError);
    expect(() => memory.createMemo({ workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "x", tags: ["x".repeat(25)] })).toThrow(MemoryError);
    expect(() => memory.createBoard({ workspaceId: ws, board: "b", author: "user", kind: "bogus" as never, content: "x" })).toThrow(MemoryError);
    expect(() => memory.createMemo({ workspaceId: ws, agentId: "agent-a", kind: "lesson", content: "x", confidence: "bogus" as never })).toThrow(MemoryError);
  });

  it("keeps selected ttl/stale behavior stable with numeric clock advances", () => {
    const { memory, clock, ws } = setup();
    const entry = board(memory, ws, "ttl one", { ttlDays: 1 });
    clock.advanceMs(DAY_MS * 0.999);
    expect(memory.getBoard(ws, entry.id)?.ttlAt).not.toBeNull();
    clock.advanceMs(DAY_MS * 0.002);
    expect(memory.sweep(ws).ttlProposed).toBe(1);
  });
});
