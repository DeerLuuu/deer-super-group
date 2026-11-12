import { useEffect, useId, useState } from "react";
import type { Agent, EventRecord, Run, Task } from "./shared/types";
import { PERMISSION_LABELS } from "./shared/copy";
import {
  canCancelRun,
  eventSummary,
  eventTime,
  eventTone,
  eventTypeLabel,
  formatClockTime,
  formatDateTime,
  formatDuration,
  formatRelative,
  failureKindText,
  runDuration,
  runStatusHint,
  runStatusLabel,
  runTimelineEvents,
  runTitle,
  runTokenText,
} from "./shared/kernelUi";
import EmptyState from "./EmptyState";
import { RunHandoffCard } from "./watchdog/WatchdogPanel";
import type { RunHandoff } from "./shared/watchdog";

export function RunStatusBadge({ status }: { status: Run["status"] }) {
  return <span className={`status run-status-${status}`}>{runStatusLabel(status)}</span>;
}

function durationText(run: Run): string {
  return formatDuration(runDuration(run));
}

/**
 * 单次 Run 的字段 + 时间线。
 * 字段满足 t69 验收：attempt / lease / heartbeat / token / error / 事件；
 * 时间线只取 aggregateId === runId 的事件（不把任务级 tool 事件错配到 Run）。
 */
