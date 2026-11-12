import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import { GitService } from "./gitService.js";
import { validateGitArgs } from "./gitExec.js";
import { GITIGNORE_TEMPLATE } from "./writeTypes.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function initRepo(): string {
  const dir = tempDir("deer-write-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Deer Test"]);
  git(dir, ["config", "user.email", "deer@test.local"]);
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function emptyRepo(): string {
  const dir = tempDir("deer-write-empty-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Deer Test"]);
  git(dir, ["config", "user.email", "deer@test.local"]);
  writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
  return dir;
}

function seedService(repoDir: string): { service: GitService; store: Store; workspaceId: string; close(): void } {
  const dataDir = tempDir("deer-write-data-");
  const store = new Store(path.join(dataDir, "deer.db"));
  const workspace = store.createWorkspace("repo", repoDir);
  const service = new GitService({ dataDir, store });
  return {
    service,
    store,
    workspaceId: workspace.id,
    close() {
      service.close();
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a git handle; best effort cleanup.
    }
  }
});

describe("t352 G1 — GitExec argv allowlist", () => {
  it("accepts add -- <paths> and reset -- <paths>, rejects dangerous shapes", () => {
    expect(validateGitArgs(["add", "--", "a.txt", "src/b.ts"]).ok).toBe(true);
    expect(validateGitArgs(["add", "-A"]).ok).toBe(true);
    expect(validateGitArgs(["add", "--", "..", "x"]).ok).toBe(false);
    expect(validateGitArgs(["add", "."]).ok).toBe(false);
    expect(validateGitArgs(["reset", "--", "a.txt"]).ok).toBe(true);
    expect(validateGitArgs(["reset", "--hard"]).ok).toBe(false);
    expect(validateGitArgs(["reset", "HEAD~1"]).ok).toBe(false);
    expect(validateGitArgs(["reset", "--", "-x"]).ok).toBe(false);
  });
});

describe("t352 G1 — stage / unstage", () => {
  it("stages and unstages selected files in a real repo", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    const { service, store, workspaceId, close } = seedService(dir);
    try {
      const staged = await service.stage(workspaceId, ["a.txt", "b.txt"]);
      expect(staged.ok).toBe(true);
      expect(staged.value?.paths).toEqual(["a.txt", "b.txt"]);
      const porcelain = git(dir, ["status", "--porcelain"]);
      expect(porcelain).toContain("A  a.txt");
      expect(porcelain).toContain("A  b.txt");

      const unstaged = await service.unstage(workspaceId, ["a.txt"]);
      expect(unstaged.ok).toBe(true);
      expect(git(dir, ["status", "--porcelain"])).toContain("?? a.txt");
      expect(git(dir, ["status", "--porcelain"])).toContain("A  b.txt");

      const events = store.listEvents({ aggregateType: "workspace", aggregateId: workspaceId });
      expect(events.some((event) => event.type === "git.staged")).toBe(true);
      expect(events.some((event) => event.type === "git.unstaged")).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects traversal, absolute and .git paths", async () => {
    const dir = initRepo();
    const { service, workspaceId, close } = seedService(dir);
    try {
      for (const bad of [["../outside.txt"], ["C:\\windows\\x"], [".git/config"], ["/etc/passwd"], []]) {
        const result = await service.stage(workspaceId, bad as string[]);
        expect(result.ok).toBe(false);
        expect(result.errorCode).toBe("GIT_WRITE_BAD_PARAM");
      }
    } finally {
      close();
    }
  });
});

