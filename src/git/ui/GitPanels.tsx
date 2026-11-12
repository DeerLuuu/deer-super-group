import { useCallback, useEffect, useRef, useState } from "react";
import { formatError } from "../../shared/copy.js";
import type { GitSettings, TaskVcsSnapshot } from "../types.js";

export interface TaskVcsPanelProps {
  taskId: string;
  onClose?: () => void;
  onOpenGraph?: () => void;
  onOpenMergeQueue?: () => void;
}

/**
 * Task-details VCS panel. Rendered in the task drawer by the integration layer;
 * keeps all network/IPC access behind window.deer and never receives tokens.
 */
export function TaskVcsPanel({ taskId, onClose, onOpenGraph, onOpenMergeQueue }: TaskVcsPanelProps) {
  const [snapshot, setSnapshot] = useState<TaskVcsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    try {
      setSnapshot(await window.deer.getTaskVcs(taskId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
    closeRef.current?.focus();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const vcs = snapshot?.vcs;
  return (
    <section aria-label="Git 状态" aria-busy={loading} className="git-vcs-panel" style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      <header>
        <h3>Git 状态</h3>
        {onClose ? (
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭 Git 状态">
            ×
          </button>
        ) : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {loading && !snapshot ? <p role="status">加载 Git 状态…</p> : null}
      {!loading && !vcs && !error ? <p>尚未产生 Git 提交。</p> : null}
      {vcs ? (
        <dl>
          <dt>分支</dt><dd>{vcs.branch ?? "—"}</dd>
          <dt>基线</dt><dd>{vcs.baseBranch ?? "—"}</dd>
          <dt>Head</dt><dd><code>{vcs.headSha?.slice(0, 12) ?? "—"}</code></dd>
          <dt>PR</dt>
          <dd>
            {vcs.pr?.url ? (
              <button type="button" onClick={() => void act(() => window.deer.gitOpenPr(taskId))}>
                #{vcs.pr.number ?? "manual"} · {vcs.pr.state}
              </button>
            ) : vcs.pr ? `#${vcs.pr.number ?? "manual"} · ${vcs.pr.state}` : "未创建"}
          </dd>
          <dt>Checks</dt><dd>{vcs.checksState ?? "none"}</dd>
          <dt>合并</dt><dd>{vcs.merge.state}{vcs.merge.commitSha ? ` · ${vcs.merge.commitSha.slice(0, 10)}` : ""}</dd>
          {vcs.degradedReason ? (<><dt>降级原因</dt><dd>{vcs.degradedReason}</dd></>) : null}
        </dl>
      ) : null}
      <div className="git-vcs-actions">
        <button type="button" disabled={busy || !vcs?.branch} onClick={() => void act(() => window.deer.gitCreatePr(taskId))}>
          创建 PR
        </button>
        <button type="button" disabled={busy || !vcs?.branch} onClick={() => void act(() => window.deer.mergeEnqueue(taskId))}>
          加入合并队列
        </button>
        <button type="button" disabled={busy || !vcs?.branch} onClick={() => void act(() => window.deer.gitCleanup(taskId))}>
          清理工作树
        </button>
        {onOpenMergeQueue ? (
          <button type="button" className="ghost" onClick={onOpenMergeQueue}>
            查看合并队列
          </button>
        ) : null}
        {onOpenGraph ? (
          <button type="button" className="ghost" onClick={onOpenGraph}>
            在版本图中查看
          </button>
        ) : null}
      </div>
    </section>
  );
}

export interface GitSettingsPanelProps {
  workspaceId: string;
  /** t198：把 Git 草稿纳入 Settings dirty guard；保存成功后回调 false。 */
  onDirtyChange?: (dirty: boolean) => void;
}

export function GitSettingsPanel({ workspaceId, onDirtyChange }: GitSettingsPanelProps) {
  const [settings, setSettings] = useState<GitSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const baselineRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await window.deer.getGitSettings(workspaceId);
      setSettings(next);
      baselineRef.current = JSON.stringify(next);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = settings !== null && baselineRef.current !== JSON.stringify(settings);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!settings) {
    return (
      <section aria-label="Git 设置" aria-busy="true">
        {error ? <p role="alert">{error}</p> : <p role="status">加载中…</p>}
      </section>
    );
  }

  const patch = (next: Partial<GitSettings>) => setSettings({ ...settings, ...next });
  const save = async () => {
    try {
      const next = await window.deer.saveGitSettings(workspaceId, settings);
      setSettings(next);
      baselineRef.current = JSON.stringify(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2_000);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  };

  return (
    <section
      aria-label="Git 设置"
      className="git-settings"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, width: "100%", boxSizing: "border-box" }}
    >
      <h3>Git</h3>
      {error ? <p role="alert">{error}</p> : null}
      {saved ? <p role="status">已保存</p> : null}
      <label>
        模式
        <select value={settings.mode} onChange={(event) => patch({ mode: event.target.value as GitSettings["mode"] })}>
          <option value="auto">auto</option>
          <option value="github">github</option>
          <option value="manual">manual</option>
          <option value="local">local</option>
          <option value="off">off</option>
        </select>
      </label>
      <label>
        Provider
        <select value={settings.provider} onChange={(event) => patch({ provider: event.target.value as GitSettings["provider"] })}>
          <option value="auto">auto</option>
          <option value="github">github</option>
          <option value="manual">manual</option>
          <option value="local">local</option>
        </select>
      </label>
      <label>
        基线分支
        <input value={settings.baseBranch} onChange={(event) => patch({ baseBranch: event.target.value })} />
      </label>
      <label>
        最大运行时 worktree（1–3）
        <input
          type="number"
          min={1}
          max={3}
          value={settings.maxWorktrees}
          onChange={(event) => patch({ maxWorktrees: Number(event.target.value) })}
        />
      </label>
      <label>
        checks 命令
        <input value={settings.checksCommand ?? ""} onChange={(event) => patch({ checksCommand: event.target.value || null })} />
      </label>
      <label>
        checks 超时（ms）
        <input
          type="number"
          min={60000}
          max={1800000}
          value={settings.checksTimeoutMs}
          onChange={(event) => patch({ checksTimeoutMs: Number(event.target.value) })}
        />
      </label>
      <label>
        <input type="checkbox" checked={settings.requireApproval} onChange={(event) => patch({ requireApproval: event.target.checked })} />
        合并前必须批准
      </label>
      <label>
        <input type="checkbox" checked={settings.autoMerge} onChange={(event) => patch({ autoMerge: event.target.checked })} />
        自动合并
      </label>
      <label>
        <input type="checkbox" checked={settings.autoCreatePr} onChange={(event) => patch({ autoCreatePr: event.target.checked })} />
        自动创建 PR
      </label>
      <label>
        <input type="checkbox" checked={settings.pushOnCancel} onChange={(event) => patch({ pushOnCancel: event.target.checked })} />
        取消时推送 WIP
      </label>
      <label>
        <input type="checkbox" checked={settings.preserveWorktreeOnCancel} onChange={(event) => patch({ preserveWorktreeOnCancel: event.target.checked })} />
        取消时保留 worktree
      </label>
      <label>
        合并方式
        <select value={settings.mergeMethod} onChange={(event) => patch({ mergeMethod: event.target.value as GitSettings["mergeMethod"] })}>
          <option value="squash">squash</option>
          <option value="merge">merge</option>
          <option value="rebase">rebase</option>
        </select>
      </label>
      <button type="button" onClick={() => void save()}>保存 Git 设置</button>
    </section>
  );
}
