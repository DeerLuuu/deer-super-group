import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * t485：为 D1 真实 Electron/CDP 走查播种隔离环境。
 *
 * 用法（仅在显式设置环境变量时执行，常规测试套件自动 skip）：
 *   D1_SEED_DB=<dir> D1_SEED_REPO=<dir> pnpm vitest run scripts/seedDiffTraceFixture.test.ts
 *
 * 产物：
 * - Store（deer.db）：workspace + router + builder 成员 + 1 个任务 + 260 条 trace 事件
 *   （assistant.message / tool.call / tool.result / run.completed 混合，含 1 条重复 seq 语义靠 id 唯一）；
 * - git 仓库：基线提交 + 工作区改动三类文件——
 *   searchable.ts（含 token 命中行）、big.txt（~500KB diff，默认 262KB 截断、1MB 全量成功）、
 *   huge.bin 文本（>8MB，触发 GIT_READ_TOO_LARGE）。
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("seedDiffTraceFixture (env-gated)", () => {
  it("seeds trace events + diff files when env is set", async () => {
    const dbDir = process.env.D1_SEED_DB;
    const repoDir = process.env.D1_SEED_REPO;
    if (!dbDir || !repoDir) return; // 常规套件：skip

    const { Store } = await import("../src/kernel/store.js");
    const store = new Store(path.join(dbDir, "deer.db"));
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.name", "D1 Screenshot"]);
    git(repoDir, ["config", "user.email", "d1@deer.local"]);

    // 基线提交（含将被修改的 searchable.ts 与 big.txt 的原始版本）。
    writeFileSync(path.join(repoDir, "searchable.ts"), "export const base = 1;\n".repeat(10));
    const bigBase = Array.from({ length: 500 }, (_, i) => `base line ${i} ${"x".repeat(30)}`).join("\n");
    writeFileSync(path.join(repoDir, "big.txt"), bigBase);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "chore: d1 baseline"]);

    // 工作区改动：
    // 1) searchable.ts：多行含 "token" 与 "needle"。
    writeFileSync(
      path.join(repoDir, "searchable.ts"),
      Array.from({ length: 40 }, (_, i) =>
        i % 4 === 0 ? `export const token_${i} = ${i};` : `export const plain_${i} = ${i};`,
      ).join("\n"),
    );
    // 2) big.txt：~500KB diff（>262KB 默认截断、<1MB 全量成功）。
    const bigNext = Array.from({ length: 9_000 }, (_, i) => `new line ${i} ${"y".repeat(40)}`).join("\n");
    writeFileSync(path.join(repoDir, "big.txt"), bigNext);
    // 3) huge.txt：>8MB 未跟踪 → git diff --no-index 超 8MB 管道 → GIT_READ_TOO_LARGE。
    writeFileSync(
      path.join(repoDir, "huge.txt"),
      Array.from({ length: 90_000 }, (_, i) => `huge line ${i} ${"z".repeat(80)}`).join("\n"),
    );

    // Store：workspace + 成员 + 任务 + trace 事件。
    const workspace = store.createWorkspace("D1 演示", repoDir);
    const memberBase = { workspaceId: workspace.id, systemPrompt: "prompt", persona: "", agentsMd: "" };
    store.createAgent({ ...memberBase, name: "Router", role: "router" , model: null }, true);
    const builder = store.createAgent({ ...memberBase, name: "Builder", role: "engineer", model: null });
    const task = store.createTask({
      workspaceId: workspace.id,
      title: "D1：diff 搜索与 trace 分页演示",
      description: "真实 Electron 走查用任务",
      acceptance: [],
    });
    store.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "task.created",
      actor: "user",
      payload: { title: task.title },
    });
    // 260 条事件：每 5 条一轮 assistant.message / tool.call / tool.result，尾部 run.completed。
    for (let index = 0; index < 52; index += 1) {
      store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "assistant.message",
        actor: `agent:${builder.name}`,
        payload: { text: `思考片段 ${index}：定位 token 相关改动。` },
      });
      store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "tool.call",
        actor: `agent:${builder.name}`,
        payload: { name: "fs.read", arguments: { path: `src/file${index}.ts` } },
      });
      store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "tool.result",
        actor: `agent:${builder.name}`,
        payload: { name: "fs.read", ok: index % 7 !== 0, error: index % 7 === 0 ? "ENOENT demo" : null },
      });
      store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "watchdog.note",
        actor: "system",
        payload: { note: `观察 ${index}` },
      });
      store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "memo.write",
        actor: `agent:${builder.name}`,
        payload: { tags: ["demo"] },
      });
    }
    store.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "run.completed",
      actor: "system",
      payload: { usage: { inputTokens: 100, outputTokens: 200 } },
    });

    expect(store.listEventsForTask(task.id).length).toBe(263);
    store.close();
  });
});
