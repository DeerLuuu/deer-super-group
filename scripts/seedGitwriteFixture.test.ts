import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * t389：为真实 Electron 截图/走查播种隔离环境。
 *
 * 用法（仅在显式设置环境变量时执行，常规测试套件自动 skip）：
 *   DSGITWRITE_SEED_DB=<dir> DSGITWRITE_SEED_REPO=<dir> DSGITWRITE_SEED_KIND=normal|unborn \
 *     pnpm vitest run scripts/seedGitwriteFixture.test.ts
 *
 * - 在 DSGITWRITE_SEED_DB 创建全新 Store（deer.db）并登记一个工作区；
 * - 在 DSGITWRITE_SEED_REPO 准备真实 git 仓库（normal=有基线提交+工作区改动；unborn=仅 init）；
 * - 配合 `electron <app> --user-data-dir=<DB dir>` 启动，App 会自动打开该工作区。
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("seedGitwriteFixture (env-gated)", () => {
  it("seeds an isolated store + git fixture when env is set", async () => {
    const dbDir = process.env.DSGITWRITE_SEED_DB;
    const repoDir = process.env.DSGITWRITE_SEED_REPO;
    const kind = process.env.DSGITWRITE_SEED_KIND === "unborn" ? "unborn" : "normal";
    if (!dbDir || !repoDir) {
      return; // 常规套件：skip
    }
    const { Store } = await import("../src/kernel/store.js");
    const store = new Store(path.join(dbDir, "deer.db"));
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.name", "Deer Screenshot"]);
    git(repoDir, ["config", "user.email", "shot@deer.local"]);
    if (kind === "normal") {
      writeFileSync(path.join(repoDir, "README.md"), "# screenshot fixture\n");
      git(repoDir, ["add", "README.md"]);
      git(repoDir, ["commit", "-m", "chore: baseline"]);
      // 工作区改动：普通文件（可暂存提交）+ 敏感文件（CommitGuard 演示）+ 未跟踪目录。
      writeFileSync(path.join(repoDir, "feature.ts"), "export const x = 1;\n");
      writeFileSync(path.join(repoDir, "notes.md"), "改动说明\n");
      writeFileSync(path.join(repoDir, ".env"), "SECRET_TOKEN=demo\n");
      mkdirSync(path.join(repoDir, "sub"), { recursive: true });
      writeFileSync(path.join(repoDir, "sub", "util.ts"), "export const y = 2;\n");
      mkdirSync(path.join(repoDir, "node_modules", "demo-pkg"), { recursive: true });
      writeFileSync(path.join(repoDir, "node_modules", "demo-pkg", "index.js"), "module.exports = 1;\n");
    } else {
      writeFileSync(path.join(repoDir, "app.ts"), "export const boot = true;\n");
      writeFileSync(path.join(repoDir, "index.html"), "<!doctype html>\n<title>demo</title>\n");
    }
    const workspace = store.createWorkspace(kind === "unborn" ? "首提演示" : "写闭环演示", repoDir);
    expect(workspace.path).toBe(repoDir);
    store.close();
  });
});
