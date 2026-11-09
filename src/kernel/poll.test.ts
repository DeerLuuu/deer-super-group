import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import type { CreatePollInput } from "../shared/poll.js";
import { PollError } from "../shared/poll.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-poll-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const store = new Store(path.join(root, "deer.db"));
  const dbPath = path.join(root, "deer.db");
  const workspace = store.createWorkspace("workspace", workspacePath);
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, workspace, dbPath };
}

function createInput(workspaceId: string, overrides: Partial<CreatePollInput> = {}): CreatePollInput {
  return {
    workspaceId,
    scope: "team",
    title: "下一轮实现哪个系统？",
    mode: "multi",
    maxSelections: 3,
    thresholdRule: "gt",
    thresholdValue: 3,
    quorum: 0,
    options: [
      { label: "Poll" },
      { label: "Watchdog" },
      { label: "Review" },
      { label: "MCP" },
    ],
    createdBy: "user",
    ...overrides,
  };
}

describe("t136 poll store", () => {
  it("adds poll tables to an existing database and keeps polls after reopen", () => {
    const { store, workspace, dbPath } = setup();
    const poll = store.createPoll(createInput(workspace.id, { options: [{ label: "A" }, { label: "B" }], maxSelections: 1 }));
    store.db.exec("DROP TABLE poll_decisions; DROP TABLE poll_ballots; DROP TABLE poll_options; DROP TABLE polls;");
    const reopened = new Store(dbPath);
    cleanups.push(() => reopened.close());
    const tables = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'poll%'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining(["polls", "poll_options", "poll_ballots", "poll_decisions"]));
    expect(reopened.getPoll(poll.id)).toBeNull();
    expect(reopened.listPolls(workspace.id)).toEqual([]);
  });

  it("creates multi/single polls with selections, threshold and quorum metadata", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id, {
      closesAt: new Date(Date.now() + 60_000).toISOString(),
      quorum: 2,
      anonymous: true,
    }));
    expect(poll.status).toBe("open");
    expect(poll.mode).toBe("multi");
    expect(poll.maxSelections).toBe(3);
    expect(poll.thresholdRule).toBe("gt");
    expect(poll.thresholdValue).toBe(3);
    expect(poll.quorum).toBe(2);
    expect(poll.anonymous).toBe(true);
    expect(poll.options).toHaveLength(4);
    expect(poll.result.totalBallots).toBe(0);
    expect(store.listEvents({ aggregateId: poll.id }).some((event) => event.type === "poll.created")).toBe(true);
    expect(store.listEvents({ aggregateId: poll.id }).some((event) => event.type === "poll.opened")).toBe(true);

    const single = store.createPoll(createInput(workspace.id, { mode: "single", maxSelections: 1 }));
    expect(single.mode).toBe("single");
    expect(single.maxSelections).toBe(1);
    expect(single.status).toBe("open");
  });

  it("rejects invalid single/multi selections and deadline/closed casts", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id));
    expect(() => store.castPoll({ pollId: poll.id, voterId: "user", voterType: "human", selections: [poll.options[0].id, poll.options[1].id, poll.options[2].id, poll.options[3].id] }))
      .toThrow(PollError);
    expect(() => store.castPoll({ pollId: poll.id, voterId: "user", voterType: "human", selections: ["not-an-option"] }))
      .toThrow(PollError);

    const single = store.createPoll(createInput(workspace.id, { mode: "single", maxSelections: 1, options: [{ label: "A" }, { label: "B" }] }));
    expect(() => store.castPoll({ pollId: single.id, voterId: "user", voterType: "human", selections: [single.options[0].id, single.options[1].id] }))
      .toThrow(PollError);

    const expired = store.createPoll(createInput(workspace.id, { maxSelections: 1, options: [{ label: "A" }, { label: "B" }] }));
    store.db.prepare("UPDATE polls SET closes_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.id);
    const refreshed = store.getPoll(expired.id);
    expect(refreshed?.status).toBe("expired");
    expect(store.listEvents({ aggregateId: expired.id }).some((event) => event.type === "poll.expired")).toBe(true);
    expect(() => store.castPoll({ pollId: expired.id, voterId: "user", voterType: "human", selections: [expired.options[0].id] }))
      .toThrow(PollError);

    const closed = store.createPoll(createInput(workspace.id, { maxSelections: 1, options: [{ label: "A" }, { label: "B" }] }));
    store.closePoll({ pollId: closed.id, actor: "user" });
    expect(() => store.castPoll({ pollId: closed.id, voterId: "user", voterType: "human", selections: [closed.options[0].id] }))
      .toThrow(PollError);
  });

  it("updates one ballot on repeated cast, does not duplicate, and emits poll.voted", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id, { options: [{ label: "A" }, { label: "B" }, { label: "C" }], maxSelections: 2 }));
    const first = store.castPoll({ pollId: poll.id, voterId: "user", voterType: "human", selections: [poll.options[0].id, poll.options[1].id] });
    expect(first.ballots).toHaveLength(1);
    expect(first.ballots[0].revision).toBe(1);

    const again = store.castPoll({ pollId: poll.id, voterId: "user", voterType: "human", selections: [poll.options[0].id, poll.options[1].id] });
    expect(again.ballots).toHaveLength(1);
    expect(again.ballots[0].revision).toBe(1);

    const changed = store.castPoll({ pollId: poll.id, voterId: "user", voterType: "human", selections: [poll.options[2].id] });
    expect(changed.ballots).toHaveLength(1);
    expect(changed.ballots[0].revision).toBe(2);
    expect(changed.ballots[0].selections).toEqual([poll.options[2].id]);
    expect(store.listEvents({ aggregateId: poll.id }).filter((event) => event.type === "poll.voted")).toHaveLength(2);
  });

  it("adopts >3 options, writes decision to board and is idempotent on close", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id));
    const voters = ["u1", "u2", "u3", "u4", "u5"];
    voters.forEach((voterId) => {
      store.castPoll({
        pollId: poll.id,
        voterId,
        voterType: "human",
        selections: [poll.options[0].id],
      });
    });
    const closed = store.closePoll({ pollId: poll.id, actor: "user", reason: "meeting" });
    expect(closed.status).toBe("closed");
    expect(closed.result.totalBallots).toBe(5);
    expect(closed.result.adoptedOptionIds).toEqual([poll.options[0].id]);
    expect(closed.decision).not.toBeNull();
    expect(closed.decision?.boardEntryId).toBeTruthy();
    const board = store.db.prepare("SELECT kind, content FROM board_entries WHERE id = ?").get(closed.decision?.boardEntryId ?? "") as { kind: string; content: string };
    expect(board.kind).toBe("decision");
    expect(board.content).toContain("采纳");
    const again = store.closePoll({ pollId: poll.id, actor: "user" });
    expect(again.decision?.id).toBe(closed.decision?.id);
    expect(store.listEvents({ aggregateId: poll.id }).filter((event) => event.type === "poll.closed")).toHaveLength(1);
    expect(store.listEvents({ aggregateId: poll.id }).filter((event) => event.type === "poll.decided")).toHaveLength(1);
  });

  it("does not adopt when quorum is missing and still records an auditable decision", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id, { quorum: 3, thresholdValue: 1, maxSelections: 1, options: [{ label: "A" }, { label: "B" }] }));
    store.castPoll({ pollId: poll.id, voterId: "u1", voterType: "human", selections: [poll.options[0].id] });
    const closed = store.closePoll({ pollId: poll.id, actor: "user" });
    expect(closed.result.quorumMet).toBe(false);
    expect(closed.result.insufficientQuorum).toBe(true);
    expect(closed.result.adoptedOptionIds).toEqual([]);
    expect(closed.decision?.insufficientQuorum).toBe(true);
    expect(closed.decision?.boardEntryId).toBeNull();
    expect(closed.decision?.summary).toContain("quorum");
  });

  it("enforces close permission and voter workspace ownership", () => {
    const { store, workspace } = setup();
    const poll = store.createPoll(createInput(workspace.id, { maxSelections: 1, options: [{ label: "A" }, { label: "B" }] }));
    expect(() => store.castPoll({ pollId: poll.id, voterId: "agent-missing", voterType: "agent", selections: [poll.options[0].id] }))
      .toThrow(PollError);
    expect(() => store.closePoll({ pollId: poll.id, actor: "someone-else" })).toThrow(PollError);
    expect(store.getPoll(poll.id)?.status).toBe("open");
  });
});