describe("t352 G1 — commit", () => {
  it("commits only staged files with title and optional body", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "feat.txt"), "new\n");
    writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n");
    const headBefore = git(dir, ["rev-parse", "HEAD"]);
    const { service, store, workspaceId, close } = seedService(dir);
    try {
      await service.stage(workspaceId, ["feat.txt"]);
      const result = await service.commitFiles(workspaceId, {
        title: "feat: add feat.txt",
        body: "正文说明\n第二行",
      });
      expect(result.ok).toBe(true);
      expect(result.value?.files).toEqual(["feat.txt"]);
      expect(result.value?.branch).toBe("main");
      expect(result.value?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.value?.sha).not.toBe(headBefore);
      expect(git(dir, ["log", "-1", "--format=%B"])).toContain("feat: add feat.txt");
      expect(git(dir, ["log", "-1", "--format=%B"])).toContain("正文说明");
      // 未暂存的 wip.txt 不进入提交，仍留在工作区。
      expect(git(dir, ["show", "--name-only", "--format=", "HEAD"])).toContain("feat.txt");
      expect(git(dir, ["show", "--name-only", "--format=", "HEAD"])).not.toContain("wip.txt");
      expect(git(dir, ["status", "--porcelain"])).toContain("?? wip.txt");

      const events = store.listEvents({ aggregateType: "workspace", aggregateId: workspaceId });
      const committed = events.find((event) => event.type === "git.committed");
      expect(committed?.payload).toMatchObject({
        workspaceId,
        files: ["feat.txt"],
        title: "feat: add feat.txt",
      });
    } finally {
      close();
    }
  });

  it("refuses to commit when nothing is staged (never add -A)", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "skip.txt"), "skip\n");
    const { service, workspaceId, close } = seedService(dir);
    try {
      const result = await service.commitFiles(workspaceId, { title: "nope" });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("GIT_WRITE_NOTHING_STAGED");
      expect(git(dir, ["status", "--porcelain"])).toContain("?? skip.txt");
    } finally {
      close();
    }
  });

  it("CommitGuard rejects sensitive path and secret content on staged files only", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    writeFileSync(path.join(dir, "deploy.key"), "-----BEGIN RSA PRIVATE KEY-----\nabc\n");
    writeFileSync(path.join(dir, "normal.txt"), "ok\n");
    const headBefore = git(dir, ["rev-parse", "HEAD"]);
    const { service, workspaceId, close } = seedService(dir);
    try {
      await service.stage(workspaceId, [".env"]);
      const blocked1 = await service.commitFiles(workspaceId, { title: "leak env" });
      expect(blocked1.ok).toBe(false);
      expect(blocked1.errorCode).toBe("GIT_WRITE_GUARD_BLOCKED");
      expect(blocked1.message).toContain(".env");

      await service.unstage(workspaceId, [".env"]);
      await service.stage(workspaceId, ["deploy.key"]);
      const blocked2 = await service.commitFiles(workspaceId, { title: "leak key" });
      expect(blocked2.ok).toBe(false);
      expect(blocked2.errorCode).toBe("GIT_WRITE_GUARD_BLOCKED");
      expect(blocked2.message).toContain("deploy.key");

      // 未暂存的问题文件不阻塞正常提交。
      await service.unstage(workspaceId, ["deploy.key"]);
      await service.stage(workspaceId, ["normal.txt"]);
      const ok = await service.commitFiles(workspaceId, { title: "safe commit" });
      expect(ok.ok).toBe(true);
      expect(git(dir, ["rev-parse", "HEAD"])).not.toBe(headBefore);
    } finally {
      close();
    }
  });

  it("supports the first commit on a freshly initialized (unborn) repo", async () => {
    const dir = emptyRepo();
    const { service, workspaceId, close } = seedService(dir);
    try {
      const unstagedBefore = await service.unstage(workspaceId, ["app.ts"]);
      // unborn 分支上 reset 尚无 HEAD 可还原：git 允许（视为空树），unstage 应成功。
      expect(unstagedBefore.ok).toBe(true);
      await service.stage(workspaceId, ["app.ts"]);
      const result = await service.commitFiles(workspaceId, { title: "chore: first commit" });
      expect(result.ok).toBe(true);
      expect(result.value?.branch).toBe("main");
      expect(git(dir, ["log", "-1", "--format=%s"])).toBe("chore: first commit");
    } finally {
      close();
    }
  });

  it("validates commit title", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, "x.txt"), "x\n");
    const { service, workspaceId, close } = seedService(dir);
    try {
      await service.stage(workspaceId, ["x.txt"]);
      const empty = await service.commitFiles(workspaceId, { title: "   " });
      expect(empty.ok).toBe(false);
      expect(empty.errorCode).toBe("GIT_WRITE_BAD_PARAM");
      const multiline = await service.commitFiles(workspaceId, { title: "a\nb" });
      expect(multiline.ok).toBe(false);
      expect(multiline.errorCode).toBe("GIT_WRITE_BAD_PARAM");
    } finally {
      close();
    }
  });
});

