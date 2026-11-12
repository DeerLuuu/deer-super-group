import { useId, useMemo, useState } from "react";
import type { Agent, SchedulerSnapshot, Task } from "./shared/types";
import {
  formatClockTime,
  formatRelative,
  schedulerActiveCount,
  schedulerLimitsText,
  schedulerQueueCount,
  schedulerSummaryText,
  statusCounts,
} from "./shared/kernelUi";
import EmptyState from "./EmptyState";

type SchedulerBarProps = {
  scheduler: SchedulerSnapshot | null;
  tasks: Task[];
  agents: Agent[];
  loading: boolean;
  error: string | null;
  busy: string | null;
  compact?: boolean;
  onRetryLoad: () => void;
  onPause: () => void;
  onResume: () => void;
  onOpenRuns: () => void;
  onSelectTask?: (taskId: string) => void;
};

/**
 * t69 调度栏：任务面板头部（设计 §9.4）。
 * - 运行中 / 排队计数、并发上限、暂停/恢复；
 * - 队列可展开（键盘可聚焦、点击选中任务）；t113：容器恒渲染、id 用 useId 唯一化（多面板安全）；
 * - loading/error 态；错误用 role=alert；t113 F5：error 时队列按钮与容器都不渲染（按钮不存在即无悬空 aria-controls）。
 */
export default function SchedulerBar({
  scheduler,
  tasks,
  agents,
  loading,
  error,
  busy,
  compact = false,
  onRetryLoad,
  onPause,
  onResume,
  onOpenRuns,
  onSelectTask,
}: SchedulerBarProps) {
  const [queueOpen, setQueueOpen] = useState(false);
  const queueId = useId();
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const counts = statusCounts(tasks);
  const running = scheduler ? schedulerActiveCount(scheduler) : counts.running;
  const queued = scheduler ? schedulerQueueCount(scheduler) : counts.queued;
  const paused = Boolean(scheduler?.paused);
  const pauseBusy = busy === "scheduler:pause" || busy === "scheduler:resume";
  const queue = scheduler?.queue ?? [];
  const summary = schedulerSummaryText(scheduler, tasks);

  if (loading) {
    return (
      <section className="scheduler-bar" aria-label="任务调度" aria-busy="true">
        <div className="scheduler-skeleton" role="status" aria-live="polite">
          正在加载调度状态…
        </div>
      </section>
    );
  }

  return (
    <section className="scheduler-bar" aria-label="任务调度">
      <div className="scheduler-main">
        <div className="scheduler-summary">
          <span
            className={`scheduler-dot ${paused ? "paused" : running > 0 ? "active" : "idle"}`}
            aria-hidden="true"
          />
          <strong className="scheduler-counts">{summary}</strong>
          <span className="muted tiny scheduler-limits" title="内核并发上限">
            {schedulerLimitsText(scheduler)}
          </span>
          {paused && (
            <span className="scheduler-paused" role="status">
              {scheduler?.pausedReason
                ? `已暂停：${scheduler.pausedReason}`
                : "已暂停"}
            </span>
          )}
        </div>
        <div className="scheduler-actions">
          {/* t113 F5：error 时队列按钮隐藏（与队列容器同条件渲染，aria-controls 永不悬空）。 */}
          {!error && queued > 0 && !compact && (
            <button
              type="button"
              className="ghost tiny"
              aria-expanded={queueOpen}
              aria-controls={queueId}
              onClick={() => setQueueOpen((open) => !open)}
            >
              队列 {queued} {queueOpen ? "▴" : "▾"}
            </button>
          )}
          {paused ? (
            <button
              type="button"
              className="primary small"
              onClick={onResume}
              disabled={pauseBusy}
              title="恢复调度：继续启动排队的任务"
            >
              {busy === "scheduler:resume" ? "恢复中…" : "恢复调度"}
            </button>
          ) : (
            <button
              type="button"
              className="ghost small"
              onClick={onPause}
              disabled={pauseBusy || !scheduler}
              aria-pressed={false}
              title="暂停调度：运行中的任务继续，新的排队任务不会启动"
            >
              {busy === "scheduler:pause" ? "暂停中…" : "暂停调度"}
            </button>
          )}
          <button type="button" className="ghost small" onClick={onOpenRuns}>
            运行面板
          </button>
        </div>
      </div>

      {error && (
        <div className="scheduler-error" role="alert">
          <span>调度状态读取失败：{error}</span>
          <button type="button" className="ghost tiny" onClick={onRetryLoad}>
            重试
          </button>
        </div>
      )}

      {/* t107 F7 + t113：队列容器始终渲染（关闭时 hidden + CSS display:none 兜底）；id 用 useId 唯一化。 */}
      {!error && queued > 0 && !compact && (
        <div className="scheduler-queue" id={queueId} hidden={!queueOpen}>
          <div className="scheduler-queue-head">
            <span className="section-label">排队任务（按优先级 / FIFO）</span>
            <span className="muted tiny">同一工作区同时只运行 1 个</span>
          </div>
          {queue.length === 0 ? (
            <EmptyState
              compact
              icon="◌"
              title="队列为空"
              description="已无 queued 任务；新任务点击「运行任务」后进入队列。"
            />
          ) : (
            <ul className="scheduler-queue-list">
              {queue.map((item) => {
                const owner = item.ownerId ? agentById.get(item.ownerId) : null;
                return (
                  <li key={item.taskId}>
                    <button
                      type="button"
                      className="scheduler-queue-item"
                      onClick={() => onSelectTask?.(item.taskId)}
                      title={`选中任务 ${item.title}`}
                    >
                      <span className="ellipsis">{item.title}</span>
                      <span className="muted tiny">
                        {owner ? owner.name : "未分配"} · 优先级 {item.priority} · 已等{" "}
                        {item.queuedAt ? formatRelative(item.queuedAt) : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {!error && queued > 0 && !compact && !queueOpen && (
        <div className="scheduler-foot muted tiny">
          最早入队 {formatClockTime(queue[0]?.queuedAt ?? null)} · 展开队列可选中任务
        </div>
      )}
    </section>
  );
}
