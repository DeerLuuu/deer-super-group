import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import { reanchorTargets, matchThread } from "./anchor.js";
import { ReviewDiffProvider } from "./diff.js";
import { ReviewStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows git may hold a handle briefly.
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const thread = {
  lineStart: 3,
  lineEnd: 3,
  contextBefore: ["a", "b"],
  contextAfter: ["d", "e"],
};

describe("review thread re-anchor", () => {
  it("moves to the unique line with the same context", () => {
    expect(matchThread(thread, ["a", "b", "c", "d", "e"], ["x", "a", "b", "c", "d", "e"])).toEqual({
      result: "moved",
      line: 4,
    });
  });

  it("marks duplicate context ambiguous instead of guessing", () => {
    const result = matchThread(thread, ["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e", "a", "b", "c", "d", "e"]);
    expect(result.result).toBe("outdated");
    expect(result.reason).toBe("ambiguous_context");
  });

  it("marks deleted/changed lines outdated", () => {
    const result = matchThread(thread, ["a", "b", "c", "d", "e"], ["a", "x", "c", "d", "e"]);
    expect(result.result).toBe("outdated");
    expect(result.reason).toBe("line_changed");
  });

  it("reanchors a thread across a rename + inserted line while keeping blocker blocking", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "review-anchor-"));
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "review@example.com"]);
    git(repo, ["config", "user.name", "Review"]);
    writeFileSync(path.join(repo, "old.txt"), "a\nb\nc\nd\ne\n");
    git(repo, ["add", "old.txt"]);
    git(repo, ["commit", "-m", "base"]);
    const oldHead = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "-b", "feature"]);
    git(repo, ["mv", "old.txt", "new.txt"]);
    writeFileSync(path.join(repo, "new.txt"), "x\na\nb\nc\nd\ne\n");
    git(repo, ["add", "new.txt"]);
    git(repo, ["commit", "-m", "rename and shift"]);
    const newHead = git(repo, ["rev-parse", "HEAD"]).trim();

    const store = new Store(path.join(dir, "db.sqlite"));
    const workspace = store.createWorkspace("anchor", repo);
    const agent = store.createAgent({
      workspaceId: workspace.id,
      name: "author",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    }, false);
    const task = store.createTask({
      workspaceId: workspace.id,
      title: "anchor",
      description: "",
      acceptance: [],
      ownerId: agent.id,
    });
    const reviewStore = new ReviewStore(store);
    const oldTarget = reviewStore.createTarget({
      workspaceId: workspace.id,
      taskId: task.id,
      authorAgentId: agent.id,
      requesterId: "user",
      requesterKind: "human",
      provider: "local",
      prNumber: null,
      prUrl: null,
      baseBranch: "main",
      baseSha: oldHead,
      headSha: oldHead,
      mergeBaseSha: oldHead,
      diffHash: "old",
    });
    const newTarget = reviewStore.createTarget({
      workspaceId: workspace.id,
      taskId: task.id,
      authorAgentId: agent.id,
      requesterId: "user",
      requesterKind: "human",
      provider: "local",
      prNumber: null,
      prUrl: null,
      baseBranch: "main",
      baseSha: oldHead,
      headSha: newHead,
      mergeBaseSha: oldHead,
      diffHash: "new",
    });
    const created = reviewStore.createThread({
      target: oldTarget,
      filePath: "old.txt",
      oldPath: null,
      side: "new",
      lineStart: 3,
      lineEnd: 3,
      severity: "blocker",
      createdBy: "user",
      body: "still blocking",
      contextBefore: ["a", "b"],
      contextAfter: ["d", "e"],
    });
    await reanchorTargets({
      store,
      reviewStore,
      diffs: new ReviewDiffProvider(() => repo),
      workspaceId: workspace.id,
      oldTarget,
      newTarget,
    });
    const moved = reviewStore.getThread(created.id)!;
    expect(moved.lineStart).toBe(4);
    expect(moved.anchorHeadSha).toBe(newHead);
    expect(moved.severity).toBe("blocker");
    expect(reviewStore.countBlockers(newTarget.id)).toBe(1);
    store.close();
  });
});
