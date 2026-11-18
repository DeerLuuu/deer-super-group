import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent } from "../../shared/types.js";
import type { GitAiDraft } from "../../shared/gitAi.js";

type Members = Array<Pick<Agent, "id" | "name" | "role">>;

/**
 * t368/G2：可复用的 Git AI 草稿区（Task VCS / Git Graph PR / Merge confirm）。
 * 只调用人类 preload；草稿可编辑、复制、重试；Mock/无模型时禁用并说明。
 */
export function GitAiDraftPanel({
  kind,
  workspaceId,
  taskId,
  headSha,
  members,
  disabledReason,
  onUse,
  label,
  useLabel,
}: {
  kind: "pr" | "merge";
  workspaceId: string;
  taskId?: string;
  headSha?: string;
  members: Members;
  disabledReason?: string | null;
  onUse?: (draft: GitAiDraft) => void;
  label?: string;
  useLabel?: string;
}) {
  const storageKey = useMemo(
    () => `deer.git.ai.agent.${workspaceId}.${kind}`,
    [kind, workspaceId],
  );
  const defaultAgent = useMemo(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && members.some((member) => member.id === stored)) return stored;
    } catch {
      // localStorage 不可用时回退默认成员。
    }
    return members.find((member) => member.role !== "Router")?.id ?? members[0]?.id ?? "";
  }, [members, storageKey]);
  const [agentId, setAgentId] = useState(defaultAgent);
  const [draft, setDraft] = useState<GitAiDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const title = label ?? (kind === "pr" ? "AI PR 描述" : "AI 合并说明");
  const disabled = Boolean(disabledReason) || members.length === 0 || !agentId || busy;

  useEffect(() => {
    if (!members.some((member) => member.id === agentId)) setAgentId(defaultAgent);
  }, [agentId, defaultAgent, members]);

  useEffect(() => {
    setDraft(null);
    setError(null);
    setCopied(false);
  }, [taskId, kind]);

  const generate = useCallback(async () => {
    if (!agentId) {
      setError("请选择生成成员");
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const api = window.deer;
      const input = { workspaceId, agentId, taskId, headSha };
      const result =
        kind === "pr"
          ? await api.gitGeneratePrDraft(input)
          : await api.gitGenerateMergeDraft(input);
      if (!result || !result.ok) {
        setError(result?.message ?? "生成失败，请重试");
        return;
      }
      setDraft(result.draft);
      try {
        window.localStorage.setItem(storageKey, agentId);
      } catch {
        // 记住成员失败不影响草稿。
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [agentId, headSha, kind, storageKey, taskId, workspaceId]);

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`${draft.title}\n\n${draft.body}`);
      setCopied(true);
    } catch {
      setError("复制失败，请手动选择文本");
    }
  }

  return (
    <section className="git-ai-draft" aria-label={title} aria-busy={busy}>
      <div className="git-ai-draft-head">
        <h4>{title}</h4>
        <span className="muted tiny">仅人类触发 · 不会自动执行 Git 操作</span>
      </div>
      <div className="git-ai-draft-controls">
        <label>
          成员
          <select
            aria-label={`${title}成员`}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={busy || members.length === 0}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} · {member.role}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary small"
          onClick={() => void generate()}
          disabled={disabled}
          title={disabledReason ?? undefined}
        >
          {busy ? "生成中…" : kind === "pr" ? "生成 PR 描述" : "生成合并说明"}
        </button>
      </div>
      {disabledReason ? (
        <p className="muted tiny git-ai-disabled" role="status">
          {disabledReason}
        </p>
      ) : null}
      {error ? (
        <div className="git-ai-error" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost tiny" onClick={() => void generate()} disabled={busy}>
            重试
          </button>
        </div>
      ) : null}
      {draft ? (
        <div className="git-ai-draft-body">
          <label>
            标题
            <input
              aria-label={`${title}标题`}
              value={draft.title}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            正文
            <textarea
              aria-label={`${title}正文`}
              value={draft.body}
              rows={8}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          <div className="row gap git-ai-draft-actions">
            {onUse ? (
              <button type="button" className="small" onClick={() => onUse(draft)}>
                {useLabel ?? "填入 PR 表单"}
              </button>
            ) : null}
            <button type="button" className="ghost small" onClick={() => void copyDraft()}>
              {copied ? "已复制" : "复制"}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={() => void generate()}
              disabled={busy}
            >
              重新生成
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
