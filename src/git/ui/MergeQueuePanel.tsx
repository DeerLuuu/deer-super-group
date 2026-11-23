import { useEffect, useMemo, useState } from "react";
import Modal from "../../Modal.js";
import { formatError } from "../../shared/copy.js";
import type { Agent } from "../../shared/types.js";
import type { GitAiDraft } from "../../shared/gitAi.js";
import type { MergeQueueItem } from "../types.js";
import { GitAiDraftPanel } from "./GitAiDraft.js";

export interface MergeQueuePanelProps {
  workspaceId: string;
  items: MergeQueueItem[] | null;
  stale?: boolean;
  error?: string | null;
  loading?: boolean;
  onReload: () => Promise<unknown> | void;
  onOpenTask?: (taskId: string) => void;
  /** t368：合并说明生成/合并后通知成员。 */
  members?: Array<Pick<Agent, "id" | "name" | "role">>;
  aiDisabledReason?: string | null;
}

function stateLabel(state: MergeQueueItem["state"]): string {
  return {
    queued: "排队中",
    waiting_checks: "等待检查",
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

export function MergeQueuePanel({
  workspaceId,
  items,
  stale,
  error: loadError,
  loading = false,
  onReload,
  onOpenTask,
  members,
  aiDisabledReason,
}: MergeQueuePanelProps) {
  "use no memo";
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<MergeQueueItem | null>(null);
  const [mergeDraft, setMergeDraft] = useState<GitAiDraft | null>(null);
  const [notifyAgentId, setNotifyAgentId] = useState("");
  const [notifyPending, setNotifyPending] = useState<{
    item: MergeQueueItem;
    body: string;
    agentId: string;
  } | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notified, setNotified] = useState<string | null>(null);
  const notifyStorageKey = useMemo(
    () => `deer.git.merge.notifyAgent.${workspaceId}`,
    [workspaceId],
  );

  const defaultNotifyAgent = useMemo(() => {
    if (!members || members.length === 0) return "";
    try {
      const stored = window.localStorage.getItem(notifyStorageKey);
      if (stored && members.some((member) => member.id === stored)) return stored;
    } catch {
      // localStorage 不可用回退默认成员。
    }
    return members.find((member) => member.role !== "Router")?.id ?? members[0]!.id;
  }, [members, notifyStorageKey]);

  useEffect(() => {
    setNotifyAgentId(defaultNotifyAgent);
  }, [defaultNotifyAgent]);

  async function sendMergeNotification(target = notifyPending) {
    if (!target) return;
    setNotifyBusy(true);
    setNotifyError(null);
    try {
      const result = await window.deer.gitNotifyMerge({
        workspaceId,
        taskId: target.item.taskId,
        agentId: target.agentId,
        body: target.body.trim() || undefined,
        prNumber: target.item.prNumber,
        branch: target.item.branch,
        mergeCommitSha: null,
      });
      if (!result.ok) {
        setNotifyError(result.message);
        setNotifyPending(target);
        return;
      }
      setNotified(`已通知 ${result.agentName}`);
      setNotifyPending(null);
      try {
        window.localStorage.setItem(notifyStorageKey, target.agentId);
      } catch {
        // 记住收件人失败不影响通知。
      }
    } catch (error) {
      setNotifyError(formatError(error));
      setNotifyPending(target);
    } finally {
      setNotifyBusy(false);
    }
  }

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await onReload();
      setActionError(null);
    } catch (cause) {
      setActionError(formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  const queue = items ?? [];
  const ready = queue.filter((item) => item.state === "ready").length;
  const active = queue.filter((item) => item.state === "merging" || item.state === "updating").length;
  const waiting = queue.filter((item) => item.state === "queued" || item.state === "waiting_checks" || item.state === "waiting_review").length;
  const conflicts = queue.filter((item) => Boolean(item.conflictTaskId)).length;

  return (
    <section className="merge-queue-panel" aria-label="合并队列" aria-busy={busy !== null || loading}>
      <header className="merge-queue-head">
        <div>
          <h3>合并队列</h3>
          <p className="muted tiny">只读队列快照 · 仅确认合并使用弹窗</p>
        </div>
        <button type="button" className="ghost small" onClick={() => void onReload()} disabled={busy !== null || loading}>
          刷新
        </button>
      </header>

      <div className="merge-queue-summary" aria-label="队列摘要">
        <span className="badge">共 {queue.length}</span>
        <span className="badge">可合并 {ready}</span>
        <span className="badge">等待 {waiting}</span>
        <span className="badge">冲突 {conflicts}</span>
        <span className="badge">进行中 {active}</span>
        {stale ? <span className="badge merge-queue-stale">数据可能过期</span> : null}
      </div>

      {items === null ? (
        loading || (!loadError && !stale) ? <p role="status">加载合并队列…</p> :
          <div className="merge-queue-error" role="alert">
            {loadError ?? "读取合并队列失败，无法确认队列状态。"}
            <button type="button" className="ghost tiny" onClick={() => void onReload()}>重试</button>
          </div>
      ) : null}
      {items !== null && loadError ? (
        <div className="merge-queue-stale-note" role="status">
          最近刷新失败：{loadError}（保留上次成功快照）
          <button type="button" className="ghost tiny" onClick={() => void onReload()}>重试</button>
        </div>
      ) : null}
      {actionError ? <div className="merge-queue-error" role="alert">{actionError} <button type="button" className="ghost tiny" onClick={() => void onReload()}>重试</button></div> : null}
      {notifyError ? (
        <div className="merge-queue-error" role="alert">
          合并通知失败：{notifyError}
          <button type="button" className="ghost tiny" onClick={() => void sendMergeNotification()}>
            重试通知
          </button>
        </div>
      ) : null}
      {notified ? <p className="muted tiny" role="status">{notified}</p> : null}
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
                    <span title="checks">检查：{item.checksWaived ? "已豁免" : `${item.checks.state}${item.checks.summary ? ` · ${item.checks.summary}` : ""}`}</span>
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
                    onClick={() => {
                      setMergeDraft(null);
                      setNotifyError(null);
                      setConfirm(item);
                    }}
                  >
                    合并…
                  </button>
                  <label className="merge-queue-waive">
                    <span className="sr-only">豁免检查原因</span>
                    <input
                      value={reason}
                      onChange={(event) => setReasons((current) => ({ ...current, [key]: event.target.value }))}
                      placeholder="豁免检查原因（≥8 字）"
                      aria-label={`${item.taskTitle} 豁免检查原因`}
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
          {members && members.length > 0 ? (
            <div className="merge-ai">
              <GitAiDraftPanel
                kind="merge"
                workspaceId={workspaceId}
                taskId={confirm.taskId}
                members={members}
                disabledReason={aiDisabledReason}
                onUse={setMergeDraft}
                useLabel="填入合并说明"
              />
              <label className="merge-notify-select">
                合并后通知成员
                <select
                  aria-label="合并后通知成员"
                  value={notifyAgentId}
                  onChange={(event) => setNotifyAgentId(event.target.value)}
                >
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} · {member.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                合并说明（可编辑，留空使用自动摘要）
                <textarea
                  aria-label="合并说明"
                  rows={5}
                  value={mergeDraft?.body ?? ""}
                  onChange={(event) =>
                    setMergeDraft({
                      title: mergeDraft?.title ?? `合并说明：${confirm.taskTitle}`,
                      body: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          ) : null}
          <div className="row gap merge-confirm-actions">
            <button type="button" className="ghost" onClick={() => setConfirm(null)}>取消</button>
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() => {
                const item = confirm;
                setConfirm(null);
                void run(`${item.id}:merge`, async () => {
                  const merged = await window.deer.mergeStart(item.taskId);
                  if (merged?.state === "merged" && notifyAgentId) {
                    const target = { item, body: mergeDraft?.body ?? "", agentId: notifyAgentId };
                    setNotifyPending(target);
                    await sendMergeNotification(target);
                  }
                  return merged;
                });
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
