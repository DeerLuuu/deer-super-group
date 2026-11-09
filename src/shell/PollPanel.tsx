import { useEffect, useMemo, useRef, useState } from "react";
import EmptyState from "../EmptyState";
import Modal from "../Modal";
import type { Agent } from "../shared/types";
import {
  PollError,
  type CreatePollRequest,
  type Poll,
  type PollMode,
  type PollOptionSource,
  type PollScope,
  type PollStatus,
  type PollThresholdRule,
} from "../shared/poll";

type NotifyKind = "success" | "error" | "info";

export function pollStatusLabel(status: PollStatus): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "open":
      return "进行中";
    case "closed":
      return "已关闭";
    case "expired":
      return "已过期";
    default:
      return status;
  }
}

export function thresholdLabel(rule: PollThresholdRule, value: number): string {
  if (rule === "gt") return `票数 > ${value}`;
  if (rule === "majority") return "票数 > 50%";
  return `票数 ≥ ${value}%`;
}

export function formatRemaining(closesAt: string | null, nowMs: number): string {
  if (!closesAt) return "无截止";
  const remaining = Date.parse(closesAt) - nowMs;
  if (remaining <= 0) return "已截止";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟后截止`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} 小时后截止`;
  return `${Math.ceil(hours / 24)} 天后截止`;
}

function errorMessage(error: unknown): string {
  if (error instanceof PollError) return error.message;
  if (error instanceof Error) {
    // Electron's ipcRenderer rejects with "Error: message"; keep the useful part.
    return error.message.replace(/^Error:\s*/, "");
  }
  return String(error);
}

