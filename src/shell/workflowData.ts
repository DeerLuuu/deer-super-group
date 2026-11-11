import type { MergeQueueItem } from "../git/types.js";
import type { Run, SchedulerSnapshot, Task } from "../shared/types.js";
import type { WatchdogSnapshot } from "../shared/watchdog.js";

/** P0-3：WorkflowRail 的六个阶段；unknown 不是阶段，只是“无法安全推断”。 */
export const WORKFLOW_STAGES = [
  { id: "discuss", label: "讨论", hint: "与 Router 澄清目标" },
  { id: "plan", label: "计划", hint: "拆任务与依赖" },
  { id: "run", label: "运行", hint: "执行与监控" },
  { id: "review", label: "评审", hint: "diff 与决定" },
  { id: "deliver", label: "交付", hint: "合并与交付" },
  { id: "remember", label: "记忆", hint: "沉淀与下一轮" },
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number]["id"];
export type WorkflowStageOrUnknown = WorkflowStage | "unknown";

export type NeedsMeKind =
  | "failed"
  | "blocked"
  | "review"
  | "merge"
  | "alert"
  | "budget";

export interface NeedsMeItem {
  /** 稳定、可去重的投影 key；不进入任务/事件存储。 */
  id: string;
  kind: NeedsMeKind;
  title: string;
  detail: string;
  taskId?: string;
}

export interface WorkflowProjection {
  stage: WorkflowStageOrUnknown;
  cta: { stage: WorkflowStage; label: string } | null;
  focusTaskId: string | null;
}

export interface WorkflowInput {
  tasks: readonly Task[];
  runs?: readonly Run[];
  scheduler?: SchedulerSnapshot | null;
  /** 现有 MergeQueue 快照；undefined 表示“未知”，不伪造待合并。 */
  mergeQueue?: readonly MergeQueueItem[] | null;
}

const CTA_LABEL: Record<WorkflowStage, string> = {
  discuss: "继续讨论",
  plan: "去规划",
  run: "查看运行",
  review: "去评审",
  deliver: "去合并",
  remember: "去沉淀",
};

const ACTIVE_MERGE_STATES = new Set<MergeQueueItem["state"]>([
  "queued",
  "waiting_checks",
  "waiting_review",
  "ready",
  "updating",
  "merging",
  "blocked",
  "failed",
]);

function firstTask(tasks: readonly Task[], status: Task["status"]): Task | null {
  return tasks.find((task) => task.status === status) ?? null;
}

function isReviewBlocked(task: Task): boolean {
  return (
    task.status === "blocked" &&
    (task.failureKind === "review_rejected" ||
      /review|评审/i.test(task.blockedReason ?? ""))
  );
}

/**
 * 从现有 facts 推导当前阶段。优先级是“用户现在最可能需要看的阶段”：
 * 运行中 > 失败/阻塞 > 评审 > 交付 > 计划 > 记忆 > 讨论 > unknown。
 * 无任务/未知状态不伪造下一步；MergeQueue 未加载时，done 任务也不安全地
 * 推断成“记忆”（可能还有 pending merge 被漏掉）。
 */
export function deriveWorkflow(input: WorkflowInput): WorkflowProjection {
  const { tasks, mergeQueue } = input;
  const activeRuns = input.runs?.some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const activeTask = tasks.find(
    (task) => task.status === "running" || task.status === "queued",
  );
  const running =
    activeRuns ||
    (input.scheduler?.activeRuns.length ?? 0) > 0 ||
    (input.scheduler?.queue.length ?? 0) > 0 ||
    Boolean(activeTask);
  if (running) {
    return {
      stage: "run",
      cta: { stage: "run", label: CTA_LABEL.run },
      focusTaskId: activeTask?.id ?? null,
    };
  }

  const reviewBlockedTask = tasks.find(isReviewBlocked) ?? null;
  if (reviewBlockedTask) {
    return {
      stage: "review",
      cta: { stage: "review", label: CTA_LABEL.review },
      focusTaskId: reviewBlockedTask.id,
    };
  }

  const failedTask = firstTask(tasks, "failed");
  if (failedTask) {
    return {
      stage: "run",
      cta: { stage: "run", label: "重试失败任务" },
      focusTaskId: failedTask.id,
    };
  }

  const blockedTask = firstTask(tasks, "blocked");
  if (blockedTask) {
    return {
      stage: "run",
      cta: { stage: "run", label: "处理阻塞" },
      focusTaskId: blockedTask.id,
    };
  }

  const reviewTask = firstTask(tasks, "review");
  if (reviewTask) {
    return {
      stage: "review",
      cta: { stage: "review", label: CTA_LABEL.review },
      focusTaskId: reviewTask.id,
    };
  }

  const mergeItem = mergeQueue?.find((item) => ACTIVE_MERGE_STATES.has(item.state)) ?? null;
  if (mergeItem) {
    return {
      stage: "deliver",
      cta: { stage: "deliver", label: CTA_LABEL.deliver },
      focusTaskId: mergeItem.taskId,
    };
  }

  const readyTask = firstTask(tasks, "ready");
  if (readyTask) {
    return {
      stage: "plan",
      cta: { stage: "plan", label: CTA_LABEL.plan },
      focusTaskId: readyTask.id,
    };
  }

  const doneTask = firstTask(tasks, "done");
  if (doneTask) {
    // 未知队列不能断言“已交付/只需记忆”；等现有 MergeQueue 快照到达再判断。
    if (mergeQueue == null) {
      return { stage: "unknown", cta: null, focusTaskId: null };
    }
    return {
      stage: "remember",
      cta: { stage: "remember", label: CTA_LABEL.remember },
      focusTaskId: doneTask.id,
    };
  }

  if (tasks.length === 0) {
    return {
      stage: "discuss",
      cta: { stage: "discuss", label: CTA_LABEL.discuss },
      focusTaskId: null,
    };
  }

  return { stage: "unknown", cta: null, focusTaskId: null };
}

