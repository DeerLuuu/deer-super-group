import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { deriveMailboxThreads } from "../shared/mailboxThreads.js";

const roots: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "deer-mailbox-parent-"));
  roots.push(dir);
  return path.join(dir, "deer.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort on Windows
    }
  }
});

describe("t409 messages.parent_id persistence", () => {
  it("persists parentId through addMessage and survives a Store reopen", () => {
    const databasePath = tempDb();
    let store = new Store(databasePath);
    const root = store.addMessage({
      workspaceId: "ws-parent",
      from: "Router",
      to: ["Builder"],
      kind: "request",
      subject: "root",
      body: "root body",
      threadId: "thread-parent",
    });
    const reply = store.addMessage({
      workspaceId: "ws-parent",
      from: "Builder",
      to: ["Router"],
      kind: "report",
      subject: "reply",
      body: "reply body",
      threadId: "thread-parent",
      parentId: root.id,
    });
    const branch = store.addMessage({
      workspaceId: "ws-parent",
      from: "Reviewer",
      to: ["Router"],
      kind: "report",
      subject: "branch",
      body: "branch body",
      threadId: "thread-parent",
      parentId: root.id,
    });
    expect(reply.parentId).toBe(root.id);
    expect(branch.parentId).toBe(root.id);
    expect(store.listMessages("ws-parent").find((message) => message.id === reply.id)?.parentId).toBe(root.id);
    const projected = deriveMailboxThreads(store.listMessages("ws-parent"));
    expect(projected).toHaveLength(1);
    const projectedById = new Map(projected[0].messages.map((entry) => [entry.message.id, entry]));
    expect(projectedById.get(root.id)?.parentId).toBeNull();
    expect(projectedById.get(reply.id)?.parentId).toBe(root.id);
    expect(projectedById.get(branch.id)?.parentId).toBe(root.id);
    expect(projectedById.get(reply.id)?.depth).toBe(1);
    expect(projectedById.get(branch.id)?.depth).toBe(1);
    store.close();

    store = new Store(databasePath);
    try {
      const reloaded = store.listMessages("ws-parent");
      expect(reloaded.find((message) => message.id === root.id)?.parentId).toBeUndefined();
      expect(reloaded.find((message) => message.id === reply.id)?.parentId).toBe(root.id);
      expect(reloaded.find((message) => message.id === branch.id)?.parentId).toBe(root.id);
    } finally {
      store.close();
    }
  });

  it("adds nullable parent_id to an old messages table idempotently", () => {
    const databasePath = tempDb();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agents TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      INSERT INTO messages (id, workspace_id, thread_id, from_agent, to_agents, kind, subject, body, refs, created_at)
      VALUES ('legacy-1', 'ws-migrate', 'thread-legacy', 'Router', '["Builder"]', 'request', 'legacy', 'body', '[]', '2026-01-01T00:00:00Z');
    `);
    legacy.close();

    let store = new Store(databasePath);
    try {
      const columns = (store as unknown as { db: DatabaseSync }).db
        .prepare("PRAGMA table_info(messages)")
        .all() as Array<{ name?: string }>;
      expect(columns.filter((column) => column.name === "parent_id")).toHaveLength(1);
      expect(store.listMessages("ws-migrate")[0].parentId).toBeUndefined();
      store.addMessage({
        workspaceId: "ws-migrate",
        from: "Builder",
        to: ["Router"],
        kind: "report",
        subject: "reply",
        body: "body",
        threadId: "thread-legacy",
        parentId: "legacy-1",
      });
      expect(store.listMessages("ws-migrate").find((message) => message.subject === "reply")?.parentId).toBe("legacy-1");
    } finally {
      store.close();
    }

    // 第二次打开不应重复 ALTER；旧行仍为 NULL。
    store = new Store(databasePath);
    try {
      const columns = (store as unknown as { db: DatabaseSync }).db
        .prepare("PRAGMA table_info(messages)")
        .all() as Array<{ name?: string }>;
      expect(columns.filter((column) => column.name === "parent_id")).toHaveLength(1);
      expect(store.listMessages("ws-migrate").find((message) => message.id === "legacy-1")?.parentId).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
