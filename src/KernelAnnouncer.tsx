import { useEffect, useRef, useState } from "react";
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
 */
export default function KernelAnnouncer({
  tasks,
  scheduler,
  runs,
  actionMessage,
}: {
  tasks: Task[];
  scheduler: SchedulerSnapshot | null;
  runs: Run[];
  actionMessage?: string | null;
}) {
  const [message, setMessage] = useState("");
  const previousTasks = useRef<ReturnType<typeof taskStatusSnapshot> | null>(null);
  const previousRuns = useRef<Map<string, Run["status"]> | null>(null);
  const previousScheduler = useRef<ReturnType<typeof schedulerAnnouncementState> | null>(null);

  useEffect(() => {
    const parts: string[] = [];
    const taskMessages = taskStatusAnnouncements(previousTasks.current, tasks);
    const nextRuns = new Map(runs.map((run) => [run.id, run.status]));
    const runMessages = runStatusAnnouncements(previousRuns.current, runs);
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
  }, [tasks, scheduler, runs]);

  useEffect(() => {
    if (actionMessage) setMessage(actionMessage);
  }, [actionMessage]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
