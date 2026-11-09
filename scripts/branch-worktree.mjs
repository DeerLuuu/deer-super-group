#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const MAX_WORKTREES = 3;
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const branchesDir = path.join(root, "branches");

function fail(message) {
  console.error(`\n[branch] ${message}\n`);
  process.exit(1);
}

function run(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  }).trim();
}

function runIn(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...options,
  }).trim();
}

function assertRepo() {
  try {
    run(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    fail("当前目录不是 Git 仓库；请先在项目根目录执行 git init。");
  }
}

function parseWorktrees() {
  const output = run(["worktree", "list", "--porcelain"]);
  return output
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const data = {};
      for (const line of lines) {
        const [key, ...rest] = line.split(" ");
        if (key && rest.length) data[key] = rest.join(" ");
      }
      return data;
    })
    .filter((item) => item.worktree);
}

function activeWorktrees() {
  const prefix = branchesDir.toLowerCase() + path.sep;
  return parseWorktrees().filter((item) =>
    item.worktree.toLowerCase().startsWith(prefix),
  );
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function branchName(taskId, slug) {
  return `feature/${taskId}-${slug}`;
}

function worktreePath(taskId, slug) {
  return path.join(branchesDir, `${taskId}-${slug}`);
}

function ensureBranchesDir() {
  mkdirSync(branchesDir, { recursive: true });
}

function assertCapacity() {
  const active = activeWorktrees();
  if (active.length >= MAX_WORKTREES) {
    fail(
      `已有 ${active.length} 个 active worktree（上限 ${MAX_WORKTREES}）。\n` +
        active.map((item) => `  - ${item.worktree}`).join("\n"),
    );
  }
}

function start(taskId, rawSlug) {
  if (!taskId || !rawSlug) fail("用法：pnpm branch:start <task-id> <slug>");
  const slug = slugify(rawSlug);
  if (!slug) fail("slug 只能包含字母、数字、连字符。");
  assertCapacity();
  ensureBranchesDir();

  const dir = worktreePath(taskId, slug);
  const branch = branchName(taskId, slug);
  if (existsSync(dir)) fail(`目录已存在：${dir}`);
  try {
    run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    fail(`分支已存在：${branch}`);
  } catch {
    // expected: branch absent
  }

  const base = (() => {
    try {
      run(["show-ref", "--verify", "--quiet", "refs/heads/main"]);
      return "main";
    } catch {
      return "HEAD";
    }
  })();

  run(["worktree", "add", "-b", branch, dir, base], { stdio: "inherit" });
  console.log(`\n[branch] 已创建 ${branch}`);
  console.log(`[branch] 工作目录：${dir}`);
  console.log(`[branch] 在该目录中开发、验证，完成后运行：`);
  console.log(`  pnpm branch:finish ${taskId}-${slug}`);
  console.log(`[branch] active worktree：${activeWorktrees().length}/${MAX_WORKTREES}`);
}

function resolveWorktree(name) {
  const wanted = path.resolve(branchesDir, name);
  const match = activeWorktrees().find(
    (item) => path.resolve(item.worktree) === wanted,
  );
  if (!match) {
    fail(
      `找不到 worktree：branches/${name}\n可用：\n` +
        activeWorktrees()
          .map((item) => `  - ${path.basename(item.worktree)}`)
          .join("\n"),
    );
  }
  return match;
}

function assertClean(cwd) {
  const dirty = runIn(cwd, ["status", "--porcelain"]);
  if (dirty) {
    console.error(dirty);
    fail("worktree 有未提交改动，先提交并推送。");
  }
}

function finish(name) {
  if (!name) fail("用法：pnpm branch:finish <task-id>-<slug>");
  const worktree = resolveWorktree(name);
  assertClean(worktree.worktree);
  const branch = runIn(worktree.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remotes = runIn(worktree.worktree, ["remote"]).split("\n").filter(Boolean);
  if (remotes.length === 0) {
    console.log(`\n[branch] 分支 ${branch} 已干净，但没有 git remote。`);
    console.log("[branch] 请先添加 remote，再执行：");
    console.log(`  git -C "${worktree.worktree}" push -u origin ${branch}`);
    console.log(`  gh pr create --base main --head ${branch} --fill`);
    return;
  }
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  runIn(worktree.worktree, ["push", "-u", remote, `${branch}:${branch}`], {
    stdio: "inherit",
  });

  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (gh.status === 0) {
    console.log(`\n[branch] 创建 PR：${branch} → main`);
    spawnSync(
      "gh",
      ["pr", "create", "--base", "main", "--head", branch, "--fill"],
      { cwd: worktree.worktree, stdio: "inherit" },
    );
  } else {
    console.log(`\n[branch] 已 push。安装 GitHub CLI 后执行：`);
    console.log(`  gh pr create --base main --head ${branch} --fill`);
    console.log("[branch] 或到远端仓库页面手动创建 PR。");
  }
  console.log("[branch] 本脚本不会自动合并；PR 评审通过后再合并。");
}

function remove(name) {
  if (!name) fail("用法：pnpm branch:remove <task-id>-<slug>");
  const worktree = resolveWorktree(name);
  assertClean(worktree.worktree);
  const branch = runIn(worktree.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  run(["worktree", "remove", worktree.worktree], { stdio: "inherit" });
  try {
    run(["branch", "-d", branch], { stdio: "inherit" });
  } catch {
    console.warn(`[branch] 本地分支 ${branch} 未删除（可能尚未合并）。`);
  }
  console.log(`\n[branch] 已移除 ${name}`);
}

function list() {
  const active = activeWorktrees();
  console.log(`[branch] active worktree：${active.length}/${MAX_WORKTREES}`);
  for (const item of active) {
    console.log(`  - ${path.basename(item.worktree)}  ${item.branch ?? ""}`);
  }
  if (active.length === 0) console.log("  （空）");
}

assertRepo();
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "start":
    start(args[0], args[1]);
    break;
  case "finish":
    finish(args[0]);
    break;
  case "remove":
    remove(args[0]);
    break;
  case "list":
    list();
    break;
  default:
    fail(
      "用法：branch-worktree.mjs <start|finish|remove|list> [args]\n" +
        "  start <task-id> <slug>\n" +
        "  finish <task-id>-<slug>\n" +
        "  remove <task-id>-<slug>",
    );
}
