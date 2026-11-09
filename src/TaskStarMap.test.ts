import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "./shared/types";
import { buildGraph } from "./TaskStarMap";

/**
 * 星图第二轮图模型验收（S02/S08）：
 * - 8 节点标准夹具：8 个任务节点 / 8 条依赖边；
 * - 依赖边唯一来自 dependsOn，绝不伪造（upstream/downstream 仅含声明的依赖）；
 * - 确定性布局：同一输入两次计算坐标逐点一致（刷新/事件刷新不跳变）；
 * - 依赖方向仍沿 x 大致可读（下游节点 x 不小于上游 - 容差）；
 * - 缺失端点的依赖只计数、不补假节点。
 */

function task(id: string, dependsOn: string[], status: TaskStatus = "ready"): Task {
  return {
    id,
    workspaceId: "ws",
    title: `任务 ${id}`,
    description: "",
    acceptance: [],
    status,
    ownerId: null,
    dependsOn,
    branch: null,
    worktree: null,
    summary: null,
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    startedAt: null,
    endedAt: null,
  };
}

/** 8 节点 DAG：a→b→{c,d}→e→f→g 与 d→h（8 条边） */
function fixture(): Task[] {
  return [
    task("a", []),
    task("b", ["a"]),
    task("c", ["b"]),
    task("d", ["b"]),
    task("e", ["c", "d"]),
    task("f", ["e"], "running"),
    task("g", ["f"], "done"),
    task("h", ["d"], "failed"),
  ];
}

describe("star map graph model (S02/S08)", () => {
  it("8 节点夹具：8 个节点 / 8 条依赖边", () => {
    const model = buildGraph(fixture());
    expect(model.layout).toHaveLength(8);
    let edgeCount = 0;
    for (const ids of model.upstream.values()) edgeCount += ids.length;
    expect(edgeCount).toBe(8);
    expect(model.issues.missingDependencyIds).toBe(0);
  });

  it("不伪造依赖边：upstream/downstream 仅含 dependsOn 声明的关系", () => {
    const model = buildGraph(fixture());
    expect(model.upstream.get("e")).toEqual(["c", "d"]);
    expect(model.upstream.get("a")).toEqual([]);
    expect((model.downstream.get("b") ?? []).sort()).toEqual(["c", "d"]);
    // 度数 = 上游 + 下游
    expect(model.degree.get("b")).toBe(3);
    expect(model.degree.get("a")).toBe(1);
  });

  it("确定性布局：同一输入两次计算坐标逐点一致", () => {
    const first = buildGraph(fixture());
    const second = buildGraph(fixture());
    for (const node of first.layout) {
      const other = second.nodeById.get(node.task.id)!;
      expect(other.x).toBe(node.x);
      expect(other.y).toBe(node.y);
    }
  });

  it("依赖方向沿 x 大致可读（下游不显著领先上游）", () => {
    const model = buildGraph(fixture());
    const tolerance = 120;
    for (const node of model.layout) {
      for (const upId of model.upstream.get(node.task.id) ?? []) {
        const up = model.nodeById.get(upId)!;
        expect(node.x).toBeGreaterThan(up.x - tolerance);
      }
    }
  });

  it("缺失端点的依赖只计数、不补假节点", () => {
    const model = buildGraph([task("a", ["ghost"]), task("b", ["a"])]);
    expect(model.layout).toHaveLength(2);
    expect(model.issues.missingDependencyIds).toBe(1);
    expect(model.upstream.get("a")).toEqual([]);
    expect(model.upstream.get("b")).toEqual(["a"]);
  });
});
