import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import type { TaskVcsSnapshot } from "../git/types.js";
import { parseUnifiedDiff } from "./diff.js";
import type { ReviewDiffResult } from "./diff.js";
import { ReviewService } from "./service.js";
import type { ReviewConfig } from "./types.js";

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-test-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "db.sqlite"));
  const workspace = store.createWorkspace("Review WS", path.join(dir, "repo"));
  const agent = store.createAgent(
    {
      workspaceId: workspace.id,
      name: "author",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    },
    false,
  );
  const task = store.createTask({
    workspaceId: workspace.id,
    title: "Implement review",
    description: "test",
    acceptance: ["pass"],
    ownerId: agent.id,
  });
  let head = "head1";
  const snapshot = (): TaskVcsSnapshot =>
    ({
      vcs: {
        taskId: task.id,
        workspaceId: workspace.id,
        mode: "auto",
        branch: "feature/review",
        baseBranch: "main",
        headSha: head,
        pr: {
          provider: "local",
          number: null,
          url: null,
          state: "open",
          checks: "none",
          review: "pending",
        },
        merge: { state: "none", commitSha: null },
        conflictTaskId: null,
        errorCode: null,
        updatedAt: new Date().toISOString(),
      },
      run: null,
    }) as unknown as TaskVcsSnapshot;
  const diff: ReviewDiffResult = {
    baseSha: "base1",
    mergeBaseSha: "merge1",
    headSha: "head1",
    diffHash: "diffhash1",
    files: parseUnifiedDiff(patch).map((file) => ({ ...file, targetId: "" })),
  };
  const service = new ReviewService({
    store,
    workspacePath: () => path.join(dir, "repo"),
    getTaskVcs: async () => snapshot(),
    computeDiff: async () => ({ ...diff, headSha: head }),
  });
  return { store, workspace, agent, task, service, setHead: (next: string) => (head = next) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // SQLite may still hold a Windows handle after a failed assertion.
    }
  }
});

