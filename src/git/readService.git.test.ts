import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitExec } from "./gitExec.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { GitReadService } from "./readService.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a short handle.
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("GitReadService with a real repository", () => {
  it("serves repo, graph, refs, status, commit and diff without writing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "git-read-"));
    dirs.push(dir);
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "read@example.com"]);
    git(dir, ["config", "user.name", "Read"]);
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "first"]);
    git(dir, ["tag", "v1"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "second"]);
    writeFileSync(path.join(dir, "working.txt"), "work\n");

    const repo = await detectRepo(dir);
    expect(repo.ok).toBe(true);
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    expect(hooks).toBeTruthy();
    const reader = new GitReadService(repo as never, new GitExec(hooks!));

    const info = await reader.repoInfo();
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    const infoValue = info.value!;
    expect(infoValue.branch).toBe("feature");
    expect(infoValue.headSha).toHaveLength(40);

    const refs = await reader.refs();
    expect(refs.ok).toBe(true);
    if (refs.ok) {
      const refsValue = refs.value!;
      expect(refsValue.refs.some((ref) => ref.name === "feature")).toBe(true);
      expect(refsValue.refs.some((ref) => ref.name === "v1" && ref.kind === "tag")).toBe(true);
      expect(refsValue.worktrees.length).toBeGreaterThan(0);
      expect(refsValue.worktrees[0].path).toBeTruthy();
    }

    const graph = await reader.graph({ limit: 20, offset: 0 });
    expect(graph.ok).toBe(true);
    if (graph.ok) {
      const graphValue = graph.value!;
      expect(graphValue.commits[0].sha).toBe(infoValue.headSha);
      expect(graphValue.commits.some((commit) => commit.subject === "first")).toBe(true);
      expect(graphValue.layout.laneCount).toBeGreaterThan(0);
    }

    const status = await reader.status();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value!.untracked.some((file) => file.path === "working.txt")).toBe(true);

    const detail = await reader.commit(infoValue.headSha!);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      const detailValue = detail.value!;
      expect(detailValue.changedFiles.some((file) => file.path === "a.txt")).toBe(true);
      expect(detailValue.diff.files.length).toBeGreaterThan(0);
    }

    const diff = await reader.diff({ scope: "commit", sha: infoValue.headSha! });
    expect(diff.ok).toBe(true);
    if (diff.ok) expect(diff.value!.files[0].hunks.length).toBeGreaterThan(0);
  });
});
