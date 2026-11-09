import type { Task } from "../../shared/types.js";
import { KernelError } from "./errors.js";

/**
 * t68 Task 状态机（v2）：8 态迁移表，非法迁移拒绝。
 * ready/queued/running/review/blocked/done/failed/cancelled
 * 创建态不在此表（createTask 直接写 ready/blocked）。
 */
export const TASK_STATES = [
  "ready",
  "queued",
  "running",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export type TransitionFrom = (typeof TASK_STATES)[number];
export type TransitionTo = (typeof TASK_STATES)[number];

const ALLOWED: Record<TransitionFrom, ReadonlySet<TransitionTo>> = {
  ready: new Set(["queued", "blocked", "cancelled"]),
  queued: new Set(["running", "ready", "blocked", "cancelled"]),
  running: new Set(["done", "review", "failed", "queued", "cancelled"]),
  review: new Set(["done", "failed", "cancelled"]),
  blocked: new Set(["ready", "cancelled"]),
  done: new Set(),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
};

export function canTransition(from: Task["status"], to: Task["status"]): boolean {
  return ALLOWED[from].has(to);
}

export function assertTransition(from: Task["status"], to: Task["status"]): void {
  if (!canTransition(from, to)) {
    throw new KernelError(
      "INVALID_TRANSITION",
      `invalid task transition: ${from} -> ${to}`,
      { from, to },
    );
  }
}

/** 依赖满足：所有 dependsOn 都 done。 */
export function dependenciesSatisfied(
  task: Pick<Task, "dependsOn">,
  lookup: (id: string) => Pick<Task, "status"> | null,
): boolean {
  return task.dependsOn.every((dependencyId) => lookup(dependencyId)?.status === "done");
}

/**
 * 失败传播：返回下游应进入的 blocked 原因；依赖仍全部 done 时返回 null（可 ready）。
 * 规则：任一依赖 failed → dependency_failed；否则任一依赖 cancelled → dependency_cancelled；
 * 否则有未完成依赖 → waiting_dependencies；全部 done → null。
 */
export function blockedReasonFor(
  task: Pick<Task, "dependsOn">,
  lookup: (id: string) => Pick<Task, "status"> | null,
): string | null {
  let waiting = false;
  for (const dependencyId of task.dependsOn) {
    const dependency = lookup(dependencyId);
    if (!dependency) {
      waiting = true;
      continue;
    }
    if (dependency.status === "done") continue;
    if (dependency.status === "cancelled") return "dependency_cancelled";
    if (dependency.status === "failed") return "dependency_failed";
    waiting = true;
  }
  return waiting ? "waiting_dependencies" : null;
}

/** 状态机迁移表（供文档/测试导出）。 */
export function transitionMatrix(): Record<TransitionFrom, TransitionTo[]> {
  return Object.fromEntries(
    TASK_STATES.map((from) => [from, [...ALLOWED[from]]]),
  ) as Record<TransitionFrom, TransitionTo[]>;
}
