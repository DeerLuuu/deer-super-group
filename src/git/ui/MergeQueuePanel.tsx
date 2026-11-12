import { useState } from "react";
import Modal from "../../Modal.js";
import { formatError } from "../../shared/copy.js";
import type { MergeQueueItem } from "../types.js";

export interface MergeQueuePanelProps {
  workspaceId: string;
  items: MergeQueueItem[] | null;
  stale?: boolean;
  onReload: () => Promise<unknown> | void;
  onOpenTask?: (taskId: string) => void;
}

function stateLabel(state: MergeQueueItem["state"]): string {
  return {
    queued: "排队中",
    waiting_checks: "等待 checks",
    waiting_review: "等待评审",
    ready: "可合并",
    updating: "更新中",
    merging: "合并中",
    merged: "已合并",
    blocked: "阻塞",
    failed: "失败",
    cancelled: "已取消",
  }[state];
}

export function MergeQueuePanel({ workspaceId, items, stale, onReload, onOpenTask }: MergeQueuePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<MergeQueueItem | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await onReload();
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  const queue = items ?? [];
  const ready = queue.filter((item) => item.state === "ready").length;
  const active = queue.filter((item) => item.state === "merging" || item.state === "updating").length;
  const waiting = queue.filter((item) => item.state === "waiting_checks" || item.state === "waiting_review").length;

  return (
    <section className="merge-queue-panel" aria-label="合并队列" aria-busy={busy !== null || items === null}>
      <header className="merge-queue-head">
        <div>
          <h3>合并队列</h3>
          <p className="muted tiny">只读队列快照 · 仅确认合并使用弹窗</p>
        </div>
        <button type="button" className="ghost small" onClick={() => void onReload()} disabled={busy !== null}>
          刷新
        </button>
      </header>

      <div className="merge-queue-summary" aria-label="队列摘要">
        <span className="badge">共 {queue.length}</span>
        <span className="badge">可合并 {ready}</span>
        <span className="badge">等待 {waiting}</span>
        <span className="badge">进行中 {active}</span>
        {stale ? <span className="badge merge-queue-stale">数据可能过期</span> : null}
      </div>

      {error ? <div className="merge-queue-error" role="alert">{error} <button type="button" className="ghost tiny" onClick={() => void onReload()}>重试</button></div> : null}
      {items === null ? <p role="status">加载合并队列…</p> : null}
      {items !== null && queue.length === 0 ? <p className="merge-queue-empty" role="status">队列为空。任务交付后可以在任务 Git 页加入合并队列。</p> : null}

      {queue.length > 0 ? (
        <ol className="merge-queue-list" aria-label="合并队列列表">
          {queue.map((item) => {
            const key = `${item.id}:${item.taskId}`;
            const reason = reasons[key] ?? "";
            const conflict = Boolean(item.conflictTaskId);
            return (
              <li key={item.id} className={`merge-queue-row ${conflict ? "has-conflict" : ""}`} aria-current={item.state === "merging" ? "true" : undefined}>
                <div className="merge-queue-row-main">
                  <div className="merge-queue-title">
                    <strong>{item.taskTitle}</strong>
                    <span className={`badge state-${item.state}`}>{stateLabel(item.state)}</span>
                    {conflict ? <span className="badge merge-queue-conflict">冲突任务</span> : null}
                  </div>
                  <div className="merge-queue-meta muted tiny">
                    <span>#{item.taskId}</span>
                    <span>{item.provider}{item.prNumber ? ` #${item.prNumber}` : ""}</span>
                    <span className="mono">{item.branch ?? "无分支"}</span>
                    <span>位置 {item.position}</span>
                    <span>checks: {item.checksWaived ? "已豁免" : `${item.checks.state}${item.checks.summary ? ` · ${item.checks.summary}` : ""}`}</span>
                  </div>
                  {item.lastError ? <p className="merge-queue-error-text" role="alert">{item.lastError}</p> : null}
                  {conflict ? <p className="muted tiny">检测到冲突，已生成冲突任务 {item.conflictTaskId}；请先处理后再合并。</p> : null}
                </div>

                <div className="merge-queue-actions">
                  {onOpenTask ? (
                    <button type="button" className="ghost tiny" onClick={() => onOpenTask(item.taskId)}>查看任务</button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={busy !== null || item.state === "merged" || item.state === "cancelled"}
                    onClick={() => void run(`${key}:approve`, () => window.deer.mergeApprove(item.taskId))}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="primary tiny"
                    disabled={busy !== null || conflict || item.state === "merged" || item.state === "cancelled" || item.state === "failed"}
                    onClick={() => setConfirm(item)}
                  >
                    合并…
                  </button>
                  <label className="merge-queue-waive">
                    <span className="sr-only">豁免 checks 原因</span>
                    <input
                      value={reason}
                      onChange={(event) => setReasons((current) => ({ ...current, [key]: event.target.value }))}
                      placeholder="豁免 checks 原因（≥8 字）"
                      aria-label={`${item.taskTitle} 豁免 checks 原因`}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={busy !== null || reason.trim().length < 8}
                    onClick={() => void run(`${key}:waive`, () => window.deer.mergeWaiveChecks(item.taskId, reason.trim()))}
                  >
                    豁免
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {confirm ? (
        <Modal title="确认合并" onClose={() => setConfirm(null)} className="merge-confirm-modal">
          <p>确认将 <strong>{confirm.taskTitle}</strong> 合并？</p>
          <dl className="merge-confirm-meta">
            <dt>任务</dt><dd>#{confirm.taskId}</dd>
            <dt>分支</dt><dd className="mono">{confirm.branch ?? "—"}</dd>
            <dt>提供方</dt><dd>{confirm.provider}{confirm.prNumber ? ` #${confirm.prNumber}` : ""}</dd>
            <dt>checks</dt><dd>{confirm.checksWaived ? "已豁免" : confirm.checks.state}</dd>
            <dt>位置</dt><dd>{confirm.position}</dd>
          </dl>
          <p className="muted small">合并是不可逆的高风险操作；确认后才会调用现有 mergeStart，权限与 merge gate 不变。</p>
          <div className="row gap merge-confirm-actions">
            <button type="button" className="ghost" onClick={() => setConfirm(null)}>取消</button>
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() => {
                const item = confirm;
                setConfirm(null);
                void run(`${item.id}:merge`, () => window.deer.mergeStart(item.taskId));
              }}
            >
              确认合并
            </button>
          </div>
        </Modal>
      ) : null}
      <p className="sr-only" aria-live="polite">工作区 {workspaceId} 合并队列 {queue.length} 项，{ready} 项可合并。</p>
    </section>
  );
}
