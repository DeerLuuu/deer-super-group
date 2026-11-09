import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import { FixedClock } from "./clock.js";
import { MemoryStore } from "./store.js";
import type { MemoryResult } from "./types.js";
import { DAY_MS } from "./types.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(options: { ftEnabled?: boolean; config?: Record<string, number> } = {}) {
  const store = new Store(":memory:");
  const clock = new FixedClock("2026-01-01T00:00:00.000Z");
  const memory = new MemoryStore(store, {
    clock,
    ftsEnabled: options.ftEnabled,
    config: options.config,
  });
  memory.db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "ws-test",
    "Memory test",
    "/tmp/deer-memory-test",
    clock.now(),
  );
  cleanups.push(() => store.close());
  return { store, clock, memory, ws: "ws-test" };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function createBoard(
  memory: MemoryStore,
  ws: string,
  content: string,
  extra: Partial<{
    board: string;
    kind: "fact" | "decision" | "question" | "warning" | "artifact" | "link";
    ttlDays: number | null;
    confidence: "low" | "medium" | "high";
    refs: string[];
    source: "user" | "agent" | "system";
  }> = {},
) {
  return memory.createBoard({
    workspaceId: ws,
    board: extra.board ?? "backend",
    author: "agent:ray",
    kind: extra.kind ?? "fact",
    content,
    ttlDays: extra.ttlDays,
    confidence: extra.confidence,
    refs: extra.refs,
    source: extra.source ?? "agent",
  });
}

describe("MemoryStore migration and schema", () => {
  it("migrates legacy rows, creates a backup, and is idempotent", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deer-memory-mig-"));
    const dbPath = path.join(dir, "deer.db");
    const store = new Store(dbPath);
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const legacy = store.postBoard({
      workspaceId: "ws-old",
      board: "Legacy",
      author: "Router",
      kind: "fact",
      content: "legacy alpha fact",
    });
    store.addMemo({ workspaceId: "ws-old", agentId: "agent-old", kind: "lesson", content: "legacy memo" });
    store.saveSummary({
      taskId: "task-old",
      runId: "run-old",
      goal: "legacy summary",
      changes: [],
      files: [],
      tests: [],
      decisions: [],
      risks: [],
      openQuestions: [],
    });

    const memory = new MemoryStore(store, { clock: new FixedClock("2026-01-01T00:00:00.000Z") });
    expect(memory.schemaVersion).toBe(1);
    expect(memory.backupPath).not.toBeNull();
    expect(existsSync(memory.backupPath as string)).toBe(true);
    expect((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);

    const board = memory.getBoard("ws-old", legacy.id);
    expect(board?.source).toBe("agent");
    expect(board?.status).toBe("active");
    expect(board?.contentHash).toHaveLength(64);
    expect(memory.listMemos("ws-old", "agent-old")[0]?.status).toBe("active");
    expect(memory.getSummaryForTask("task-old")?.contentHash).toHaveLength(64);
    expect(memory.snapshot("ws-old").domains[0]?.name).toBe("Legacy");

    const domainsBefore = memory.listDomains("ws-old").length;
    const reopened = new MemoryStore(store, { clock: new FixedClock("2026-01-01T00:00:00.000Z") });
    expect(reopened.schemaVersion).toBe(1);
    expect(reopened.listDomains("ws-old")).toHaveLength(domainsBefore);
  });

  it("rolls back additive DDL when migration is interrupted", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deer-memory-rollback-"));
    const dbPath = path.join(dir, "deer.db");
    const store = new Store(dbPath);
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(() => new MemoryStore(store, { migrationFault: "after-ddl" })).toThrow(/injected memory migration fault/);
    const columns = store.db.prepare("PRAGMA table_info(board_entries)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "source")).toBe(false);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_schema'").all();
    expect(tables).toHaveLength(0);

    const recovered = new MemoryStore(store, { clock: new FixedClock("2026-01-01T00:00:00.000Z") });
    expect(recovered.schemaVersion).toBe(1);
  });

  it("keeps old postBoard/addMemo/saveSummary call paths working after migration", () => {
    const { store, memory, ws } = setup();
    const oldBoard = store.postBoard({
      workspaceId: ws,
      board: "legacy",
      author: "Router",
      kind: "fact",
      content: "old path",
    });
    const oldMemo = store.addMemo({ workspaceId: ws, agentId: "a", kind: "lesson", content: "old memo" });
    expect(memory.getBoard(ws, oldBoard.id)?.content).toBe("old path");
    expect(memory.listMemos(ws, "a")[0]?.content).toBe("old memo");
    expect(oldMemo.agentId).toBe("a");
  });

  it("normalizes board domains and preserves memo provenance/tags", () => {
    const { memory, ws } = setup();
    const first = createBoard(memory, ws, "domain one", { board: "Frontend" });
    const second = createBoard(memory, ws, "domain two", { board: "  frontend  " });
    expect(first.board).toBe("Frontend");
    expect(second.board).toBe("frontend");
    expect(memory.listDomains(ws)).toHaveLength(1);
    const memo = memory.createMemo({
      workspaceId: ws,
      agentId: "agent-a",
      kind: "shortcut",
      content: "memo provenance",
      tags: ["ui", "ui", " keyboard "],
      sourceTaskId: "task-9",
      sourceRunId: "run-9",
      expiresInDays: 3,
    });
    expect(memo.tags).toEqual(["ui", "keyboard"]);
    expect(memo.sourceTaskId).toBe("task-9");
    expect(memo.sourceRunId).toBe("run-9");
    expect(memo.expiresAt).not.toBeNull();
  });
});

