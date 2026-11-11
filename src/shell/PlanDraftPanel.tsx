import { useEffect, useRef, useState } from "react";
import type { Agent } from "../shared/types";
import {
  hasHighRiskTask,
  planContractForTask,
  planDraftFingerprint,
  type PlanDraft,
  type PlanDraftTask,
  type PlanIssue,
  type PlanSource,
} from "../shared/planDraft";

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function textareaLines(values: string[]): string {
  return values.join("\n");
}

function issueFor(issues: PlanIssue[], taskId: string, code: string): PlanIssue | undefined {
  return issues.find((issue) => issue.taskId === taskId && issue.code === code);
}

export default function PlanDraftPanel({
  draft,
  source,
  sourceChanged,
  issues,
  agents,
  busy,
  error,
  confirming,
  onDraftChange,
  onGoalChange,
  onConfirm,
  onCancel,
  onRetry,
}: {
  draft: PlanDraft | null;
  source: PlanSource | null;
  sourceChanged: boolean;
  issues: PlanIssue[];
  agents: readonly Agent[];
  busy: boolean;
  error: string | null;
  confirming: boolean;
  onDraftChange: (draft: PlanDraft) => void;
  onGoalChange: (goal: string) => void;
  onConfirm: (ackHighRisk: boolean) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [ackNotice, setAckNotice] = useState("");
  const firstTitleRef = useRef<HTMLInputElement | null>(null);
  const taskTitleRefs = useRef(new Map<string, HTMLInputElement | null>());
  const pendingFocusRef = useRef<string | null>(null);
  const previousDraftRef = useRef<PlanDraft | null>(null);
  const draftFingerprintRef = useRef("");
  const tasks = draft?.tasks ?? [];
  const errors = issues.filter((issue) => issue.severity === "error");
  const highRisk = hasHighRiskTask(tasks);
  const canConfirm =
    Boolean(draft) &&
    !sourceChanged &&
    !busy &&
    !confirming &&
    errors.length === 0 &&
    (!highRisk || ack);
  const confirmBlockReason = sourceChanged
    ? "目标已修改，请重新生成草案后再确认"
    : !draft
      ? "尚无草案"
      : errors.length > 0
        ? `当前有 ${errors.length} 个校验错误`
        : highRisk && !ack
          ? "请勾选高风险确认"
          : busy
            ? "正在生成草案"
            : confirming
              ? "正在创建任务"
              : "";

  useEffect(() => {
    const fingerprint = `${source?.digest ?? ""}:${draft ? planDraftFingerprint(draft) : ""}`;
    if (fingerprint === draftFingerprintRef.current) return;
    if (draftFingerprintRef.current && ack) {
      setAckNotice("草案已修改，请重新确认高风险项。");
    }
    draftFingerprintRef.current = fingerprint;
    setAck(false);
  }, [draft, source, ack]);

  useEffect(() => {
    const previous = previousDraftRef.current;
    previousDraftRef.current = draft;
    if (!draft) return;
    const firstArrival = !previous || previous.source.digest !== draft.source.digest;
    if (firstArrival) {
      pendingFocusRef.current = null;
      firstTitleRef.current?.focus();
      return;
    }
    const pending = pendingFocusRef.current;
    if (pending) {
      pendingFocusRef.current = null;
      taskTitleRefs.current.get(pending)?.focus();
    }
  }, [draft]);

  function patchTask(taskId: string, patch: Partial<PlanDraftTask>) {
    if (!draft) return;
    onDraftChange({
      ...draft,
      tasks: draft.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    });
  }

  function removeTask(taskId: string) {
    if (!draft) return;
    const index = draft.tasks.findIndex((task) => task.id === taskId);
    const remaining = draft.tasks.filter((task) => task.id !== taskId);
    const focusTarget = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
    pendingFocusRef.current = focusTarget?.id ?? null;
    onDraftChange({
      ...draft,
      tasks: remaining.map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dep) => dep !== taskId),
      })),
    });
  }

  function addTask() {
    if (!draft) return;
    let nextId = 1;
    const used = new Set(draft.tasks.map((task) => task.id));
    while (used.has(`draft-${nextId}`)) nextId += 1;
    const newId = `draft-${nextId}`;
    pendingFocusRef.current = newId;
    const index = draft.tasks.length + 1;
    onDraftChange({
      ...draft,
      tasks: [
        ...draft.tasks,
        {
          id: newId,
          title: `新任务 ${index}`,
          description: "",
          acceptance: [],
          dependsOn: [],
          ownerId: null,
          priority: 50,
          risks: [],
          unknowns: [],
        },
      ],
    });
  }

  function moveTask(index: number, delta: number) {
    if (!draft) return;
    const next = [...draft.tasks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    pendingFocusRef.current = next[target]!.id;
    onDraftChange({ ...draft, tasks: next });
  }

  return (
    <section className="plan-draft-panel" aria-label="计划草案">
      <header className="plan-draft-head">
        <div>
          <div className="panel-title">计划草案</div>
          <div className="muted tiny">
            确认前不会创建任务或 Run；草案仅本次会话有效。
          </div>
        </div>
        <div className="row gap">
          <button type="button" className="ghost small" onClick={onRetry} disabled={busy || confirming}>
            重新生成
          </button>
          <button type="button" className="ghost small" onClick={onCancel} disabled={confirming}>
            取消
          </button>
        </div>
      </header>

      {source ? (
        <>
          <label className="plan-draft-goal">
            目标（可编辑）
            <textarea
              rows={2}
              aria-label="计划目标"
              value={source.goal}
              onChange={(event) => onGoalChange(event.target.value)}
              placeholder="例如：给当前项目增加健康检查接口并补测试"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <div className="plan-draft-source" aria-label="规划来源">
            <span>来源：当前对话</span>
            <span>{source.messages.length} 条消息</span>
            <span>{source.characterCount} 字符</span>
            <span className="mono">digest {source.digest.slice(0, 8)}</span>
            {source.summary ? <span>含压缩摘要</span> : null}
          </div>
          {sourceChanged ? (
            <div className="notice small plan-draft-source-changed" role="status">
              目标已修改；当前草案仍保留，但确认已禁用。请重新生成草案，或把目标改回原值。
            </div>
          ) : null}
        </>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {busy ? "正在生成计划草案" : draft ? `草案已就绪，共 ${tasks.length} 个任务` : ""}
      </div>

      {busy ? <div className="plan-draft-status" role="status">正在生成草案…</div> : null}
      {error ? (
        <div className="error plan-draft-error" role="alert">
          {error}
          <button type="button" className="ghost tiny" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}

      {draft ? (
        <>
          <div className="plan-draft-list">
            {tasks.map((task, index) => {
              const taskIssues = issues.filter((issue) => issue.taskId === task.id);
              const contract = planContractForTask(task, agents);
              return (
                <article className="plan-draft-task" key={task.id} aria-label={`任务 ${index + 1}`}>
                  <div className="plan-draft-task-head">
                    <span className="plan-draft-index">{index + 1}</span>
                    <input
                      ref={(node) => {
                        taskTitleRefs.current.set(task.id, node);
                        if (index === 0) firstTitleRef.current = node;
                      }}
                      aria-label={`任务 ${index + 1} 标题`}
                      value={task.title}
                      aria-invalid={Boolean(issueFor(issues, task.id, "TASK_TITLE_EMPTY"))}
                      aria-describedby={
                        taskIssues.length > 0 ? `plan-task-issues-${task.id}` : undefined
                      }
                      onChange={(event) => patchTask(task.id, { title: event.target.value })}
                    />
                    <div className="row gap">
                      <button type="button" className="ghost tiny" onClick={() => moveTask(index, -1)} disabled={index === 0}>
                        上移
                      </button>
                      <button type="button" className="ghost tiny" onClick={() => moveTask(index, 1)} disabled={index === tasks.length - 1}>
                        下移
                      </button>
                      <button type="button" className="ghost tiny run-danger" onClick={() => removeTask(task.id)}>
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="plan-draft-grid">
                    <label>
                      描述
                      <textarea
                        rows={2}
                        value={task.description}
                        onChange={(event) => patchTask(task.id, { description: event.target.value })}
                      />
                    </label>
                    <label>
                      验收标准（每行一条）
                      <textarea
                        rows={2}
                        value={textareaLines(task.acceptance)}
                        onChange={(event) => patchTask(task.id, { acceptance: lines(event.target.value) })}
                      />
                    </label>
                    <label>
                      负责人
                      <select
                        value={task.ownerId ?? ""}
                        onChange={(event) =>
                          patchTask(task.id, { ownerId: event.target.value || null })
                        }
                      >
                        <option value="">未分配</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                            {agent.isRouter ? "（Router，不建议分配）" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      优先级
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={task.priority}
                        onChange={(event) =>
                          patchTask(task.id, { priority: Number(event.target.value) })
                        }
                      />
                    </label>
                  </div>

                  <div className="plan-draft-deps">
                    <div className="section-label">依赖</div>
                    {tasks.length <= 1 ? (
                      <span className="muted tiny">无其他任务</span>
                    ) : (
                      tasks
                        .filter((candidate) => candidate.id !== task.id)
                        .map((candidate) => (
                          <label key={candidate.id} className="plan-draft-dep">
                            <input
                              type="checkbox"
                              checked={task.dependsOn.includes(candidate.id)}
                              onChange={(event) =>
                                patchTask(task.id, {
                                  dependsOn: event.target.checked
                                    ? [...new Set([...task.dependsOn, candidate.id])]
                                    : task.dependsOn.filter((dep) => dep !== candidate.id),
                                })
                              }
                            />
                            {candidate.title || "未命名任务"}
                          </label>
                        ))
                    )}
                  </div>

                  <div className="plan-draft-contract" title="执行契约由负责人来源决定；本批不支持逐任务改模型/权限">
                    <span className="section-label">执行契约</span>
                    <span className={`plan-contract-chip is-${contract.source}`}>{contract.label}</span>
                  </div>

                  <div className="plan-draft-grid">
                    <label>
                      风险（每行一条）
                      <textarea
                        rows={2}
                        value={textareaLines(task.risks)}
                        onChange={(event) => patchTask(task.id, { risks: lines(event.target.value) })}
                      />
                    </label>
                    <label>
                      未知项（每行一条）
                      <textarea
                        rows={2}
                        value={textareaLines(task.unknowns)}
                        onChange={(event) => patchTask(task.id, { unknowns: lines(event.target.value) })}
                      />
                    </label>
                  </div>

                  {taskIssues.length > 0 ? (
                    <ul
                  id={`plan-task-issues-${task.id}`}
                  className="plan-draft-issues"
                  aria-label={`任务 ${index + 1} 校验`}
                  aria-live="polite"
                >
                      {taskIssues.map((issue) => (
                        <li key={`${issue.code}:${issue.message}`} className={`is-${issue.severity}`}>
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              );
            })}
          </div>

          <div className="row gap plan-draft-add">
            <button type="button" className="ghost small" onClick={addTask} disabled={tasks.length >= 12}>
              + 添加任务
            </button>
          </div>

          {issues.filter((issue) => !issue.taskId).length > 0 ? (
            <ul
              id="plan-draft-global-issues"
              className="plan-draft-issues"
              aria-label="草案校验"
              aria-live="polite"
            >
              {issues
                .filter((issue) => !issue.taskId)
                .map((issue) => (
                  <li key={`${issue.code}:${issue.message}`} className={`is-${issue.severity}`}>
                    {issue.message}
                  </li>
                ))}
            </ul>
          ) : null}

          {highRisk ? (
            <label className="plan-draft-risk-ack">
              <input
                type="checkbox"
                checked={ack}
                onChange={(event) => {
                  setAck(event.target.checked);
                  setAckNotice("");
                }}
              />
              我已确认草案包含删除/迁移/权限/密钥等高风险操作
            </label>
          ) : null}
          {ackNotice ? (
            <div className="plan-draft-ack-note muted tiny" role="status">
              {ackNotice}
            </div>
          ) : null}

          <footer className="plan-draft-foot">
            <span className="muted tiny">
              {tasks.length} 个任务 · {errors.length} 个错误 · 确认后一次创建 DAG，不自动运行
            </span>
            <span id="plan-draft-confirm-summary" className="muted tiny" role="status">
              {confirmBlockReason}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!canConfirm}
              aria-describedby={canConfirm ? undefined : "plan-draft-confirm-summary"}
              onClick={() => onConfirm(ack)}
            >
              {confirming ? "创建中…" : "确认创建"}
            </button>
          </footer>
        </>
      ) : (
        !busy && !error ? (
          <div className="plan-draft-empty">等待生成草案。</div>
        ) : null
      )}
    </section>
  );
}