export default function PollPanel({
  workspaceId,
  agents,
  onNotify,
  autoOpenCreate = false,
  onAutoOpenHandled,
  initialSource = null,
}: {
  workspaceId: string;
  agents: Agent[];
  onNotify?: (message: string, kind?: NotifyKind) => void;
  autoOpenCreate?: boolean;
  onAutoOpenHandled?: () => void;
  initialSource?: { title: string; sourceId: string; scope: PollScope; scopeId: string } | null;
}) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(autoOpenCreate);
  const [createSource, setCreateSource] = useState(initialSource);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshRef = useRef<() => void>(() => {});
  const createRef = useRef<HTMLButtonElement | null>(null);

  async function load(preferId?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const next = await window.deer.listPolls(workspaceId);
      setPolls(next);
      const wanted = preferId ?? selectedId;
      const visible = next.filter((poll) => {
        if (filter === "open") return poll.status === "open";
        if (filter === "closed") return poll.status === "closed" || poll.status === "expired";
        return true;
      });
      if (wanted && next.some((poll) => poll.id === wanted)) setSelectedId(wanted);
      else setSelectedId(visible[0]?.id ?? next[0]?.id ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  refreshRef.current = () => void load(selectedId);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, filter]);

  useEffect(() => {
    if (!autoOpenCreate) return;
    setCreateSource(initialSource);
    setShowCreate(true);
    onAutoOpenHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenCreate]);

  useEffect(() => {
    if (typeof window.deer.onEvent !== "function") return;
    return window.deer.onEvent((event) => {
      if (event.aggregateType === "poll" || event.type.startsWith("poll.")) {
        refreshRef.current();
      }
    });
  }, []);

  const visible = useMemo(
    () =>
      polls.filter((poll) => {
        if (filter === "open") return poll.status === "open";
        if (filter === "closed") return poll.status === "closed" || poll.status === "expired";
        return true;
      }),
    [polls, filter],
  );
  const selected = polls.find((poll) => poll.id === selectedId) ?? visible[0] ?? null;

  function notify(text: string, kind: NotifyKind = "success") {
    setMessage(text);
    onNotify?.(text, kind);
  }

  async function handleCreated(poll: Poll) {
    setShowCreate(false);
    setFilter(poll.status === "open" ? "open" : "all");
    await load(poll.id);
    notify("投票已创建");
  }

  return (
    <section className="panel poll-panel" aria-label="团队投票">
      <div className="panel-head poll-head">
        <div>
          <div className="panel-title">团队投票</div>
          <div className="muted poll-subtitle">可创建、可审计、关闭后生成 decision</div>
        </div>
        <button
          ref={createRef}
          type="button"
          className="primary small"
          onClick={() => setShowCreate(true)}
        >
          新建投票
        </button>
      </div>

      <div className="poll-toolbar">
        <div className="memory-tabs" role="tablist" aria-label="投票筛选">
          {(["open", "closed", "all"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`memory-tab ${filter === key ? "active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {key === "open" ? "进行中" : key === "closed" ? "已结束" : "全部"}
            </button>
          ))}
        </div>
        <button type="button" className="ghost tiny" onClick={() => void load(selectedId)} disabled={loading}>
          刷新
        </button>
      </div>

      <div className="poll-status" role="status" aria-live="polite">
        {message ?? (loading ? "正在加载投票…" : "")}
      </div>
      {error && (
        <div className="memory-error poll-error" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost tiny" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="poll-layout">
        <div className="poll-list" aria-label="投票列表">
          {visible.length === 0 ? (
            <EmptyState
              compact
              icon="◇"
              title={filter === "open" ? "还没有进行中的投票" : "没有匹配的投票"}
              description="创建单选/多选投票，设置阈值、quorum 与截止时间。"
              actions={[{ label: "新建投票", primary: true, onClick: () => setShowCreate(true) }]}
            />
          ) : (
            visible.map((poll) => (
              <PollCard
                key={poll.id}
                poll={poll}
                active={selected?.id === poll.id}
                onSelect={() => setSelectedId(poll.id)}
              />
            ))
          )}
        </div>

        <div className="poll-detail">
          {selected ? (
            <PollDetail
              poll={selected}
              nowMs={nowMs}
              onNotify={notify}
              onChanged={(poll) => void load(poll.id)}
            />
          ) : (
            <EmptyState
              icon="◇"
              title="选择一个投票"
              description="投票是团队决策工具：明确问题、候选、voter、截止时间和采纳规则。"
              actions={[{ label: "新建投票", primary: true, onClick: () => setShowCreate(true) }]}
            />
          )}
        </div>
      </div>

      {showCreate && (
        <CreatePollModal
          workspaceId={workspaceId}
          agents={agents}
          initialSource={createSource}
          onClose={() => {
            setShowCreate(false);
            setCreateSource(null);
          }}
          onCreated={handleCreated}
          onError={(text) => setError(text)}
        />
      )}
    </section>
  );
}

function PollCard({ poll, active, onSelect }: { poll: Poll; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`poll-card ${active ? "active" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="poll-card-top">
        <span className="poll-card-title">{poll.title}</span>
        <span className={`badge poll-badge-${poll.status}`}>{pollStatusLabel(poll.status)}</span>
      </span>
      <span className="poll-card-meta">
        {poll.mode === "single" ? "单选" : `多选${poll.maxSelections ? ` · 最多 ${poll.maxSelections}` : ""}`}
        {" · "}
        {poll.result.totalBallots} 票
        {poll.quorum > 0 ? ` · quorum ${poll.quorum}` : ""}
      </span>
      <span className="poll-card-meta">
        {formatRemaining(poll.closesAt, Date.now())} · {thresholdLabel(poll.thresholdRule, poll.thresholdValue)}
      </span>
    </button>
  );
}

function PollDetail({
  poll,
  nowMs,
  onNotify,
  onChanged,
}: {
  poll: Poll;
  nowMs: number;
  onNotify: (message: string, kind?: NotifyKind) => void;
  onChanged: (poll: Poll) => void;
}) {
  const own = poll.ballots.find((ballot) => ballot.voterId === "user");
  const [selections, setSelections] = useState<string[]>(own?.selections ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const canVote = poll.status === "open";
  const canClose = poll.status !== "closed" && poll.createdBy === "user";

  useEffect(() => {
    setSelections(poll.ballots.find((ballot) => ballot.voterId === "user")?.selections ?? []);
    setError(null);
  }, [poll.id]);

  function toggle(optionId: string) {
    setSelections((current) => {
      if (poll.mode === "single") return current.includes(optionId) ? [] : [optionId];
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      if (poll.maxSelections !== null && current.length >= poll.maxSelections) {
        setLive(`最多选择 ${poll.maxSelections} 项`);
        return current;
      }
      return [...current, optionId];
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.deer.castPoll(poll.workspaceId, {
        pollId: poll.id,
        voterType: "human",
        selections,
      });
      onChanged(updated);
      setLive(selections.length === 0 ? "已记录弃权票" : "投票已记录");
      onNotify("投票已记录");
    } catch (cause) {
      const text = errorMessage(cause);
      setError(text);
      setLive(text);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!window.confirm("关闭投票后将生成 decision，不能继续改票，确定关闭吗？")) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await window.deer.closePoll(poll.workspaceId, { pollId: poll.id });
      onChanged(updated);
      setLive("投票已关闭，decision 已生成");
      onNotify(updated.decision?.boardEntryId ? "投票已关闭，decision 已写入黑板" : "投票已关闭");
    } catch (cause) {
      const text = errorMessage(cause);
      setError(text);
      setLive(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="poll-article" aria-labelledby={`poll-title-${poll.id}`}>
      <header className="poll-detail-head">
        <div>
          <h3 id={`poll-title-${poll.id}`}>{poll.title}</h3>
          <div className="muted">{poll.description || "无说明"}</div>
          <div className="poll-meta-row">
            <span className={`badge poll-badge-${poll.status}`}>{pollStatusLabel(poll.status)}</span>
            <span>{poll.mode === "single" ? "单选" : "多选"}</span>
            <span>{thresholdLabel(poll.thresholdRule, poll.thresholdValue)}</span>
            <span>{poll.quorum > 0 ? `quorum ${poll.quorum}` : "无 quorum"}</span>
            <span>{formatRemaining(poll.closesAt, nowMs)}</span>
            {poll.anonymous && <span className="badge muted">匿名展示</span>}
          </div>
        </div>
        {canClose && (
          <button type="button" className="ghost small" onClick={() => void close()} disabled={busy}>
            关闭投票
          </button>
        )}
      </header>

      <div className="poll-status" role="status" aria-live="polite">
        {live || (own ? `已投票 · 第 ${own.revision} 次提交，可改票` : canVote ? "尚未投票" : "")}
      </div>
      {error && (
        <div className="memory-error" role="alert">
          {error}
        </div>
      )}

      <fieldset className="poll-options" disabled={!canVote || busy}>
        <legend className="sr-only">候选</legend>
        {poll.options.map((option) => {
          const checked = selections.includes(option.id);
          const inputId = `poll-${poll.id}-${option.id}`;
          return (
            <label key={option.id} className={`poll-option ${checked ? "selected" : ""}`} htmlFor={inputId}>
              <input
                id={inputId}
                type={poll.mode === "single" ? "radio" : "checkbox"}
                name={`poll-${poll.id}`}
                checked={checked}
                onChange={() => toggle(option.id)}
              />
              <span className="poll-option-text">
                <span className="poll-option-label">{option.label}</span>
                {option.description && <span className="muted">{option.description}</span>}
              </span>
              <span className="poll-option-count" aria-label={`${option.label} 得票`}>
                {poll.result.options.find((entry) => entry.optionId === option.id)?.count ?? 0}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="row gap poll-actions">
        <button type="button" className="primary small" onClick={() => void submit()} disabled={!canVote || busy}>
          {own ? "改票" : "提交投票"}
        </button>
        {poll.allowAbstain && canVote && (
          <button
            type="button"
            className="ghost small"
            onClick={() => setSelections([])}
            disabled={busy}
          >
            弃权
          </button>
        )}
        <span className="muted">Ctrl/⌘ + Enter 提交；Esc 关闭弹窗</span>
      </div>

      <PollResults poll={poll} />

      {poll.decision && (
        <section className="poll-decision" aria-label="投票 decision">
          <div className="poll-decision-head">
            <strong>Decision</strong>
            <span className="muted">{poll.decision.createdAt}</span>
          </div>
          <p>{poll.decision.summary}</p>
          {poll.decision.boardEntryId && (
            <p className="muted">已写入黑板 decision（{poll.decision.boardEntryId}）</p>
          )}
        </section>
      )}
    </article>
  );
}

export function PollResults({ poll }: { poll: Poll }) {
  return (
    <section className="poll-results" aria-label="投票结果">
      <div className="poll-results-head">
        <strong>结果</strong>
        <span className="muted">
          {poll.result.totalBallots} 票 · {poll.result.quorumMet ? "达到 quorum" : `未达 quorum（${poll.quorum}）`}
        </span>
      </div>
      <ul className="poll-result-list" role="list">
        {poll.result.options.map((option) => (
          <li key={option.optionId} className={`poll-result ${option.adopted ? "adopted" : ""}`} role="listitem">
            <div className="poll-result-label">
              <span>{option.label}</span>
              <span className="muted">
                {option.count} 票 · {option.percent}% {option.adopted ? "· 采纳" : ""}
              </span>
            </div>
            <div
              className="poll-bar"
              role="progressbar"
              aria-label={`${option.label} 得票比例`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={option.percent}
            >
              <span style={{ width: `${Math.min(100, option.percent)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <div className="poll-threshold-note">
        采纳规则：{thresholdLabel(poll.thresholdRule, poll.thresholdValue)}
        {poll.quorum > 0 ? ` · quorum ${poll.quorum}` : ""}
        {poll.result.insufficientQuorum ? " · quorum 未达到，不产生采纳项" : ""}
      </div>
    </section>
  );
}

function CreatePollModal({
  workspaceId,
  agents,
  initialSource,
  onClose,
  onCreated,
  onError,
}: {
  workspaceId: string;
  agents: Agent[];
  initialSource: { title: string; sourceId: string; scope: PollScope; scopeId: string } | null;
  onClose: () => void;
  onCreated: (poll: Poll) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(initialSource?.title ?? "");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<PollScope>(initialSource?.scope ?? "team");
  const [scopeId, setScopeId] = useState(initialSource?.scopeId ?? "");
  const [mode, setMode] = useState<PollMode>("multi");
  const [maxSelections, setMaxSelections] = useState(2);
  const [thresholdRule, setThresholdRule] = useState<PollThresholdRule>("gt");
  const [thresholdValue, setThresholdValue] = useState(3);
  const [quorum, setQuorum] = useState(0);
  const [closesAt, setClosesAt] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [allowAbstain, setAllowAbstain] = useState(false);
  const [optionRows, setOptionRows] = useState(() => {
    const sourceType: PollOptionSource =
      initialSource?.scope === "board" ? "board" : initialSource?.scope === "task" ? "task" : "manual";
    return [
      {
        label: initialSource?.title ?? "",
        description: "",
        sourceType,
        sourceId: initialSource?.sourceId ?? "",
      },
      { label: "", description: "", sourceType: "manual" as PollOptionSource, sourceId: "" },
    ];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function updateOption(index: number, patch: Partial<(typeof optionRows)[number]>) {
    setDirty(true);
    setOptionRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function addOption() {
    setDirty(true);
    setOptionRows((current) => [...current, { label: "", description: "", sourceType: "manual", sourceId: "" }]);
  }

  function removeOption(index: number) {
    setDirty(true);
    setOptionRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const input: CreatePollRequest = {
        workspaceId,
        scope,
        scopeId: scopeId.trim() || null,
        title,
        description,
        mode,
        maxSelections: mode === "single" ? 1 : maxSelections,
        thresholdRule,
        thresholdValue: thresholdRule === "majority" ? 0 : thresholdValue,
        quorum,
        allowAbstain,
        anonymous,
        closesAt: closesAt ? new Date(closesAt).toISOString() : null,
        options: optionRows
          .filter((row) => row.label.trim())
          .map((row) => ({
            label: row.label,
            description: row.description,
            sourceType: row.sourceType,
            sourceId: row.sourceId.trim() || null,
          })),
      };
      const poll = await window.deer.createPoll(input);
      onCreated(poll);
    } catch (cause) {
      const text = errorMessage(cause);
      setError(text);
      onError(text);
    } finally {
      setBusy(false);
    }
  }

  const agentNames = agents.filter((agent) => !agent.isRouter).map((agent) => agent.name);

  return (
    <Modal
      title="新建团队投票"
      description="明确问题、候选、阈值、quorum 和截止时间；关闭后生成 decision。"
      onClose={onClose}
      confirmClose={dirty}
      className="poll-create-modal"
    >
      <div
        className="form poll-create-form"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <label>
          标题
          <input
            autoFocus
            value={title}
            maxLength={200}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
            placeholder="例如：下一轮实现哪个系统？"
          />
        </label>
        <label>
          说明
          <textarea
            value={description}
            rows={2}
            maxLength={2000}
            onChange={(event) => {
              setDescription(event.target.value);
              setDirty(true);
            }}
            placeholder="可选：背景、约束、决策要求"
          />
        </label>
        <div className="poll-form-row">
          <label>
            范围
            <select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as PollScope);
                setDirty(true);
              }}
            >
              <option value="workspace">工作区</option>
              <option value="team">团队</option>
              <option value="task">任务</option>
              <option value="board">黑板</option>
            </select>
          </label>
          {scope !== "workspace" && scope !== "team" && (
            <label>
              {scope === "task" ? "任务 ID" : "黑板/来源 ID"}
              <input
                value={scopeId}
                onChange={(event) => {
                  setScopeId(event.target.value);
                  setDirty(true);
                }}
                placeholder="可选"
              />
            </label>
          )}
          <label>
            模式
            <select
              value={mode}
              onChange={(event) => {
                const next = event.target.value as PollMode;
                setMode(next);
                if (next === "single") setMaxSelections(1);
                setDirty(true);
              }}
            >
              <option value="single">单选</option>
              <option value="multi">多选</option>
            </select>
          </label>
          {mode === "multi" && (
            <label>
              最多可选
              <input
                type="number"
                min={1}
                max={optionRows.length}
                value={maxSelections}
                onChange={(event) => {
                  setMaxSelections(Number(event.target.value));
                  setDirty(true);
                }}
              />
            </label>
          )}
        </div>

        <div className="poll-form-row">
          <label>
            采纳规则
            <select
              value={thresholdRule}
              onChange={(event) => {
                const next = event.target.value as PollThresholdRule;
                setThresholdRule(next);
                setThresholdValue(next === "gt" ? 3 : next === "percent" ? 50 : 0);
                setDirty(true);
              }}
            >
              <option value="gt">票数 &gt; N</option>
              <option value="majority">多数（&gt;50%）</option>
              <option value="percent">百分比</option>
            </select>
          </label>
          {(thresholdRule === "gt" || thresholdRule === "percent") && (
            <label>
              {thresholdRule === "gt" ? "N" : "百分比"}
              <input
                type="number"
                min={thresholdRule === "percent" ? 1 : 0}
                max={thresholdRule === "percent" ? 100 : undefined}
                value={thresholdValue}
                onChange={(event) => {
                  setThresholdValue(Number(event.target.value));
                  setDirty(true);
                }}
              />
            </label>
          )}
          <label>
            quorum
            <input
              type="number"
              min={0}
              max={1000}
              value={quorum}
              onChange={(event) => {
                setQuorum(Number(event.target.value));
                setDirty(true);
              }}
            />
          </label>
          <label>
            截止时间
            <input
              type="datetime-local"
              value={closesAt}
              onChange={(event) => {
                setClosesAt(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        </div>

        <div className="row wrap gap">
          <label className="check">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(event) => {
                setAnonymous(event.target.checked);
                setDirty(true);
              }}
            />
            匿名展示（审计仍保留 voter）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={allowAbstain}
              onChange={(event) => {
                setAllowAbstain(event.target.checked);
                setDirty(true);
              }}
            />
            允许弃权
          </label>
        </div>

        <div className="poll-form-options">
          <div className="row between">
            <strong>候选</strong>
            <button type="button" className="ghost tiny" onClick={addOption} disabled={optionRows.length >= 50}>
              添加候选
            </button>
          </div>
          {optionRows.map((row, index) => (
            <div className="poll-option-row" key={index}>
              <span className="muted">{index + 1}</span>
              <input
                value={row.label}
                placeholder="候选标题"
                maxLength={200}
                onChange={(event) => updateOption(index, { label: event.target.value })}
              />
              <input
                value={row.description}
                placeholder="说明（可选）"
                maxLength={1000}
                onChange={(event) => updateOption(index, { description: event.target.value })}
              />
              <button
                type="button"
                className="ghost tiny"
                onClick={() => removeOption(index)}
                disabled={optionRows.length <= 2}
                aria-label={`删除候选 ${index + 1}`}
              >
                删除
              </button>
            </div>
          ))}
          <div className="muted">
            至少 2 个候选；也可从黑板/任务发起时带入来源。成员：{agentNames.slice(0, 6).join("、") || "无"}
          </div>
        </div>

        {error && (
          <div className="memory-error" role="alert">
            {error}
          </div>
        )}
        <div className="row end gap poll-create-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "创建中…" : "创建并开放投票"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
