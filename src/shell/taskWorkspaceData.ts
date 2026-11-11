import type { Task } from "../shared/types.js";

export type TaskWorkspaceTab = "overview" | "runs" | "review" | "git" | "history";

export const TASK_WORKSPACE_TABS: ReadonlyArray<{ id: TaskWorkspaceTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "runs", label: "运行" },
  { id: "review", label: "评审" },
  { id: "git", label: "Git" },
  { id: "history", label: "历史" },
];

export function taskWorkspaceTabForKey(
  tab: TaskWorkspaceTab,
  key: string,
): TaskWorkspaceTab | null {
  const index = TASK_WORKSPACE_TABS.findIndex((item) => item.id === tab);
  if (index < 0) return null;
  if (key === "Home") return TASK_WORKSPACE_TABS[0]!.id;
  if (key === "End") return TASK_WORKSPACE_TABS[TASK_WORKSPACE_TABS.length - 1]!.id;
  if (key === "ArrowLeft") {
    return TASK_WORKSPACE_TABS[(index - 1 + TASK_WORKSPACE_TABS.length) % TASK_WORKSPACE_TABS.length]!.id;
  }
  if (key === "ArrowRight") {
    return TASK_WORKSPACE_TABS[(index + 1) % TASK_WORKSPACE_TABS.length]!.id;
  }
  return null;
}

export type TaskWorkspacePrimary =
  | "run"
  | "retry"
  | "review-tab"
  | "git-tab"
  | "runs-tab"
  | "history-tab"
  | "upstream"
  | "none";

export interface TaskWorkspaceNext {
  key: TaskWorkspacePrimary;
  label: string;
  detail: string;
  tab?: TaskWorkspaceTab;
  disabled?: boolean;
  reason?: string;
}

/** Sticky 头唯一 primary：按当前交付阶段给出下一步，不改变任何 gate。 */
export function taskWorkspaceNext(input: {
  task: Pick<Task, "status" | "blockedReason" | "failureKind">;
  startEnabled: boolean;
  startReason: string;
  retryEnabled: boolean;
  retryReason: string;
  unfilledDeps: number;
}): TaskWorkspaceNext {
  const { task } = input;
  if (task.status === "review") {
    return {
      key: "review-tab",
      label: "去评审",
      detail: "任务等待交付评审：检查 diff 后批准或拒绝。",
      tab: "review",
    };
  }
  if (task.status === "failed") {
    return {
      key: "retry",
      label: "重试任务",
      detail: "失败任务会新建一次 attempt；确认原因后再重试。",
      disabled: !input.retryEnabled,
      reason: input.retryReason,
    };
  }
  if (task.status === "done") {
    return {
      key: "git-tab",
      label: "查看 Git / 合并",
      detail: "交付已完成：检查分支、PR、检查与合并队列状态。",
      tab: "git",
    };
  }
  if (task.status === "queued" || task.status === "running") {
    return {
      key: "runs-tab",
      label: "查看运行",
      detail:
        task.status === "running"
          ? "任务运行中：查看当前 Run，必要时停止。"
          : "任务已入队：查看调度与 Run 状态。",
      tab: "runs",
    };
  }
  if (task.status === "cancelled") {
    return {
      key: "history-tab",
      label: "查看历史",
      detail: "任务已取消：保留 trace 与 Run 历史供审计。",
      tab: "history",
    };
  }
  if (task.status === "blocked" && /conflict|冲突|merge/i.test(task.blockedReason ?? "")) {
    return {
      key: "git-tab",
      label: "处理冲突",
      detail: "合并/worktree 冲突：到 Git tab 查看冲突与 worktree 后处理。",
      tab: "git",
    };
  }
  if (task.status === "blocked" && input.unfilledDeps > 0) {
    return {
      key: "upstream",
      label: "查看上游依赖",
      detail: "任务被未完成的上游依赖阻塞；先完成上游或定位依赖。",
      disabled: false,
    };
  }
  return {
    key: "run",
    label: "运行任务",
    detail: "任务可运行：确认权限与范围后入队。",
    disabled: !input.startEnabled,
    reason: input.startReason,
  };
}