export interface NeedsMeInput {
  tasks: readonly Task[];
  mergeQueue?: readonly MergeQueueItem[] | null;
  watchdog?: WatchdogSnapshot | null;
}

/** NeedsMe listbox 的 Arrow/Home/End 导航；返回 null 表示不处理。 */
export function needsListNavigation(
  current: number,
  key: string,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (key === "ArrowDown" || key === "ArrowRight") return (current + 1) % length;
  if (key === "ArrowUp" || key === "ArrowLeft") return (current - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

function taskItem(task: Task, kind: "failed" | "blocked" | "review"): NeedsMeItem {
  return {
    id: `task:${kind}:${task.id}`,
    kind,
    title: task.title,
    detail:
      kind === "failed"
        ? "任务失败，需要重试或调整"
        : kind === "blocked"
          ? "任务阻塞，等待上游/人工处理"
          : "任务等待评审决定",
    taskId: task.id,
  };
}

/**
 * 汇总“需要我处理”的现有状态：
 * failed/blocked/review 任务、合并队列、open watchdog alert、硬预算。
 * 纯投影、按 id 去重；空数组表示无待办，不渲染空的 NeedsMe。
 */
export function deriveNeedsMe(input: NeedsMeInput): NeedsMeItem[] {
  const items: NeedsMeItem[] = [];
  const seen = new Set<string>();
  function add(item: NeedsMeItem) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  }

  for (const task of input.tasks) {
    if (task.status === "failed") add(taskItem(task, "failed"));
    else if (isReviewBlocked(task)) add(taskItem(task, "review"));
    else if (task.status === "blocked") add(taskItem(task, "blocked"));
    else if (task.status === "review") add(taskItem(task, "review"));
  }

  for (const item of input.mergeQueue ?? []) {
    if (!ACTIVE_MERGE_STATES.has(item.state)) continue;
    const blocked = item.state === "blocked" || item.state === "failed";
    add({
      id: `merge:${item.id}`,
      kind: "merge",
      title: item.taskTitle,
      detail: blocked
        ? `合并${item.state === "failed" ? "失败" : "阻塞"}，需要处理`
        : "待合并，等待批准/合并",
      taskId: item.taskId,
    });
  }

  const openAlerts = (input.watchdog?.alerts ?? []).filter(
    (alert) => alert.status === "open",
  );
  for (const alert of openAlerts) {
    add({
      id: `alert:${alert.id}`,
      kind: "alert",
      title: alert.title,
      detail: `${alert.severity} · 运行监控告警`,
      ...(alert.taskId ? { taskId: alert.taskId } : {}),
    });
  }

  const budgetRatio = input.watchdog?.budgets.workspaceDay.ratio;
  const hasBudgetAlert = openAlerts.some(
    (alert) => alert.kind === "budget_soft" || alert.kind === "budget_hard",
  );
  if (budgetRatio != null && budgetRatio >= 1 && !hasBudgetAlert) {
    add({
      id: "budget:workspace",
      kind: "budget",
      title: "工作区预算已用尽",
      detail: "预算达到上限，运行可能被暂停",
    });
  }

  return items;
}