describe("t352 G1 — .gitignore preview / apply", () => {
  it("previews template additions and applies them as a new untracked file", async () => {
    const dir = initRepo();
    const { service, workspaceId, close } = seedService(dir);
    try {
      const preview = await service.ignorePreview(workspaceId);
      expect(preview.ok).toBe(true);
      expect(preview.value?.exists).toBe(false);
      expect(preview.value?.additions).toEqual([...GITIGNORE_TEMPLATE]);

      const applied = await service.ignoreApply(workspaceId);
      expect(applied.ok).toBe(true);
      expect(applied.value?.created).toBe(true);
      expect(applied.value?.addedLines).toEqual([...GITIGNORE_TEMPLATE]);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("node_modules/");
      expect(content).toContain("branches/");
      // 应用后作为未跟踪文件出现在工作区。
      expect(git(dir, ["status", "--porcelain"])).toContain("?? .gitignore");
    } finally {
      close();
    }
  });

  it("appends only missing lines and never overwrites existing content", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, ".gitignore"), "custom-entry/\nnode_modules/\n"); // 故意无结尾换行的变体在下一用例
    const { service, workspaceId, close } = seedService(dir);
    try {
      const preview = await service.ignorePreview(workspaceId);
      expect(preview.value?.exists).toBe(true);
      expect(preview.value?.additions).not.toContain("node_modules/");
      expect(preview.value?.additions).toContain("dist/");
      expect(preview.value?.existing).toContain("custom-entry/");

      const applied = await service.ignoreApply(workspaceId);
      expect(applied.ok).toBe(true);
      expect(applied.value?.created).toBe(false);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("custom-entry/");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");

      // 幂等：再次应用无缺失行，不重复追加。
      const again = await service.ignoreApply(workspaceId);
      expect(again.ok).toBe(true);
      expect(again.value?.addedLines).toEqual([]);
      const content2 = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content2.match(/dist\//g)?.length).toBe(1);

      const store = (service as unknown as { options: { store: Store } }).options.store;
      const audit = store
        .listEvents({ aggregateType: "workspace", aggregateId: workspaceId })
        .filter((event) => event.type === "git.ignore_updated");
      expect(audit.length).toBe(1);
    } finally {
      close();
    }
  });

  it("handles an existing file without trailing newline", async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, ".gitignore"), "keep/");
    const { service, workspaceId, close } = seedService(dir);
    try {
      const applied = await service.ignoreApply(workspaceId);
      expect(applied.ok).toBe(true);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      // 「keep/」与追加内容之间必须换行，不得拼成同一行。
      expect(content.startsWith("keep/\n")).toBe(true);
      expect(content).toContain("node_modules/");
    } finally {
      close();
    }
  });

  it("reports not-repo for a workspace without .git", async () => {
    const dir = tempDir("deer-write-plain-");
    const { service, workspaceId, close } = seedService(dir);
    try {
      const result = await service.stage(workspaceId, ["a.txt"]);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("GIT_WRITE_NOT_REPO");
      expect(existsSync(path.join(dir, ".git"))).toBe(false);
    } finally {
      close();
    }
  });
});
