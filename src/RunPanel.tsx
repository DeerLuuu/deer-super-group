import { useMemo } from "react";
import type {
  Agent,
  EventRecord,
  Run,
  SchedulerSnapshot,
  Snapshot,
  Task,
} from "./shared/types";
import {
  blockedReasonText,
  failureKindText,
  formatClockTime,
  formatRelative,
  runStatusLabel,
  schedulerLimitsText,
  schedulerSummaryText,
  taskActionState,
  taskAttemptText,
  taskNextStep,
  unfinishedDependencies,
} from "./shared/kernelUi";
import EmptyState from "./EmptyState";
import StatusBadge from "./StatusBadge";
import { RunDetail, RunMiniRow } from "./RunHistory";

/**
 * t69 Dock「运行」面板：
 * - 左栏：调度摘要（暂停/恢复）+ 活跃 Run + 队列 + 当前任务的 Run 历史；
 * - 右栏：选中 Run 的字段、心跳/租约/token/错误与事件时间线；
 * - 与任务页/团队页共享 selectedTaskId/selectedRunId，支持 #/tasks?t=&r= 深链；
 * - 窄面板下左右栏自动换行（CSS flex-wrap），所有操作键盘可达。
 */
export default function RunPanel({
  snapshot,
  scheduler,
  schedulerLoading,
  schedulerError,
  runs,
  runsLoading,
  runsError,
  trace,
  selectedTaskId,
  selectedRunId,
  busy,
  onSelectTask,
  onSelectRun,
  onOpenRun,
  onOpenTaskPage,
  onOpenTaskChat,
  onStartTask,
  onRetryTask,
  onCancelTask,
  onCancelRun,
  onReviewTask,
  onPause,
  onResume,
  onReloadScheduler,
  onReloadRuns,
  onOpenTasks,
}: {
  snapshot: Snapshot;
  scheduler: SchedulerSnapshot | null;
  schedulerLoading: boolean;
  schedulerError: string | null;
  runs: Run[];
  runsLoading: boolean;
  runsError: string | null;
  trace: EventRecord[];
  selectedTaskId: string | null;
  selectedRunId: string | null;
  busy: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectRun: (runId: string | null) => void;
  onOpenRun: (taskId: string, runId: string) => void;
  onOpenTaskPage: (taskId: string) => void;
  onOpenTaskChat: (taskId: string) => void;
  onStartTask: (task: Task) => void;
  onRetryTask: (task: Task) => void;
  onCancelTask: (task: Task) => void;
  onCancelRun: (run: Run) => void;
  onReviewTask: (task: Task, decision: "approve" | "reject") => void;
  onPause: () => void;
  onResume: () => void;
  onReloadScheduler: () => void;
  onReloadRuns: () => void;
  onOpenTasks: () => void;
}) {
  const taskById = useMemo(
    () => new Map(snapshot.tasks.map((task) => [task.id, task])),
    [snapshot.tasks],
  );
  const agentById = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.id, agent])),
    [snapshot.agents],
  );
  const selectedTask = selectedTaskId ? (taskById.get(selectedTaskId) ?? null) : null;
  const sortedRuns = useMemo(
    () =>
      [...runs].sort(
        (a, b) =>
          (b.attempt ?? 0) - (a.attempt ?? 0) ||
          b.startedAt.localeCompare(a.startedAt),
      ),
    [runs],
  );
  const selectedRun =
    sortedRuns.find((run) => run.id === selectedRunId) ??
    (selectedTask ? sortedRuns[0] ?? null : null);
  const paused = Boolean(scheduler?.paused);
  const pauseBusy = busy === "scheduler:pause" || busy === "scheduler:resume";
  const actions = selectedTask
    ? taskActionState(
        selectedTask,
        taskById,
        snapshot.agents.some((agent) => !agent.isRouter && agent.status !== "offline"),
      )
    : null;
  const nextStep = selectedTask
    ? taskNextStep(
        selectedTask,
        taskById,
        snapshot.agents.some((agent) => !agent.isRouter && agent.status !== "offline"),
      )
    : null;
  const unfilled = selectedTask ? unfinishedDependencies(selectedTask, taskById) : [];

  return (
    <div className="run-panel">
      <header className="run-panel-head">
        <div>
          <div className="panel-title">运行与调度</div>
          <div className="muted tiny">
            {schedulerLoading
              ? "读取调度状态…"
              : schedulerSummaryText(scheduler, snapshot.tasks)}
            {scheduler ? ` · ${schedulerLimitsText(scheduler)}` : ""}
          </div>
        </div>
        <div className="row gap wrap">
          {paused ? (
            <button
              type="button"
              className="primary small"
              onClick={onResume}
              disabled={pauseBusy}
            >
              {busy === "scheduler:resume" ? "恢复中…" : "恢复调度"}
            </button>
          ) : (
            <button
              type="button"
              className="ghost small"
              onClick={onPause}
              disabled={pauseBusy || !scheduler}
              title="暂停调度：运行中的任务继续，队列不启动"
            >
              {busy === "scheduler:pause" ? "暂停中…" : "暂停调度"}
            </button>
          )}
          <button type="button" className="ghost small" onClick={onOpenTasks}>
            任务页
          </button>
        </div>
      </header>

      {paused && (
        <div className="notice small run-panel-paused" role="status">
          调度已暂停{scheduler?.pausedReason ? `（${scheduler.pausedReason}）` : ""}
          ；运行中的任务会继续，排队的任务不会启动。
        </div>
      )}
      {schedulerError && (
        <div className="run-panel-error" role="alert">
          <span>调度状态读取失败：{schedulerError}</span>
          <button type="button" className="ghost tiny" onClick={onReloadScheduler}>
            重试
          </button>
        </div>
      )}

      <div className="run-panel-body">
        <section className="run-panel-list" aria-label="活跃任务执行、队列与历史">
          {schedulerLoading ? (
            <div className="run-panel-skeleton" role="status" aria-live="polite">
              正在加载调度队列…
            </div>
          ) : (
            <>
              <div className="run-section-head">
                <span className="section-label">活跃执行</span>
                <span className="muted tiny">{scheduler?.activeRuns.length ?? 0} 个</span>
              </div>
              {(scheduler?.activeRuns.length ?? 0) === 0 ? (
                <div className="empty small">
                  当前没有运行中的任务执行。
                  <button type="button" className="ghost tiny" onClick={onOpenTasks}>
                    去任务页运行
                  </button>
                </div>
              ) : (
                <ul className="run-list">
                  {scheduler?.activeRuns.map((run) => {
                    const task = taskById.get(run.taskId);
                    const agent = agentById.get(run.agentId);
                    return (
                      <li key={run.id}>
                        <RunMiniRow
                          run={{
                            id: run.id,
                            taskId: run.taskId,
                            agentId: run.agentId,
                            status: run.status,
                            error: null,
                            startedAt: run.startedAt,
                            endedAt: run.endedAt,
                            tokenIn: 0,
                            tokenOut: 0,
                            attempt: run.attempt,
                            heartbeatAt: run.heartbeatAt,
                            errorCode: run.errorCode,
                          }}
                          agentName={agent ? agent.name : run.agentId}
                          taskTitle={task?.title ?? run.taskId}
                          active={selectedRun?.id === run.id}
                          onClick={() => onOpenRun(run.taskId, run.id)}
                        />
                        <div className="muted tiny run-mini-meta">
                          {runStatusLabel(run.status)} · 心跳{" "}
                          {run.heartbeatAt ? formatRelative(run.heartbeatAt) : "—"} · 开始{" "}
                          {formatClockTime(run.startedAt)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="run-section-head">
                <span className="section-label">队列</span>
                <span className="muted tiny">{scheduler?.queue.length ?? 0} 个</span>
              </div>
              {(scheduler?.queue.length ?? 0) === 0 ? (
                <div className="empty small">队列为空。</div>
              ) : (
                <ul className="run-list">
                  {scheduler?.queue.map((item) => {
                    const owner = item.ownerId ? agentById.get(item.ownerId) : null;
                    const active = item.taskId === selectedTaskId;
                    return (
                      <li key={item.taskId}>
                        <button
                          type="button"
                          className={`run-row run-mini ${active ? "selected" : ""}`}
                          onClick={() => onSelectTask(item.taskId)}
                          aria-pressed={active}
                        >
                          <span className="run-row-main">
                            <span className="run-attempt">D</span>
                            <span className="status run-status-queued">排队</span>
                            <span className="ellipsis">{item.title}</span>
                          </span>
                          <span className="run-row-meta muted tiny">
                            <span>{owner ? owner.name : "未分配"}</span>
                            <span>优先级 {item.priority}</span>
                            <span>{item.queuedAt ? formatRelative(item.queuedAt) : "—"}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="run-section-head">
                <span className="section-label">当前任务</span>
                <span className="muted tiny">
                  {selectedTask ? taskAttemptText(selectedTask) : "未选择"}
                </span>
              </div>
              {!selectedTask ? (
                <EmptyState
                  compact
                  icon="▷"
                  title="选择一个任务"
                  description="从上方活跃 Run/队列选择，或去任务页选择任务；这里会展示它的全部 Run 与时间线。"
                  actions={[{ label: "打开任务页", onClick: onOpenTasks, primary: true }]}
                />
              ) : (
                <div className="run-selected-task">
                  <div className="run-selected-task-head">
                    <button
                      type="button"
                      className="link-button ellipsis"
                      onClick={() => onOpenTaskPage(selectedTask.id)}
                      title="在任务页打开该任务"
                    >
                      {selectedTask.title}
                    </button>
                    <StatusBadge status={selectedTask.status} />
                  </div>
                  <div className="muted tiny">
                    {selectedTask.status} · {taskAttemptText(selectedTask)}
                    {selectedTask.blockedReason
                      ? ` · ${blockedReasonText(selectedTask.blockedReason)}`
                      : ""}
                    {selectedTask.failureKind
                      ? ` · ${failureKindText(selectedTask.failureKind)}`
                      : ""}
                  </div>
                  {nextStep && (
                    <div className={`run-next-step tone-${nextStep.kind}`}>
                      <strong>{nextStep.label}</strong>
                      <span>{nextStep.detail}</span>
                      {unfilled.length > 0 && (
                        <span className="muted tiny">
                          上游：{unfilled.map((item) => item.title).join("、")}
                        </span>
                      )}
                    </div>
                  )}
                  {/* t107 F3：主要操作常驻渲染（disabled + 原因），与任务页一致。 */}
                  <div className="row gap wrap run-selected-task-actions">
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => onStartTask(selectedTask)}
                      disabled={
                        !actions?.start.enabled || busy === `task:start:${selectedTask.id}`
                      }
                      title={actions?.start.reason || "入队运行"}
                      aria-describedby={
                        actions?.start.enabled ? undefined : "run-panel-action-hint"
                      }
                    >
                      {busy === `task:start:${selectedTask.id}` ? "入队中…" : "运行任务"}
                    </button>
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => onRetryTask(selectedTask)}
                      disabled={
                        !actions?.retry.enabled || busy === `task:retry:${selectedTask.id}`
                      }
                      title={actions?.retry.reason || "重新入队：会新建一次 attempt"}
                      aria-describedby={
                        actions?.retry.enabled ? undefined : "run-panel-action-hint"
                      }
                    >
                      {busy === `task:retry:${selectedTask.id}` ? "重试中…" : "重试任务"}
                    </button>
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => onReviewTask(selectedTask, "approve")}
                      disabled={
                        !actions?.review.enabled || busy === `task:review:${selectedTask.id}`
                      }
                      title={actions?.review.reason || "批准：任务标记为已交付"}
                      aria-describedby={
                        actions?.review.enabled ? undefined : "run-panel-action-hint"
                      }
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className="ghost small run-danger"
                      onClick={() => onReviewTask(selectedTask, "reject")}
                      disabled={
                        !actions?.review.enabled || busy === `task:review:${selectedTask.id}`
                      }
                      title={actions?.review.reason || "拒绝：任务标记失败（REVIEW_REJECTED）"}
                      aria-describedby={
                        actions?.review.enabled ? undefined : "run-panel-action-hint"
                      }
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="ghost small run-danger"
                      onClick={() => onCancelTask(selectedTask)}
                      disabled={
                        !actions?.cancel.enabled || busy === `task:cancel:${selectedTask.id}`
                      }
                      title={actions?.cancel.reason || "取消任务：正在执行的任务会中止，取消是终态"}
                      aria-describedby={
                        actions?.cancel.enabled ? undefined : "run-panel-action-hint"
                      }
                    >
                      {busy === `task:cancel:${selectedTask.id}` ? "取消中…" : "取消任务"}
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => onOpenTaskChat(selectedTask.id)}
                    >
                      打开会话
                    </button>
                  </div>
                  {actions && (
                    <div
                      id="run-panel-action-hint"
                      className="muted tiny task-action-hint"
                    >
                      {[actions.start, actions.retry, actions.review, actions.cancel]
                        .filter((gate) => !gate.enabled && gate.reason)
                        .map((gate) => gate.reason)
                        .join("；")}
                    </div>
                  )}
                  {runsError && (
                    <div className="run-panel-error" role="alert">
                      <span>Run 记录读取失败：{runsError}</span>
                      <button type="button" className="ghost tiny" onClick={onReloadRuns}>
                        重试
                      </button>
                    </div>
                  )}
                  {runsLoading && sortedRuns.length === 0 ? (
                    <div className="run-panel-skeleton" role="status" aria-live="polite">
                      正在加载运行记录…
                    </div>
                  ) : sortedRuns.length === 0 ? (
                    <div className="empty small">该任务还没有执行记录。</div>
                  ) : (
                    <ul className="run-list">
                      {sortedRuns.map((run) => (
                        <li key={run.id}>
                          <RunMiniRow
                            run={run}
                            agentName={
                              agentById.get(run.agentId)?.name ?? run.agentId
                            }
                            active={selectedRun?.id === run.id}
                            onClick={() => onSelectRun(run.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <section className="run-panel-detail" aria-label="Run 详情与时间线">
          {selectedRun ? (
            <RunDetail
              run={selectedRun}
              agent={agentById.get(selectedRun.agentId) ?? null}
              events={trace}
              busy={busy}
              onCancelRun={onCancelRun}
            />
          ) : (
            <EmptyState
              icon="▷"
              title="没有选中的 Run"
              description="选择左侧的活跃 Run / 历史 Run，或从任务页「在运行面板打开」带 Run id 跳转。"
              actions={[{ label: "打开任务页", onClick: onOpenTasks }]}
            />
          )}
        </section>
      </div>
    </div>
  );
}
