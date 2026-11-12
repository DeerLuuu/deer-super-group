import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  Agent,
  MemberCandidate,
  PermissionMode,
  RecommendMembersRequest,
  RecommendMembersResponse,
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
import DangerConfirmModal from "./DangerConfirmModal";
import { recommendationErrorMessage } from "./shared/memberRecommendation";

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
  recommendedMembers,
  onRecommendedMembersHandled,
  autoEditMemberId,
  onAutoEditHandled,
  onCreate,
  onRecommend,
  onUpdate,
  onOpenSettings,
  onDelete,
  onOpenTask,
  onOpenTaskPage,
  onOpenMergeQueue,
  onOpenMemory,
  onOpenTaskGit,
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
  /** t415: Router read-only candidates handed off from Chat. */
  recommendedMembers?: MemberCandidate[] | null;
  onRecommendedMembersHandled?: () => void;
  /** P1-5：从任务头权限 chip 跳到指定成员的编辑弹窗（一次性）。 */
  autoEditMemberId?: string | null;
  onAutoEditHandled?: () => void;
  onCreate: (input: AgentDraft) => Promise<boolean>;
  onRecommend: (
    input: Omit<RecommendMembersRequest, "workspaceId">,
  ) => Promise<RecommendMembersResponse>;
  onOpenSettings: () => void;
  onUpdate: (input: UpdateAgentInput) => void;
  /** t167：删除成员；调用方负责二次确认后的 API。 */
  onDelete: (agent: Agent) => Promise<boolean>;
  onOpenTask: (taskId: string) => void;
  /** S04：星图浮窗「在任务页打开」。 */
  onOpenTaskPage: (taskId: string) => void;
  /** t103：团队页 Git 入口。 */
  onOpenMergeQueue: () => void;
  /** t123：团队页记忆工作台入口。 */
  onOpenMemory: () => void;
  onOpenTaskGit: (taskId: string) => void;
  /** t69：调度快照（团队进度/排队段与运行面板联动）。 */
  scheduler?: SchedulerSnapshot | null;
  /** t69：打开运行面板；可带选中任务。 */
  onOpenRuns: (taskId?: string | null) => void;
}) {
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ agent: Agent | null; candidates?: MemberCandidate[] } | null>(null);
  const [deleteMember, setDeleteMember] = useState<{
    agent: Agent;
    owned: number;
  } | null>(null);

  // C11：从顶栏/命令面板进入时自动打开「新建成员」弹窗（一次性）。
  useEffect(() => {
    if (!autoOpenMemberDialog) return;
    setDialog({ agent: null });
    onAutoOpenHandled();
  }, [autoOpenMemberDialog, onAutoOpenHandled]);

  // t415: Chat Router recommendation → open the existing create dialog with
  // candidates prefilled. This never creates; hiring still needs confirmation.
  useEffect(() => {
    if (!recommendedMembers?.length) return;
    setDialog({ agent: null, candidates: recommendedMembers });
    onRecommendedMembersHandled?.();
  }, [recommendedMembers, onRecommendedMembersHandled]);

  // P1-5：任务头权限 chip → 团队仅保留一处成员编辑。
  useEffect(() => {
    if (!autoEditMemberId) return;
    const agent = snapshot.agents.find((item) => item.id === autoEditMemberId);
    if (agent) setDialog({ agent });
    onAutoEditHandled?.();
  }, [autoEditMemberId, snapshot.agents, onAutoEditHandled]);

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

  useEffect(() => {    if (!selectedTaskId) return;
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

  async function submitAgent(draft: AgentDraft): Promise<boolean> {
    if (dialog?.agent) {
      onUpdate({ id: dialog.agent.id, ...draft });
      setDialog(null);
      return true;
    }
    const created = await onCreate(draft);
    if (created) setDialog(null);
    return created;
  }

  return (
    <div className="team-layout">
      <ProgressHeader
        stats={stats}
        scheduler={scheduler ?? null}
        onOpenRuns={() => onOpenRuns(selectedTaskId)}
        onOpenMergeQueue={onOpenMergeQueue}
        onOpenMemory={onOpenMemory}
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

            {members.filter((member) => !member.isRouter).length === 0 ? (
              <EmptyState
                compact
                icon="✦"
                title="还没有团队成员"
                description="创建一位执行成员，Router 才能把任务交给它运行。"
                actions={[
                  {
                    label: "新建成员",
                    onClick: () => openAgentDialog(null),
                    primary: true,
                  },
                ]}
              />
            ) : null}

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
                  <button
                    type="button"
                    className="team-member-delete run-danger"
                    title={member.isRouter ? "Router 不能删除" : "删除成员"}
                    disabled={member.isRouter || busy}
                    onClick={() => setDeleteMember({ agent: member, owned })}
                  >
                    删除
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

      {dialog && (
        <AgentDialog
          key={dialog.agent?.id ?? `new-${dialog.candidates?.map((candidate) => candidate.candidateId).join(",") ?? ""}`}
          agent={dialog.agent}
          initialCandidates={dialog.candidates}
          snapshot={snapshot}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={submitAgent}
          onRecommend={onRecommend}
          onOpenSettings={onOpenSettings}
          onDeleteRequest={(target, owned) => {
            setDialog(null);
            setDeleteMember({ agent: target, owned });
          }}
        />
      )}

      {deleteMember && (
        <DangerConfirmModal
          title="删除成员？"
          description="成员会从团队中移除；历史聊天、邮件与事件保留。"
          subject={deleteMember.agent.name}
          subjectLabel="成员名称"
          impact={[
            deleteMember.owned > 0
              ? `${deleteMember.owned} 个归属任务会变为未分配，需要重新指派。`
              : "当前没有归属任务。",
            "该成员的历史聊天、邮件和事件记录会保留。",
            "有排队/运行中的任务执行时，删除会被拒绝。",
            "Router 不能删除。",
          ]}
          confirmLabel="永久删除成员"
          onClose={() => setDeleteMember(null)}
          onConfirm={() => onDelete(deleteMember.agent)}
        />
      )}
    </div>
  );
}

function ProgressHeader({
  stats,
  scheduler,
  onOpenRuns,
  onOpenMergeQueue,
  onOpenMemory,
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
  onOpenMergeQueue: () => void;
  onOpenMemory: () => void;
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
              onClick={onOpenMergeQueue}
              title="打开合并队列（串行合并、检查与冲突处理）"
              aria-label="打开合并队列（合并确认在此执行）"
            >
              合并队列
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={onOpenMemory}
              title="打开记忆工作台：黑板、备忘录与归档审批"
            >
              记忆
            </button>
            <button
              type="button"
              className="ghost tiny"
              onClick={onOpenRuns}
              title="打开运行面板：调度队列、运行记录与时间线"
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
  initialCandidates,
  snapshot,
  busy,
  onClose,
  onSubmit,
  onRecommend,
  onOpenSettings,
  onDeleteRequest,
}: {
  agent: Agent | null;
  initialCandidates?: MemberCandidate[];
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: AgentDraft) => Promise<boolean> | boolean;
  onRecommend: (
    input: Omit<RecommendMembersRequest, "workspaceId">,
  ) => Promise<RecommendMembersResponse>;
  onOpenSettings: () => void;
  onDeleteRequest: (agent: Agent, owned: number) => void;
}) {
  const defaultManual = snapshot.settings.models.length === 0 || snapshot.settings.mock;
  const seededCandidates = initialCandidates ?? [];
  const [tab, setTab] = useState<"router" | "manual" | "description">(
    agent || (defaultManual && seededCandidates.length === 0) ? "manual" : "router",
  );
  const [candidates, setCandidates] = useState<MemberCandidate[]>(seededCandidates);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [recommendationCode, setRecommendationCode] = useState<string | null>(null);
  const [recommending, setRecommending] = useState(false);
  const [description, setDescription] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);
  const [hireError, setHireError] = useState<string | null>(null);
  const hiringRef = useRef(false);
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
      (agent !== null && permission !== agent.permission) ||
      (!agent && (description.trim().length > 0 || candidates.length > 0)),
  );

  async function runRecommendation(mode: "team-gap" | "description") {
    if (recommending) return;
    if (mode === "description" && (!description.trim() || description.trim().length > 2000)) {
      setRecommendationCode("RECOMMEND_INVALID_SCHEMA");
      setRecommendationError(
        !description.trim() ? "请先描述需要的成员" : "描述不能超过 2000 字符",
      );
      return;
    }
    setRecommending(true);
    setRecommendationError(null);
    setRecommendationCode(null);
    setCandidates([]);
    try {
      const response = await onRecommend({
        mode,
        ...(mode === "description" ? { description: description.trim() } : {}),
      });
      if (!response.ok) {
        setRecommendationCode(response.code);
        setRecommendationError(recommendationErrorMessage(response.code));
        return;
      }
      setCandidates(response.result.candidates);
      if (response.result.candidates.length === 0) {
        setRecommendationCode("RECOMMEND_EMPTY");
        setRecommendationError(recommendationErrorMessage("RECOMMEND_EMPTY"));
      }
    } catch (error) {
      setRecommendationCode("RECOMMEND_FAILED");
      setRecommendationError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecommending(false);
    }
  }

  function candidateToDraft(candidate: MemberCandidate): AgentDraft {
    return {
      name: candidate.name,
      role: candidate.role,
      model: candidate.suggestedModelProfileId,
      systemPrompt: candidate.systemPrompt ?? "",
      persona: candidate.persona ?? "",
      agentsMd: candidate.agentsMd ?? "",
      permission: "read_only",
    };
  }

  function editCandidate(candidate: MemberCandidate) {
    const draft = candidateToDraft(candidate);
    setName(draft.name);
    setRole(draft.role);
    setModel(draft.model ?? "");
    setSystemPrompt(draft.systemPrompt);
    setPersona(draft.persona);
    setAgentsMd(draft.agentsMd);
    setTab("manual");
  }

  async function hireCandidate(candidate: MemberCandidate) {
    if (hiringRef.current || busy || candidate.nameConflict) return;
    hiringRef.current = true;
    setHiring(true);
    setHireError(null);
    try {
      const created = await onSubmit(candidateToDraft(candidate));
      if (!created) setHireError("聘用失败；候选与输入已保留，可修改后重试。");
    } catch (error) {
      setHireError(error instanceof Error ? error.message : String(error));
    } finally {
      hiringRef.current = false;
      setHiring(false);
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const order: Array<"router" | "manual" | "description"> = [
      "router",
      "manual",
      "description",
    ];
    const index = order.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? order[(index + 1) % order.length]
        : event.key === "ArrowLeft"
          ? order[(index - 1 + order.length) % order.length]
          : event.key === "Home"
            ? order[0]
            : event.key === "End"
              ? order[order.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    if ((next === "router" || next === "description") && defaultManual) return;
    setTab(next);
    const list = event.currentTarget.parentElement;
    const tabs = list ? Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')) : [];
    tabs[order.indexOf(next)]?.focus?.();
  }

  function candidateCards() {
    const recommendationUnavailable = snapshot.settings.mock || snapshot.settings.models.length === 0;
    return (
      <div className="member-candidates">
        {recommendationUnavailable ? (
          <div className="notice small" role="alert">
            {snapshot.settings.mock
              ? "Mock 模式不提供推荐成员或聘用；请关闭 Mock / 配置模型后重试。"
              : "尚未配置模型，无法推荐或聘用成员；请先在设置中添加模型。"}
          </div>
        ) : null}
        {candidates.map((candidate) => {
          const confirming = confirmId === candidate.candidateId;
          return (
            <article className="member-candidate" key={candidate.candidateId}>
              <div className="member-candidate-head">
                <div>
                  <strong>{candidate.name}</strong>
                  <span className="muted tiny"> · {candidate.role}</span>
                </div>
                <span className="chip">read_only</span>
              </div>
              <div className="muted tiny">
                建议模型：{candidate.suggestedModelLabel ?? "使用默认模型"}
              </div>
              <p>{candidate.responsibilities}</p>
              <p className="muted tiny">推荐理由：{candidate.reason}</p>
              {candidate.nameConflict ? (
                <div className="notice small" role="alert">
                  名称与现有成员重复；请编辑后聘用。
                </div>
              ) : null}
              {candidate.roleConflict ? (
                <div className="notice small">已有多名同角色成员；角色冲突不阻断聘用。</div>
              ) : null}
              {candidate.skills.length > 0 ? (
                <div className="row gap wrap">
                  {candidate.skills.map((skill) => (
                    <span className="chip" key={skill}>
                      {skill}
                    </span>
                  ))}
                </div>
              ) : null}
              {candidate.risks.length > 0 ? (
                <ul className="muted tiny">
                  {candidate.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              ) : null}
              <details className="member-candidate-details">
                <summary>详情（systemPrompt / persona / AGENTS.md）</summary>
                <pre>{candidate.systemPrompt ?? "（空）"}</pre>
                <pre>{candidate.persona ?? "（空）"}</pre>
                <pre>{candidate.agentsMd ?? "（空）"}</pre>
              </details>
              <div className="row gap wrap">
                <button
                  type="button"
                  className="primary small"
                  disabled={busy || hiring || candidate.nameConflict || recommendationUnavailable}
                  onClick={() => {
                    setConfirmId(confirming ? null : candidate.candidateId);
                    setHireError(null);
                  }}
                  aria-expanded={confirming}
                  aria-controls={`member-confirm-${candidate.candidateId}`}
                >
                  聘用
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy || hiring || recommendationUnavailable}
                  onClick={() => editCandidate(candidate)}
                >
                  编辑后聘用
                </button>
              </div>
              {confirming ? (
                <div
                  className="member-confirm"
                  id={`member-confirm-${candidate.candidateId}`}
                  role="group"
                  aria-label={`确认聘用 ${candidate.name}`}
                >
                  <div className="muted tiny">
                    确认聘用 {candidate.name}（{candidate.role}，read_only）。创建后只能在成员编辑中提权。
                  </div>
                  {hireError ? (
                    <div className="notice small" role="alert">
                      {hireError}
                    </div>
                  ) : null}
                  <div className="row gap">
                    <button
                      type="button"
                      className="primary small"
                      disabled={hiring || busy || candidate.nameConflict}
                      aria-busy={hiring}
                      onClick={() => void hireCandidate(candidate)}
                    >
                      {hiring ? "聘用中…" : "确认聘用"}
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={hiring}
                      onClick={() => setConfirmId(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <Modal
      title={agent ? "编辑成员" : "新建成员"}
      description={agent ? agent.name : "每个成员有自己的提示词、人格与模型"}
      onClose={onClose}
      confirmClose={dirty}
    >
      {!agent ? (
        <div className="member-tabs" role="tablist" aria-label="新建成员方式">
          {(
            [
              ["router", "Router 推荐"],
              ["manual", "自己设定"],
              ["description", "描述生成"],
            ] as const
          ).map(([key, label]) => {
            const disabled = defaultManual && key !== "manual";
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`member-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`member-panel-${key}`}
                aria-disabled={disabled}
                tabIndex={tab === key ? 0 : -1}
                className={tab === key ? "active" : ""}
                onClick={() => {
                  if (!disabled) setTab(key);
                }}
                onKeyDown={onTabKeyDown}
                title={
                  disabled
                    ? snapshot.settings.mock
                      ? "Mock 模式不提供推荐"
                      : "请先在设置中添加模型"
                    : undefined
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      {agent || tab === "manual" ? (
      <form
          className="form modal-form"
          id="member-panel-manual"
          role={agent ? undefined : "tabpanel"}
          aria-labelledby={agent ? undefined : "member-tab-manual"}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim()) return;
            if (!agent && snapshot.settings.models.length === 0) return;
            await onSubmit({
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
          {agent && !agent.isRouter && (
            <div className="agent-danger-zone">
              <div>
                <strong>危险操作</strong>
                <span className="muted tiny">
                  删除成员后，其 {snapshot.tasks.filter((task) => task.ownerId === agent.id).length} 个归属任务会转为未分配。
                </span>
              </div>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  onDeleteRequest(
                    agent,
                    snapshot.tasks.filter((task) => task.ownerId === agent.id).length,
                  )
                }
              >
                删除成员
              </button>
            </div>
          )}
          <div className="modal-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !name.trim() || snapshot.settings.models.length === 0}
            >
              {agent ? "保存成员" : "创建成员"}
            </button>
          </div>
          {!agent && snapshot.settings.models.length === 0 ? (
            <div className="notice small" role="status">
              尚未配置模型，不能聘用成员；请先在设置中添加模型。
            </div>
          ) : null}
        </form>
      ) : tab === "router" ? (
        <div
          className="member-panel"
          id="member-panel-router"
          role="tabpanel"
          aria-labelledby="member-tab-router"
        >
          <p className="muted small">
            让 Router 根据当前工作区、任务缺口和现有团队推荐 1–3 位成员。推荐不会自动创建成员，聘用前必须确认。
          </p>
          {defaultManual ? (
            <div className="notice small">
              {snapshot.settings.mock
                ? "Mock 模式不提供真实推荐；请使用「自己设定」。"
                : "尚未配置模型；请先在设置中添加模型，或使用「自己设定」。"}
              {!snapshot.settings.mock ? (
                <button type="button" className="ghost small" onClick={onOpenSettings}>
                  去设置模型
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={recommending}
              aria-busy={recommending}
              onClick={() => void runRecommendation("team-gap")}
            >
              {recommending ? "Router 正在推荐…" : "让 Router 推荐"}
            </button>
          )}
          <div aria-live="polite" role="status">
            {recommending ? "Router 正在推荐…" : null}
          </div>
          {recommendationError ? (
            <div className="notice small" role="alert">
              {recommendationError}
              {!defaultManual ? (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void runRecommendation("team-gap")}
                  disabled={recommending}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {!recommending && candidates.length > 0 ? (
            <>
              {candidateCards()}
              <button
                type="button"
                className="ghost small"
                disabled={recommending || hiring}
                onClick={() => void runRecommendation("team-gap")}
              >
                重新推荐
              </button>
            </>
          ) : null}
          {!recommending && !recommendationError && candidates.length === 0 && !defaultManual ? (
            <div className="muted small">点击「让 Router 推荐」开始；不会自动创建成员。</div>
          ) : null}
          <div className="modal-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div
          className="member-panel"
          id="member-panel-description"
          role="tabpanel"
          aria-labelledby="member-tab-description"
        >
          <label>
            描述你需要的成员（1–2000 字符）
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              placeholder="例如：需要一个负责前端可访问性与响应式回归的 QA，熟悉键盘/读屏，权限先只读"
            />
          </label>
          <div className="muted tiny" aria-live="polite">
            {description.trim().length} / 2000
          </div>
          {description.trim().length > 2000 ? (
            <div className="notice small" role="alert">
              描述不能超过 2000 字符。
            </div>
          ) : null}
          {defaultManual ? (
            <div className="notice small">
              {snapshot.settings.mock
                ? "Mock 模式不提供真实推荐；请使用「自己设定」。"
                : "尚未配置模型；请先在设置中添加模型，或使用「自己设定」。"}
              {!snapshot.settings.mock ? (
                <button type="button" className="ghost small" onClick={onOpenSettings}>
                  去设置模型
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="row gap">
            <button
              type="button"
              className="primary"
              disabled={
                recommending ||
                defaultManual ||
                !description.trim() ||
                description.trim().length > 2000
              }
              aria-busy={recommending}
              onClick={() => void runRecommendation("description")}
            >
              {recommending ? "Router 正在生成…" : candidates.length ? "重新生成" : "生成候选"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={recommending || !description}
              onClick={() => {
                setDescription("");
                setCandidates([]);
                setRecommendationError(null);
              }}
            >
              清空
            </button>
          </div>
          {recommendationError ? (
            <div className="notice small" role="alert">
              {recommendationError}
              {!defaultManual ? (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void runRecommendation("description")}
                  disabled={recommending}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {!recommending && candidates.length > 0 ? candidateCards() : null}
          <div className="modal-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
