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
 * t69 aria-live 播报：任务状态、Run 状态、调度暂停/恢复与运行/排队计数变化。
 * 只输出无视觉的 live region；首次快照不播报，避免打开页面时刷屏。
 * t107 F5：Run 集合 = 当前展示 Runs ∪ scheduler.activeRuns（新增 id 以「新增（状态）」播报）。
 * t113 F2：contextKey（workspaceId:panelKey 或 workspaceId:selectedTaskId）变化时重置
 * 三个 previous refs 但不播报——切换面板/任务不产生「全部新增」的刷屏。
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
  /** t113：上下文键；变化时静默重置基线（不播报）。 */
  contextKey?: string;
}) {
  const [message, setMessage] = useState("");
  const previousTasks = useRef<ReturnType<typeof taskStatusSnapshot> | null>(null);
  const previousRuns = useRef<Map<string, Run["status"]> | null>(null);
  const previousScheduler = useRef<ReturnType<typeof schedulerAnnouncementState> | null>(null);
  const previousContextKey = useRef<string | undefined>(undefined);
  const contextReset = useRef(false);

  // t113 F2：contextKey 变化 → 静默重置基线（本轮 effect 里 previous 已为 null，
  // 所有 announcement 函数对 previous=null 返回 []，天然不播报）。
  if (contextKey !== previousContextKey.current) {
    previousContextKey.current = contextKey;
    previousTasks.current = null;
    previousRuns.current = null;
    previousScheduler.current = null;
    contextReset.current = true;
  }

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
    else if (contextReset.current) setMessage("");
    contextReset.current = false;
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