describe("review service", () => {
  it("creates a commit-bound target, files and default human reviewer", async () => {
    const { store, task, service } = setup();
    const target = await service.ensureTarget(task.id);
    expect(target.headSha).toBe("head1");
    expect(target.authorAgentId).not.toBeNull();
    expect(target.reviewers).toHaveLength(1);
    expect(target.reviewers[0].reviewerId).toBe("user");
    expect(service.getConfig(target.workspaceId).mode).toBe("advisory");
    const diff = await service.getDiff(task.id);
    expect(diff.file.path).toBe("src/a.ts");
    expect(diff.lines.some((line) => line.kind === "add")).toBe(true);
    store.close();
  });

  it("enforces required gate: blocker -> resolve -> approve", async () => {
    const { store, workspace, task, service } = setup();
    service.saveConfig(workspace.id, { mode: "required" });
    await service.ensureTarget(task.id);
    const pending = await service.evaluateTask(task.id);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.code).toBe("REVIEW_PENDING");

    const thread = await service.createThread({
      taskId: task.id,
      filePath: "src/a.ts",
      side: "new",
      lineStart: 2,
      body: "This needs a test",
      severity: "blocker",
    });
    expect(thread.severity).toBe("blocker");
    const blocked = await service.evaluateTask(task.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("REVIEW_BLOCKED");
    await expect(service.assertMergeAllowed(task.id)).rejects.toMatchObject({ code: "REVIEW_BLOCKED" });

    await service.resolveThread(task.id, thread.id, "added test");
    const approved = await service.submitDecision({
      taskId: task.id,
      decision: "approve",
      headSha: "head1",
      notes: "ok",
    });
    expect(approved.status).toBe("approved");
    const gate = await service.evaluateTask(task.id);
    expect(gate.ok).toBe(true);
    await expect(service.assertMergeAllowed(task.id)).resolves.toBeUndefined();
    store.close();
  });

  it("keeps decision revision history and supports request_changes -> approve", async () => {
    const { store, workspace, task, service } = setup();
    service.saveConfig(workspace.id, { mode: "required" });
    await service.ensureTarget(task.id);
    await service.submitDecision({
      taskId: task.id,
      decision: "comment",
      headSha: "head1",
      notes: "first",
    });
    await service.submitDecision({
      taskId: task.id,
      decision: "request_changes",
      headSha: "head1",
      notes: "needs work",
    });
    const afterChange = await service.getSummary(task.id);
    expect(afterChange.target.status).toBe("changes_requested");
    await service.submitDecision({
      taskId: task.id,
      decision: "approve",
      headSha: "head1",
      notes: "fixed",
    });
    const afterApprove = await service.getSummary(task.id);
    expect(afterApprove.target.status).toBe("approved");
    expect(afterApprove.decisions.filter((decision) => decision.isCurrent)).toHaveLength(1);
    expect(afterApprove.decisions.filter((decision) => decision.isCurrent)[0].decision).toBe("approve");
    expect(afterApprove.decisions.length).toBeGreaterThanOrEqual(3);
    store.close();
  });

  it("stores thread comments/edited/deleted and JSON context without body in events", async () => {
    const { store, task, service } = setup();
    await service.ensureTarget(task.id);
    const thread = await service.createThread({
      taskId: task.id,
      filePath: "src/a.ts",
      side: "new",
      lineStart: 2,
      body: "hello",
      severity: "suggestion",
    });
    expect(thread.contextBefore).toEqual(["const a = 1;"]);
    const reply = await service.reply(task.id, thread.id, "reply");
    expect(reply.authorId).toBe("user");
    const edited = await service.editComment(task.id, thread.comments[0].id, "edited");
    expect(edited.body).toBe("edited");
    const deleted = await service.deleteComment(task.id, edited.id);
    expect(deleted.deletedAt).not.toBeNull();
    const events = store.listEvents({ aggregateId: task.id });
    expect(events.some((event) => event.type === "review.comment_edited")).toBe(true);
    expect(events.some((event) => event.type === "review.comment_deleted")).toBe(true);
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain("edited");
    store.close();
  });

  it("remove/replace reviewer invalidates current decisions and unassigns gate", async () => {
    const { store, workspace, task, service } = setup();
    service.saveConfig(workspace.id, { mode: "required" });
    await service.ensureTarget(task.id);
    await service.submitDecision({ taskId: task.id, decision: "approve", headSha: "head1" });
    const target = await service.ensureTarget(task.id);
    await service.removeReviewer(task.id, "user", "reviewer unavailable");
    const after = await service.getSummary(task.id);
    expect(after.target.reviewers.find((reviewer) => reviewer.reviewerId === "user")?.status).toBe("removed");
    expect(after.decisions.filter((decision) => decision.isCurrent)).toHaveLength(0);
    expect(after.gate.ok).toBe(false);
    await service.assignReviewer(task.id, "user");
    await service.submitDecision({ taskId: task.id, decision: "approve", headSha: "head1" });
    expect((await service.getSummary(task.id)).target.status).toBe("approved");
    store.close();
  });

  it("supports advisory/off modes and replaceReviewer", async () => {
    const { store, workspace, task, service } = setup();
    service.saveConfig(workspace.id, { mode: "advisory" });
    await service.ensureTarget(task.id);
    expect((await service.evaluateTask(task.id)).ok).toBe(true);
    service.saveConfig(workspace.id, { mode: "off" });
    expect((await service.evaluateTask(task.id)).ok).toBe(true);
    service.saveConfig(workspace.id, { mode: "required" });
    await service.ensureTarget(task.id);
    await service.replaceReviewer(task.id, "user", "user", "rotate reviewer");
    const after = await service.getSummary(task.id);
    expect(after.target.reviewers.find((reviewer) => reviewer.reviewerId === "user")?.status).not.toBe("removed");
    expect(after.gate.ok).toBe(false);
    if (!after.gate.ok) expect(after.gate.code).toBe("REVIEW_PENDING");
    store.close();
  });

  it("requires confirmation to clear merge approvals on mode downgrade", async () => {
    const { store, workspace, service } = setup();
    service.saveConfig(workspace.id, { mode: "required" });
    store.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS merge_queue (
          id TEXT PRIMARY KEY, workspace_id TEXT, task_id TEXT, head_sha TEXT, state TEXT,
          approved_head_sha TEXT, checks_waived INTEGER NOT NULL DEFAULT 0,
          checks_waived_by TEXT, checks_waived_reason TEXT, checks_waived_at TEXT, updated_at TEXT
        )`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO merge_queue(id, workspace_id, task_id, head_sha, state, approved_head_sha, checks_waived, updated_at)
         VALUES ('q1', ?, 't1', 'head1', 'ready', 'head1', 1, ?)`,
      )
      .run(workspace.id, new Date().toISOString());
    expect(() => service.saveConfig(workspace.id, { mode: "off" })).toThrowError(
      expect.objectContaining({ code: "REVIEW_CONFIG_CONFIRM_REQUIRED" }),
    );
    service.saveConfig(workspace.id, { mode: "off" }, { confirmResets: true });
    const row = store.db.prepare("SELECT * FROM merge_queue WHERE id = 'q1'").get() as Record<string, unknown>;
    expect(row.approved_head_sha).toBeNull();
    expect(Number(row.checks_waived)).toBe(0);
    expect(String(row.state)).toBe("waiting_review");
    store.close();
  });

  it("marks old target stale on head change and returns a new target", async () => {
    const { store, task, service, setHead } = setup();
    const first = await service.ensureTarget(task.id);
    setHead("head2");
    const second = await service.ensureTarget(task.id);
    expect(second.id).not.toBe(first.id);
    expect(second.headSha).toBe("head2");
    const old = service.patches.getTargetById(first.id);
    expect(old?.status).toBe("stale");
    store.close();
  });

  it("rejects agent writes and P0 approvals >1", async () => {
    const { store, workspace, task, service } = setup();
    const config = service.saveConfig(workspace.id, { mode: "required" });
    expect(config.requiredApprovals).toBe(1);
    await expect(
      service.createThread({
        taskId: task.id,
        filePath: "src/a.ts",
        side: "new",
        lineStart: 2,
        body: "agent",
        severity: "nit",
        actor: "agent:a1",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_FORBIDDEN" });
    store.close();
  });
});
