import { useEffect, useMemo, useState } from "react";
import type {
  Agent,
  PermissionMode,
  SchedulerSnapshot,
  Snapshot,
  Task,
  UpdateAgentInput,
} from "./shared/types";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  PERMISSION_MODES,
  TASK_STATUS_LABEL,
} from "./shared/copy";
import {
  schedulerActiveCount,
} from "./shared/kernelUi";
import TaskStarMap from "./TaskStarMap";
import Modal from "./Modal";
import EmptyState from "./EmptyState";

type AgentDraft = {
  name: string;
  role: string;
  model: string | null;
  systemPrompt: string;
  persona: string;
  agentsMd: string;
  /** t55 集成修复 IF-04：成员权限可在编辑弹窗调整（DESIGN §15.6 agent.updatePermission）。 */
  permission: PermissionMode;
};

export type StarmapFocus = { taskId: string; nonce: number } | null;

export default function TeamDashboard({
  snapshot,
  busy,
  selectedTaskId,
  onSelectTask,
  starmapFocus,
  autoOpenMemberDialog,
  onAutoOpenHandled,
  onCreate,
  onUpdate,
  onOpenTask,
  onOpenTaskPage,
  scheduler,
  onOpenRuns,
}: {
  snapshot: Snapshot;
  busy: boolean;
  /** C14：App 级唯一「当前任务」选中态，与任务页/对话页共享。 */
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  /** C14：任务页「在星图中定位」触发的居中请求。 */
  starmapFocus: StarmapFocus;
  /** C11：命令面板/「＋新建」触发的自动打开成员弹窗（一次性）。 */
  autoOpenMemberDialog: boolean;
  onAutoOpenHandled: () => void;
  onCreate: (input: AgentDraft) => void;
  onUpdate: (input: UpdateAgentInput) => void;
  onOpenTask: (taskId: string) => void;
  /** S04：星图浮窗「在任务页打开」。 */
  onOpenTaskPage: (taskId: string) => void;
  /** t69：调度快照（团队进度/排队段与运行面板联动）。 */
  scheduler?: SchedulerSnapshot | null;
  /** t69：打开运行面板；可带选中任务。 */
  onOpenRuns: (taskId?: string | null) => void;
}) {
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ agent: Agent | null } | null>(null);

  // C11：从顶栏/命令面板进入时自动打开「新建成员」弹窗（一次性）。
  useEffect(() => {
    if (!autoOpenMemberDialog) return;
    setDialog({ agent: null });
    onAutoOpenHandled();
  }, [autoOpenMemberDialog, onAutoOpenHandled]);

  const taskById = useMemo(
    () => new Map(snapshot.tasks.map((task) => [task.id, task])),
    [snapshot.tasks],
  );

  function dependsOnUnfinished(task: Task): boolean {
    return task.dependsOn.some((id) => taskById.get(id)?.status !== "done");
  }

  const stats = useMemo(() => {
    const total = snapshot.tasks.length;
    const running = snapshot.tasks.filter(
      (task) => task.status === "running" || task.status === "review",
    ).length;
    const delivered = snapshot.tasks.filter((task) => task.status === "done").length;
    const queued = snapshot.tasks.filter((task) => task.status === "queued").length;
    const waiting = snapshot.tasks.filter(
      (task) =>
        (task.status === "ready" || task.status === "blocked") &&
        dependsOnUnfinished(task),
    ).length;
    const ready = snapshot.tasks.filter(
      (task) => task.status === "ready" && !dependsOnUnfinished(task),
    ).length;
    const other = total - running - delivered - queued - waiting - ready;
    const deliveryPct = total === 0 ? 0 : Math.round((delivered / total) * 100);
    return { total, running, delivered, queued, waiting, ready, other, deliveryPct };
  }, [snapshot.tasks, taskById]);

  const members = snapshot.agents;
  const memberFilterName = memberFilter
    ? members.find((member) => member.id === memberFilter)?.name ?? "成员"
    : null;
  const visibleTasks = memberFilter
    ? snapshot.tasks.filter((task) => task.ownerId === memberFilter)
    : snapshot.tasks;
  const selectedTask =
    snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedOwner = selectedTask?.ownerId
    ? members.find((member) => member.id === selectedTask.ownerId) ?? null
    : null;

  useEffect(() => {
    if (!selectedTaskId) return;
    const selected = snapshot.tasks.find((task) => task.id === selectedTaskId);
    if (!selected) {
      onSelectTask(null);
      return;
    }
    if (memberFilter && selected.ownerId !== memberFilter) {
      onSelectTask(null);
    }
  }, [memberFilter, selectedTaskId, snapshot.tasks, onSelectTask]);

  function openAgentDialog(agent: Agent | null) {
    setDialog({ agent });
  }

  function submitAgent(draft: AgentDraft) {
    if (dialog?.agent) {
      onUpdate({ id: dialog.agent.id, ...draft });
    } else {
      onCreate(draft);
    }
    setDialog(null);
  }

  return (
    <div className="team-layout">
      <ProgressHeader
        stats={stats}
        scheduler={scheduler ?? null}
        onOpenRuns={() => onOpenRuns(selectedTaskId)}
      />

      <div className="team-middle">
        <aside className="panel team-members">
          <div className="panel-head">
            <div>
              <div className="panel-title">成员</div>
              <div className="muted tiny">{members.length} 位（含 Router）</div>
            </div>
            <button
              type="button"
              className="ghost tiny"
              onClick={() => openAgentDialog(null)}
              disabled={busy}
            >
              + 新建成员
            </button>
          </div>
          <div className="team-member-list">
            <button
              type="button"
              className={`team-member team-member-all ${
                memberFilter === null ? "selected" : ""
              }`}
              onClick={() => setMemberFilter(null)}
            >
              <span className="team-member-avatar all">全</span>
              <span className="team-member-name">
                <strong>全部成员</strong>
                <span className="muted tiny">显示全部任务</span>
              </span>
              <span className="team-member-count">{snapshot.tasks.length}</span>
            </button>

            {members.map((member) => {
              const owned = snapshot.tasks.filter(
                (task) => task.ownerId === member.id,
              ).length;
              return (
                <div
                  key={member.id}
                  className={`team-member ${
                    memberFilter === member.id ? "selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="team-member-main"
                    onClick={() =>
                      setMemberFilter((current) =>
                        current === member.id ? null : member.id,
                      )
                    }
                  >
                    <span className="team-member-avatar">
                      {member.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="team-member-name">
                      <strong>
                        {member.name}
                        {member.isRouter && <span className="badge">Router</span>}
                      </strong>
                      <span className="muted tiny">{member.role}</span>
                    </span>
                    <span className="team-member-count">{owned}</span>
                  </button>
                  <button
                    type="button"
                    className="team-member-edit"
                    title="编辑成员"
                    onClick={() => openAgentDialog(member)}
                  >
                    编辑
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="panel team-map-panel">
          <div className="panel-head team-map-head">
            <div>
              <div className="panel-title">任务星图</div>
              <div className="muted tiny">
                {visibleTasks.length} 个任务
                {memberFilterName ? ` · ${memberFilterName} 的任务` : " · 全部任务"}
              </div>
            </div>
            <div className="muted tiny">拖动空白平移 · 滚轮缩放</div>
          </div>
          <TaskStarMap
            tasks={visibleTasks}
            agents={members}
            selectedTaskId={selectedTaskId}
            focus={starmapFocus}
            workspaceId={snapshot.workspace.id}
            memberFilterId={memberFilter}
            onSelect={(task) => onSelectTask(task.id)}
            onOpen={(task) => onOpenTask(task.id)}
            onOpenTaskPage={(task) => onOpenTaskPage(task.id)}
            onFilterMember={(memberId) => setMemberFilter(memberId)}
          />
        </section>
      </div>

      <section className="panel team-task-detail">
        {selectedTask ? (
          <>
            <div className="team-detail-head">
              <div className="team-detail-title">
                <span className={`status status-${selectedTask.status}`}>
                  {TASK_STATUS_LABEL[selectedTask.status]}
                </span>
                <strong>{selectedTask.title}</strong>
                <span className="muted tiny mono">{selectedTask.id}</span>
              </div>
              <button
                type="button"
                className="primary small"
                onClick={() => onOpenTask(selectedTask.id)}
              >
                打开任务会话
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => onOpenRuns(selectedTask.id)}
                title="在运行面板查看该任务的 Run 历史与时间线"
              >
                运行详情
              </button>
            </div>
            <div className="team-detail-body">
              <div className="team-detail-description">
                <div className="section-label">任务描述</div>
                <p>{selectedTask.description || "（无描述）"}</p>
                {selectedTask.summary && (
                  <p className="muted tiny">摘要：{selectedTask.summary}</p>
                )}
              </div>
              <div className="team-detail-meta">
                <div>
                  <div className="section-label">负责人</div>
                  <div>{selectedOwner ? selectedOwner.name : "未分配"}</div>
                </div>
                <div>
                  <div className="section-label">依赖</div>
                  <div>
                    {selectedTask.dependsOn.length === 0
                      ? "无"
                      : selectedTask.dependsOn
                          .map((id) => taskById.get(id)?.title ?? id)
                          .join("、")}
                  </div>
                </div>
                <div>
                  <div className="section-label">验收标准</div>
                  <div>
                    {selectedTask.acceptance.length === 0
                      ? "无"
                      : selectedTask.acceptance.join("；")}
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          // C24：空状态统一组件。
          <EmptyState
            compact
            icon="✦"
            title="在星图中选择任务"
            description="单击节点查看描述；双击节点或点「↗」直接打开任务会话。"
          />
        )}
      </section>

      {dialog && (
        <AgentDialog
          key={dialog.agent?.id ?? "new"}
          agent={dialog.agent}
          snapshot={snapshot}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={submitAgent}
        />
      )}
    </div>
  );
}

function ProgressHeader({
  stats,
  scheduler,
  onOpenRuns,
}: {
  stats: {
    total: number;
    running: number;
    delivered: number;
    queued: number;
    waiting: number;
    ready: number;
    other: number;
    deliveryPct: number;
  };
  scheduler: SchedulerSnapshot | null;
  onOpenRuns: () => void;
}) {
  function percent(value: number): string {
    return stats.total === 0 ? "0%" : `${(value / stats.total) * 100}%`;
  }
  const activeRuns = schedulerActiveCount(scheduler);
  const paused = Boolean(scheduler?.paused);

  return (
    <section className="panel team-progress">
      <div className="team-progress-summary">
        <div className="team-progress-heading">
          <div>
            <div className="panel-title">团队总进度</div>
            <div className="muted tiny">
              {stats.total === 0
                ? "还没有任务"
                : `${stats.delivered} / ${stats.total} 个任务已交付`}
            </div>
          </div>
          <div className="team-progress-actions">
            <span className="muted tiny">
              {paused
                ? "调度已暂停"
                : activeRuns > 0
                  ? `运行中 ${activeRuns} · 排队 ${stats.queued}`
                  : `排队 ${stats.queued}`}
            </span>
            <button
              type="button"
              className="ghost tiny"
              onClick={onOpenRuns}
              title="打开运行面板：调度队列、Run 历史与时间线"
            >
              运行面板
            </button>
          </div>
        </div>
        <div className="team-progress-bar">
          {stats.running > 0 && (
            <span
              className="team-progress-seg running"
              style={{ width: percent(stats.running) }}
            />
          )}
          {stats.queued > 0 && (
            <span
              className="team-progress-seg queued"
              style={{ width: percent(stats.queued) }}
            />
          )}
          {stats.waiting > 0 && (
            <span
              className="team-progress-seg waiting"
              style={{ width: percent(stats.waiting) }}
            />
          )}
          {stats.ready > 0 && (
            <span
              className="team-progress-seg ready"
              style={{ width: percent(stats.ready) }}
            />
          )}
          {stats.delivered > 0 && (
            <span
              className="team-progress-seg delivered"
              style={{ width: percent(stats.delivered) }}
            />
          )}
          {stats.other > 0 && (
            <span
              className="team-progress-seg other"
              style={{ width: percent(stats.other) }}
            />
          )}
          {stats.total === 0 && <span className="team-progress-seg empty" />}
        </div>
        <div className="team-progress-legend">
          <span>
            <i className="dot running" /> 进行中 {stats.running}
          </span>
          <span>
            <i className="dot queued" /> 排队中 {stats.queued}
          </span>
          <span>
            <i className="dot waiting" /> 等待依赖 {stats.waiting}
          </span>
          <span>
            <i className="dot ready" /> 待运行 {stats.ready}
          </span>
          <span>
            <i className="dot delivered" /> 已交付 {stats.delivered}
          </span>
        </div>
      </div>

      <div className="team-progress-cards">
        <div className="team-progress-card">
          <span className="muted tiny">进行中</span>
          <strong>{stats.running}</strong>
          <span className="muted tiny">含评审中的任务</span>
        </div>
        <div className="team-progress-card">
          <span className="muted tiny">排队中</span>
          <strong>{stats.queued}</strong>
          <span className="muted tiny">已入队待启动</span>
        </div>
        <div className="team-progress-card">
          <span className="muted tiny">等待依赖</span>
          <strong>{stats.waiting}</strong>
          <span className="muted tiny">依赖尚未交付</span>
        </div>
        <div className="team-progress-card">
          <span className="muted tiny">已交付</span>
          <strong>{stats.delivered}</strong>
          <span className="muted tiny">已完成任务</span>
        </div>
      </div>

      <div
        className="team-donut"
        style={{
          background: `conic-gradient(var(--green) 0 ${stats.deliveryPct}%, var(--border-2) ${stats.deliveryPct}% 100%)`,
        }}
      >
        <div className="team-donut-inner">
          <strong>{stats.deliveryPct}%</strong>
          <span className="muted tiny">交付率</span>
        </div>
      </div>
    </section>
  );
}

function AgentDialog({
  agent,
  snapshot,
  busy,
  onClose,
  onSubmit,
}: {
  agent: Agent | null;
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: AgentDraft) => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "engineer");
  const [model, setModel] = useState(() => {
    if (!agent?.model) return "";
    const matched =
      snapshot.settings.models.find((profile) => profile.id === agent.model) ??
      snapshot.settings.models.find((profile) => profile.modelId === agent.model);
    return matched?.id ?? "";
  });
  const [systemPrompt, setSystemPrompt] = useState(
    agent?.systemPrompt ??
      "You are a careful engineer. Inspect before editing, keep changes minimal, run checks, and report clearly.",
  );
  const [persona, setPersona] = useState(agent?.persona ?? "");
  const [agentsMd, setAgentsMd] = useState(agent?.agentsMd ?? "");
  const [permission, setPermission] = useState<PermissionMode>(
    agent?.permission ?? "read_only",
  );
  // C25：编辑已有内容或已改动时，关闭需确认。
  const dirty = Boolean(
    name.trim() && name !== (agent?.name ?? "") ||
      role !== (agent?.role ?? "engineer") ||
      systemPrompt !==
        (agent?.systemPrompt ??
          "You are a careful engineer. Inspect before editing, keep changes minimal, run checks, and report clearly.") ||
      persona !== (agent?.persona ?? "") ||
      agentsMd !== (agent?.agentsMd ?? "") ||
      (agent !== null && permission !== agent.permission),
  );

  return (
    <Modal
      title={agent ? "编辑成员" : "新建成员"}
      description={agent ? agent.name : "每个成员有自己的提示词、人格与模型"}
      onClose={onClose}
      confirmClose={dirty}
    >
      <form
          className="form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onSubmit({
              name: name.trim(),
              role: role.trim() || "engineer",
              model: model || null,
              systemPrompt,
              persona,
              agentsMd,
              permission,
            });
          }}
        >
          <div className="provider-grid">
            <label>
              名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Builder"
              />
            </label>
            <label>
              角色
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="engineer"
              />
            </label>
          </div>
          <label>
            模型
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={snapshot.settings.models.length === 0}
            >
              <option value="">使用默认模型</option>
              {snapshot.settings.models.map((profile) => {
                const provider = snapshot.settings.providers.find(
                  (item) => item.id === profile.providerId,
                );
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} · {provider?.name ?? profile.providerId} (
                    {profile.modelId})
                  </option>
                );
              })}
            </select>
          </label>
          {agent ? (
            <label>
              权限
              <select
                value={permission}
                onChange={(event) => setPermission(event.target.value as PermissionMode)}
                disabled={busy}
                title={PERMISSION_DESCRIPTIONS[permission]}
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode} title={PERMISSION_DESCRIPTIONS[mode]}>
                    {PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
              <span className="muted tiny">{PERMISSION_DESCRIPTIONS[permission]}</span>
            </label>
          ) : (
            <div className="notice small">
              新成员默认「{PERMISSION_LABELS.read_only}」，创建后可在成员编辑中调整权限；权限是执行层硬门禁。
            </div>
          )}
          <label>
            系统提示词
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={5}
            />
          </label>
          <label>
            人格
            <textarea
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
              rows={2}
            />
          </label>
          <label>
            AGENTS.md
            <textarea
              value={agentsMd}
              onChange={(event) => setAgentsMd(event.target.value)}
              rows={2}
            />
          </label>
          <div className="modal-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={busy || !name.trim()}>
              {agent ? "保存成员" : "创建成员"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