describe("MemoryStore lifecycle and governance primitives", () => {
  it("TTL expiry creates an entry snapshot and only explicit approval archives", () => {
    const { memory, clock, ws } = setup();
    const entry = createBoard(memory, ws, "expiring fact", { ttlDays: 1 });
    clock.advanceDays(2);
    const sweep = memory.sweep(ws);
    expect(sweep.ttlProposed).toBe(1);
    const proposals = memory.listProposals(ws, "pending");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].entrySnapshot?.contentPreview).toContain("expiring fact");
    expect(memory.getBoard(ws, entry.id)?.status).toBe("active");

    memory.decideArchive({ workspaceId: ws, proposalId: proposals[0].id, decision: "approve", actor: "user" });
    expect(memory.getBoard(ws, entry.id)?.status).toBe("archived");
    expect(memory.listBoard(ws)).toHaveLength(0);
    expect(memory.listBoard(ws, { includeArchived: true })).toHaveLength(1);
  });

  it("reject starts a 7-day cooldown; the next sweep does not immediately re-propose", () => {
    const { memory, clock, ws } = setup();
    createBoard(memory, ws, "rejected fact", { ttlDays: 1 });
    clock.advanceDays(2);
    expect(memory.sweep(ws).ttlProposed).toBe(1);
    const proposal = memory.listProposals(ws, "pending")[0];
    memory.decideArchive({ workspaceId: ws, proposalId: proposal.id, decision: "reject", actor: "user" });

    clock.advanceDays(1);
    expect(memory.sweep(ws).ttlProposed).toBe(0);
    expect(memory.listProposals(ws, "pending")).toHaveLength(0);

    clock.advanceDays(7);
    expect(memory.sweep(ws).ttlProposed).toBe(1);
    expect(memory.listProposals(ws, "pending")).toHaveLength(1);
  });

  it("stale boundary is 29.9d/30d/31d and uses verifiedAt before createdAt", () => {
    const { memory, clock, ws } = setup();
    const entry = createBoard(memory, ws, "stale boundary");
    clock.advanceDays(29.9);
    memory.sweep(ws);
    expect(memory.getBoard(ws, entry.id)?.stale).toBe(false);
    clock.advanceMs(DAY_MS * 0.1);
    memory.sweep(ws);
    expect(memory.getBoard(ws, entry.id)?.stale).toBe(true);
    clock.advanceDays(1);
    memory.sweep(ws);
    expect(memory.getBoard(ws, entry.id)?.stale).toBe(true);

    const verified = createBoard(memory, ws, "verified boundary");
    clock.advanceDays(10);
    memory.verifyBoard(ws, verified.id, "user");
    clock.advanceDays(20);
    memory.sweep(ws);
    expect(memory.getBoard(ws, verified.id)?.stale).toBe(false);
    clock.advanceDays(10);
    memory.sweep(ws);
    expect(memory.getBoard(ws, verified.id)?.stale).toBe(true);
  });

  it("keeps the proposal snapshot stable when the entry is verified after proposal", () => {
    const { memory, ws } = setup();
    const entry = createBoard(memory, ws, "snapshot fact");
    const proposal = memory.proposeArchive({ workspaceId: ws, entryId: entry.id, proposedBy: "user", reason: "manual" });
    expect(proposal.entrySnapshot?.lastVerifiedAt).toBeNull();
    memory.verifyBoard(ws, entry.id, "user");
    const superseded = memory.listProposals(ws, "superseded")[0];
    expect(superseded.entrySnapshot?.lastVerifiedAt).toBeNull();
    expect(memory.getBoard(ws, entry.id)?.lastVerifiedAt).not.toBeNull();
  });

  it("memo expiry and human-only low-level mutation are auditable", () => {
    const { store, memory, clock, ws } = setup();
    const memo = memory.createMemo({
      workspaceId: ws,
      agentId: "agent-memo",
      kind: "lesson",
      content: "short lived memo",
      expiresInDays: 1,
    });
    clock.advanceDays(2);
    memory.sweep(ws);
    expect(memory.listMemos(ws, "agent-memo").find((item) => item.id === memo.id)?.status).toBe("expired");
    expect(memory.getMemo(ws, "agent-memo", memo.id)?.content).toContain("short lived");
    const events = store.listEvents({ aggregateType: "memo" });
    expect(events.some((event) => event.type === "memo.created")).toBe(true);
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain("short lived memo");
  });

  it("Run success only refreshes board evidenceAt, never memo evidence", () => {
    const { memory, clock, ws } = setup();
    const board = createBoard(memory, ws, "evidence board", { refs: ["task:t1", "run:r1"] });
    const memo = memory.createMemo({ workspaceId: ws, agentId: "a", kind: "lesson", content: "evidence memo", sourceTaskId: "t1" });
    clock.advanceDays(1);
    expect(memory.onRunCompleted("t1", "r1", ws)).toBe(1);
    expect(memory.getBoard(ws, board.id)?.evidenceAt).not.toBeNull();
    expect(memory.getMemo(ws, "a", memo.id)?.lastVerifiedAt).toBeNull();
  });

  it("summary upsert is idempotent by run and content hash is stable", () => {
    const { memory, store, ws } = setup();
    const first = memory.saveSummary({
      taskId: "task-1",
      runId: "run-1",
      workspaceId: ws,
      goal: "done",
      changes: ["a"],
      outcome: "completed",
    });
    const second = memory.saveSummary({
      taskId: "task-1",
      runId: "run-1",
      workspaceId: ws,
      goal: "done",
      changes: ["a"],
      outcome: "completed",
    });
    expect(second.id).toBe(first.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(memory.listSummaries(ws)).toHaveLength(1);
    const events = store.listEvents({ aggregateType: "memory" }).filter((event) => event.type === "memory.summary_ingested");
    expect(events).toHaveLength(1);
  });
});
