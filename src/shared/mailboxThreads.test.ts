import { describe, expect, it } from "vitest";
import {
  MAILBOX_MAX_DEPTH,
  MAILBOX_MAX_INDENT,
  deriveMailboxThreads,
  filterMailboxThreads,
  mailboxParticipants,
  mailboxReadStorageKey,
  parseMailboxReadIds,
  pruneMailboxReadIds,
  serializeMailboxReadIds,
  totalMailboxUnread,
} from "./mailboxThreads";
import type { MailboxMessage } from "./types";

let seq = 0;

function message(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    workspaceId: "ws",
    threadId: `thread-${seq}`,
    from: "Router",
    to: ["Builder"],
    kind: "request",
    subject: "subject",
    body: "body",
    refs: [],
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    ...overrides,
  };
}

describe("t356 mailbox thread projection", () => {
  it("keeps legacy messages without parentId as independent threads when thread ids differ", () => {
    const first = message({ subject: "one" });
    const second = message({ subject: "two", threadId: "other" });
    const threads = deriveMailboxThreads([second, first]);
    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.threadId)).toEqual([second.id, first.id]);
    expect(threads.every((thread) => thread.messages[0].parentId === null)).toBe(true);
  });

  it("groups existing thread_id rows and derives a linear parent chain", () => {
    const root = message({ threadId: "t1", subject: "thread title" });
    const reply = message({
      threadId: "t1",
      from: "Builder",
      to: ["Router"],
      body: "reply body",
    });
    const threads = deriveMailboxThreads([reply, root]);
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe(root.id);
    expect(threads[0].threadKey).toBe("t1");
    expect(threads[0].messages.map((entry) => entry.message.id)).toEqual([root.id, reply.id]);
    expect(threads[0].messages[1].parentId).toBe(root.id);
    expect(threads[0].messages[1].depth).toBe(1);
    expect(threads[0].participants).toEqual(["Router", "Builder"]);
    expect(threads[0].subject).toBe("thread title");
    expect(threads[0].summary).toBe("reply body");
  });

  it("honors explicit parentId chains even when thread ids differ", () => {
    const root = message({ threadId: "root-key", subject: "root" });
    const child = message({ threadId: "child-key", parentId: root.id, subject: "child" });
    const grandchild = message({ threadId: "grand-key", parentId: child.id, subject: "grand" });
    const threads = deriveMailboxThreads([grandchild, root, child]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((entry) => entry.parentId)).toEqual([null, root.id, child.id]);
    expect(threads[0].messages.map((entry) => entry.depth)).toEqual([0, 1, 2]);
    expect(threads[0].threadId).toBe(root.id);
  });

  it("supports real branch replies A→B and A→C instead of a createdAt chain", () => {
    const a = message({ threadId: "branch", subject: "A" });
    const b = message({ threadId: "branch", parentId: a.id, subject: "B" });
    const c = message({ threadId: "branch", parentId: a.id, subject: "C" });
    const threads = deriveMailboxThreads([c, b, a]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((entry) => entry.parentId)).toEqual([null, a.id, a.id]);
    expect(threads[0].messages.map((entry) => entry.depth)).toEqual([0, 1, 1]);
    expect(threads[0].messages[1].parentId).toBe(threads[0].messages[2].parentId);
  });

  it("aggregates unread and sorts by latest activity", () => {
    const older = message({ threadId: "old", createdAt: "2026-01-01T00:00:01Z" });
    const newerRoot = message({ threadId: "new", createdAt: "2026-01-01T00:00:02Z" });
    const newerReply = message({
      threadId: "new",
      createdAt: "2026-01-01T00:00:03Z",
    });
    const threads = deriveMailboxThreads([older, newerReply, newerRoot], new Set([older.id]));
    expect(threads[0].threadId).toBe(newerRoot.id);
    expect(threads[0].unreadCount).toBe(2);
    expect(threads[1].unreadCount).toBe(0);
    expect(totalMailboxUnread(threads)).toBe(2);
  });

  it("searches subject/summary/participants and filters by member", () => {
    const first = message({
      threadId: "a",
      subject: "Launch checklist",
      body: "Ready to ship",
      from: "Router",
      to: ["Builder"],
    });
    const second = message({
      threadId: "b",
      subject: "Review notes",
      body: "Please check",
      from: "Builder",
      to: ["Reviewer"],
    });
    const threads = deriveMailboxThreads([first, second]);
    expect(filterMailboxThreads(threads, "launch", null)).toHaveLength(1);
    expect(filterMailboxThreads(threads, "please check", null)).toHaveLength(1);
    expect(filterMailboxThreads(threads, "", "Reviewer")).toHaveLength(1);
    expect(filterMailboxThreads(threads, "missing", null)).toHaveLength(0);
    expect(mailboxParticipants(threads)).toEqual(["Builder", "Reviewer", "Router"]);
  });

  it("returns an empty projection for an empty mailbox", () => {
    expect(deriveMailboxThreads([])).toEqual([]);
    expect(totalMailboxUnread([])).toBe(0);
  });

  it("caps very deep chains at depth 12 and documents indent 6", () => {
    const root = message({ threadId: "deep", subject: "deep thread" });
    const chain = [root];
    for (let index = 1; index < 50; index += 1) {
      chain.push(message({ threadId: "deep", parentId: chain[index - 1].id }));
    }
    const threads = deriveMailboxThreads(chain);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages).toHaveLength(50);
    expect(threads[0].messages[0].depth).toBe(0);
    expect(threads[0].messages[MAILBOX_MAX_DEPTH].depth).toBe(MAILBOX_MAX_DEPTH);
    expect(threads[0].messages[49].depth).toBe(MAILBOX_MAX_DEPTH);
    expect(MAILBOX_MAX_INDENT).toBe(6);
  });

  it("round-trips read state through the workspace-scoped storage value after reload", () => {
    const key = mailboxReadStorageKey("ws-1");
    expect(key).toBe("deer.mailbox.read.ws-1");
    const saved = serializeMailboxReadIds(new Set(["msg-1", "msg-2"]));
    const afterReload = parseMailboxReadIds(saved);
    expect([...afterReload]).toEqual(["msg-1", "msg-2"]);
    expect(parseMailboxReadIds(null).size).toBe(0);
    expect(parseMailboxReadIds("{broken").size).toBe(0);
  });

  it("prunes read ids for archived or missing messages", () => {
    expect([...pruneMailboxReadIds(new Set(["a", "b", "gone"]), ["a", "b", "c"])]).toEqual([
      "a",
      "b",
    ]);
  });
});
