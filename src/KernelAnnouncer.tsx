import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, SchedulerSnapshot, Task } from "./shared/types";
import {
  runStatusAnnouncements,
  schedulerAnnouncement,
  schedulerAnnouncementState,
  taskStatusAnnouncements,
  taskStatusSnapshot,
} from "./shared/kernelUi";

/**
 * t117：以「当前数据」建立播报基线（非 null）——contextKey 切换后首个真实变化可正常 diff。
 * 导出供纯函数测试：切 tab 后基线 != null ⇒ 第一次任务/Run 变化不会被吞。
 */
export function announcerBaseline(
  tasks: Task[],
  displayedRuns: Run[],
  scheduler: SchedulerSnapshot | null,
) {
  return {
    tasks: taskStatusSnapshot(tasks),
    runs: new Map<string, Run["status"]>(displayedRuns.map((run) => [run.id, run.status])),
    scheduler: schedulerAnnouncementState(scheduler, tasks),
  };
}

/**
 * t69 aria-live 播报：任务状态、Run 状态、调度暂停/恢复与运行/排队计数变化。
 * 只输出无视觉的 live region；首次快照不播报，避免打开页面时刷屏。
 * t107 F5：Run 集合 = 当前展示 Runs ∪ scheduler.activeRuns（新增 id 以「新增（状态）」播报）。
 * t113/t117：contextKey（workspaceId:tab:selectedTaskId）变化时在独立 effect 中
 * **静默建立当前数据基线**（previous refs = 当前快照，而非 null）并清空旧 message——
 * 修复 t113 版本把 refs 置 null 导致切回 tab 后首个真实变化被 previous=null 吞掉的问题；
 * 后续数据变化照常 diff 播报。
 */
export default function KernelAnnouncer({
  tasks,
  scheduler,
  runs,
  actionMessage,
  contextKey,
}: {
  tasks: Task[];
  scheduler: SchedulerSnapshot | null;
  runs: Run[];
  actionMessage?: string | null;
  /** t113/t117：上下文键；变化时静默以当前数据重建基线（不播报）并清空旧 message。 */
  contextKey?: string;
}) {
  const [message, setMessage] = useState("");
  const previousTasks = useRef<ReturnType<typeof taskStatusSnapshot> | null>(null);
  const previousRuns = useRef<Map<string, Run["status"]> | null>(null);
  const previousScheduler = useRef<ReturnType<typeof schedulerAnnouncementState> | null>(null);

  // t107 F5：合并展示 Runs 与活跃 Run（同一 id 以展示 Runs 为准，避免状态抖动）。
  const displayedRuns = useMemo(() => {
    const map = new Map(runs.map((run) => [run.id, run]));
    for (const active of scheduler?.activeRuns ?? []) {
      if (map.has(active.id)) continue;
      map.set(active.id, {
        id: active.id,
        taskId: active.taskId,
        agentId: active.agentId,
        status: active.status,
        error: null,
        startedAt: active.startedAt,
        endedAt: active.endedAt,
        tokenIn: 0,
        tokenOut: 0,
        attempt: active.attempt,
      });
    }
    return [...map.values()];
  }, [runs, scheduler]);

  // t117 F1：contextKey 变化 → 独立 effect 静默重建基线（previous refs = 当前数据）+ 清空旧 message。
  // 基线非 null ⇒ 后续数据 effect 对真实变化正常 diff 播报（不再被 previous=null 吞掉）。
  useEffect(() => {
    const baseline = announcerBaseline(tasks, displayedRuns, scheduler);
    previousTasks.current = baseline.tasks;
    previousRuns.current = baseline.runs;
    previousScheduler.current = baseline.scheduler;
    setMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey]);

  // 数据 diff effect：首次（previous 仍为 null）不播报，只建基线。
  useEffect(() => {
    const parts: string[] = [];
    const taskMessages = taskStatusAnnouncements(previousTasks.current, tasks);
    const nextRuns = new Map(displayedRuns.map((run) => [run.id, run.status]));
    const runMessages = runStatusAnnouncements(previousRuns.current, displayedRuns);
    const nextScheduler = schedulerAnnouncementState(scheduler, tasks);
    const schedulerMessage = schedulerAnnouncement(
      previousScheduler.current,
      nextScheduler,
    );
    previousTasks.current = taskStatusSnapshot(tasks);
    previousRuns.current = nextRuns;
    previousScheduler.current = nextScheduler;
    parts.push(...taskMessages, ...runMessages);
    if (schedulerMessage) parts.push(schedulerMessage);
    if (parts.length > 0) setMessage(parts.join("；"));
  }, [tasks, scheduler, displayedRuns]);

  useEffect(() => {
    if (actionMessage) setMessage(actionMessage);
  }, [actionMessage]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
