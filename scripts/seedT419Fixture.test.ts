import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * t419：为星图单击/双击真实 Electron 走查播种隔离环境。
 *
 * 用法（仅在显式设置环境变量时执行，常规套件自动 skip）：
 *   DST419_SEED_DB=<dir> DST419_SEED_REPO=<dir> pnpm vitest run scripts/seedT419Fixture.test.ts
 *
 * 产出：一个工作区 + 1 名成员 + 3 个带依赖链的任务（A → B → C）。
 * 配合 `electron <worktree> --user-data-dir=<DB dir>` 启动走查。
 */

describe("seedT419Fixture (env-gated)", () => {
  it("seeds a workspace with a dependency chain when env is set", async () => {
    const dbDir = process.env.DST419_SEED_DB;
    const repoDir = process.env.DST419_SEED_REPO;
    if (!dbDir || !repoDir) return;
    const { Store } = await import("../src/kernel/store.js");
    const store = new Store(path.join(dbDir, "deer.db"));
    mkdirSync(repoDir, { recursive: true });
    const workspace = store.createWorkspace("星图走查", repoDir);
    if (store.listTasks(workspace.id).some((task) => task.id === "t419-a")) {
      store.close();
      return; // 幂等：同一 DB 重复执行时跳过
    }
    store.createAgent({
      workspaceId: workspace.id,
      name: "Aster",
      role: "engineer",
      model: null,
      systemPrompt: "",
      persona: "",
      agentsMd: "",
    } as never);
    const chain: Array<[string, string, string[], string]> = [
      ["t419-a", "铺设基础接口", [], "ready"],
      ["t419-b", "补充集成测试", ["t419-a"], "running"],
      ["t419-c", "发布与文档", ["t419-b"], "blocked"],
    ];
    for (const [id, title, dependsOn, status] of chain) {
      const task = store.createTask({
        workspaceId: workspace.id,
        title,
        description: `${title}（t419 星图走查任务）`,
        acceptance: [],
      });
      store.db
        .prepare("UPDATE tasks SET id=?, depends_on=?, status=?, owner_id=? WHERE id=?")
        .run(id, JSON.stringify(dependsOn), status, store.listAgents(workspace.id)[0]?.id ?? null, task.id);
    }
    const tasks = store.listTasks(workspace.id);
    expect(tasks.length).toBe(3);
    expect(tasks.find((task) => task.id === "t419-b")?.dependsOn).toEqual(["t419-a"]);
    store.close();
  });
});