export function RunDetail({
  run,
  agent,
  events,
  busy,
  onCancelRun,
  onOpenRunPanel,
}: {
  run: Run;
  agent: Agent | null;
  events: EventRecord[];
  busy: string | null;
  onCancelRun: (run: Run) => void;
  onOpenRunPanel?: (runId: string) => void;
}) {
  const timeline = runTimelineEvents(events, run.id).sort((a, b) => a.seq - b.seq);
  const cancelBusy = busy === `run:${run.id}`;
  // t113 F4：hint id 用 useId 前缀，双面板（任务页 + Runs 面板）同时渲染不撞 id。
  const cancelHintId = `${useId()}-run-cancel-hint`;
  return (
    <div className="run-detail" data-run-id={run.id}>
      <div className="run-detail-head">
        <div className="row gap wrap">
          <RunStatusBadge status={run.status} />
          <strong>{runTitle(run)}</strong>
          <span className="muted tiny">{runStatusHint(run)}</span>
        </div>
        <div className="row gap">
          {onOpenRunPanel && (
            <button
              type="button"
              className="ghost tiny"
              onClick={() => onOpenRunPanel(run.id)}
              title="在运行面板查看该 Run 的完整上下文"
            >
              在运行面板打开
            </button>
          )}
          {/* t107 F3：取消 Run 常驻渲染（disabled + 原因），与任务页/RunPanel 一致。 */}
          <button
            type="button"
            className="ghost tiny run-danger"
            onClick={() => onCancelRun(run)}
            disabled={!canCancelRun(run) || cancelBusy}
            title={
              canCancelRun(run)
                ? "取消该 Run：会中止执行，任务将被标记为失败（RUN_CANCELLED）"
                : "仅运行中（running）的 Run 可以取消"
            }
            aria-describedby={canCancelRun(run) ? undefined : cancelHintId}
          >
            {cancelBusy ? "取消中…" : "取消 Run"}
          </button>
        </div>
      </div>

      <dl className="run-fields">
        <div>
          <dt>attempt</dt>
          <dd>#{run.attempt ?? 1}</dd>
        </div>
        <div>
          <dt>成员</dt>
          <dd>{agent ? agent.name : run.agentId}</dd>
        </div>
        <div>
          <dt>model</dt>
          <dd className="mono tiny">{run.modelId || "默认"}</dd>
        </div>
        <div>
          <dt>权限</dt>
          <dd>
            {run.permissionSnapshot
              ? PERMISSION_LABELS[run.permissionSnapshot] ?? run.permissionSnapshot
              : "—"}
          </dd>
        </div>
        <div>
          <dt>开始</dt>
          <dd title={formatDateTime(run.startedAt)}>{formatClockTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd title={formatDateTime(run.endedAt)}>{formatClockTime(run.endedAt)}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{durationText(run)}</dd>
        </div>
        <div>
          <dt>心跳</dt>
          <dd title={formatDateTime(run.heartbeatAt)}>
            {run.heartbeatAt ? formatRelative(run.heartbeatAt) : "—"}
          </dd>
        </div>
        <div>
          <dt>租约</dt>
          <dd className="mono tiny" title={run.leaseExpiresAt ?? undefined}>
            {run.leaseOwner ? `owner ${run.leaseOwner}` : "—"}
            {run.leaseExpiresAt ? ` · 至 ${formatClockTime(run.leaseExpiresAt)}` : ""}
          </dd>
        </div>
        <div>
          <dt>token（入/出）</dt>
          <dd className="mono tiny">{runTokenText(run)}</dd>
        </div>
        <div>
          <dt>steps</dt>
          <dd>{run.steps ?? 0}</dd>
        </div>
        <div>
          <dt>checkpoint</dt>
          <dd className="mono tiny">
            step {run.checkpointStep ?? 0}
            {run.checkpointRef ? ` · ${run.checkpointRef}` : ""}
          </dd>
        </div>
        <div>
          <dt>花费</dt>
          <dd>${Number(run.costUsd ?? 0).toFixed(4)}</dd>
        </div>
        <div>
          <dt>错误码</dt>
          <dd className={run.errorCode ? "run-error-code" : ""}>
            {run.errorCode ? failureKindText(run.errorCode) : "—"}
          </dd>
        </div>
      </dl>

      {run.error && (
        <div className="run-error" role="alert">
          <div className="section-label">错误详情</div>
          <p>{run.error}</p>
          <span className="muted tiny">
            {run.retryable ? "可重试（内核会自动退避重试）" : "不可重试"}
          </span>
        </div>
      )}

      {/* t107 F3：取消不可用时的可见原因（aria-describedby 引用）。 */}
      {!canCancelRun(run) && (
        <div id={cancelHintId} className="muted tiny task-action-hint">
          仅运行中（running）的 Run 可以取消；历史 Run 不可取消。
        </div>
      )}

      <div className="run-timeline-head">
        <span className="section-label">Run 事件</span>
        <span className="muted tiny">{timeline.length} 条</span>
      </div>
      {timeline.length === 0 ? (
        <div className="empty small">该 Run 暂无事件（可能仍在启动或事件被清理）。</div>
      ) : (
        <ol className="run-timeline" aria-label={`${runTitle(run)} 事件时间线`}>
          {timeline.map((event) => (
            <li key={event.seq} className={`run-event tone-${eventTone(event.type)}`}>
              <div className="run-event-meta">
                <span className="mono tiny">{formatClockTime(eventTime(event))}</span>
                <span className="run-event-type">{eventTypeLabel(event.type)}</span>
                <span className="muted tiny">{event.actor || "—"}</span>
              </div>
              {eventSummary(event) && (
                <div className="run-event-body">{eventSummary(event)}</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * 任务详情里的 Run 历史：按 attempt 倒序；选中行展开字段+时间线。
 * loading/error/empty 三态齐备；操作有 disabled 原因与 aria 标签。
 */
export default function RunHistory({
  task,
  runs,
  agents,
  events,
  loading,
  error,
  selectedRunId,
  busy,
  onRetryLoad,
  onSelectRun,
  onCancelRun,
  onOpenRunPanel,
  onRetryTask,
  handoffs,
}: {
  task: Task;
  runs: Run[];
  agents: Agent[];
  events: EventRecord[];
  loading: boolean;
  error: string | null;
  selectedRunId: string | null;
  busy: string | null;
  onRetryLoad: () => void;
  onSelectRun: (runId: string) => void;
  onCancelRun: (run: Run) => void;
  onOpenRunPanel: (runId?: string) => void;
  onRetryTask: () => void;
  handoffs?: Record<string, RunHandoff>;
}) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const sorted = [...runs].sort(
    (a, b) =>
      (b.attempt ?? 0) - (a.attempt ?? 0) ||
      b.startedAt.localeCompare(a.startedAt),
  );
  const selected =
    sorted.find((item) => item.id === selectedRunId) ?? sorted[0] ?? null;
  const [loadedHandoff, setLoadedHandoff] = useState<RunHandoff | null>(null);
  useEffect(() => {
    if (!selected) {
      setLoadedHandoff(null);
      return;
    }
    let active = true;
    void window.deer
      .getRunHandoff(task.workspaceId, selected.id)
      .then((result) => {
        if (active && result.ok) setLoadedHandoff(result.value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selected?.id, task.workspaceId]);
  const selectedHandoff = selected ? handoffs?.[selected.id] ?? loadedHandoff : null;
  const retryBusy = busy === "task:retry";

  return (
    <section className="run-history" aria-label="运行记录" title="Run 历史">
      <div className="run-history-head">
        <div>
          <div className="panel-title">运行记录</div>
          <div className="muted tiny">
            {runs.length === 0
              ? "还没有执行记录"
              : `${runs.length} 次尝试 · 最近 ${formatRelative(sorted[0]?.startedAt)}`}
          </div>
        </div>
        <div className="row gap wrap">
          {task.status === "failed" && (
            <button
              type="button"
              className="primary small"
              onClick={onRetryTask}
              disabled={retryBusy}
              title="重新入队：会新建一次 attempt，沿用同一任务与依赖"
            >
              {retryBusy ? "重试中…" : "重试任务"}
            </button>
          )}
          <button
            type="button"
            className="ghost small"
            onClick={() => onOpenRunPanel(selected?.id)}
            title="在 Dock 运行面板中查看（支持深链）"
          >
            在运行面板打开
          </button>
        </div>
      </div>

      {loading && runs.length === 0 && (
        <div className="run-history-skeleton" role="status" aria-live="polite">
          <span /> <span /> <span />
          <div className="muted tiny">正在加载 Run 记录…</div>
        </div>
      )}

      {error && (
        <div className="run-history-error" role="alert">
          <span>Run 记录读取失败：{error}</span>
          <button type="button" className="ghost tiny" onClick={onRetryLoad}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          compact
          icon="▷"
          title="还没有执行记录"
          description="点击「运行任务」入队；每次 attempt 的成员、心跳、token 与事件会记录在这里。"
        />
      )}

      {sorted.length > 0 && (
        <>
          <ul className="run-list" aria-label="Run 列表">
            {sorted.map((run) => {
              const agent = agentById.get(run.agentId) ?? null;
              const active = run.id === selected?.id;
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    className={`run-row ${active ? "selected" : ""}`}
                    onClick={() => onSelectRun(run.id)}
                    aria-pressed={active}
                    aria-label={`${runTitle(run)}，${runStatusLabel(run.status)}`}
                  >
                    <span className="run-row-main">
                      <span className="run-attempt">#{run.attempt ?? 1}</span>
                      <RunStatusBadge status={run.status} />
                      <span className="ellipsis">{agent ? agent.name : run.agentId}</span>
                    </span>
                    <span className="run-row-meta muted tiny">
                      <span>{formatClockTime(run.startedAt)}</span>
                      <span>{durationText(run)}</span>
                      <span>tok {runTokenText(run)}</span>
                      {run.errorCode && (
                        <span className="run-error-code">{failureKindText(run.errorCode)}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <>
              <RunDetail
                run={selected}
                agent={agentById.get(selected.agentId) ?? null}
                events={events}
                busy={busy}
                onCancelRun={onCancelRun}
                onOpenRunPanel={onOpenRunPanel}
              />
              {selectedHandoff && <RunHandoffCard handoff={selectedHandoff} />}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Run 面板左栏复用的小行（不依赖任务详情选中态）。 */
export function RunMiniRow({
  run,
  agentName,
  taskTitle,
  active,
  onClick,
}: {
  run: Run;
  agentName: string;
  taskTitle?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`run-row run-mini ${active ? "selected" : ""}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="run-row-main">
        <span className="run-attempt">#{run.attempt ?? 1}</span>
        <RunStatusBadge status={run.status} />
        <span className="ellipsis">{taskTitle ?? run.taskId}</span>
      </span>
      <span className="run-row-meta muted tiny">
        <span>{agentName}</span>
        <span>{formatRelative(run.heartbeatAt ?? run.startedAt)}</span>
      </span>
    </button>
  );
}

