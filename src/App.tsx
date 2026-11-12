import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  Agent,
  BoardEntry,
  ChatAssistantTurn,
  ChatMessage,
  ChatQuestionRecord,
  ChatTrajectoryEntry,
  ChatTurn,
  ChatTurnHistoryPage,
  ChatTurnReasoning,
  ChatTurnTerminal,
  ChatTurnTool,
  ContextSnapshot,
  EventRecord,
  KernelResult,
  LlmSettings,
  MailboxMessage,
  PermissionMode,
  RecommendMembersRequest,
  RecommendMembersResponse,
  MemberCandidate,
  RiskApprovalRequest,
  Run,
  SchedulerSnapshot,
  Snapshot,
  Task,
  UpdateAgentInput,
  Workspace,
} from "./shared/types";
import { DEFAULT_MAX_DOCK_GROUPS } from "./shared/types";
import {
  MAILBOX_MAX_INDENT,
  deriveMailboxThreads,
  filterMailboxThreads,
  mailboxParticipants,
  mailboxReadStorageKey,
  parseMailboxReadIds,
  pruneMailboxReadIds,
  serializeMailboxReadIds,
  totalMailboxUnread,
  type MailboxThread,
} from "./shared/mailboxThreads";
import {
  captureMailboxScrollState,
  parseMailboxScrollState,
  restoreMailboxScrollTop,
  serializeMailboxScrollState,
  type MailboxScrollItem,
  type MailboxScrollState,
} from "./shell/mailboxScroll";
import Modal from "./Modal";
import StatusBadge from "./StatusBadge";
import EmptyState from "./EmptyState";
import DangerConfirmModal from "./DangerConfirmModal";
import SchedulerBar from "./SchedulerBar";
import RunHistory from "./RunHistory";
import RunPanel from "./RunPanel";
import { createChatTranslationMemo } from "./kernel/chatTranslationMemo";
import { extractRecommendationCandidates, parseTeamCommand } from "./shared/routerMemberHandoff";
import { translationCacheNeedsInvalidation } from "./shared/translationCache";
import {
  applyHistoryScrollPreservation,
  nextVisibleMessageCount,
} from "./shared/chatHistory";
import {
  BudgetBar,
  WatchdogAlertBanner,
  WatchdogPanel,
} from "./watchdog/WatchdogPanel";
import type {
  CostSnapshot,
  RunHandoff,
  WatchdogAlert,
  WatchdogHoldReason,
  WatchdogSnapshot,
} from "./shared/watchdog";
import KernelAnnouncer from "./KernelAnnouncer";
import ChatContent from "./ChatContent";
import { TaskVcsPanel } from "./git/ui/GitPanels";
import ReviewSection from "./review/ui/ReviewSection";
import QuestionModal, { type QuestionSubmitResult } from "./interactive/QuestionModal";
import {
  answerAlreadySent,
  isComposerFocusWithin,
  isEditableElement,
  shouldAutoOpenQuestion,
} from "./interactive/questionFlow";
import type { QuestionValues } from "./shared/interactive";
import type { ChatLiveSettled } from "./shared/chatLive";
import type {
  ChatLiveReasoningSegment as ChatReasoningSegment,
  ChatLiveToolTrace as ChatToolTrace,
} from "./shared/chatLive";
import { ChatLiveBridge } from "./shell/chat/ChatLiveBridge";
import {
  ChatLiveStore,
  useChatLiveState,
  useChatLiveTerminals,
} from "./shell/chat/chatLiveStore";
import CommandPalette, {
  CREATE_LABELS,
  CREATE_TARGET_TAB,
  type CreateIntent,
  type PanelAction,
} from "./CommandPalette";
import WorkflowRail from "./shell/WorkflowRail";
import { useMergeQueue } from "./shell/useMergeQueue";
import {
  ALL_REFRESH_DOMAINS,
  RefreshCoordinator,
  type RefreshDomain,
} from "./shell/refreshCoordinator";
import FirstRunCard from "./shell/FirstRunCard";
import ErrorRecoveryBar from "./shell/ErrorRecoveryBar";
import ApprovalTerms from "./shell/ApprovalTerms";
import { LazyPanel } from "./shell/LazyPanel";
import { deriveFirstRunState, resolveFirstRunKeyStatus } from "./shell/firstRunData";
import { writeThenRefresh } from "./shell/writeThenRefresh";
import TaskWorkspaceTabs from "./shell/TaskWorkspaceTabs";
import {
  resolveTaskWorkspaceSource,
  TASK_WORKSPACE_INITIAL_TAB,
  taskWorkspaceNext,
  taskWorkspacePanelId,
  type TaskWorkspaceSource,
  type TaskWorkspaceTab,
} from "./shell/taskWorkspaceData";
import {
  isPlanDraftDirty,
  isPlanDraftSourceChanged,
  PlanPreviewGate,
  planDraftLeaveDisposition,
  planDraftLeaveMessage,
  type PlanDraftLeaveReason,
} from "./shell/planDraftSession";
import {
  buildPlanSource,
  planSourceIssues,
  planDraftFingerprint,
  validatePlanDraft,
  type PlanDraft,
  type PlanIssue,
  type PlanSource,
} from "./shared/planDraft";
import {
  deriveNeedsMe,
  deriveWorkflow,
  type NeedsMeItem,
  type WorkflowStage,
} from "./shell/workflowData";
import { ToastHost, useToasts, type ToastItem } from "./Toast";
import { taskExecutionContract } from "./shell/executionContract";
import { TaskContractChips } from "./shell/TaskContractChips";
import type { SettingsSection } from "./SettingsView";
import {
  BOARD_CONFIDENCE_LABEL,
  BOARD_KIND_LABEL,
  MESSAGE_KIND_LABEL,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  PERMISSION_MODES,
  TASK_STATUS_LABEL,
  formatError,
} from "./shared/copy";
import { buildHash, normalizeHash, parseHash, type RouteTab } from "./shared/deeplink";
import { hasOpenModal } from "./shared/modalStack";
import { RISK_APPROVAL_TIMEOUT_MS } from "./shared/approval";
import type { TaskStatus } from "./shared/types";
import {
  KernelUiError,
  blockedReasonText,
  eventSummary,
  eventTone,
  eventTypeLabel,
  failureKindText,
  filterTaskList,
  formatRelative,
  kernelConfirmCopy,
  kernelErrorText,
  statusCounts,
  taskActionState,
  taskAttemptRatioText,
  unwrapKernel,
} from "./shared/kernelUi";
import DockShell, { type DockHandle } from "./shell/dock/DockShell";
import {
  PanelHostProvider,
  type PanelRender,
} from "./shell/panel/PanelHost";
import { buildPanelDeps } from "./shell/panel/panelDeps";
import {
  PANEL_DEFS,
  routeTabFromPanel,
  type PanelKey,
} from "./shell/dock/panelRegistry";
import {
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  commitSidebarWidth,
  displayedSidebarWidth,
  resizeSidebarWidth,
  shouldAutoCollapseSidebar,
  sidebarMaxWidth,
  sidebarWidthStateForWindow,
} from "./shell/dock/narrowWindow";
import PrimaryRail, { usePrimaryRailFocus } from "./shell/PrimaryRail";
import SeparatorControl from "./shell/SeparatorControl";
import SkipLink from "./shell/SkipLink";
import { clampTaskListWidth, taskListMaxWidth } from "./shell/taskListWidth";
import { railKeyForActive, type PrimaryRailKey } from "./shell/primaryRailData";

type Tab = RouteTab;

const loadSettingsPanel = () => import("./SettingsView");
const loadTeamPanel = () => import("./TeamDashboard");
const loadMemoryPanel = () => import("./shell/MemoryWorkbench");
const loadPollPanel = () => import("./shell/PollPanel");
const loadGitGraphPanel = () => import("./git/ui/GitGraphPanel");
const loadMergeQueuePanel = () =>
  import("./git/ui/MergeQueuePanel").then((module) => ({ default: module.MergeQueuePanel }));
const loadPlanDraftPanel = () => import("./shell/PlanDraftPanel");

/** 侧栏「面板」启动器：设置独立为弹窗，不在此列。 */
export const PANEL_LAUNCHER_KEYS: PanelKey[] = [
  "chat",
  "tasks",
  "planDraft",
  "gitGraph",
  "mergeQueue",
  "team",
  "runs",
  "mailbox",
  "board",
  "polls",
  "watchdog",
  "context",
];

export const PANEL_LAUNCHER_GROUPS: Array<{ label: string; keys: PanelKey[] }> = [
  { label: "主面板", keys: ["chat", "tasks", "team", "mailbox", "board"] },
  { label: "辅助面板", keys: ["context", "polls", "watchdog", "runs"] },
  { label: "工作流", keys: ["planDraft", "gitGraph", "mergeQueue"] },
];

export function filterPanelLauncherKeys(search: string): PanelKey[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return PANEL_LAUNCHER_KEYS;
  return PANEL_LAUNCHER_KEYS.filter(
    (key) =>
      PANEL_DEFS[key].title.toLowerCase().includes(needle) ||
      key.toLowerCase().includes(needle),
  );
}

// C10：Router 页并入对话（概述）与任务（规划），导航 7→6。
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "tasks", label: "任务", hint: "查看任务、规划目标、运行与回看 trace" },
  { id: "team", label: "团队", hint: "查看总进度、成员与任务星图" },
  { id: "chat", label: "对话", hint: "与 Router 讨论、查看上下文与工作区概述" },
  { id: "mailbox", label: "邮箱", hint: "查看团队内部消息" },
  { id: "board", label: "记忆", hint: "黑板、备忘录、检索与归档审批" },
  { id: "settings", label: "设置", hint: "配置模型与运行参数" },
];

const REFRESH_DOMAIN_LABEL: Record<RefreshDomain, string> = {
  snapshot: "任务/成员/邮箱/记忆",
  scheduler: "调度",
  watchdog: "看门狗/预算",
  mergeQueue: "合并队列",
  runs: "运行记录",
  trace: "执行轨迹",
};

type TaskStatusFilter = "all" | TaskStatus;

const chatLiveStore = new ChatLiveStore();

const CHAT_TRAJECTORY_KIND_LABEL: Record<ChatTrajectoryEntry["kind"], string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
  reasoning: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  context: "上下文",
};

const TOOL_LABELS: Record<string, string> = {
  "fs.list": "列出文件",
  "fs.read": "读取文件",
  "fs.write": "写入文件",
  "fs.search": "搜索文件",
  "shell.run": "执行命令",
  "git.status": "查看 Git 状态",
  "git.diff": "查看 Git 差异",
  "task.list": "列出任务",
  "task.get": "查看任务",
  "task.complete": "完成任务",
  "mailbox.list": "列出消息",
  "mailbox.read": "读取消息",
  "mailbox.send": "发送消息",
  "board.list": "查看黑板",
  "board.post": "发布黑板",
  "memo.search": "搜索备忘录",
  "memo.write": "写入备忘录",
  "memory.search": "检索记忆",
  "memory.context": "读取记忆上下文",
  "memory.board.list": "查看记忆黑板",
  "memory.board.post": "发布记忆",
  "memory.memo.write": "写入记忆备忘录",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/**
 * t175：重试只更新 composer，不发送。空输入填入；已有不同内容不覆盖；
 * 相同内容只聚焦。返回 null 表示空重试文本，不做操作。
 */
export function retryComposerState(
  currentInput: string,
  retryText: string,
): { value: string; message: string } | null {
  const text = retryText.trim();
  if (!text) return null;
  const current = currentInput.trim();
  if (!current) return { value: text, message: "已填入输入框，确认后发送" };
  if (current === text) return { value: currentInput, message: "输入框已是该内容，确认后发送" };
  return { value: currentInput, message: "输入框已有内容，请确认后替换" };
}


/** t69：需要二次确认的内核操作（重试/取消/暂停/评审拒绝等有副作用的动作）。 */
type ConfirmIntent =
  | { kind: "retry"; task: Task }
  | { kind: "cancelTask"; task: Task }
  | { kind: "cancelRun"; run: Run; taskTitle: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "review"; task: Task; decision: "approve" | "reject" };

function time(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function errorText(error: unknown): string {
  return formatError(error);
}

/** t237：显式空串表示“清空目标”，不能回退到 composer/最近消息。 */
export function resolvePlanGoal(
  goalOverride: string | undefined,
  composer: string,
  lastUser: string | null,
): string {
  if (goalOverride !== undefined) return goalOverride.trim();
  return composer.trim() || lastUser?.trim() || "";
}

/** t235：Tasks 的自动打开意图只映射到新建任务或 Plan Draft，不再映射旧 Modal。 */
export function tasksAutoOpenAction(
  autoOpen: "task" | "plan" | null,
): "compose" | "planDraft" | null {
  if (autoOpen === "task") return "compose";
  if (autoOpen === "plan") return "planDraft";
  return null;
}

export type WorkflowStageNavigation = {
  panel: "chat" | "tasks" | "board" | "merge" | "planDraft";
  taskId?: string;
  review?: boolean;
};

/** P0-3/P0-4：阶段 CTA 的目标仅由阶段/task 决定；plan 统一进 Plan Draft。 */
export function workflowStageNavigation(
  stage: WorkflowStage,
  taskId: string | null,
): WorkflowStageNavigation {
  if (stage === "discuss") return { panel: "chat" };
  if (stage === "plan") return { panel: "planDraft" };
  if (stage === "deliver") return { panel: "merge" };
  if (stage === "remember") return { panel: "board" };
  if (stage === "review") {
    return { panel: "tasks", ...(taskId ? { taskId } : {}), review: true };
  }
  return { panel: "tasks", ...(taskId ? { taskId } : {}) };
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** t103：只滚动最近的滚动容器，避免 scrollIntoView 把整个窗口带偏。 */
function scrollWithin(container: HTMLElement, target: HTMLElement) {
  const delta =
    target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += delta;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // C12：初始 tab 来自 hash 深链（旧 #/router 由 parseHash 重定向到 tasks）。
  const [initialRoute] = useState(() => {
    const originalHash = window.location.hash;
    const normalizedHash = normalizeHash(originalHash);
    if (normalizedHash !== originalHash) {
      window.history.replaceState(null, "", normalizedHash);
    }
    const route = parseHash(normalizedHash);
    return /^#\/merge(?:\?|$)/.test(normalizedHash)
      ? { ...route, tab: "tasks" as const, mergeQueue: true }
      : route;
  });
  // t52 集成修复 IF-01：冷启动（无显式深链）默认激活「对话」主面板，满足验收
  // 「对话与团队默认同时可见」与设计 §4 activePanel=chat；显式深链（#/tasks 等）
  // 仍优先。deeplink 模块与其默认路由契约不变（tests 不受影响）。
  // t69：带 r=<runId> 的深链优先打开 Run 面板（Run 面板挂在 tasks 路由下）。
  const [bootPanel] = useState<PanelKey | null>(() =>
    initialRoute.run
      ? "runs"
      : initialRoute.gitGraph
        ? "gitGraph"
        : initialRoute.mergeQueue
          ? "mergeQueue"
          : window.location.hash.startsWith("#/") && initialRoute.tab !== "settings"
            ? initialRoute.tab
            : null,
  );
  const [tab, setTab] = useState<Tab>(() => {
    if (initialRoute.tab === "settings") return "settings";
    if (initialRoute.run || initialRoute.gitGraph || initialRoute.mergeQueue) return "tasks";
    if (!bootPanel) return "chat";
    return bootPanel === "runs" ? "tasks" : (bootPanel as Tab);
  });
  const [settingsOpen, setSettingsOpen] = useState(
    () => initialRoute.tab === "settings",
  );
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsReturnTab, setSettingsReturnTab] = useState<Tab>(() =>
    initialRoute.tab === "settings" ? "chat" : initialRoute.tab,
  );
  // t103：Git 入口——合并队列 Modal、设置 Modal 内 Git 区聚焦、任务详情 VCS 区聚焦。
  const [mergeQueueOpen, setMergeQueueOpen] = useState(false);
  const [gitSettingsFocus, setGitSettingsFocus] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection | undefined>(
    undefined,
  );
  const [taskVcsFocus, setTaskVcsFocus] = useState(false);
  const [taskReviewFocus, setTaskReviewFocus] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskWorkspaceSource, setTaskWorkspaceSource] = useState<TaskWorkspaceSource>("tasks");
  const [trace, setTrace] = useState<EventRecord[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // P0-4：Plan Draft 仅 session 内存；确认前不创建任务/事件。
  const [planSource, setPlanSource] = useState<PlanSource | null>(null);
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [planIssues, setPlanIssues] = useState<PlanIssue[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planConfirming, setPlanConfirming] = useState(false);
  const planConfirmKeyRef = useRef("");
  const planPreviewGateRef = useRef(new PlanPreviewGate());
  const [chatBusy, setChatBusy] = useState(false);
  const [chatContextBusy, setChatContextBusy] = useState(false);
  const [chatTurns, setChatTurns] = useState<ChatTurnHistoryPage | null>(null);
  const [chatTurnsLoading, setChatTurnsLoading] = useState(false);
  const [chatTurnsError, setChatTurnsError] = useState<string | null>(null);
  const [translationRevision, setTranslationRevision] = useState(0);
  const chatComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const historyTranslationMemo = useMemo(
    () => createChatTranslationMemo((text) => window.deer.translateText(text)),
    [],
  );
  const chatTurnsRequestRef = useRef(0);
  const chatTurnsToastRef = useRef(false);
  const translationSettingsKeyRef = useRef<string | null>(null);
  const chatTurnsByAssistant = useMemo(
    () =>
      new Map<string, ChatAssistantTurn>(
        chatTurns?.turns.flatMap((turn) =>
          turn.assistants.map((assistant) => [assistant.messageId, assistant] as const),
        ) ?? [],
      ),
    [chatTurns],
  );
  const chatTurnByUser = useMemo(
    () =>
      new Map(
        chatTurns?.turns
          .filter((turn) => turn.userMessage)
          .map((turn) => [turn.userMessage!.id, turn] as const) ?? [],
      ),
    [chatTurns],
  );
  const [chatView, setChatView] = useState<"chat" | "trajectory">("chat");
  const [chatTrajectory, setChatTrajectory] = useState<ChatTrajectoryEntry[]>([]);
  const [chatTrajectoryLoading, setChatTrajectoryLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [contextTaskId, setContextTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRetry, setErrorRetry] = useState<{
    message: string;
    label: string;
    run: () => void;
  } | null>(null);
  const [firstRunCollapsed, setFirstRunCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("deer.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 250;
  });
  // t212：displayed 是窄窗拖拽的会话内显示值；不写入 preferred/localStorage，
  // 回到宽窗必须恢复 preferred（类似浏览器「临时缩放」与「默认值」分离）。
  const [sidebarDisplayWidth, setSidebarDisplayWidth] = useState<number | null>(null);
  // t194 P0-1：viewport 宽度同时驱动 Dock single 判定、侧栏自动折叠与可读宽度钳制。
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const viewportWidthRef = useRef(viewportWidth);
  // C06：任务列表状态过滤提升到 App，供顶栏失败计数一键跳转。
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatusFilter>("all");
  // C14：跨页返回来源（从哪个 tab 进入任务会话）。
  const [contextSource, setContextSource] = useState<"tasks" | "team" | null>(null);
  // C14：星图定位请求（nonce 允许对同一任务重复定位）。
  const [starmapFocus, setStarmapFocus] = useState<{ taskId: string; nonce: number } | null>(
    null,
  );
  // C11：命令面板与「＋新建」菜单。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [panelSearch, setPanelSearch] = useState("");
  const [openPanelKeys, setOpenPanelKeys] = useState<PanelKey[]>([]);
  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  const [recommendedMembers, setRecommendedMembers] = useState<MemberCandidate[] | null>(null);
  const [memberEditTarget, setMemberEditTarget] = useState<string | null>(null);
  // t136：从任务/黑板发起 Poll 时带入来源并自动打开创建弹窗。
  const [pollIntent, setPollIntent] = useState<{
    title: string;
    sourceId: string;
    scope: "task" | "board";
    scopeId: string;
  } | null>(null);
  // C12：邮箱 / 黑板选中项提升到 App，进入 hash 深链。
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  // t356：read state 是 UI-only（localStorage），不新增数据源/DB 字段。
  const [mailboxReadIds, setMailboxReadIds] = useState<Set<string>>(() => new Set());
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  // t69：调度与 Run 可观测状态（调度器快照 + 当前任务 Run 历史）。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerSnapshot | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(true);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [taskRuns, setTaskRuns] = useState<Run[]>([]);
  const mergeQueueRefreshKey =
    snapshot?.tasks.map((task) => `${task.id}:${task.status}`).join("|") ?? "";
  const {
    items: mergeQueueItems,
    reload: loadMergeQueue,
    stale: mergeQueueStale,
    error: mergeQueueError,
    loading: mergeQueueLoading,
  } = useMergeQueue(
    snapshot?.workspace.id,
    mergeQueueOpen,
    mergeQueueRefreshKey,
  );
  // t157：watchdog/预算/交接 UI 数据（面板、顶部预算条、任务告警、RunHistory）。
  const [watchdogSnapshot, setWatchdogSnapshot] = useState<WatchdogSnapshot | null>(null);
  const [watchdogCosts, setWatchdogCosts] = useState<CostSnapshot | null>(null);
  const [watchdogHandoffs, setWatchdogHandoffs] = useState<Record<string, RunHandoff>>({});
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmIntent | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [kernelAnnouncement, setKernelAnnouncement] = useState<string | null>(null);
  const [activePanelKey, setActivePanelKey] = useState<PanelKey | null>(bootPanel);
  useEffect(() => {
    if (activePanelKey === "mergeQueue") setMergeQueueOpen(true);
  }, [activePanelKey]);
  const schedulerRequestRef = useRef(0);
  const runsRequestRef = useRef(0);
  // DESIGN §15.4：满血模式（会话级，不持久化、不随启动恢复）。
  const [chatFullThrottle, setChatFullThrottle] = useState(false);
  // t58 IF-05：auto_risk 高风险人类审批队列（内存态；刷新即失，主进程超时兜底）。
  // 多个高风险调用并发时按 FIFO 依次弹窗，避免后到请求覆盖先到请求导致误超时。
  const [riskApprovals, setRiskApprovals] = useState<RiskApprovalRequest[]>([]);
  const riskApproval = riskApprovals[0] ?? null;
  // t64：交互画布/提问表单状态（问题状态以主进程 chat_questions 为唯一事实源）。
  const [chatQuestions, setChatQuestions] = useState<ChatQuestionRecord[]>([]);
  const [questionsLoaded, setQuestionsLoaded] = useState(false);
  const [questionModalId, setQuestionModalId] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionValues>>({});
  const [deferredQuestionIds, setDeferredQuestionIds] = useState<string[]>([]);
  const [submittingQuestion, setSubmittingQuestion] = useState(false);
  const autoOpenedQuestionIdsRef = useRef<Set<string>>(new Set());
  const knownPendingQuestionIdsRef = useRef<Set<string>>(new Set());
  const questionsFirstLoadRef = useRef(true);
  // C26：全局 toast 反馈。
  const { toasts, pushToast: pushRawToast, dismissToast } = useToasts();
  const pushToast = useCallback(
    (toast: { kind: "success" | "error" | "info"; message: string; detail?: string; action?: { label: string; onClick: () => void } }) => {
      pushRawToast({
        ...toast,
        message: formatError(toast.message),
        ...(toast.detail ? { detail: formatError(toast.detail) } : {}),
      });
    },
    [pushRawToast],
  );
  // t50：Dock 布局（对话/团队双主面板）。
  const dockRef = useRef<DockHandle | null>(null);
  const dockHostRef = useRef<HTMLDivElement | null>(null);
  // R2：Dock 不再接收 renderPanel 闭包；只通过稳定 ref 读取最新面板内容。
  const panelRenderRef = useRef<PanelRender>(() => null);
  const [dockWidth, setDockWidth] = useState(() =>
    Math.max(320, window.innerWidth - 300),
  );
  const [refreshStale, setRefreshStale] = useState(false);
  const [staleDomains, setStaleDomains] = useState<ReadonlySet<RefreshDomain>>(
    () => new Set(),
  );
  const snapshotRef = useRef<Snapshot | null>(null);
  const selectedTaskRef = useRef<string | null>(null);
  const refreshCoordinatorRef = useRef<RefreshCoordinator | null>(null);
  const refreshTokenRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const refreshLastSeqRef = useRef(0);
  const handoffFetchedRef = useRef<Set<string>>(new Set());
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarDisplayWidthRef = useRef<number | null>(sidebarDisplayWidth);
  const resizingRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      localStorage.getItem("deer.sidebarCollapsed") === "1" ||
      window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH,
  );
  const prevViewportWidthRef = useRef<number | null>(null);

  // t64：问题队列派生值（按 created_at 升序；同一时间只显示一个 Modal）。
  const questionsByKey = useMemo(() => {
    const map = new Map<string, ChatQuestionRecord>();
    for (const question of chatQuestions) map.set(question.id, question);
    return map;
  }, [chatQuestions]);
  const pendingQuestions = useMemo(
    () =>
      chatQuestions
        .filter((question) => question.status === "pending")
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    [chatQuestions],
  );
  const activeQuestion = useMemo(
    () => (questionModalId ? chatQuestions.find((item) => item.id === questionModalId) ?? null : null),
    [chatQuestions, questionModalId],
  );

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // t50：openPanel 是所有导航的唯一入口（侧栏/Alt+N/命令面板/hash/C14 都走这里）。
  const openPanel = useCallback(
    (key: PanelKey) => {
      if (key === "settings") {
        if (tab !== "settings") setSettingsReturnTab(tab);
        setSettingsOpen(true);
        setTab("settings");
        return;
      }
      if (settingsOpen && settingsDirty && !window.confirm("设置尚未保存，确定离开吗？")) {
        return;
      }
      setSettingsDirty(false);
      setSettingsOpen(false);
      setGitSettingsFocus(false);
      setSettingsInitialSection(undefined);
      if (key !== "tasks") setTaskVcsFocus(false);
      if (key !== "tasks") setTaskReviewFocus(false);
      setPanelMenuOpen(false);
      const route = routeTabFromPanel(key);
      if (route) setTab(route);
      setActivePanelKey(key);
      if (key === "mergeQueue") {
        setMergeQueueOpen(true);
        void loadMergeQueue();
      }
      dockRef.current?.openPanel(key);
    },
    [loadMergeQueue, settingsDirty, settingsOpen, tab],
  );

  function focusPanelNow(key: PrimaryRailKey): boolean {
    if (activePanelKey !== key) return false;
    const panel = document.querySelector<HTMLElement>(
      `.dock-panel-body[data-panel="${key}"]`,
    );
    if (!panel || panel.closest("[inert]")) return false;
    if (panel.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(panel);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (key === "chat") {
      const composer =
        panel.querySelector<HTMLElement>('textarea:not([disabled]), [contenteditable="true"]') ??
        panel.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
      if (composer) {
        composer.focus({ preventScroll: true });
        return (
          composer === document.activeElement ||
          composer.contains(document.activeElement)
        );
      }
      return false;
    }
    // 面板容器（tabIndex=-1）比首个按钮稳定：事件刷新/面板重渲染不会替换容器，
    // 键盘下一次 Tab 仍会进入面板首个控件。
    panel.focus({ preventScroll: true });
    return panel === document.activeElement;
  }

  const { requestFocus: requestRailFocus } = usePrimaryRailFocus(
    activePanelKey,
    focusPanelNow,
  );

  const openPrimaryPanel = useCallback(
    (key: PrimaryRailKey) => {
      // 复用唯一面板入口：面板已关闭时 DockShell 会 ensurePanel 重开。
      openPanel(key);
      // generation/timer 由 hook 管理：旧请求在 pointerdown/keydown/active 变化时失效。
      requestRailFocus(key);
    },
    [openPanel, requestRailFocus],
  );

  function togglePanelMenu() {
    if (!panelMenuOpen) {
      setOpenPanelKeys(dockRef.current?.getOpenPanelKeys() ?? []);
      setPanelSearch("");
    }
    setCreateMenuOpen(false);
    setPanelMenuOpen((open) => !open);
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsDirty(false);
    setGitSettingsFocus(false);
    setSettingsInitialSection(undefined);
    // t172：设置页可能修改了翻译源/目标；关闭时清空会话翻译缓存。
    historyTranslationMemo.clear();
    translationSettingsKeyRef.current = null;
    const back = settingsReturnTab === "settings" ? "chat" : settingsReturnTab;
    setTab(back);
    dockRef.current?.openPanel(back);
  }

  // t50：dock 激活面板 → 派生路由 tab（context 面板不改变 hash；runs 与 tasks 同路由）。
  const handleDockActivePanel = useCallback((key: PanelKey) => {
    setActivePanelKey(key);
    const route = routeTabFromPanel(key);
    if (route) setTab((current) => (current === route ? current : route));
  }, []);

  // t50：dock 宽度测量（变体 wide/medium/narrow/single 的判定依据）。
  useEffect(() => {
    const el = dockHostRef.current;
    if (!el) return;
    const update = () => setDockWidth(Math.round(el.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [snapshot]);

  useEffect(() => {
    selectedTaskRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    sidebarDisplayWidthRef.current = sidebarDisplayWidth;
  }, [sidebarDisplayWidth]);

  // C12：状态 → hash。tab 变更换历史记录（可前进/后退），选中变化原地替换。
  const appliedInitialRouteRef = useRef(false);
  const lastWrittenHashRef = useRef<string>(window.location.hash);
  const lastTabRef = useRef<Tab>(tab);
  useEffect(() => {
    if (!appliedInitialRouteRef.current) return; // 初始深链未应用前不改写 URL
    const hash = buildHash(tab, {
      task: selectedTaskId,
      chatTask: contextTaskId,
      message: selectedMessageId,
      board: selectedBoard,
      // t69：只在 Run 面板激活时写 r，避免任务页内联 Run 历史污染深链。
      run: activePanelKey === "runs" ? selectedRunId : null,
      mergeQueue: mergeQueueOpen,
      gitSettings: gitSettingsFocus,
      taskVcs: taskVcsFocus && Boolean(selectedTaskId),
      taskReview: taskReviewFocus && Boolean(selectedTaskId),
    });
    if (window.location.hash === hash) return;
    lastWrittenHashRef.current = hash;
    if (lastTabRef.current !== tab) {
      lastTabRef.current = tab;
      window.location.hash = hash; // 产生 history 条目
    } else {
      history.replaceState(null, "", hash);
    }
  }, [
    tab,
    selectedTaskId,
    contextTaskId,
    selectedMessageId,
    selectedBoard,
    selectedRunId,
    activePanelKey,
    mergeQueueOpen,
    gitSettingsFocus,
    taskVcsFocus,
    taskReviewFocus,
  ]);

  // t103：深链/命令 → 滚动并聚焦设置 Git 区或任务 VCS 区。
  useEffect(() => {
    if (!gitSettingsFocus || !settingsOpen) return;
    const timer = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>("#settings-git");
      if (!target) return;
      const modal = target.closest<HTMLElement>(".settings-modal");
      if (modal) scrollWithin(modal, target);
      else target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [gitSettingsFocus, settingsOpen]);

  useEffect(() => {
    if (!taskVcsFocus || !selectedTaskId) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById("task-git-section");
      if (!target) return;
      const panel = target.closest<HTMLElement>(".task-detail-panel");
      if (panel) scrollWithin(panel, target);
      else target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [taskVcsFocus, selectedTaskId]);

  useEffect(() => {
    if (!taskReviewFocus || !selectedTaskId) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById("task-review-section");
      if (!target) return;
      const panel = target.closest<HTMLElement>(".task-detail-panel");
      if (panel) scrollWithin(panel, target);
      else target.scrollIntoView({ block: "start" });
      const focusTarget = target.querySelector<HTMLElement>("button, textarea, select");
      focusTarget?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [taskReviewFocus, selectedTaskId]);

  // C09 + t194：窄窗自动折叠侧栏；Ctrl/⌘+B 手动切换。
  // 只在「宽→窄」边沿自动折叠，窄窗内手动展开后继续 resize 不覆盖用户选择。
  // t212：离开窄窗时清掉 display override，恢复 preferred。
  useEffect(() => {
    viewportWidthRef.current = viewportWidth;
    const next = sidebarWidthStateForWindow(
      {
        preferred: sidebarWidthRef.current,
        displayed: sidebarDisplayWidthRef.current,
      },
      viewportWidth,
    );
    if (next.displayed !== sidebarDisplayWidthRef.current) {
      sidebarDisplayWidthRef.current = next.displayed;
      setSidebarDisplayWidth(next.displayed);
    }
  }, [viewportWidth]);

  useEffect(() => {
    function onResize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const prev = prevViewportWidthRef.current;
    prevViewportWidthRef.current = viewportWidth;
    if (!shouldAutoCollapseSidebar(prev, viewportWidth)) return;
    setSidebarCollapsed(true);
    localStorage.setItem("deer.sidebarCollapsed", "1");
  }, [viewportWidth]);

  // C09/C11：全局快捷键——Ctrl/⌘+B 折叠侧栏、Ctrl/⌘+K 命令面板、Alt+1–6 切换页面。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // t190：Modal（含风险审批/队列）打开时全局快捷键不穿透。
      if (hasOpenModal()) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => {
          const next = !collapsed;
          localStorage.setItem("deer.sidebarCollapsed", next ? "1" : "0");
          return next;
        });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        const target = TABS[Number(event.key) - 1];
        if (target) openPanel(target.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem("deer.sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!resizingRef.current) return;
      // t194/t212：窄窗拖拽只改 displayed（不写 preferred/localStorage）；
      // 宽窗拖拽改 preferred。宽度预算含 6px sidebar resizer。
      const next = resizeSidebarWidth(
        {
          preferred: sidebarWidthRef.current,
          displayed: sidebarDisplayWidthRef.current,
        },
        viewportWidthRef.current,
        event.clientX,
      );
      sidebarWidthRef.current = next.preferred;
      sidebarDisplayWidthRef.current = next.displayed;
      setSidebarWidth(next.preferred);
      setSidebarDisplayWidth(next.displayed);
    }
    function onUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const committed = commitSidebarWidth(
        {
          preferred: sidebarWidthRef.current,
          displayed: sidebarDisplayWidthRef.current,
        },
        viewportWidthRef.current,
      );
      sidebarDisplayWidthRef.current = committed.displayed;
      setSidebarDisplayWidth(committed.displayed);
      if (committed.persist) {
        localStorage.setItem("deer.sidebarWidth", String(committed.preferred));
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function startResize(event: { preventDefault: () => void }) {
    event.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function resetSidebarWidth() {
    // 显式重置是唯一允许在窄窗写 preferred 的路径。
    sidebarWidthRef.current = SIDEBAR_DEFAULT_WIDTH;
    sidebarDisplayWidthRef.current = null;
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    setSidebarDisplayWidth(null);
    localStorage.setItem("deer.sidebarWidth", String(SIDEBAR_DEFAULT_WIDTH));
  }

  function stepSidebarWidth(delta: number) {
    const state = {
      preferred: sidebarWidthRef.current,
      displayed: sidebarDisplayWidthRef.current,
    };
    const current = displayedSidebarWidth(state, viewportWidthRef.current);
    const next = resizeSidebarWidth(
      state,
      viewportWidthRef.current,
      current + delta,
    );
    sidebarWidthRef.current = next.preferred;
    sidebarDisplayWidthRef.current = next.displayed;
    setSidebarWidth(next.preferred);
    setSidebarDisplayWidth(next.displayed);
    if (viewportWidthRef.current > 1100) {
      localStorage.setItem("deer.sidebarWidth", String(next.preferred));
    }
  }

  const loadTrace = useCallback(
    async (
      taskId: string,
      options: { strict?: boolean; guard?: () => boolean } = {},
    ) => {
      try {
        const next = await window.deer.getTaskTrace(taskId);
        if (options.guard && !options.guard()) return;
        setTrace(next);
      } catch (error) {
        if (options.guard && !options.guard()) return;
        setError(errorText(error));
        if (options.strict) throw error;
      }
    },
    [],
  );

  /** t69/R3：调度器快照；silent 用于事件批次刷新，避免出现骨架闪烁。 */
  const loadScheduler = useCallback(
    async (
      workspaceId: string,
      silent = false,
      options: { strict?: boolean; guard?: () => boolean } = {},
    ) => {
      const requestId = ++schedulerRequestRef.current;
      if (!silent) setSchedulerLoading(true);
      try {
        const result = await window.deer.getScheduler(workspaceId);
        if (options.guard && !options.guard()) return;
        if (schedulerRequestRef.current !== requestId) return;
        if (result.ok) {
          setScheduler(result.value);
          setSchedulerError(null);
        } else {
          const message = kernelErrorText(result.error);
          setSchedulerError(message);
          if (options.strict) throw new Error(message);
        }
      } catch (error) {
        if (options.guard && !options.guard()) return;
        if (schedulerRequestRef.current === requestId) {
          setSchedulerError(errorText(error));
        }
        if (options.strict) throw error;
      } finally {
        if (schedulerRequestRef.current === requestId) setSchedulerLoading(false);
      }
    },
    [],
  );

  /** t69：当前任务的 Run 历史；silent 同上。 */
  const loadRuns = useCallback(
    async (
      taskId: string,
      silent = false,
      options: { strict?: boolean; guard?: () => boolean } = {},
    ) => {
      const requestId = ++runsRequestRef.current;
      if (!silent) {
        setRunsLoading(true);
        setTaskRuns([]);
      }
      try {
        const result = await window.deer.listRuns(taskId);
        if (options.guard && !options.guard()) return;
        if (runsRequestRef.current !== requestId) return;
        if (result.ok) {
          setTaskRuns(result.value);
          setRunsError(null);
        } else {
          const message = kernelErrorText(result.error);
          if (options.strict) {
            setRunsError(message);
            throw new Error(message);
          }
          setTaskRuns([]);
          setRunsError(message);
        }
      } catch (error) {
        if (options.guard && !options.guard()) return;
        if (runsRequestRef.current === requestId) {
          setRunsError(errorText(error));
        }
        if (options.strict) throw error;
      } finally {
        if (runsRequestRef.current === requestId) setRunsLoading(false);
      }
    },
    [],
  );

  const loadChat = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return;
    const router = current.agents.find((agent) => agent.isRouter);
    if (!router) return;
    const requestId = ++chatTurnsRequestRef.current;
    const turnsPromise = window.deer
      .getChatTurns(current.workspace.id, router.id, { limit: 20 })
      .catch((error) => {
        if (!chatTurnsToastRef.current) {
          chatTurnsToastRef.current = true;
          pushToast({
            kind: "error",
            message: `历史执行过程加载失败：${formatError(error)}`,
          });
        }
        return null;
      });
    const [messages, contextSnapshot, turns] = await Promise.all([
      window.deer.listChat(current.workspace.id, router.id),
      window.deer.getContext(
        current.workspace.id,
        contextTaskId ? undefined : router.id,
        contextTaskId ?? undefined,
      ),
      turnsPromise,
    ]);
    setChatMessages(messages);
    setContext(contextSnapshot);
    if (requestId === chatTurnsRequestRef.current) {
      setChatTurns(turns);
      setChatTurnsError(null);
      setChatTurnsLoading(false);
      if (turns) chatTurnsToastRef.current = false;
    }
    // t64 §4.9：问题状态单独加载；失败不阻断消息渲染（画布/文本仍可用）。
    try {
      const questions = await window.deer.listChatQuestions(current.workspace.id, router.id);
      setChatQuestions(questions);
      setQuestionsLoaded(true);
    } catch (error) {
      setQuestionsLoaded(true);
      pushToast({
        kind: "error",
        message: `问题状态加载失败：${formatError(error)}`,
      });
    }
  }, [contextTaskId, pushToast]);

  const loadEarlierChatTurns = useCallback(async (): Promise<boolean> => {
    const current = snapshotRef.current;
    const page = chatTurns;
    if (!current || !page?.hasMore || !page.nextBefore || chatTurnsLoading) return false;
    const router = current.agents.find((agent) => agent.isRouter);
    if (!router) return false;
    setChatTurnsLoading(true);
    setChatTurnsError(null);
    try {
      const earlier = await window.deer.getChatTurns(current.workspace.id, router.id, {
        limit: 20,
        before: page.nextBefore,
      });
      setChatTurns((previous) => {
        if (!previous) return earlier;
        const seen = new Set(previous.turns.map((turn) => turn.turnId));
        const merged = [
          ...earlier.turns.filter((turn) => !seen.has(turn.turnId)),
          ...previous.turns,
        ];
        return {
          ...previous,
          turns: merged,
          hasMore: earlier.hasMore,
          nextBefore: earlier.nextBefore,
          truncated: previous.truncated || earlier.truncated,
          generatedAt: earlier.generatedAt,
        };
      });
      return true;
    } catch (error) {
      setChatTurnsError(errorText(error));
      return false;
    } finally {
      setChatTurnsLoading(false);
    }
  }, [chatTurns, chatTurnsLoading]);

  const loadChatTrajectory = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return;
    const router = current.agents.find((agent) => agent.isRouter);
    if (!router) return;
    setChatTrajectoryLoading(true);
    try {
      const entries = await window.deer.getChatTrajectory(current.workspace.id, router.id);
      setChatTrajectory(entries);
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: `轨迹加载失败：${formatError(error)}` });
    } finally {
      setChatTrajectoryLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (chatView !== "trajectory") return;
    void loadChatTrajectory();
  }, [chatView, snapshot?.workspace.id, loadChatTrajectory]);

  const loadWatchdog = useCallback(
    async (
      workspaceId: string,
      options: { strict?: boolean; guard?: () => boolean } = {},
    ) => {
      try {
        const [snapshotResult, costsResult] = await Promise.all([
          window.deer.getWatchdogSnapshot(workspaceId),
          window.deer.getWatchdogCosts(workspaceId),
        ]);
        if (options.guard && !options.guard()) return;
        if (snapshotResult.ok) setWatchdogSnapshot(snapshotResult.value);
        if (costsResult.ok) setWatchdogCosts(costsResult.value);
        if (options.strict) {
          if (!snapshotResult.ok) throw new Error(snapshotResult.error.message);
          if (!costsResult.ok) throw new Error(costsResult.error.message);
        }
      } catch (error) {
        if (options.guard && !options.guard()) return;
        if (options.strict) throw error;
        // 非事件路径（首屏/手动）保留 last-good，不把 watchdog 错误扩散到主界面。
      }
    },
    [],
  );

  /** R3：只读取本次事件涉及的域；带 App token，旧响应不得覆盖新数据。 */
  const refreshDomains = useCallback(
    async (
      workspaceId: string,
      domains: ReadonlySet<RefreshDomain>,
      token: number,
    ) => {
      const isCurrent = () =>
        token === refreshTokenRef.current &&
        snapshotRef.current?.workspace.id === workspaceId;

      if (domains.has("snapshot")) {
        try {
          const next = await window.deer.getSnapshot(workspaceId);
          if (!isCurrent()) return;
          setSnapshot(next);
        } catch (error) {
          if (!isCurrent()) return;
          throw error;
        }
      }

      const jobs: Promise<void>[] = [];
      if (domains.has("scheduler")) {
        jobs.push(loadScheduler(workspaceId, true, { strict: true, guard: isCurrent }));
      }
      if (domains.has("watchdog")) {
        jobs.push(loadWatchdog(workspaceId, { strict: true, guard: isCurrent }));
      }
      if (domains.has("mergeQueue")) {
        jobs.push(loadMergeQueue({ strict: true, guard: isCurrent }));
      }
      if ((domains.has("runs") || domains.has("trace")) && selectedTaskRef.current) {
        const taskId = selectedTaskRef.current;
        jobs.push(loadTrace(taskId, { strict: true, guard: isCurrent }));
        jobs.push(loadRuns(taskId, true, { strict: true, guard: isCurrent }));
      }
      await Promise.all(jobs);
    },
    [loadTrace, loadScheduler, loadRuns, loadWatchdog, loadMergeQueue],
  );

  /**
   * 手动 full refresh：与 App token/stale 共享，但不推进 Coordinator 的 generation/lastSeq；
   * 成功后显式 markRecovered，允许后续 onEvent notify 继续 flush；失败 invalidateAll 进入 backoff。
   */
  const refresh = useCallback(
    async (workspaceId: string) => {
      const token = ++refreshTokenRef.current;
      try {
        await refreshDomains(workspaceId, ALL_REFRESH_DOMAINS, token);
        if (token === refreshTokenRef.current) {
          setRefreshStale(false);
          setStaleDomains(new Set());
          refreshCoordinatorRef.current?.markRecovered();
        }
      } catch (error) {
        if (token === refreshTokenRef.current) {
          setRefreshStale(true);
          setStaleDomains(new Set(ALL_REFRESH_DOMAINS));
          // 手动 full refresh 失败也进入事件协调器的 backoff，避免调用方反复手刷。
          refreshCoordinatorRef.current?.invalidateAll();
        }
        throw error;
      }
    },
    [refreshDomains],
  );

  const handleManualRefresh = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return;
    try {
      await refresh(current.workspace.id);
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: `刷新失败：${formatError(error)}` });
    }
  }, [refresh, pushToast]);

  const refreshWatchdog = useCallback(async () => {
    const workspaceId = snapshotRef.current?.workspace.id;
    if (workspaceId) await loadWatchdog(workspaceId);
  }, [loadWatchdog]);

  const holdReasonForAlert = useCallback(
    (alert: WatchdogAlert): WatchdogHoldReason => {
      const holds = watchdogSnapshot?.holds.filter((hold) => hold.taskId === alert.taskId) ?? [];
      if (holds.some((hold) => hold.reason === "escalation")) return "escalation";
      if (holds.some((hold) => hold.reason === "budget")) return "budget";
      return "watchdog";
    },
    [watchdogSnapshot],
  );

  const handleAckWatchdogAlert = useCallback(
    async (alert: WatchdogAlert) => {
      const workspaceId = snapshotRef.current?.workspace.id;
      if (!workspaceId) return;
      const result = await window.deer.ackWatchdogAlert(workspaceId, alert.id);
      if (!result.ok) pushToast({ kind: "error", message: result.error.message });
      await refreshWatchdog();
    },
    [pushToast, refreshWatchdog],
  );

  const handleResolveWatchdogAlert = useCallback(
    async (alert: WatchdogAlert) => {
      const workspaceId = snapshotRef.current?.workspace.id;
      if (!workspaceId) return;
      const result = await window.deer.resolveWatchdogAlert(workspaceId, alert.id);
      if (!result.ok) pushToast({ kind: "error", message: result.error.message });
      await refreshWatchdog();
    },
    [pushToast, refreshWatchdog],
  );

  const handleReleaseWatchdogHold = useCallback(
    async (alert: WatchdogAlert) => {
      const workspaceId = snapshotRef.current?.workspace.id;
      if (!workspaceId || !alert.taskId) return;
      const result = await window.deer.releaseWatchdogTaskHold(
        workspaceId,
        alert.taskId,
        holdReasonForAlert(alert),
      );
      if (!result.ok) {
        pushToast({ kind: "error", message: result.error.message });
        return;
      }
      pushToast({ kind: "success", message: "已释放当前暂停原因；其他 hold 仍保留。" });
      await refreshWatchdog();
      void loadRuns(alert.taskId);
    },
    [holdReasonForAlert, loadRuns, pushToast, refreshWatchdog],
  );

  // t69/R3：工作区切换/首屏就绪后加载调度与 watchdog；之后由事件域驱动，不做 15s 常驻轮询。
  useEffect(() => {
    if (!snapshot) return;
    void loadScheduler(snapshot.workspace.id);
    void loadWatchdog(snapshot.workspace.id);
  }, [snapshot?.workspace.id, loadScheduler, loadWatchdog]);

  // t157：RunHistory 的交接卡按需加载，避免触碰 Run 事件契约。
  useEffect(() => {
    const workspaceId = snapshotRef.current?.workspace.id;
    if (!workspaceId) return;
    for (const run of taskRuns) {
      if (handoffFetchedRef.current.has(run.id)) continue;
      handoffFetchedRef.current.add(run.id);
      void window.deer.getRunHandoff(workspaceId, run.id).then((result) => {
        if (result.ok && result.value) {
          setWatchdogHandoffs((previous) => ({ ...previous, [run.id]: result.value! }));
        }
      });
    }
  }, [taskRuns]);

  // t69：选中任务变化 → 拉取该任务的 Run 历史。
  useEffect(() => {
    if (!selectedTaskId) {
      setTaskRuns([]);
      setRunsError(null);
      setRunsLoading(false);
      return;
    }
    void loadRuns(selectedTaskId);
  }, [selectedTaskId, loadRuns]);

  // C12：初始深链——快照就绪后应用选中对象（任务/邮件/黑板）。
  useEffect(() => {
    if (!snapshot || appliedInitialRouteRef.current) return;
    appliedInitialRouteRef.current = true;
    if (initialRoute.task) {
      setSelectedTaskId(initialRoute.task);
      void loadTrace(initialRoute.task);
    }
    if (initialRoute.run) {
      setSelectedRunId(initialRoute.run);
      if (initialRoute.run && initialRoute.task) void loadRuns(initialRoute.task);
    }
    if (initialRoute.chatTask) {
      setContextTaskId(initialRoute.chatTask);
      setContextSource("tasks");
    }
    if (initialRoute.message) setSelectedMessageId(initialRoute.message);
    if (initialRoute.board) setSelectedBoard(initialRoute.board);
    // t103：Git 入口深链（合并队列 / 设置 Git 区 / 任务 VCS）。
    setMergeQueueOpen(initialRoute.mergeQueue);
    if (initialRoute.gitSettings) {
      setSettingsOpen(true);
      setTab("settings");
      setGitSettingsFocus(true);
    }
    setTaskVcsFocus(initialRoute.taskVcs);
    setTaskReviewFocus(initialRoute.taskReview);
  }, [snapshot, initialRoute, loadTrace, loadRuns]);

  // C12：浏览器前进/后退或外部 hash 变更 → 恢复视图（自己写入的 hash 跳过）。
  useEffect(() => {
    function onHashChange() {
      if (window.location.hash === lastWrittenHashRef.current) return;
      const previousHash = lastWrittenHashRef.current;
      lastWrittenHashRef.current = window.location.hash;
      if (isPlanDraftDirty(planSource, planDraft)) {
        if (!window.confirm(planDraftLeaveMessage("deep-link"))) {
          lastWrittenHashRef.current = previousHash;
          window.location.hash = previousHash;
          return;
        }
        clearPlanDraftSession();
      }
      const parsed = parseHash(window.location.hash);
      const route = /^#\/merge(?:\?|$)/.test(window.location.hash)
        ? { ...parsed, tab: "tasks" as const, mergeQueue: true }
        : parsed;
      lastTabRef.current = route.tab;
      if (route.gitGraph) {
        setTab("tasks");
        setActivePanelKey("gitGraph");
        dockRef.current?.openPanel("gitGraph");
        setSelectedTaskId(null);
        return;
      }
      if (route.tab === "settings") {
        setSettingsOpen(true);
        setTab("settings");
      } else {
        if (settingsOpen && settingsDirty && !window.confirm("设置尚未保存，确定离开吗？")) {
          return;
        }
        setSettingsDirty(false);
        setSettingsOpen(false);
        setSettingsInitialSection(undefined);
        setSettingsReturnTab(route.tab);
        setTab(route.tab);
        dockRef.current?.openPanel(route.tab);
      }
      if (route.task) {
        setTaskWorkspaceSource("tasks");
        setSelectedTaskId(route.task);
        void loadTrace(route.task);
      } else if (route.tab === "tasks" || route.tab === "team") {
        setSelectedTaskId(null);
      }
      // t69：r 参数 → 打开 Run 面板并选中 Run（刷新/后退可恢复）。
      // 非 tasks 路由的 r 不生效，避免 chat/team 深链残留 Run 选择。
      setSelectedRunId(route.tab === "tasks" ? route.run : null);
      if (route.tab === "tasks" && route.run) {
        setActivePanelKey("runs");
        dockRef.current?.openPanel("runs");
        if (route.task) void loadRuns(route.task);
      }
      setContextTaskId(route.chatTask);
      setContextSource(route.chatTask ? "tasks" : null);
      setSelectedMessageId(route.message);
      setSelectedBoard(route.board);
      // t103：Git 入口深链。设置页没有 git=1 时关闭 Git 聚焦，避免残留。
      setMergeQueueOpen(route.mergeQueue);
      if (route.mergeQueue) {
        setActivePanelKey("mergeQueue");
        dockRef.current?.openPanel("mergeQueue");
        void loadMergeQueue();
      }
      if (route.gitSettings) {
        setSettingsOpen(true);
        setTab("settings");
        setGitSettingsFocus(true);
      } else {
        setGitSettingsFocus(false);
      }
      setTaskVcsFocus(route.taskVcs);
      setTaskReviewFocus(route.taskReview);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadRuns, loadTrace, settingsDirty, settingsOpen, planSource, planDraft]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.deer.listWorkspaces();
        setWorkspaces(list);
        if (list.length > 0) {
          setSnapshot(await window.deer.getSnapshot(list[0].id));
        }
      } catch (error) {
        setError(errorText(error));
      }
    })();
  }, []);

  useEffect(() => {
    const workspaceId = snapshot?.workspace.id;
    if (!workspaceId) return;
    try {
      setMailboxReadIds(
        parseMailboxReadIds(localStorage.getItem(mailboxReadStorageKey(workspaceId))),
      );
    } catch {
      setMailboxReadIds(new Set());
    }
  }, [snapshot?.workspace.id]);

  useEffect(() => {
    const workspaceId = snapshot?.workspace.id;
    if (!workspaceId || !snapshot || snapshot.messages.length === 0) return;
    setMailboxReadIds((previous) => {
      const next = pruneMailboxReadIds(
        previous,
        snapshot.messages.map((message) => message.id),
      );
      if (next.size === previous.size) return previous;
      try {
        localStorage.setItem(mailboxReadStorageKey(workspaceId), serializeMailboxReadIds(next));
      } catch {
        // localStorage 不可用时仍保留会话内已读状态。
      }
      return next;
    });
  }, [snapshot?.workspace.id, snapshot?.messages]);

  useEffect(() => {
    const coordinator = new RefreshCoordinator({
      onFlush: async ({ domains, generation, lastSeq }) => {
        const current = snapshotRef.current;
        if (!current) return;
        const token = ++refreshTokenRef.current;
        refreshGenerationRef.current = generation;
        refreshLastSeqRef.current = lastSeq;
        await refreshDomains(current.workspace.id, domains, token);
        if (token === refreshTokenRef.current) {
          setRefreshStale(false);
          setStaleDomains(new Set());
        }
      },
      onStale: (domains) => {
        setStaleDomains(new Set(domains));
        setRefreshStale(true);
      },
    });
    refreshCoordinatorRef.current = coordinator;
    const off = window.deer.onEvent((event: EventRecord) => {
      coordinator.notify({ seq: event.seq, type: event.type });
    });
    const onOnline = () => coordinator.invalidateAll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") coordinator.invalidateAll();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      off();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      coordinator.dispose();
      refreshCoordinatorRef.current = null;
    };
  }, [refreshDomains]);

  // 工作区切换：seq/token 从新 workspace 重新起算，旧 in-flight 响应失效。
  useEffect(() => {
    refreshTokenRef.current += 1;
    refreshCoordinatorRef.current?.reset();
    refreshGenerationRef.current = 0;
    refreshLastSeqRef.current = 0;
    setRefreshStale(false);
    setStaleDomains(new Set());
  }, [snapshot?.workspace.id]);

  useEffect(() => {
    if (!snapshot) return;
    void loadChat().catch((error) => setError(errorText(error)));
  }, [snapshot?.workspace.id, contextTaskId, loadChat]);

  // t64 §6.3 / t80 F6：待回答问题自动打开（DEC-10）。纯函数 shouldAutoOpenQuestion
  // 统一判定「对话面板可见 / 窗口有焦点 / 无其他弹窗 / composer 未聚焦且无草稿 /
  // 未延后 / 每个问题只自动开一次 / Router 不在回复」。
  useEffect(() => {
    if (!snapshot || !questionsLoaded) return;
    if (activeQuestion || riskApproval || settingsOpen) return;
    const windowFocused = typeof document === "undefined" ? false : document.hasFocus();
    const otherModalOpen =
      typeof document === "undefined"
        ? false
        : Boolean(document.querySelector('[role="dialog"]'));
    const activeElement =
      typeof document === "undefined"
        ? null
        : (document.activeElement as
            | { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown }
            | null);
    const composerFocused =
      Boolean(activeElement) &&
      (isEditableElement(activeElement) || isComposerFocusWithin(activeElement));
    const candidate = pendingQuestions.find((question) =>
      shouldAutoOpenQuestion({
        questionsLoaded,
        panelVisible: tab === "chat",
        windowFocused,
        otherModalOpen,
        composerFocused,
        composerHasDraft: Boolean(chatInput.trim()),
        chatBusy,
        deferred: deferredQuestionIds.includes(question.id),
        alreadyAutoOpened: autoOpenedQuestionIdsRef.current.has(question.id),
      }),
    );
    if (!candidate) return;
    autoOpenedQuestionIdsRef.current.add(candidate.id);
    setQuestionModalId(candidate.id);
  }, [
    activeQuestion,
    chatBusy,
    chatInput,
    deferredQuestionIds,
    pendingQuestions,
    questionsLoaded,
    riskApproval,
    settingsOpen,
    snapshot,
    tab,
  ]);

  // t64：新问题到达但未被自动打开 → 一条 info toast（同一批只发一条）。
  useEffect(() => {
    const known = knownPendingQuestionIdsRef.current;
    const fresh = pendingQuestions.filter((question) => !known.has(question.id));
    for (const question of pendingQuestions) known.add(question.id);
    if (questionsFirstLoadRef.current) {
      questionsFirstLoadRef.current = false;
      return;
    }
    if (fresh.length === 0 || questionModalId || riskApproval) return;
    pushToast({
      kind: "info",
      message:
        fresh.length === 1
          ? `Router 有 1 个问题需要你回答：${fresh[0].title}`
          : `Router 有 ${fresh.length} 个问题需要你回答`,
      action: {
        label: "去回答",
        onClick: () => {
          openPanel("chat");
          openQuestionModal(fresh[0].id);
        },
      },
    });
  }, [pendingQuestions, questionModalId, riskApproval, pushToast, openPanel]);

  // t64 §7.3：不允许嵌套 Modal——高风险审批优先，问题弹窗收起但保留 pending。
  useEffect(() => {
    if (!riskApproval || !questionModalId) return;
    setQuestionModalId(null);
    pushToast({ kind: "info", message: "先处理高风险审批；问题已保留，可稍后回答" });
  }, [riskApproval, questionModalId, pushToast]);

  // t58 IF-05：主进程高风险审批请求 → 人类审批弹窗；拒绝/超时在主进程写审计事件。
  useEffect(() => {
    return window.deer.onRiskApproval((request) => {
      setRiskApprovals((current) =>
        current.some((item) => item.requestId === request.requestId)
          ? current
          : [...current, request],
      );
    });
  }, []);

  // t58 IF-05：审批超过主进程超时时间后自动收起弹窗并提示——
  // 避免「主进程已按 human_required 拒绝，UI 仍显示可批准」的状态不一致。
  useEffect(() => {
    if (!riskApproval) return;
    const created = new Date(riskApproval.createdAt).getTime();
    const remaining = Number.isFinite(created)
      ? Math.max(0, RISK_APPROVAL_TIMEOUT_MS - (Date.now() - created))
      : RISK_APPROVAL_TIMEOUT_MS;
    const timer = window.setTimeout(() => {
      setRiskApprovals((current) =>
        current.filter((item) => item.requestId !== riskApproval.requestId),
      );
      pushToast({
        kind: "error",
        message: `高风险操作审批超时，已按未批准处理：${riskApproval.toolName}`,
      });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [riskApproval, pushToast]);

  async function respondRiskApproval(approved: boolean) {
    const request = riskApprovals[0];
    if (!request) return;
    setRiskApprovals((current) =>
      current.filter((item) => item.requestId !== request.requestId),
    );
    try {
      const accepted = await window.deer.respondRiskApproval(request.requestId, approved);
      if (!accepted) {
        // 主进程已超时/已消费（例如 120s 到期后再点批准）：明确告知未生效，绝不误报成功。
        pushToast({
          kind: "error",
          message: `审批已失效（超时或已处理），操作未执行：${request.toolName}`,
        });
        return;
      }
      pushToast({
        kind: approved ? "success" : "error",
        message: approved
          ? `已批准本次高风险操作（仅该次调用生效）：${request.toolName}`
          : `已拒绝高风险操作：${request.toolName}`,
      });
    } catch (error) {
      setError(errorText(error));
    }
  }

  const handleChatLiveSettled = useCallback((settled: ChatLiveSettled) => {
    setChatBusy(false);
    if (settled.kind === "error") {
      setError(formatError(settled.event.error));
    }
  }, []);

  // t168/t172：历史思考只在展开时翻译；设置指纹变化时清缓存，文本缓存复用实时译文。
  const translateHistoryText = useCallback(
    async (text: string): Promise<string> => {
      let settingsKey: string | null = null;
      try {
        settingsKey = JSON.stringify(await window.deer.getTranslationSettings());
      } catch {
        // 设置读取失败不阻断翻译；沿用现有缓存。
      }
      if (translationCacheNeedsInvalidation(translationSettingsKeyRef.current, settingsKey)) {
        historyTranslationMemo.clear();
        setTranslationRevision((value) => value + 1);
      }
      if (settingsKey !== null) translationSettingsKeyRef.current = settingsKey;
      return historyTranslationMemo.translate(text);
    },
    [historyTranslationMemo],
  );

  function resetForWorkspace() {
    planPreviewGateRef.current.invalidate();
    setPlanSource(null);
    setPlanDraft(null);
    setPlanIssues([]);
    setPlanError(null);
    setPlanBusy(false);
    planConfirmKeyRef.current = "";
    setSelectedTaskId(null);
    setTaskWorkspaceSource("tasks");
    setSelectedRunId(null);
    setTrace([]);
    setTaskRuns([]);
    setScheduler(null);
    setSchedulerError(null);
    setSchedulerLoading(true);
    setRunsError(null);
    setRunsLoading(false);
    setActionError(null);
    setActionBusy(null);
    setPendingConfirm(null);
    setKernelAnnouncement(null);
    setChatMessages([]);
    chatLiveStore.reset();
    setChatTurns(null);
    setChatTurnsLoading(false);
    setChatTurnsError(null);
    chatTurnsRequestRef.current += 1;
    chatTurnsToastRef.current = false;
    historyTranslationMemo.clear();
    translationSettingsKeyRef.current = null;
    setChatView("chat");
    setChatTrajectory([]);
    setChatBusy(false);
    setContext(null);
    setContextTaskId(null);
    setContextSource(null);
    setTaskStatusFilter("all");
    setSelectedMessageId(null);
    setSelectedBoard(null);
    // DESIGN §15.4：满血模式仅会话级，切换工作区即复位。
    setChatFullThrottle(false);
    // t64 §6.4：切换工作区关闭问题弹窗、清空队列/草稿/延后（新工作区独立）。
    setChatQuestions([]);
    setQuestionsLoaded(false);
    setQuestionModalId(null);
    setQuestionDrafts({});
    setDeferredQuestionIds([]);
    autoOpenedQuestionIdsRef.current = new Set();
    knownPendingQuestionIdsRef.current = new Set();
    questionsFirstLoadRef.current = true;
  }

  // t55 集成修复 IF-03：切换工作区前清掉旧工作区的满血模式，
  // 避免服务端会话仍注入高预算提示、而 UI 标识与本地状态已归零。
  async function clearFullThrottleBeforeWorkspaceSwitch(): Promise<void> {
    if (!chatFullThrottle) return;
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    if (current && router) {
      try {
        await window.deer.setFullThrottle(current.workspace.id, router.id, false);
      } catch {
        /* 审计失败不阻塞工作区切换 */
      }
    }
    setChatFullThrottle(false);
  }

  async function handleOpenWorkspace() {
    if (!confirmPlanDraftLeave("workspace")) return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await window.deer.openWorkspace();
      if (!workspace) return;
      await clearFullThrottleBeforeWorkspaceSwitch();
      setWorkspaces(await window.deer.listWorkspaces());
      setSnapshot(await window.deer.getSnapshot(workspace.id));
      resetForWorkspace();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectWorkspace(workspaceId: string) {
    if (!confirmPlanDraftLeave("workspace")) return;
    setBusy(true);
    setError(null);
    try {
      await clearFullThrottleBeforeWorkspaceSwitch();
      setSnapshot(await window.deer.getSnapshot(workspaceId));
      resetForWorkspace();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  /** t69：统一内核命令执行（KernelResult → toast/inline error + 刷新 + aria 播报）。 */
  async function executeKernelAction(
    busyKey: string,
    call: () => Promise<KernelResult<unknown>>,
    successMessage: string,
  ): Promise<boolean> {
    setActionBusy(busyKey);
    setActionError(null);
    try {
      unwrapKernel(await call());
      pushToast({
        kind: "success",
        message: successMessage,
        action: {
          label: "运行面板",
          onClick: () => openPanel("runs"),
        },
      });
      setKernelAnnouncement(successMessage);
      const current = snapshotRef.current;
      if (current) await refresh(current.workspace.id);
      return true;
    } catch (error) {
      const message =
        error instanceof KernelUiError ? error.message : errorText(error);
      setActionError(message);
      pushToast({ kind: "error", message: `操作失败：${message}` });
      setKernelAnnouncement(`操作失败：${message}`);
      return false;
    } finally {
      setActionBusy(null);
    }
  }

  function handleStartTask(task: Task) {
    void executeKernelAction(
      `task:start:${task.id}`,
      () => window.deer.startTask(task.id),
      `已入队运行「${task.title}」`,
    );
  }

  function handleRequestRetry(task: Task) {
    setPendingConfirm({ kind: "retry", task });
  }

  function handleRequestCancelTask(task: Task) {
    setPendingConfirm({ kind: "cancelTask", task });
  }

  function handleRequestCancelRun(run: Run) {
    const task = snapshotRef.current?.tasks.find((item) => item.id === run.taskId);
    setPendingConfirm({
      kind: "cancelRun",
      run,
      taskTitle: task?.title ?? run.taskId,
    });
  }

  function handleRequestPauseScheduler() {
    setPendingConfirm({ kind: "pause" });
  }

  // t107 F1：恢复调度与暂停一致，必须经确认弹窗（三处入口统一走这里）。
  function handleRequestResumeScheduler() {
    setPendingConfirm({ kind: "resume" });
  }

  function handleRequestReview(task: Task, decision: "approve" | "reject") {
    setReviewNotes("");
    setPendingConfirm({ kind: "review", task, decision });
  }

  async function confirmPendingAction() {
    const intent = pendingConfirm;
    if (!intent) return;
    setPendingConfirm(null);
    const current = snapshotRef.current;
    switch (intent.kind) {
      case "retry":
        await executeKernelAction(
          `task:retry:${intent.task.id}`,
          () => window.deer.retryTask(intent.task.id),
          `已重新入队「${intent.task.title}」`,
        );
        break;
      case "cancelTask":
        await executeKernelAction(
          `task:cancel:${intent.task.id}`,
          () => window.deer.cancelTask(intent.task.id),
          `已取消任务「${intent.task.title}」`,
        );
        break;
      case "cancelRun":
        await executeKernelAction(
          `run:${intent.run.id}`,
          () => window.deer.cancelRun(intent.run.id),
          `已取消执行 #${intent.run.attempt ?? 1}（${intent.taskTitle}）`,
        );
        break;
      case "pause":
        if (!current) return;
        await executeKernelAction(
          "scheduler:pause",
          () => window.deer.pauseScheduler(current.workspace.id, "user_paused"),
          "调度已暂停",
        );
        break;
      case "resume":
        // t107 F1：恢复调度经确认弹窗后执行。
        if (!current) return;
        await executeKernelAction(
          "scheduler:resume",
          () => window.deer.resumeScheduler(current.workspace.id),
          "调度已恢复",
        );
        break;
      case "review":
        await executeKernelAction(
          `task:review:${intent.task.id}`,
          () =>
            window.deer.reviewTask(intent.task.id, intent.decision, {
              reviewer: "user",
              notes: reviewNotes.trim() || undefined,
            }),
          intent.decision === "approve"
            ? `已批准「${intent.task.title}」`
            : `已拒绝「${intent.task.title}」`,
        );
        break;
      default:
        break;
    }
  }

  async function handleCreateTask(
    title: string,
    description: string,
    acceptance: string[],
  ): Promise<boolean> {
    const current = snapshotRef.current;
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      const { value: task, postError } = await writeThenRefresh(
        () =>
          window.deer.createTask({
            workspaceId: current.workspace.id,
            title,
            description,
            acceptance,
          }),
        async (created) => {
          setSelectedTaskId(created.id);
          openPanel("tasks");
          await refresh(current.workspace.id);
          await loadTrace(created.id);
        },
      );
      if (postError) {
        pushToast({
          kind: "error",
          message: `任务已创建，但刷新失败：${formatError(postError)}`,
        });
      } else {
        pushToast({
          kind: "success",
          message: `已创建任务「${title}」`,
          action: {
            label: "查看",
            onClick: () => {
              setSelectedTaskId(task.id);
              openPanel("tasks");
            },
          },
        });
      }
      // 写已提交：即使刷新失败也必须关闭表单，避免用户重提造成重复。
      return true;
    } catch (error) {
      // 非幂等写操作不自动重试；write 本身失败时保留表单。
      showError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAgent(input: {
    name: string;
    role: string;
    model: string | null;
    systemPrompt: string;
    persona: string;
    agentsMd: string;
  }): Promise<boolean> {
    const current = snapshotRef.current;
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      const { postError } = await writeThenRefresh(
        () => window.deer.createAgent({ workspaceId: current.workspace.id, ...input }),
        async () => {
          await refresh(current.workspace.id);
        },
      );
      if (postError) {
        pushToast({
          kind: "error",
          message: `成员已创建，但刷新失败：${formatError(postError)}`,
        });
      } else {
        pushToast({
          kind: "success",
          message: `已创建成员 ${input.name}`,
          action: { label: "查看", onClick: () => openPanel("team") },
        });
      }
      return true;
    } catch (error) {
      setError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handleRecommendMembers(
    input: Omit<RecommendMembersRequest, "workspaceId">,
  ): Promise<RecommendMembersResponse> {
    const current = snapshotRef.current;
    if (!current) {
      return Promise.resolve({
        ok: false,
        code: "RECOMMEND_FAILED",
        message: "工作区尚未加载",
      });
    }
    return window.deer.recommendMembers({ ...input, workspaceId: current.workspace.id });
  }

  async function handleTeamCommand(description: string | null): Promise<void> {
    if (chatBusy || chatContextBusy) return;
    setChatBusy(true);
    setError(null);
    try {
      const response = await handleRecommendMembers(
        description ? { mode: "description", description } : { mode: "team-gap" },
      );
      if (!response.ok) {
        pushToast({ kind: "error", message: response.message });
        return;
      }
      const candidates = extractRecommendationCandidates(response);
      if (!candidates) {
        pushToast({ kind: "error", message: "Router 没有返回可聘用的成员候选。" });
        return;
      }
      setRecommendedMembers(candidates);
      setCreateIntent(null);
      openPanel("team");
    } catch (error) {
      pushToast({ kind: "error", message: errorText(error) });
    } finally {
      setChatBusy(false);
    }
  }

  async function handleUpdateAgent(input: UpdateAgentInput) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await window.deer.updateAgent(input);
      await refresh(current.workspace.id);
      // C26：成功 toast。
      if (input.name) pushToast({ kind: "success", message: `已保存成员 ${input.name}` });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAgent(agent: Agent): Promise<boolean> {
    const current = snapshotRef.current;
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await window.deer.deleteAgent(agent.id);
      await refresh(current.workspace.id);
      pushToast({
        kind: "success",
        message: `已删除成员 ${agent.name}${
          result.reassignedTasks > 0 ? `，${result.reassignedTasks} 个任务转为未分配` : ""
        }`,
      });
      return true;
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTask(task: Task): Promise<boolean> {
    const current = snapshotRef.current;
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await window.deer.deleteTask(task.id);
      await refresh(current.workspace.id);
      if (selectedTaskId === task.id) setSelectedTaskId(null);
      pushToast({
        kind: "success",
        message: `已删除任务「${task.title}」${
          result.removedRuns > 0 ? `，清理 ${result.removedRuns} 条运行记录` : ""
        }`,
      });
      return true;
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  // DESIGN §15.5：对话控制条——模型/权限切换（写入当前 Agent，失败保留原值）。
  async function handleChatControlUpdate(patch: {
    model?: string | null;
    permission?: PermissionMode;
  }) {
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    if (!router || !current) return;
    setBusy(true);
    setError(null);
    try {
      await window.deer.updateAgent({ id: router.id, ...patch });
      await refresh(current.workspace.id);
      if (patch.model !== undefined) {
        pushToast({ kind: "success", message: "已切换对话模型，下一条消息生效" });
      }
      if (patch.permission) {
        pushToast({
          kind: "success",
          message: `权限已切换：${PERMISSION_LABELS[patch.permission]}`,
        });
      }
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: "切换失败，已保留原值" });
    } finally {
      setBusy(false);
    }
  }

  // DESIGN §15.4：满血模式开关（会话级提示/预算覆盖，不改变权限）。
  async function handleFullThrottleChange(enabled: boolean) {
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    if (!router || !current) return;
    try {
      await window.deer.setFullThrottle(current.workspace.id, router.id, enabled);
      setChatFullThrottle(enabled);
      pushToast({
        kind: "success",
        message: enabled
          ? "满血模式已开启：注入高预算指令，回复更完整，成本/延迟可能上升；不改变工具权限"
          : "满血模式已关闭，提示注入已移除",
      });
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: "切换失败，已保留原值" });
    }
  }

  async function loadPlanPreview(source: PlanSource) {
    const current = snapshotRef.current;
    if (!current) return;
    const token = planPreviewGateRef.current.start();
    setPlanBusy(true);
    setPlanError(null);
    setPlanDraft(null);
    setPlanIssues(planSourceIssues(source));
    try {
      const result = await window.deer.previewPlan(current.workspace.id, source);
      if (!planPreviewGateRef.current.isCurrent(token)) return;
      setPlanIssues(result.issues);
      if (!result.ok || !result.draft) {
        setPlanError(
          result.error === "PLAN_UNPARSEABLE"
            ? "规划器返回无法解析，请重新生成（不会 fallback 建单任务）。"
            : result.error
              ? "规划生成失败，请重试。"
              : "规划源不满足条件。",
        );
        return;
      }
      setPlanDraft(result.draft);
      planConfirmKeyRef.current = planDraftFingerprint(result.draft);
    } catch (error) {
      if (planPreviewGateRef.current.isCurrent(token)) {
        setPlanError(`规划生成失败：${formatError(error)}`);
      }
    } finally {
      if (planPreviewGateRef.current.isCurrent(token)) setPlanBusy(false);
    }
  }

  function planSourceFromChat(goalOverride?: string): PlanSource {
    const current = snapshotRef.current;
    const lastUser = [...chatMessages].reverse().find((message) => message.role === "user");
    const goal = resolvePlanGoal(goalOverride, chatInput, lastUser?.content ?? null);
    const summary = chatMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    return buildPlanSource({
      goal,
      goalSource:
        goalOverride !== undefined
          ? "edited"
          : chatInput.trim()
            ? "composer"
            : "last_user_message",
      messages: chatMessages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content })),
      summary,
      overview: current?.workspace.overview ?? "",
    });
  }

  function invalidatePlanPreview() {
    planPreviewGateRef.current.invalidate();
    setPlanBusy(false);
  }

  function clearPlanDraftSession() {
    planPreviewGateRef.current.invalidate();
    setPlanSource(null);
    setPlanDraft(null);
    setPlanIssues([]);
    setPlanError(null);
    setPlanBusy(false);
    planConfirmKeyRef.current = "";
  }

  function confirmPlanDraftLeave(reason: PlanDraftLeaveReason): boolean {
    if (!isPlanDraftDirty(planSource, planDraft)) return true;
    if (!window.confirm(planDraftLeaveMessage(reason))) return false;
    if (planDraftLeaveDisposition(reason) === "discard") clearPlanDraftSession();
    else invalidatePlanPreview();
    return true;
  }

  function openPlanDraft(source: PlanSource, preview: boolean): boolean {
    // t237：无论是否立即 preview，都先失效在途请求，避免旧响应回填新 source。
    planPreviewGateRef.current.invalidate();
    setPlanBusy(false);
    const sameSource = planSource?.digest === source.digest;
    if (!sameSource && !confirmPlanDraftLeave("replace")) return false;
    if (sameSource && planDraft) {
      openPanel("planDraft");
      return true;
    }
    setPlanSource(source);
    setPlanDraft(null);
    setPlanError(null);
    setPlanIssues(planSourceIssues(source));
    openPanel("planDraft");
    if (preview) void loadPlanPreview(source);
    return true;
  }

  function handlePlanFromChat() {
    if (!snapshotRef.current) return;
    openPlanDraft(planSourceFromChat(), true);
  }

  /** Tasks/CommandPalette/WorkflowRail 旧规划入口统一落到草案，不直接建任务。 */
  function handlePlanDraftEntry() {
    if (!snapshotRef.current) return;
    const source = planSourceFromChat();
    openPlanDraft(source, Boolean(source.goal.trim() || source.messages.length));
  }

  function handlePlanGoalChange(goal: string) {
    const next = planSourceFromChat(goal);
    setPlanSource(next);
    setPlanIssues([
      ...planSourceIssues(next),
      ...(planDraft
        ? validatePlanDraft(planDraft.tasks, { agents: snapshot?.agents ?? [] })
        : []),
    ]);
    setPlanError(null);
    invalidatePlanPreview();
  }

  function handlePlanDraftChange(next: PlanDraft) {
    setPlanDraft(next);
    setPlanIssues([
      ...planSourceIssues(planSource ?? next.source),
      ...validatePlanDraft(next.tasks, { agents: snapshot?.agents ?? [] }),
    ]);
    planConfirmKeyRef.current = planDraftFingerprint(next);
  }

  async function handleConfirmPlan(ackHighRisk: boolean) {
    const current = snapshotRef.current;
    if (!current || !planDraft || planBusy || planConfirming) return;
    if (isPlanDraftSourceChanged(planDraft, planSource)) {
      setPlanError("目标已修改，当前草案对应的目标已过期；请重新生成后再确认。");
      return;
    }
    setPlanConfirming(true);
    setPlanError(null);
    try {
      const result = await window.deer.confirmPlan({
        workspaceId: current.workspace.id,
        source: planDraft.source,
        sourceDigest: planDraft.source.digest,
        idempotencyKey: planConfirmKeyRef.current,
        tasks: planDraft.tasks,
        ackHighRisk,
      });
      await refresh(current.workspace.id);
      if (result.tasks[0]) {
        setSelectedTaskId(result.tasks[0].id);
        void loadTrace(result.tasks[0].id);
        void loadRuns(result.tasks[0].id);
      }
      setPlanSource(null);
      setPlanDraft(null);
      setPlanIssues([]);
      if (activePanelKey === "planDraft") dockRef.current?.closeActivePanel();
      openPanel("tasks");
      pushToast({
        kind: "success",
        message: result.alreadyConfirmed
          ? `草案已确认过，复用 ${result.tasks.length} 个任务`
          : `已创建 ${result.tasks.length} 个任务（DAG）`,
      });
    } catch (error) {
      const message = `确认失败：${formatError(error)}`;
      setPlanError(message);
      showError(message, {
        label: "重试确认",
        run: () => void handleConfirmPlan(ackHighRisk),
      });
    } finally {
      setPlanConfirming(false);
    }
  }

  function handleCancelPlan() {
    if (!confirmPlanDraftLeave("cancel")) return;
    clearPlanDraftSession();
    if (activePanelKey === "planDraft") dockRef.current?.closeActivePanel();
    openPanel("chat");
  }

  /** Dock 关闭：dirty 时确认；确认“关闭”会保留会话草案，可从 launcher 恢复。 */
  function handlePlanDraftPanelClosed() {
    if (!isPlanDraftDirty(planSource, planDraft)) return;
    if (!window.confirm(planDraftLeaveMessage("close"))) {
      openPanel("planDraft");
      return;
    }
    invalidatePlanPreview();
  }

  /**
   * t64：对话发送的唯一实现（composer 与「回答表单」都走这里）。
   * t80 F5：回答回流失败时由调用方提供 onFailure（带「重新发送回答」action 的 toast）。
   */
  async function sendChatText(
    text: string,
    options: { failureToast?: string; onFailure?: () => void } = {},
  ): Promise<boolean> {
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    const message = text.trim();
    if (!current || !router || !message || chatBusy) return false;
    setChatBusy(true);
    chatLiveStore.clearLive();
    setError(null);
    setChatMessages((prev) => [
      ...prev,
      {
        id: `temp-${Date.now()}`,
        workspaceId: current.workspace.id,
        agentId: router.id,
        role: "user",
        content: message,
        reasoning: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    try {
      await window.deer.sendChat(current.workspace.id, message);
      return true;
    } catch (error) {
      setError(errorText(error));
      if (options.onFailure) {
        options.onFailure();
      } else if (options.failureToast) {
        pushToast({ kind: "error", message: options.failureToast });
      }
      return false;
    } finally {
      setChatBusy(false);
      void loadChat().catch((error) => setError(errorText(error)));
    }
  }

  /**
   * t80 F5：「重新发送回答」——重发前 loadChat 对比最后一条消息内容 === answerText，
   * 已存在则不重复发送（幂等兜底；服务端回答状态机仍是唯一事实源）。
   */
  async function resendAnswer(answerText: string) {
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    if (!current || !router) return;
    try {
      const messages = await window.deer.listChat(current.workspace.id, router.id);
      setChatMessages(messages);
      if (answerAlreadySent(messages, answerText)) {
        pushToast({ kind: "info", message: "该回答已在对话中，未重复发送" });
        return;
      }
    } catch (error) {
      pushToast({ kind: "error", message: `读取对话失败：${errorText(error)}` });
      return;
    }
    void sendChatText(answerText, { failureToast: "重新发送回答失败，请稍后重试" });
  }

  async function handleClearContext(): Promise<void> {
    const current = snapshotRef.current;
    if (!current || chatBusy || chatContextBusy) return;
    if (
      chatMessages.length > 0 &&
      !window.confirm("清空当前对话上下文？消息、画布索引与提问会被删除，此操作不可撤销。")
    ) {
      return;
    }
    setChatContextBusy(true);
    chatLiveStore.clearLive();
    setError(null);
    try {
      const result = await window.deer.clearChatContext(current.workspace.id);
      await loadChat();
      setChatTrajectory([]);
      if (chatView === "trajectory") await loadChatTrajectory();
      pushToast({
        kind: "success",
        message: `已清空上下文：${result.removedMessages} 条消息、${result.removedArtifacts} 个画布、${result.removedQuestions} 个提问`,
      });
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: `清空上下文失败：${errorText(error)}` });
    } finally {
      setChatContextBusy(false);
    }
  }

  async function handleCompactContext(): Promise<void> {
    const current = snapshotRef.current;
    if (!current || chatBusy || chatContextBusy) return;
    setChatContextBusy(true);
    chatLiveStore.clearLive();
    setError(null);
    try {
      const result = await window.deer.compactChatContext(current.workspace.id);
      await loadChat();
      setChatTrajectory([]);
      if (chatView === "trajectory") await loadChatTrajectory();
      pushToast({
        kind: result.summarizedMessages > 0 ? "success" : "info",
        message:
          result.summarizedMessages > 0
            ? `已压缩 ${result.summarizedMessages} 条消息，保留最近 ${result.keptMessages} 条`
            : "消息不足 9 条，无需压缩",
      });
    } catch (error) {
      setError(errorText(error));
      pushToast({ kind: "error", message: `压缩上下文失败：${errorText(error)}` });
    } finally {
      setChatContextBusy(false);
    }
  }

  function handleRetryTurn(content: string) {
    if (chatBusy || chatContextBusy) return;
    const next = retryComposerState(chatInput, content);
    if (!next) return;
    setChatInput(next.value);
    pushToast({ kind: "info", message: next.message });
    window.setTimeout(() => chatComposerRef.current?.focus(), 0);
  }

  async function handleSendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy || chatContextBusy) return;
    const command = text.toLowerCase();
    if (command === "/clear" || command === "/清空") {
      setChatInput("");
      await handleClearContext();
      return;
    }
    if (command === "/compact" || command === "/压缩") {
      setChatInput("");
      await handleCompactContext();
      return;
    }
    const team = parseTeamCommand(text);
    if (team) {
      setChatInput("");
      await handleTeamCommand(team.description);
      return;
    }
    setChatInput("");
    await sendChatText(text);
  }

  // ---------- t64：提问弹窗（队列 / 自动打开 / 回答 / 取消 / 超时） ----------

  function openQuestionModal(questionId: string) {
    setQuestionModalId(questionId);
    setDeferredQuestionIds((current) => current.filter((id) => id !== questionId));
  }

  function handleDeferQuestion(questionId: string) {
    setQuestionModalId(null);
    setDeferredQuestionIds((current) =>
      current.includes(questionId) ? current : [...current, questionId],
    );
    pushToast({ kind: "info", message: "已稍后回答；问题卡片仍保留在对话里" });
  }

  async function handleCancelQuestion(questionId: string) {
    const current = snapshotRef.current;
    if (!current) return;
    try {
      const result = await window.deer.cancelChatQuestion({
        workspaceId: current.workspace.id,
        questionId,
      });
      if (!result.ok) {
        pushToast({ kind: "error", message: result.message });
        if (result.code === "E_EXPIRED" || result.code === "E_CLOSED") {
          setQuestionModalId(null);
          void loadChat().catch(() => {});
        }
        return;
      }
      setChatQuestions((previous) =>
        previous.map((item) => (item.id === result.question.id ? result.question : item)),
      );
      setQuestionModalId(null);
      pushToast({ kind: "success", message: "已取消提问" });
    } catch (error) {
      pushToast({ kind: "error", message: `取消失败：${errorText(error)}` });
    }
  }

  /**
   * 提交回答：先落库（服务端条件更新 + 校验），changed 才发送用户消息（AC-10/AC-12）。
   * 返回字段错误给 QuestionModal 内联展示；业务失败不抛异常。
   */
  async function handleAnswerQuestion(values: QuestionValues): Promise<QuestionSubmitResult> {
    const current = snapshotRef.current;
    const question = activeQuestion;
    if (!current || !question) return { ok: false, message: "问题不存在或已关闭" };
    if (chatBusy) return { ok: false, message: "Router 正在回复，请稍后再提交" };
    setSubmittingQuestion(true);
    try {
      const result = await window.deer.answerChatQuestion({
        workspaceId: current.workspace.id,
        questionId: question.id,
        values,
      });
      if (!result.ok) {
        if (result.code === "E_INVALID_ANSWER" && result.fieldErrors?.length) {
          return { ok: false, fieldErrors: result.fieldErrors, message: result.message };
        }
        pushToast({ kind: "error", message: result.message });
        if (result.code === "E_EXPIRED" || result.code === "E_CLOSED") {
          setQuestionModalId(null);
          void loadChat().catch(() => {});
        }
        return { ok: false, message: result.message };
      }
      setChatQuestions((previous) =>
        previous.map((item) => (item.id === result.question.id ? result.question : item)),
      );
      setQuestionModalId(null);
      setQuestionDrafts((previous) => {
        const next = { ...previous };
        delete next[question.id];
        return next;
      });
      if (!result.changed) {
        pushToast({ kind: "info", message: "该问题已回答，未重复发送" });
        return { ok: true };
      }
      pushToast({ kind: "success", message: "回答已提交，Router 继续" });
      // 不 await：弹窗立即关闭、对话继续流式输出。
      // t80 F5：失败时 toast 带「重新发送回答」action；重发前会按最后一条消息去重。
      const answerText = result.answerText;
      void sendChatText(answerText, {
        onFailure: () =>
          pushToast({
            kind: "error",
            message: "回答已保存，但发送失败",
            action: {
              label: "重新发送回答",
              onClick: () => void resendAnswer(answerText),
            },
          }),
      });
      return { ok: true };
    } catch (error) {
      const message = errorText(error);
      pushToast({ kind: "error", message: `提交回答失败：${message}` });
      return { ok: false, message };
    } finally {
      setSubmittingQuestion(false);
    }
  }

  function handleExpireQuestion(questionId: string) {
    if (questionModalId !== questionId) return;
    setQuestionModalId(null);
    pushToast({ kind: "error", message: "问题已到期，未提交" });
    void loadChat().catch(() => {});
  }

  async function handleStopChat() {
    const current = snapshotRef.current;
    if (!current) return;
    try {
      await window.deer.cancelChat(current.workspace.id);
    } catch (error) {
      setError(errorText(error));
    }
  }

  // C14：进入任务会话时记录来源 tab，对话页提供「返回」。
  function handleShowTaskContext(taskId: string, source: "tasks" | "team" = "tasks") {
    setContextTaskId(taskId);
    setContextSource(source);
    setSelectedRunId(null);
    openPanel("chat");
  }

  // C14：任务详情 → 在星图中定位（跳团队页并居中该节点）。
  function handleLocateInStarMap(taskId: string) {
    setSelectedTaskId(taskId);
    setSelectedRunId(null);
    setStarmapFocus({ taskId, nonce: Date.now() });
    openPanel("team");
  }

  /** t69：打开 Runs 面板（可带任务/Run 深链选择）。 */
  function openRunsPanel(
    taskId?: string | null,
    runId?: string | null,
    source?: "tasks" | "team" | "runs",
  ) {
    setTaskWorkspaceSource(
      resolveTaskWorkspaceSource(source ?? "runs", taskWorkspaceSource),
    );
    if (taskId) {
      setSelectedTaskId(taskId);
      void loadTrace(taskId);
      void loadRuns(taskId);
    }
    setSelectedRunId(runId ?? null);
    openPanel("runs");
  }

  function openSettingsSection(section: SettingsSection = "models") {
    setGitSettingsFocus(false);
    setSettingsInitialSection(section);
    openPanel("settings");
  }

  function openTeamMember(ownerId: string | null) {
    setMemberEditTarget(ownerId);
    openPanel("team");
  }

  function showError(
    message: string,
    retry?: { label: string; run: () => void },
  ) {
    setError(message);
    setErrorRetry(retry ? { ...retry, message } : null);
  }

  function handleRetryAfterError() {
    setError(null);
    setErrorRetry(null);
    void handleManualRefresh();
    void loadChat().catch((cause) => showError(errorText(cause)));
  }

  function handleFirstRunAction() {    switch (firstRunState.action.kind) {
      case "workspace":
        void handleOpenWorkspace();
        return;
      case "settings-model":
      case "settings-key":
        openSettingsSection("models");
        return;
      case "team":
        startCreate("member");
        return;
      case "plan":
        handlePlanDraftEntry();
        return;
      case "chat":
        openPanel("chat");
        window.setTimeout(() => chatComposerRef.current?.focus(), 0);
        return;
    }
  }

  function handleOpenTaskWorkspace(taskId: string, source: "tasks" | "team" = "tasks") {
    setTaskWorkspaceSource(source);
    setSelectedTaskId(taskId);
    setSelectedRunId(null);
    void loadTrace(taskId);
    void loadRuns(taskId);
    openPanel("tasks");
  }

  function handleOpenTaskPage(taskId: string) {
    handleOpenTaskWorkspace(taskId, "tasks");
  }

  // C06：顶栏失败计数一键跳到任务页并过滤 failed。
  function jumpToFailedTasks() {
    setTaskStatusFilter("failed");
    openPanel("tasks");
  }

  // C11：「＋新建」/ 命令面板统一入口——跳到目标页并自动打开对应弹窗。
  function startCreate(intent: CreateIntent) {
    setCreateMenuOpen(false);
    setCreateIntent(intent);
    openPanel(CREATE_TARGET_TAB[intent]);
  }

  function handlePaletteNavigate(target: RouteTab) {
    openPanel(target);
  }

  // t103：Git 入口（命令面板 / 团队页 / 深链共用）。
  function handleOpenMergeQueue() {
    if (tab === "settings") {
      if (settingsDirty && !window.confirm("设置尚未保存，确定离开吗？")) return;
      setSettingsDirty(false);
      setSettingsOpen(false);
      setGitSettingsFocus(false);
      setSettingsInitialSection(undefined);
    }
    if (tab !== "tasks" && tab !== "team") {
      setTab("tasks");
      dockRef.current?.openPanel("tasks");
    }
    setActivePanelKey("mergeQueue");
    dockRef.current?.openPanel("mergeQueue");
    setMergeQueueOpen(true);
    void loadMergeQueue();
  }

  function handleOpenGitSettings() {
    if (tab !== "settings") setSettingsReturnTab(tab);
    setSettingsOpen(true);
    setTab("settings");
    setGitSettingsFocus(true);
  }

  function handleOpenTaskVcs(taskId?: string | null) {
    const targetId = taskId ?? selectedTaskId ?? snapshotRef.current?.tasks[0]?.id ?? null;
    if (!targetId) {
      pushToast({ kind: "error", message: "先在任务页选择一个任务，再查看 Git 状态。" });
      return;
    }
    setSelectedTaskId(targetId);
    void loadTrace(targetId);
    openPanel("tasks");
    setTaskVcsFocus(true);
  }

  function handleOpenTaskReview(taskId?: string | null) {
    const targetId = taskId ?? selectedTaskId ?? snapshotRef.current?.tasks[0]?.id ?? null;
    if (!targetId) {
      pushToast({ kind: "error", message: "先在任务页选择一个任务，再打开评审。" });
      return;
    }
    setSelectedTaskId(targetId);
    void loadTrace(targetId);
    openPanel("tasks");
    setTaskReviewFocus(true);
  }

  /** P0-3：阶段入口只复用现有面板/任务/队列入口，不新增事实或状态机。 */
  function handleWorkflowStage(stage: WorkflowStage, taskId: string | null) {
    const target = workflowStageNavigation(stage, taskId);
    if (target.panel === "merge") {
      handleOpenMergeQueue();
      return;
    }
    if (target.panel === "chat") {
      openPanel("chat");
      return;
    }
    if (target.panel === "board") {
      openPanel("board");
      return;
    }
    if (target.panel === "planDraft") {
      handlePlanDraftEntry();
      return;
    }
    if (target.review) {
      handleOpenTaskReview(target.taskId ?? null);
      return;
    }
    if (target.taskId) handleOpenTaskPage(target.taskId);
    else openPanel("tasks");
  }

  function handleNeedsMeItem(item: NeedsMeItem) {
    if (item.kind === "alert" || item.kind === "budget") {
      openPanel("watchdog");
      return;
    }
    if (item.kind === "merge") {
      handleOpenMergeQueue();
      return;
    }
    if (item.taskId) {
      if (item.kind === "review") handleOpenTaskReview(item.taskId);
      else handleOpenTaskPage(item.taskId);
      return;
    }
    openPanel("tasks");
  }

  // t50：命令面板「面板」组动作 → DockHandle。
  function handlePanelAction(action: PanelAction) {
    if (action === "open-merge-queue") {
      handleOpenMergeQueue();
      return;
    }
    if (action === "open-git-settings") {
      handleOpenGitSettings();
      return;
    }
    if (action === "open-task-vcs") {
      handleOpenTaskVcs();
      return;
    }
    if (action === "open-task-review") {
      handleOpenTaskReview();
      return;
    }
    const dock = dockRef.current;
    if (!dock) return;
    switch (action) {
      case "open-context":
        openPanel("context");
        break;
      case "open-runs":
        openPanel("runs");
        break;
      case "open-polls":
        openPanel("polls");
        break;
      case "close-active":
        dock.closeActivePanel();
        break;
      case "reset-layout":
        dock.resetLayout();
        break;
      case "reset-all":
        if (window.confirm("重置当前工作区的全部已保存布局？")) {
          dock.resetAllLayouts();
        }
        break;
      case "move-left":
        dock.moveActivePanel("left");
        break;
      case "move-right":
        dock.moveActivePanel("right");
        break;
      case "move-up":
        dock.moveActivePanel("above");
        break;
      case "move-down":
        dock.moveActivePanel("below");
        break;
      default:
        break;
    }
  }

  function handlePaletteOpenTask(taskId: string) {
    setSelectedTaskId(taskId);
    setSelectedRunId(null);
    void loadTrace(taskId);
    void loadRuns(taskId);
    openPanel("tasks");
  }

  function handlePaletteOpenMessage(messageId: string) {
    setSelectedMessageId(messageId);
    openPanel("mailbox");
  }

  function handlePaletteOpenBoard(board: string) {
    setSelectedBoard(board);
    openPanel("board");
  }

  function markMailboxRead(ids: string[]) {
    const workspaceId = snapshotRef.current?.workspace.id;
    if (!workspaceId || ids.length === 0) return;
    setMailboxReadIds((previous) => {
      const next = new Set(previous);
      for (const id of ids) next.add(id);
      try {
        localStorage.setItem(mailboxReadStorageKey(workspaceId), serializeMailboxReadIds(next));
      } catch {
        // localStorage 不可用时仍保留会话内已读状态。
      }
      return next;
    });
  }

  async function handleSendMessage(input: {
    to: string[];
    subject: string;
    body: string;
    kind: MailboxMessage["kind"];
    threadId?: string;
    parentId?: string;
  }): Promise<boolean> {
    const current = snapshotRef.current;
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      const { postError } = await writeThenRefresh(
        () =>
          window.deer.sendMessage({
            workspaceId: current.workspace.id,
            from: "user",
            ...input,
          }),
        async () => {
          await refresh(current.workspace.id);
        },
      );
      if (postError) {
        pushToast({
          kind: "error",
          message: `邮件已发送，但刷新失败：${formatError(postError)}`,
        });
      } else {
        pushToast({
          kind: "success",
          message: `已发送邮件「${input.subject}」`,
          action: { label: "查看", onClick: () => openPanel("mailbox") },
        });
      }
      // 写已提交：即使刷新失败也必须关闭表单，避免用户重发造成重复。
      return true;
    } catch (error) {
      // 非幂等写操作不自动重试；write 本身失败时保留表单。
      showError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handlePostBoard(input: {
    board: string;
    kind: BoardEntry["kind"];
    content: string;
    confidence: BoardEntry["confidence"];
  }) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await window.deer.postBoard({
        workspaceId: current.workspace.id,
        author: "user",
        ...input,
      });
      await refresh(current.workspace.id);
      // C26：成功 toast + 下一步动作。
      pushToast({
        kind: "success",
        message: "已发布黑板条目",
        action: {
          label: "查看",
          onClick: () => {
            setSelectedBoard(input.board);
            openPanel("board");
          },
        },
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings(
    settings: LlmSettings,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    setBusy(true);
    try {
      await window.deer.saveSettings(settings);
      // 翻译设置/目标语言可能变化：清空已挂载译文，并通知 reasoning 重新请求。
      historyTranslationMemo.clear();
      translationSettingsKeyRef.current = null;
      setTranslationRevision((value) => value + 1);
      const current = snapshotRef.current;
      if (current) await refresh(current.workspace.id);
      // t190：保存反馈由 SettingsView 内部呈现；不把错误丢到全局 banner。
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      setBusy(false);
    }
  }

  // C03：页面地标——窗口标题随工作区/页面更新。
  // 集成修复 IF-01（t24）：本 effect 必须位于下面的 `if (!snapshot)` 提前返回之前。
  // 原实现放在提前返回之后：首屏（无快照）少调一个 hook，快照就绪后的渲染多调一个，
  // React 会抛 "Rendered more hooks than during the previous render"（开发构建）。
  useEffect(() => {
    const pageLabel =
    TABS.find((item) => item.id === tab)?.label ??
    PANEL_DEFS[tab as PanelKey]?.title ??
    "";
    document.title = snapshot
      ? `${snapshot.workspace.name} · ${pageLabel} — DeerSuperGroup`
      : "DeerSuperGroup";
  }, [snapshot, tab]);

  if (!snapshot) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="brand-mark">DG</div>
          <h1>DeerSuperGroup</h1>
          <p className="muted">
            一个本地优先的 AI 团队工作台：Router 拆任务，成员在隔离工作区里执行，邮箱与黑板共享上下文。
          </p>
          <button className="primary" onClick={handleOpenWorkspace} disabled={busy}>
            {busy ? "打开中…" : "打开工作区文件夹"}
          </button>
          {workspaces.length > 0 && (
            <div className="recent">
              <div className="section-label">最近工作区</div>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className="recent-item"
                  onClick={() => void handleSelectWorkspace(workspace.id)}
                >
                  <span>{workspace.name}</span>
                  <span className="muted mono">{workspace.path}</span>
                </button>
              ))}
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  const selectedTask = snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const workers = snapshot.agents.filter((agent) => !agent.isRouter);
  const firstRunModel = snapshot.settings.models.find(
    (profile) => profile.id === snapshot.settings.model,
  );
  const firstRunProvider = firstRunModel
    ? snapshot.settings.providers.find((provider) => provider.id === firstRunModel.providerId)
    : undefined;
  const firstRunKey = resolveFirstRunKeyStatus(
    snapshot.settings.providers,
    firstRunModel ?? null,
  );
  const firstRunState = deriveFirstRunState({
    workspaceName: snapshot.workspace.name,
    workspacePath: snapshot.workspace.path,
    tasksCount: snapshot.tasks.length,
    messagesCount: chatMessages.length,
    workerCount: workers.filter((worker) => worker.status !== "offline").length,
    modelCount: snapshot.settings.models.length,
    modelId: snapshot.settings.model,
    modelLabel: firstRunModel
      ? `${firstRunModel.label} · ${firstRunProvider?.name ?? firstRunModel.providerId}`
      : "",
    mock: snapshot.settings.mock,
    keyReady: firstRunKey.keyReady,
    keyProviderName: firstRunKey.providerName,
  });
  const failedCount = snapshot.tasks.filter((task) => task.status === "failed").length;
  // t194：显示宽度而不是改写保存宽度；回到宽屏后恢复用户原始 250/480。
  const effectiveSidebarWidth = displayedSidebarWidth(
    { preferred: sidebarWidth, displayed: sidebarDisplayWidth },
    viewportWidth,
  );
  // P0-2：一级入口 active 只从现有 Dock 激活面板/route tab 派生，不新增第二套面板状态。
  const activeRailKey = railKeyForActive(activePanelKey, tab);
  // P0-3：阶段与 NeedsMe 都是现有 tasks/runs/scheduler/merge/watchdog 的纯投影。
  const workflowProjection = deriveWorkflow({
    tasks: snapshot.tasks,
    runs: taskRuns,
    scheduler,
    mergeQueue: mergeQueueItems,
  });
  const needsMe = deriveNeedsMe({
    tasks: snapshot.tasks,
    mergeQueue: mergeQueueItems,
    watchdog: watchdogSnapshot,
  });

  const renderPanelContent = (key: PanelKey): ReactNode => {
              switch (key) {
                case "planDraft":
                  return (
                    <LazyPanel load={loadPlanDraftPanel} label="计划草案">
                      {(PlanDraftPanel) => (
                        <PlanDraftPanel
                          draft={planDraft}
                          source={planSource}
                          sourceChanged={isPlanDraftSourceChanged(planDraft, planSource)}
                          issues={planIssues}
                          agents={snapshot.agents}
                          busy={planBusy}
                          error={planError}
                          confirming={planConfirming}
                          onDraftChange={handlePlanDraftChange}
                          onGoalChange={handlePlanGoalChange}
                          onConfirm={(ack) => void handleConfirmPlan(ack)}
                          onCancel={handleCancelPlan}
                          onRetry={() => {
                            if (planSource) void loadPlanPreview(planSource);
                          }}
                        />
                      )}
                    </LazyPanel>
                  );
                case "gitGraph":
                  return (
                    <LazyPanel load={loadGitGraphPanel} label="版本图">
                      {(GitGraphPanel) => (
                        <GitGraphPanel workspaceId={snapshot.workspace.id} />
                      )}
                    </LazyPanel>
                  );
                case "mergeQueue":
                  return (
                    <LazyPanel load={loadMergeQueuePanel} label="合并队列">
                      {(MergeQueuePanel) => (
                        <MergeQueuePanel
                          workspaceId={snapshot.workspace.id}
                          items={mergeQueueItems}
                          stale={mergeQueueStale}
                          error={mergeQueueError}
                          loading={mergeQueueLoading}
                          onReload={() => loadMergeQueue()}
                          onOpenTask={(taskId) => handleOpenTaskPage(taskId)}
                        />
                      )}
                    </LazyPanel>
                  );
                case "tasks":
                  return (
                    <TasksView
                      snapshot={snapshot}
                      selectedTask={selectedTask}
                      trace={trace}
                      busy={busy}
                      statusFilter={taskStatusFilter}
                      onStatusFilter={setTaskStatusFilter}
                      autoOpen={
                        createIntent === "task" || createIntent === "plan" ? createIntent : null
                      }
                      onAutoOpenHandled={() => setCreateIntent(null)}
                      onSelect={(task) => {
                        setTaskWorkspaceSource("tasks");
                        setSelectedTaskId(task.id);
                        setSelectedRunId(null);
                        void loadTrace(task.id);
                        void loadRuns(task.id);
                      }}
                      onCreate={handleCreateTask}
                      onContext={(taskId) => {
                        handleShowTaskContext(taskId, "tasks");
                        // 集成修复 IF-04（t52）：上下文抽为独立面板后，任务详情
                        // 「查看上下文」需同时打开上下文面板，否则动作名与结果不符。
                        openPanel("context");
                      }}
                      onLocate={handleLocateInStarMap}
                      onPlanDraft={handlePlanDraftEntry}
                      onStartPoll={(task) => {
                        setPollIntent({
                          title: task.title,
                          sourceId: task.id,
                          scope: "task",
                          scopeId: task.id,
                        });
                        openPanel("polls");
                      }}
                      scheduler={scheduler}
                      schedulerLoading={schedulerLoading}
                      schedulerError={schedulerError}
                      runs={taskRuns}
                      runsLoading={runsLoading}
                      runsError={runsError}
                      selectedRunId={selectedRunId}
                      actionBusy={actionBusy}
                      actionError={actionError}
                      onReloadScheduler={() => void loadScheduler(snapshot.workspace.id)}
                      onReloadRuns={() => {
                        if (selectedTaskId) void loadRuns(selectedTaskId);
                      }}
                      onSelectRun={setSelectedRunId}
                      onOpenRuns={(taskId, runId) =>
                        openRunsPanel(taskId, runId, "tasks")
                      }
                      onStartTask={handleStartTask}
                      onRetryTask={handleRequestRetry}
                      onCancelTask={handleRequestCancelTask}
                      onCancelRun={handleRequestCancelRun}
                      onDeleteTask={handleDeleteTask}
                      onReviewTask={handleRequestReview}
                      onPause={handleRequestPauseScheduler}
                      onResume={handleRequestResumeScheduler}
                      watchdogAlerts={watchdogSnapshot?.alerts}
                      onAckWatchdogAlert={handleAckWatchdogAlert}
                      onResolveWatchdogAlert={handleResolveWatchdogAlert}
                      onReleaseWatchdogHold={handleReleaseWatchdogHold}
                      watchdogHandoffs={watchdogHandoffs}
                      workspaceSource={taskWorkspaceSource}
                      onReturnSource={() => openPanel("team")}
                      onOpenGitGraph={() => openPanel("gitGraph")}
                      onOpenMergeQueue={handleOpenMergeQueue}
                      fullThrottle={chatFullThrottle}
                      onOpenModels={() => openSettingsSection("models")}
                      onEditOwner={(ownerId) => openTeamMember(ownerId)}
                    />
                  );
                case "team":
                  return (
                    <LazyPanel load={loadTeamPanel} label="团队">
                      {(TeamDashboard) => (
                        <TeamDashboard
                          snapshot={snapshot}
                          busy={busy}
                          selectedTaskId={null}
                          onSelectTask={(taskId) => {
                            if (taskId) handleOpenTaskWorkspace(taskId, "team");
                          }}
                          starmapFocus={starmapFocus}
                          autoOpenMemberDialog={createIntent === "member"}
                          onAutoOpenHandled={() => setCreateIntent(null)}
                          recommendedMembers={recommendedMembers}
                          onRecommendedMembersHandled={() => setRecommendedMembers(null)}
                          autoEditMemberId={memberEditTarget}
                          onAutoEditHandled={() => setMemberEditTarget(null)}
                          onCreate={handleCreateAgent}
                          onRecommend={handleRecommendMembers}
                          onOpenSettings={() => openSettingsSection("models")}
                          onUpdate={handleUpdateAgent}
                          onDelete={handleDeleteAgent}
                          onOpenTask={(taskId) => handleShowTaskContext(taskId, "team")}
                          onOpenTaskPage={(taskId) => handleOpenTaskWorkspace(taskId, "team")}
                          scheduler={scheduler}
                          onOpenRuns={(taskId) =>
                            openRunsPanel(taskId ?? selectedTaskId, null, "team")
                          }
                          onOpenMergeQueue={handleOpenMergeQueue}
                          onOpenMemory={() => openPanel("board")}
                          onOpenTaskGit={(taskId) => handleOpenTaskVcs(taskId)}
                        />
                      )}
                    </LazyPanel>
                  );
                case "runs":
                  return (
                    <RunPanel
                      snapshot={snapshot}
                      scheduler={scheduler}
                      schedulerLoading={schedulerLoading}
                      schedulerError={schedulerError}
                      runs={taskRuns}
                      runsLoading={runsLoading}
                      runsError={runsError}
                      trace={trace}
                      selectedTaskId={selectedTaskId}
                      selectedRunId={selectedRunId}
                      busy={actionBusy}
                      onSelectTask={(taskId) => {
                        setSelectedTaskId(taskId);
                        setSelectedRunId(null);
                        void loadTrace(taskId);
                        void loadRuns(taskId);
                      }}
                      onSelectRun={setSelectedRunId}
                      onOpenRun={(taskId, runId) => {
                        setSelectedTaskId(taskId);
                        setSelectedRunId(runId);
                        void loadTrace(taskId);
                        void loadRuns(taskId);
                      }}
                      onOpenTaskPage={(taskId) =>
                        handleOpenTaskWorkspace(taskId, taskWorkspaceSource)
                      }
                      onOpenTaskChat={(taskId) =>
                        handleShowTaskContext(taskId, taskWorkspaceSource)
                      }
                      onStartTask={handleStartTask}
                      onRetryTask={handleRequestRetry}
                      onCancelTask={handleRequestCancelTask}
                      onCancelRun={handleRequestCancelRun}
                      onReviewTask={handleRequestReview}
                      onPause={handleRequestPauseScheduler}
                      onResume={handleRequestResumeScheduler}
                      onReloadScheduler={() => void loadScheduler(snapshot.workspace.id)}
                      onReloadRuns={() => {
                        if (selectedTaskId) void loadRuns(selectedTaskId);
                      }}
                      onOpenTasks={() => openPanel("tasks")}
                    />
                  );
                case "chat": {
                  const chatRouter =
                    snapshot.agents.find((agent) => agent.isRouter) ?? null;
                  if (!chatRouter) return null;
                  const chatModelOptions = snapshot.settings.models.map((profile) => {
                    const provider = snapshot.settings.providers.find(
                      (item) => item.id === profile.providerId,
                    );
                    return {
                      id: profile.id,
                      label: `${profile.label} · ${provider?.name ?? profile.providerId}`,
                    };
                  });
                  return (
                    <ChatView
                      messages={chatMessages}
                      liveStore={chatLiveStore}
                      turnByAssistant={chatTurnsByAssistant}
                      turnByUser={chatTurnByUser}
                      onRetryTurn={handleRetryTurn}
                      composerRef={chatComposerRef}
                      translateHistoryText={translateHistoryText}
                      translationRevision={translationRevision}
                      historyHasMore={Boolean(chatTurns?.hasMore)}
                      historyLoading={chatTurnsLoading}
                      historyError={chatTurnsError}
                      onLoadEarlierHistory={loadEarlierChatTurns}
                      view={chatView}
                      onViewChange={setChatView}
                      trajectory={chatTrajectory}
                      trajectoryLoading={chatTrajectoryLoading}
                      onRefreshTrajectory={() => void loadChatTrajectory()}
                      busy={chatBusy}
                      input={chatInput}
                      onInput={setChatInput}
                      onSend={handleSendChat}
                      onPlanFromChat={handlePlanFromChat}
                      onStop={handleStopChat}
                      questions={questionsByKey}
                      questionsLoaded={questionsLoaded}
                      pendingQuestionCount={pendingQuestions.length}
                      onOpenFirstQuestion={() => {
                        const first = pendingQuestions[0];
                        if (first) openQuestionModal(first.id);
                      }}
                      onAnswerQuestion={openQuestionModal}
                      onToast={pushToast}
                      taskContext={contextTaskId}
                      taskContextSource={contextSource}
                      onReturnToSource={
                        contextSource ? () => openPanel(contextSource) : undefined
                      }
                      onClearTaskContext={() => {
                        setContextTaskId(null);
                        setContextSource(null);
                      }}
                      onOpenContextPanel={() => openPanel("context")}
                      contextBusy={chatContextBusy}
                      onClearContext={() => void handleClearContext()}
                      onCompactContext={() => void handleCompactContext()}
                      overview={snapshot.workspace.overview}
                      routerAgent={chatRouter}
                      modelOptions={chatModelOptions}
                      fullThrottle={chatFullThrottle}
                      onModelChange={(model) => void handleChatControlUpdate({ model })}
                      onPermissionChange={(permission) =>
                        void handleChatControlUpdate({ permission })
                      }
                      onFullThrottleChange={(enabled) =>
                        void handleFullThrottleChange(enabled)
                      }
                    />
                  );
                }
                case "context":
                  return (
                    <ContextPanel
                      context={context}
                      taskContext={contextTaskId}
                      onClearTaskContext={() => {
                        setContextTaskId(null);
                        setContextSource(null);
                      }}
                    />
                  );
                case "mailbox":
                  return (
                    <MailboxView
                      snapshot={snapshot}
                      busy={busy}
                      selectedMessageId={selectedMessageId}
                      onSelectMessage={setSelectedMessageId}
                      autoOpenCompose={createIntent === "mail"}
                      onAutoOpenHandled={() => setCreateIntent(null)}
                      onSend={handleSendMessage}
                      readIds={mailboxReadIds}
                      onMarkRead={markMailboxRead}
                    />
                  );
                case "board":
                  return (
                    <LazyPanel load={loadMemoryPanel} label="记忆">
                      {(MemoryWorkbench) => (
                        <MemoryWorkbench
                          workspaceId={snapshot.workspace.id}
                          agents={snapshot.agents}
                          selectedBoard={selectedBoard}
                          onSelectBoard={setSelectedBoard}
                          autoOpenPublish={createIntent === "board"}
                          onAutoOpenHandled={() => setCreateIntent(null)}
                          onNotify={(message, kind) => pushToast({ kind: kind ?? "success", message })}
                          onStartPoll={(source) => {
                            setPollIntent({
                              title: source.title,
                              sourceId: source.sourceId,
                              scope: "board",
                              scopeId: source.sourceId,
                            });
                            openPanel("polls");
                          }}
                        />
                      )}
                    </LazyPanel>
                  );
                case "polls":
                  return (
                    <LazyPanel load={loadPollPanel} label="投票">
                      {(PollPanel) => (
                        <PollPanel
                          workspaceId={snapshot.workspace.id}
                          agents={snapshot.agents}
                          autoOpenCreate={pollIntent !== null}
                          initialSource={pollIntent}
                          onAutoOpenHandled={() => setPollIntent(null)}
                          onNotify={(message, kind) => pushToast({ kind: kind ?? "success", message })}
                        />
                      )}
                    </LazyPanel>
                  );
                case "watchdog":
                  if (!watchdogSnapshot) {
                    return (
                      <EmptyState
                        icon="◈"
                        title="看门狗尚未加载"
                        description="正在读取 watchdog/cost 快照；若持续为空，请检查主进程日志。"
                      />
                    );
                  }
                  return (
                    <WatchdogPanel
                      snapshot={watchdogSnapshot}
                      costs={watchdogCosts}
                      onAck={handleAckWatchdogAlert}
                      onResolve={handleResolveWatchdogAlert}
                      onRelease={handleReleaseWatchdogHold}
                      onOpenRun={(runId) => {
                        if (runId) openRunsPanel(selectedTaskId, runId);
                      }}
                    />
                  );
                default:
                  return null;
              }
  };
  panelRenderRef.current = renderPanelContent;

  // R2：每个 panel 的 domain deps；引用未变则 PanelHost 不 render。
  // 这里只列 panel 自身消费的 slice/selection，不把 App 的无关 state 混进来。
  const panelDepsByKey = buildPanelDeps({
    agents: snapshot.agents,
    chatRouter: snapshot.agents.find((agent) => agent.isRouter) ?? null,
    tasks: snapshot.tasks,
    workspace: snapshot.workspace,
    workspaceId: snapshot.workspace.id,
    runs: snapshot.runs,
    settings: snapshot.settings,
    boardEntries: snapshot.boardEntries,
    messages: snapshot.messages,
    selectedTask,
    selectedTaskId,
    trace,
    busy,
    taskStatusFilter,
    createIntent,
    scheduler,
    schedulerLoading,
    schedulerError,
    taskRuns,
    runsLoading,
    runsError,
    selectedRunId,
    actionBusy,
    actionError,
    watchdogAlerts: watchdogSnapshot?.alerts,
    watchdogHandoffs,
    taskWorkspaceSource,
    starmapFocus,
    mergeQueueItems,
    mergeQueueStale,
    planDraft,
    planSource,
    planIssues,
    planBusy,
    planError,
    planConfirming,
    chatMessages,
    chatTurnsByAssistant,
    chatTurnByUser,
    questionsByKey,
    questionsLoaded,
    pendingQuestions,
    chatBusy,
    chatInput,
    chatView,
    chatTrajectory,
    chatTrajectoryLoading,
    contextTaskId,
    contextSource,
    chatContextBusy,
    chatFullThrottle,
    workspaceOverview: snapshot.workspace.overview,
    context,
    selectedMessageId,
    selectedBoard,
    pollIntent,
    watchdogSnapshot,
    watchdogCosts,
  });
  return (
    <div className="app" data-translation-revision={translationRevision}>
      <SkipLink />
      <ChatLiveBridge
        store={chatLiveStore}
        workspaceId={snapshot.workspace.id}
        onSettled={handleChatLiveSettled}
      />
      <aside
        className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
        aria-label="侧栏"
        style={sidebarCollapsed ? undefined : { width: `${effectiveSidebarWidth}px` }}
      >
        <div className="brand">
          <div className="brand-mark small">DG</div>
          {!sidebarCollapsed && (
            <div className="brand-text">
              <div className="brand-name">DeerSuperGroup</div>
              <div className="muted tiny">AI team workspace</div>
            </div>
          )}
          <button
            type="button"
            className="ghost tiny sidebar-toggle"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? "展开侧栏（Ctrl/⌘+B）" : "折叠侧栏（Ctrl/⌘+B）"}
            aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? "»" : "«"}
          </button>
        </div>

        {sidebarCollapsed ? (
          <div className="sidebar-rail-workspace">
            <button
              type="button"
              className="ghost small sidebar-action"
              onClick={handleOpenWorkspace}
              disabled={busy}
              title={`切换工作区：${snapshot.workspace.name}`}
              aria-label="切换工作区"
            >
              <span className="sidebar-action-icon">⇄</span>
            </button>
          </div>
        ) : (
          <div className="workspace-box">
            <div className="section-label">工作区</div>
            <div className="workspace-name">{snapshot.workspace.name}</div>
            <div className="muted mono tiny ellipsis">{snapshot.workspace.path}</div>
            <button className="ghost small" onClick={handleOpenWorkspace} disabled={busy}>
              切换工作区
            </button>
          </div>
        )}

        <PrimaryRail
          activeKey={activeRailKey}
          collapsed={sidebarCollapsed}
          onOpen={openPrimaryPanel}
        />

        <div className="sidebar-actions">
          {!sidebarCollapsed && <div className="section-label">操作</div>}
          {(createMenuOpen || panelMenuOpen) && (
            <div
              className="menu-backdrop"
              onClick={() => {
                setCreateMenuOpen(false);
                setPanelMenuOpen(false);
              }}
            />
          )}
          <button
            type="button"
            className="ghost small sidebar-action"
            onClick={() => setPaletteOpen(true)}
            title="全局搜索与命令面板（Ctrl/⌘+K）"
          >
            <span className="sidebar-action-icon">⌘</span>
            <span className="sidebar-action-label">⌘K 搜索</span>
          </button>
          <div className="create-menu-wrap">
            <button
              type="button"
              className="primary small sidebar-action"
              onClick={() => {
                setPanelMenuOpen(false);
                setCreateMenuOpen((open) => !open);
              }}
              aria-expanded={createMenuOpen}
              aria-haspopup="menu"
              aria-label="新建"
              title="新建"
            >
              <span className="sidebar-action-icon">＋</span>
              <span className="sidebar-action-label">＋ 新建 ▾</span>
            </button>
            {createMenuOpen && (
              <div className="create-menu" role="menu" aria-label="新建">
                {(Object.keys(CREATE_LABELS) as CreateIntent[]).map((intent) => (
                  <button
                    key={intent}
                    type="button"
                    role="menuitem"
                    className="create-menu-item"
                    onClick={() => startCreate(intent)}
                  >
                    {CREATE_LABELS[intent]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ghost small sidebar-action"
            onClick={() => void handleManualRefresh()}
            aria-label="刷新"
            title="刷新"
          >
            <span className="sidebar-action-icon">↻</span>
            <span className="sidebar-action-label">刷新</span>
          </button>
          <button
            type="button"
            className="ghost small sidebar-action"
            onClick={() => openPanel("gitGraph")}
            aria-label="版本图"
            title="打开只读版本图"
          >
            <span className="sidebar-action-icon">◈</span>
            <span className="sidebar-action-label">版本图</span>
          </button>
          <button
            type="button"
            className="ghost small sidebar-action"
            onClick={handleOpenMergeQueue}
            aria-label="合并队列"
            title="打开合并队列面板"
          >
            <span className="sidebar-action-icon">⇥</span>
            <span className="sidebar-action-label">合并队列</span>
          </button>
          <div className="panel-menu-wrap">
            <button
              type="button"
              className="ghost small sidebar-action"
              onClick={togglePanelMenu}
              aria-expanded={panelMenuOpen}
              aria-haspopup="menu"
              aria-label="面板"
              title="面板：打开或聚焦面板"
            >
              <span className="sidebar-action-icon">▦</span>
              <span className="sidebar-action-label">面板</span>
            </button>
            {panelMenuOpen && (
              <div className="panel-menu" role="menu" aria-label="面板">
                <div className="panel-menu-head">
                  <span>面板</span>
                  <span className="muted tiny">点击打开 / 聚焦</span>
                </div>
                <input
                  className="panel-menu-search"
                  type="search"
                  value={panelSearch}
                  onChange={(event) => setPanelSearch(event.target.value)}
                  placeholder="搜索面板…"
                  aria-label="搜索面板"
                />
                {PANEL_LAUNCHER_GROUPS.map((group) => {
                  const visible = filterPanelLauncherKeys(panelSearch);
                  const keys = group.keys.filter((key) => visible.includes(key));
                  if (keys.length === 0) return null;
                  return (
                    <div
                      className="panel-menu-group"
                      role="group"
                      aria-label={group.label}
                      key={group.label}
                    >
                      <div className="panel-menu-group-title">{group.label}</div>
                      {keys.map((key) => {
                        const def = PANEL_DEFS[key];
                        const isOpen = openPanelKeys.includes(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            role="menuitem"
                            className={`panel-menu-item ${isOpen ? "is-open" : ""}`}
                            onClick={() => {
                              if (key === "planDraft" && !planSource) handlePlanDraftEntry();
                              else openPanel(key);
                            }}
                          >
                            <span className="panel-menu-title">{def.title}</span>
                            <span className="panel-menu-state">
                              {isOpen ? "已打开" : "打开"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {filterPanelLauncherKeys(panelSearch).length === 0 ? (
                  <div className="muted tiny" role="status">
                    没有匹配的面板
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ghost small sidebar-action"
            onClick={() => openPanel("settings")}
            title="设置"
          >
            <span className="sidebar-action-icon">⚙</span>
            <span className="sidebar-action-label">设置</span>
          </button>
          {!sidebarCollapsed && (
            <div className="sidebar-actions-row">
              <span className="topbar-live" aria-live="polite">
                {busy && <span className="pill busy">运行中…</span>}
              </span>
            </div>
          )}
          {!sidebarCollapsed && failedCount > 0 && (
            <button
              type="button"
              className="pill pill-failed sidebar-failed"
              onClick={jumpToFailedTasks}
              title="跳到任务页并过滤失败任务"
            >
              失败 {failedCount}
            </button>
          )}
        </div>

        {!sidebarCollapsed && (
          <div className="sidebar-panel-hint">
            <div className="section-label">导航提示</div>
            <p className="muted tiny">
              Dock 标签切换面板；拖动标签可拆分或合并分栏。
            </p>
            <p className="muted tiny">
              <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> 搜索与命令 ·{" "}
              <kbd>Ctrl B</kbd> 折叠侧栏 · <kbd>Alt 1–6</kbd> 快速切换。
            </p>
            <p className="muted tiny">
              设置已独立为弹窗：点击左侧 <kbd>⚙</kbd> 打开；关闭的面板可从{" "}
              <kbd>▦</kbd> 面板按钮重新打开。
            </p>
          </div>
        )}

        {!sidebarCollapsed && (
          <div className="sidebar-footer">
            <div className="muted tiny">
              {snapshot.settings.mock
                ? "Mock 模式"
                : snapshot.settings.providers[0]?.apiKeySource === "env"
                  ? `Key: ${snapshot.settings.providers[0]?.apiKeyEnvActive ?? ""}`
                  : snapshot.settings.providers[0]?.apiKeySource === "local"
                    ? "Key: 本地保存"
                    : "未配置 Key"}
            </div>
            <div className="muted tiny">{workers.length} 位成员</div>
          </div>
        )}
      </aside>

      {!sidebarCollapsed ? (
        <SeparatorControl
          className="resizer"
          label="调整侧栏宽度"
          value={effectiveSidebarWidth}
          min={180}
          max={sidebarMaxWidth(viewportWidth)}
          onStep={stepSidebarWidth}
          onReset={resetSidebarWidth}
          onMouseDown={startResize}
          onDoubleClick={resetSidebarWidth}
        />
      ) : null}

      <main className="main" id="main-content" aria-label="主内容" tabIndex={-1}>
        <WorkflowRail
          projection={workflowProjection}
          needs={needsMe}
          onStage={handleWorkflowStage}
          onNeedsMe={handleNeedsMeItem}
        />
        {firstRunState.show ? (
          <FirstRunCard
            state={firstRunState}
            collapsed={firstRunCollapsed}
            onToggle={() => setFirstRunCollapsed((value) => !value)}
            onAction={handleFirstRunAction}
          />
        ) : null}
        {error && (
          <ErrorRecoveryBar
            message={formatError(error)}
            retryAction={
              errorRetry?.message === error
                ? { label: errorRetry.label, run: errorRetry.run }
                : undefined
            }
            onOpenSettings={() => openSettingsSection("models")}
            onOpenModels={() => openSettingsSection("models")}
            onRetry={handleRetryAfterError}
            onClose={() => {
              setError(null);
              setErrorRetry(null);
            }}
          />
        )}

        {refreshStale && (
          <div
            className="notice small"
            role="status"
            data-stale-domains={[...staleDomains].join(",")}
          >
            {staleDomains.size > 0
              ? `以下数据可能过期：${[...staleDomains]
                  .map((domain) => REFRESH_DOMAIN_LABEL[domain])
                  .join("、")}。当前显示上次成功数据；连接恢复后会自动对齐。`
              : "实时刷新暂不可用，当前显示上次成功的数据；连接恢复后会自动对齐。"}
          </div>
        )}

        {watchdogSnapshot && (
          <div className="watchdog-topbar" role="region" aria-label="看门狗与预算">
            <button
              type="button"
              className="ghost tiny watchdog-topbar-open"
              onClick={() => openPanel("watchdog")}
            >
              看门狗
            </button>
            <BudgetBar
              spentUsd={watchdogSnapshot.budgets.workspaceDay.spentUsd}
              limitUsd={watchdogSnapshot.budgets.workspaceDay.limitUsd}
              ratio={watchdogSnapshot.budgets.workspaceDay.ratio}
              softRatio={watchdogSnapshot.budgets.softRatio}
              label="今日预算"
              onOpen={() => openPanel("watchdog")}
            />
            {watchdogSnapshot.alerts.some((alert) => alert.status === "open") && (
              <span className="pill pill-warning">
                告警 {watchdogSnapshot.alerts.filter((alert) => alert.status === "open").length}
              </span>
            )}
          </div>
        )}

        {/* t50：VSCode 风格 Dock 布局——对话/团队双主面板，其余视图为可拖动面板 */}
        <div className="dock-host" ref={dockHostRef}>
          <PanelHostProvider renderRef={panelRenderRef} depsByKey={panelDepsByKey}>
            <DockShell
              ref={dockRef}
              workspaceId={snapshot.workspace.id}
              dockWidth={dockWidth}
              windowWidth={viewportWidth}
              maxGroups={snapshot.settings.layout?.maxDockGroups ?? DEFAULT_MAX_DOCK_GROUPS}
              initialPanelKey={bootPanel}
              onActivePanelChange={handleDockActivePanel}
              onPanelClose={(key) => {
                if (key === "planDraft") handlePlanDraftPanelClosed();
                if (key === "mergeQueue") setMergeQueueOpen(false);
              }}
              onNotify={(message) => pushToast({ kind: "success", message })}
            />
          </PanelHostProvider>
        </div>
      </main>

      {/* C11：全局命令面板 */}
      {paletteOpen && snapshot && (
        <CommandPalette
          snapshot={snapshot}
          onClose={() => setPaletteOpen(false)}
          onNavigate={handlePaletteNavigate}
          onOpenTask={handlePaletteOpenTask}
          onOpenMessage={handlePaletteOpenMessage}
          onOpenBoard={handlePaletteOpenBoard}
          onCreate={startCreate}
          onPanelAction={handlePanelAction}
        />
      )}

      {settingsOpen && snapshot && (
        <Modal
          title="设置"
          description="模型、界面、翻译、Git、插件、MCP、Skills 与团队"
          onClose={closeSettings}
          confirmClose={settingsDirty}
          className="settings-modal"
        >
          <LazyPanel load={loadSettingsPanel} label="设置">
            {(SettingsView) => (
              <SettingsView
                snapshot={snapshot}
                busy={busy}
                onSave={handleSaveSettings}
                onDirtyChange={setSettingsDirty}
                onReload={() => void handleManualRefresh()}
                initialSection={gitSettingsFocus ? "git" : settingsInitialSection}
              />
            )}
          </LazyPanel>
        </Modal>
      )}

      {/* 合并队列已改为 Dock 面板；仅确认合并在面板内使用单次 Modal。 */}

      {/* t64：模型提问表单弹窗（不嵌套：风险审批优先，审批期间不渲染问题弹窗） */}
      {activeQuestion && !riskApproval && (
        <QuestionModal
          key={activeQuestion.id}
          question={activeQuestion}
          index={Math.max(
            0,
            pendingQuestions.findIndex((item) => item.id === activeQuestion.id),
          )}
          total={Math.max(1, pendingQuestions.length)}
          busy={chatBusy || submittingQuestion}
          initialValues={questionDrafts[activeQuestion.id]}
          onDraftChange={(values) =>
            setQuestionDrafts((previous) => ({ ...previous, [activeQuestion.id]: values }))
          }
          onSubmit={handleAnswerQuestion}
          onDefer={() => handleDeferQuestion(activeQuestion.id)}
          onCancel={() => handleCancelQuestion(activeQuestion.id)}
          onExpire={() => handleExpireQuestion(activeQuestion.id)}
        />
      )}

      {/* t58 IF-05：auto_risk 高风险人类审批弹窗（Esc/关闭 = 拒绝，安全默认） */}
      {riskApproval && (
        <Modal
          title="高风险操作需要人工确认"
          description={`auto_risk：以下操作需要人工确认，Agent 不能自行放行${
            riskApprovals.length > 1 ? `（队列 ${riskApprovals.length} 个，当前第 1 个）` : ""
          }`}
          onClose={() => void respondRiskApproval(false)}
        >
          <div className="risk-approval">
            <div className="risk-approval-grid">
              <div>
                <div className="section-label">风险等级</div>
                <span
                  className={`status status-${
                    riskApproval.risk === "high"
                      ? "failed"
                      : riskApproval.risk === "medium"
                        ? "running"
                        : "ready"
                  }`}
                >
                  {riskApproval.risk === "high"
                    ? "高风险"
                    : riskApproval.risk === "medium"
                      ? "中风险"
                      : "低风险"}
                </span>
              </div>
              <div>
                <div className="section-label">发起成员</div>
                <div>{riskApproval.agentName}</div>
              </div>
              <div>
                <div className="section-label">任务</div>
                <div className="mono tiny ellipsis" title={riskApproval.taskId}>
                  {riskApproval.taskId}
                </div>
              </div>
              <div>
                <div className="section-label">工具</div>
                <div className="mono">{riskApproval.toolName}</div>
              </div>
              <div>
                <div className="section-label">目标</div>
                <div className="mono ellipsis" title={riskApproval.target}>
                  {riskApproval.target}
                </div>
              </div>
            </div>
            <div>
              <div className="section-label">原因</div>
              <p className="muted">{riskApproval.reason}</p>
            </div>
            <div className="muted tiny">
              批准仅对本次调用生效，不改变成员权限；拒绝或 120 秒超时都会写入审计事件。
            </div>
            <div className="modal-foot">
              <button type="button" className="ghost" onClick={() => void respondRiskApproval(false)}>
                拒绝
              </button>
              <button type="button" className="primary" onClick={() => void respondRiskApproval(true)}>
                批准（仅本次）
              </button>
            </div>
          </div>
        </Modal>
      )}

      {pendingConfirm && (
        <KernelConfirmModal
          intent={pendingConfirm}
          reviewNotes={reviewNotes}
          onNotesChange={setReviewNotes}
          onClose={() => setPendingConfirm(null)}
          onConfirm={() => void confirmPendingAction()}
        />
      )}

      {/* t69：任务/Run/调度状态变化的 aria-live 播报（视觉隐藏）。t113：contextKey 变化静默重置基线。
          t204：全局 live region 与 toast 必须 portal 到 body；否则 Modal 打开时 #root inert 会冻结它们。 */}
      <AppLiveRegions
        tasks={snapshot.tasks}
        scheduler={scheduler}
        runs={taskRuns}
        actionMessage={kernelAnnouncement}
        contextKey={`${snapshot.workspace.id}:${tab}:${selectedTaskId ?? "-"}`}
        toasts={toasts}
        onDismiss={dismissToast}
      />
    </div>
  );
}

/**
 * t204：全局 live region（KernelAnnouncer + ToastHost）必须在 inert #root 外。
 * 顶层风险/设置/队列 Modal 打开时 #root.inert=true；若 toast/播报仍挂在 app 内，
 * 既不可读也不可关闭，aria-live 也不会被辅助技术播报。
 */
export function AppLiveRegions({
  tasks,
  scheduler,
  runs,
  actionMessage,
  contextKey,
  toasts,
  onDismiss,
}: {
  tasks: Task[];
  scheduler: SchedulerSnapshot | null;
  runs: Run[];
  actionMessage?: string | null;
  contextKey?: string;
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const content = (
    <>
      <KernelAnnouncer
        tasks={tasks}
        scheduler={scheduler}
        runs={runs}
        actionMessage={actionMessage}
        contextKey={contextKey}
      />
      {/* t206：toast 必须在 modal-backdrop(1000)/palette(150) 之上；
          用独立 fixed 层提升 z-index，且 pointer-events:none 不挡背景，
          .toast 自身 pointer-events:auto 保持关闭/action 可点击。 */}
      <div
        className="app-toast-layer"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1200,
          pointerEvents: "none",
        }}
      >
        <ToastHost toasts={toasts} onDismiss={onDismiss} />
      </div>
    </>
  );
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}

/** t69：有副作用的内核操作统一二次确认（Esc/焦点陷阱由 Modal 提供）。t107：文案走 kernelConfirmCopy 纯函数（含 resume）。 */
function KernelConfirmModal({
  intent,
  reviewNotes,
  onNotesChange,
  onClose,
  onConfirm,
}: {
  intent: ConfirmIntent;
  reviewNotes: string;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isReject = intent.kind === "review" && intent.decision === "reject";
  // t107 F1/F6：文案统一为纯函数（含 resume）；评审备注聚焦改用 Modal initialFocusRef（去掉 autoFocus）。
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const copy = kernelConfirmCopy({
    kind: intent.kind,
    taskTitle:
      intent.kind === "retry" || intent.kind === "cancelTask" || intent.kind === "review"
        ? intent.task.title
        : intent.kind === "cancelRun"
          ? intent.taskTitle
          : undefined,
    taskStatus:
      intent.kind === "cancelTask" || intent.kind === "retry" || intent.kind === "review"
        ? intent.task.status
        : undefined,
    runAttempt: intent.kind === "cancelRun" ? intent.run.attempt : undefined,
    decision: intent.kind === "review" ? intent.decision : undefined,
  });

  return (
    <Modal
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      confirmClose={intent.kind === "review" && Boolean(reviewNotes.trim())}
      initialFocusRef={intent.kind === "review" ? notesRef : undefined}
    >
      <div className="kernel-confirm">
        {intent.kind === "review" && (
          <label>
            {intent.decision === "reject" ? "拒绝备注（必填）" : "评审备注（可选）"}
            <textarea
              ref={notesRef}
              value={reviewNotes}
              onChange={(event) => onNotesChange(event.target.value)}
              rows={3}
              placeholder={
                intent.decision === "reject"
                  ? "说明拒绝原因，便于成员修复后重试"
                  : "可记录验收依据或后续建议"
              }
            />
          </label>
        )}
        {intent.kind === "cancelTask" && (
          <div className="notice small">
            取消不会删除任务与已有运行记录；需要重跑请新建任务或使用「重试」（仅失败任务）。
          </div>
        )}
        {intent.kind === "cancelRun" && (
          <div className="notice small">
            本次执行级取消只影响这一轮；任务可选择「重试」重新入队。
          </div>
        )}
        {intent.kind === "resume" && (
          <div className="notice small">
            恢复不是危险操作，此处确认用于避免误触；运行中的任务执行不受影响。
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            返回
          </button>
          <button
            type="button"
            className={copy.danger ? "primary danger-button" : "primary"}
            onClick={onConfirm}
            disabled={isReject && !reviewNotes.trim()}
            title={isReject && !reviewNotes.trim() ? "拒绝必须填写备注" : undefined}
          >
            {copy.confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const TASK_FILTERS: Array<TaskStatusFilter> = [
  "all",
  "queued",
  "running",
  "blocked",
  "ready",
  "review",
  "done",
  "failed",
  "cancelled",
];

function filterLabel(filter: TaskStatusFilter): string {
  return filter === "all" ? "全部" : TASK_STATUS_LABEL[filter];
}

function TasksView({
  snapshot,
  selectedTask,
  trace,
  busy,
  statusFilter,
  onStatusFilter,
  autoOpen,
  onAutoOpenHandled,
  onSelect,
  onCreate,
  onContext,
  onLocate,
  onPlanDraft,
  onStartPoll,
  scheduler,
  schedulerLoading,
  schedulerError,
  runs,
  runsLoading,
  runsError,
  selectedRunId,
  actionBusy,
  actionError,
  onReloadScheduler,
  onReloadRuns,
  onSelectRun,
  onOpenRuns,
  onStartTask,
  onRetryTask,
  onCancelTask,
  onCancelRun,
  onDeleteTask,
  onReviewTask,
  onPause,
  onResume,
  watchdogAlerts,
  onAckWatchdogAlert,
  onResolveWatchdogAlert,
  onReleaseWatchdogHold,
  watchdogHandoffs,
  workspaceSource,
  onReturnSource,
  onOpenGitGraph,
  onOpenMergeQueue,
  fullThrottle,
  onOpenModels,
  onEditOwner,
}: {
  snapshot: Snapshot;
  selectedTask: Task | null;
  trace: EventRecord[];
  busy: boolean;
  statusFilter: TaskStatusFilter;
  onStatusFilter: (filter: TaskStatusFilter) => void;
  /** C11：命令面板/「＋新建」触发的自动打开（task=新建任务，plan=规划任务）。 */
  autoOpen: "task" | "plan" | null;
  onAutoOpenHandled: () => void;
  onSelect: (task: Task) => void;
  onCreate: (title: string, description: string, acceptance: string[]) => Promise<boolean>;
  onContext: (taskId: string) => void;
  onLocate: (taskId: string) => void;
  onPlanDraft: () => void;
  onStartPoll: (task: Task) => void;
  scheduler: SchedulerSnapshot | null;
  schedulerLoading: boolean;
  schedulerError: string | null;
  runs: Run[];
  runsLoading: boolean;
  runsError: string | null;
  selectedRunId: string | null;
  actionBusy: string | null;
  actionError: string | null;
  onReloadScheduler: () => void;
  onReloadRuns: () => void;
  onSelectRun: (runId: string | null) => void;
  onOpenRuns: (taskId?: string | null, runId?: string | null) => void;
  onStartTask: (task: Task) => void;
  onRetryTask: (task: Task) => void;
  onCancelTask: (task: Task) => void;
  onCancelRun: (run: Run) => void;
  /** t167：删除任务；二级确认后由 App 调 API。 */
  onDeleteTask: (task: Task) => Promise<boolean>;
  onReviewTask: (task: Task, decision: "approve" | "reject") => void;
  onPause: () => void;
  onResume: () => void;
  watchdogAlerts?: WatchdogAlert[];
  onAckWatchdogAlert?: (alert: WatchdogAlert) => void;
  onResolveWatchdogAlert?: (alert: WatchdogAlert) => void;
  onReleaseWatchdogHold?: (alert: WatchdogAlert) => void;
  watchdogHandoffs?: Record<string, RunHandoff>;
  workspaceSource: "tasks" | "team";
  onReturnSource: () => void;
  onOpenGitGraph: () => void;
  onOpenMergeQueue: () => void;
  fullThrottle: boolean;
  onOpenModels: () => void;
  onEditOwner: (ownerId: string | null) => void;
}) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [taskTab, setTaskTab] = useState<TaskWorkspaceTab>(TASK_WORKSPACE_INITIAL_TAB);

  // C11：从顶栏/命令面板进入时自动打开对应弹窗（一次性）。
  useEffect(() => {
    if (!autoOpen) return;
    const action = tasksAutoOpenAction(autoOpen);
    if (action === "compose") setComposeOpen(true);
    if (action === "planDraft") onPlanDraft();
    onAutoOpenHandled();
  }, [autoOpen, onAutoOpenHandled, onPlanDraft]);
  const [search, setSearch] = useState("");
  // C06：任务列表分栏 280–520px 可拖宽、双击复位、可收起，宽度持久化。
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(localStorage.getItem("deer.taskListWidth"));
    return Number.isFinite(saved) && saved >= 280 && saved <= 520 ? saved : 380;
  });
  const [listCollapsed, setListCollapsed] = useState(
    () => localStorage.getItem("deer.taskListCollapsed") === "1",
  );
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const listWidthRef = useRef(listWidth);
  const listLayoutWidthRef = useRef(0);
  const resizingListRef = useRef(false);
  const [listLayoutWidth, setListLayoutWidth] = useState(0);

  useEffect(() => {
    const node = layoutRef.current;
    if (!node) {
      setListLayoutWidth(0);
      return;
    }
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      listLayoutWidthRef.current = width;
      setListLayoutWidth(width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [listCollapsed]);

  useEffect(() => {
    listWidthRef.current = listWidth;
  }, [listWidth]);

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!resizingListRef.current) return;
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = Math.min(520, Math.max(280, event.clientX - rect.left));
      listWidthRef.current = next;
      setListWidth(next);
    }
    function onUp() {
      if (!resizingListRef.current) return;
      resizingListRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("deer.taskListWidth", String(listWidthRef.current));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const taskListMax = taskListMaxWidth(listLayoutWidth);
  const actualListWidth = clampTaskListWidth(listWidth, listLayoutWidth);

  function startListResize(event: { preventDefault: () => void }) {
    event.preventDefault();
    resizingListRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function resetListWidth() {
    listWidthRef.current = 380;
    setListWidth(380);
    localStorage.setItem("deer.taskListWidth", "380");
  }

  function stepListWidth(delta: number) {
    const actual = clampTaskListWidth(listWidthRef.current, listLayoutWidthRef.current);
    const next = clampTaskListWidth(actual + delta, listLayoutWidthRef.current);
    listWidthRef.current = next;
    setListWidth(next);
    localStorage.setItem("deer.taskListWidth", String(next));
  }

  function toggleListCollapsed() {
    setListCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem("deer.taskListCollapsed", next ? "1" : "0");
      return next;
    });
  }

  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const hasWorker = snapshot.agents.some(
    (agent) => !agent.isRouter && agent.status !== "offline",
  );
  const counts = statusCounts(snapshot.tasks);
  const filteredTasks = filterTaskList(snapshot.tasks, statusFilter, search);
  const actionState = selectedTask
    ? taskActionState(selectedTask, taskById, hasWorker)
    : null;
  const selectedTaskDeps = selectedTask
    ? selectedTask.dependsOn
        .map((id) => taskById.get(id))
        .filter((item): item is Task => Boolean(item))
    : [];
  const unfilledDeps = selectedTaskDeps.filter((task) => task.status !== "done");
  const selectedOwner = selectedTask?.ownerId ? agents.get(selectedTask.ownerId) ?? null : null;
  const contract = taskExecutionContract(
    selectedTask,
    snapshot.agents,
    fullThrottle,
    trace.length,
  );
  const currentRun =
    runs.find((run) => run.id === selectedRunId) ??
    runs.find((run) => run.status === "running") ??
    runs[0] ??
    null;
  const workspaceNext =
    selectedTask && actionState
      ? taskWorkspaceNext({
          task: selectedTask,
          startEnabled: actionState.start.enabled,
          startReason: actionState.start.reason,
          retryEnabled: actionState.retry.enabled,
          retryReason: actionState.retry.reason,
          unfilledDeps: unfilledDeps.length,
        })
      : null;

  useEffect(() => {
    setTaskTab(TASK_WORKSPACE_INITIAL_TAB);
  }, [selectedTask?.id]);

  function openTaskTab(tab: TaskWorkspaceTab, focus = true) {
    setTaskTab(tab);
    if (focus) {
      window.setTimeout(() => {
        document.getElementById(taskWorkspacePanelId(tab))?.focus();
      }, 0);
    }
  }

  function runWorkspacePrimary() {
    if (!selectedTask || !workspaceNext) return;
    if (workspaceNext.key === "run") {
      onStartTask(selectedTask);
      return;
    }
    if (workspaceNext.key === "retry") {
      onRetryTask(selectedTask);
      return;
    }
    if (workspaceNext.key === "upstream") {
      const dependency = unfilledDeps[0];
      if (dependency) onSelect(dependency);
      return;
    }
    if (workspaceNext.tab) openTaskTab(workspaceNext.tab);
  }

  function countFor(filter: TaskStatusFilter): number {
    return filter === "all" ? counts.all : counts[filter];
  }

  function taskRuntimeHint(task: Task): string | null {
    if (task.status === "queued") {
      return `排队中 · 已等 ${task.queuedAt ? formatRelative(task.queuedAt) : "—"}`;
    }
    if (task.status === "blocked" && task.blockedReason) {
      return blockedReasonText(task.blockedReason);
    }
    if (task.status === "failed" && task.failureKind) {
      return failureKindText(task.failureKind);
    }
    if (task.status === "running") {
      return `第 ${task.attemptCount ?? 0} 次执行`;
    }
    if (task.status === "review") {
      return "等待评审批准";
    }
    return null;
  }

  return (
    <div
      className={`tasks-layout ${listCollapsed ? "collapsed" : ""}`}
      ref={layoutRef}
      style={
        listCollapsed ? undefined : ({ "--task-list-w": `${listWidth}px` } as CSSProperties)
      }
    >
      <SchedulerBar
        scheduler={scheduler}
        tasks={snapshot.tasks}
        agents={snapshot.agents}
        loading={schedulerLoading}
        error={schedulerError}
        busy={actionBusy}
        onRetryLoad={onReloadScheduler}
        onPause={onPause}
        onResume={onResume}
        onOpenRuns={() => onOpenRuns(selectedTask?.id ?? null, selectedRunId)}
        onSelectTask={(taskId) => {
          const task = taskById.get(taskId);
          if (task) onSelect(task);
        }}
      />
      {!listCollapsed && (
        <section className="panel task-list-panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">任务</div>
              <div className="muted tiny">
                {filteredTasks.length} / {snapshot.tasks.length} 个任务
              </div>
            </div>
            <div className="row gap">
              {snapshot.tasks.length > 0 ? (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => onPlanDraft()}
                  disabled={busy}
                  title="从对话目标生成可编辑 Plan Draft（secondary；不会直接创建任务）"
                  aria-label="从对话规划（secondary，不会直接创建任务）"
                >
                  从对话规划
                </button>
              ) : null}
              <button
                type="button"
                className="primary small"
                onClick={() => setComposeOpen(true)}
                disabled={busy}
              >
                + 新建
              </button>
            </div>
          </div>

          <div className="task-toolbar">
            <input
              className="task-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题 / ID / 摘要"
              aria-label="搜索任务"
            />
            <div className="task-filter-chips">
              {TASK_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`chip ${statusFilter === filter ? "active" : ""}`}
                  onClick={() => onStatusFilter(filter)}
                >
                  {filterLabel(filter)} {countFor(filter)}
                </button>
              ))}
            </div>
          </div>

          <div className="task-list">
            {snapshot.tasks.length === 0 && (
              // C24：空状态带行动引导。
              <EmptyState
                icon="✓"
                title="还没有任务"
                description="直接创建一个任务，或让 Router 把目标拆成任务 DAG。"
                actions={[
                  { label: "+ 新建任务", onClick: () => setComposeOpen(true), primary: true },
                ]}
              />
            )}
            {snapshot.tasks.length > 0 && filteredTasks.length === 0 && (
              <EmptyState
                compact
                icon="⌕"
                title="没有符合当前过滤条件的任务"
                description="调整搜索词或状态过滤后再试。"
                actions={[{ label: "清除过滤", onClick: () => { setSearch(""); onStatusFilter("all"); } }]}
              />
            )}
            {filteredTasks.map((task) => {
              const owner = task.ownerId ? agents.get(task.ownerId) : null;
              const hint = taskRuntimeHint(task);
              return (
                <button
                  key={task.id}
                  className={`task-row compact ${selectedTask?.id === task.id ? "selected" : ""}`}
                  onClick={() => onSelect(task)}
                >
                  <div className="task-row-top">
                    <span className="task-title">{task.title}</span>
                    <StatusBadge status={task.status} />
                  </div>
                  <div className="muted tiny task-row-meta">
                    <span>{owner ? owner.name : "未分配"}</span>
                    <span title="自动重试上限 3 次（总尝试）">
                      尝试 {taskAttemptRatioText(task)}
                    </span>
                    {task.dependsOn.length > 0 && <span>依赖 {task.dependsOn.length}</span>}
                    <span>{time(task.createdAt)}</span>
                  </div>
                  {hint && (
                    <div
                      className={`task-row-hint ${
                        task.status === "failed" ? "is-error" : ""
                      }`}
                    >
                      {hint}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!listCollapsed && listLayoutWidth > 640 ? (
        <SeparatorControl
          className="task-resizer"
          label="调整任务列表宽度"
          value={actualListWidth}
          min={280}
          max={taskListMax}
          onStep={stepListWidth}
          onReset={resetListWidth}
          onMouseDown={startListResize}
          onDoubleClick={resetListWidth}
        />
      ) : null}

      <section className="panel task-detail-panel">
        <div className="panel-head">
          <div className="row gap">
            {listCollapsed && (
              <button
                type="button"
                className="ghost tiny"
                onClick={toggleListCollapsed}
                title="展开任务列表"
              >
                » 任务列表
              </button>
            )}
            <div className="panel-title">
              {selectedTask ? selectedTask.title : "任务详情"}
            </div>
          </div>
          {selectedTask && (
            <div className="row gap">
              <button
                type="button"
                className="ghost tiny"
                onClick={toggleListCollapsed}
                title={listCollapsed ? "展开任务列表" : "收起任务列表"}
              >
                {listCollapsed ? "展开列表" : "收起列表"}
              </button>
              <button
                type="button"
                className="ghost tiny run-danger"
                onClick={() => setDeleteOpen(true)}
                disabled={busy}
                title="删除任务：需要二级确认；运行中任务需先取消"
              >
                删除任务
              </button>
            </div>
          )}
        </div>

        {!selectedTask && (
          <EmptyState
            icon="☰"
            title={snapshot.tasks.length === 0 ? "创建第一个任务" : "选择一个任务"}
            description={
              snapshot.tasks.length === 0
                ? "先新建一个任务；也可以从对话页让 Router 先规划。"
                : "在左侧列表选择任务，查看详情与执行 trace。"
            }
            actions={
              snapshot.tasks.length === 0
                ? [
                    { label: "+ 新建任务", onClick: () => setComposeOpen(true), primary: true },
                  ]
                : undefined
            }
          />
        )}
        {selectedTask && (
          <>
            {(watchdogAlerts ?? [])
              .filter(
                (alert) =>
                  alert.taskId === selectedTask.id && alert.status !== "resolved",
              )
              .slice(0, 3)
              .map((alert) => (
                <WatchdogAlertBanner
                  key={alert.id}
                  alert={alert}
                  onAck={onAckWatchdogAlert}
                  onResolve={onResolveWatchdogAlert}
                  onRelease={onReleaseWatchdogHold}
                />
              ))}
            <div className="task-workspace-head">
              <div className="task-workspace-title-row">
                <div className="task-workspace-identity">
                  <div className="row gap wrap">
                    <strong>{selectedTask.title}</strong>
                    <StatusBadge status={selectedTask.status} />
                    <span className="muted tiny mono">{selectedTask.id}</span>
                  </div>
                  <div className="muted tiny task-workspace-meta">
                    <span>负责人：{selectedOwner?.name ?? "未分配"}</span>
                    <span>优先级：{selectedTask.priority ?? 50}</span>
                    <span>当前执行：{currentRun ? currentRun.id.slice(0, 10) : "无"}</span>
                  </div>
                  <TaskContractChips
                    contract={contract}
                    fullThrottle={fullThrottle}
                    onOpenModels={onOpenModels}
                    onEditOwner={onEditOwner}
                  />
                </div>
                <div className="row gap wrap task-workspace-actions">
                  {workspaceSource === "team" ? (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={onReturnSource}
                      title="返回团队"
                    >
                      ← 返回团队
                    </button>
                  ) : null}
                  <details className="task-workspace-more">
                    <summary className="ghost small">更多</summary>
                    <div className="task-workspace-more-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="ghost small"
                        onClick={() => onLocate(selectedTask.id)}
                        title="在团队页星图中定位该任务"
                      >
                        在星图中定位
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="ghost small"
                        onClick={() => onContext(selectedTask.id)}
                        title="在对话页查看这次任务的上下文"
                      >
                        查看上下文
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="ghost small"
                        onClick={() => onStartPoll(selectedTask)}
                        title="从该任务发起团队投票"
                      >
                        发起投票
                      </button>
                    </div>
                  </details>
                  <button
                    className="ghost small run-danger"
                    disabled={
                      !actionState?.cancel.enabled ||
                      actionBusy === `task:cancel:${selectedTask.id}`
                    }
                    onClick={() => onCancelTask(selectedTask)}
                    title={actionState?.cancel.reason || "取消任务：正在执行的任务会中止，取消是终态"}
                    aria-describedby={
                      actionState?.cancel.enabled ? undefined : "task-action-hint"
                    }
                  >
                    {actionBusy === `task:cancel:${selectedTask.id}` ? "取消中…" : "取消任务"}
                  </button>
                  {workspaceNext ? (
                    <button
                      className="primary small task-workspace-primary"
                      disabled={
                        workspaceNext.disabled ||
                        actionBusy === `task:${workspaceNext.key}:${selectedTask.id}`
                      }
                      onClick={runWorkspacePrimary}
                      title={workspaceNext.reason || workspaceNext.detail}
                      aria-describedby={
                        workspaceNext.disabled ? "task-workspace-primary-hint" : undefined
                      }
                    >
                      {workspaceNext.label}
                    </button>
                  ) : null}
                </div>
              </div>
              {workspaceNext ? (
                <div className={`task-workspace-next tone-${workspaceNext.key}`} role="status">
                  <strong>{workspaceNext.label}</strong>
                  <span>{workspaceNext.detail}</span>
                  {workspaceNext.disabled && workspaceNext.reason ? (
                    <span id="task-workspace-primary-hint" className="muted tiny">
                      {workspaceNext.reason}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* t107 F3：不可用操作的原因（供 aria-describedby 引用；视觉上由 primary next 承载）。 */}
            {actionState && (
              <div id="task-action-hint" className="sr-only">
                {[
                  actionState.start,
                  actionState.retry,
                  actionState.review,
                  actionState.cancel,
                ]
                  .filter((gate) => !gate.enabled && gate.reason)
                  .map((gate) => gate.reason)
                  .join("；")}
              </div>
            )}

            {actionError && (
              <div className="error banner task-action-error" role="alert">
                <span>操作失败：{formatError(actionError)}</span>
              </div>
            )}

            <TaskWorkspaceTabs
              tab={taskTab}
              onChange={(tab) => openTaskTab(tab, false)}
              counts={{
                runs: runs.length,
                review: selectedTask.status === "review" ? 1 : undefined,
              }}
            />

            {taskTab === "overview" && (
              <div
                className="task-workspace-panel"
                id={taskWorkspacePanelId("overview")}
                role="tabpanel"
                aria-labelledby="task-tab-overview"
                tabIndex={0}
              >
                {!hasWorker ? (
                  <div className="notice">
                    还没有可用成员。请先到「团队」创建成员或把成员设为非离线，再运行任务。
                  </div>
                ) : null}
                {unfilledDeps.length > 0 ? (
                  <div className="task-workspace-upstream muted tiny">
                    上游依赖：
                    {unfilledDeps.map((dep) => (
                      <button
                        key={dep.id}
                        type="button"
                        className="link-button"
                        onClick={() => onSelect(dep)}
                      >
                        {dep.title}（{TASK_STATUS_LABEL[dep.status]}）
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="task-runtime-grid">
              <div>
                <div className="section-label">尝试</div>
                <div>{taskAttemptRatioText(selectedTask)}（共 {selectedTask.attemptCount ?? 0} 次）</div>
              </div>
              <div>
                <div className="section-label">优先级</div>
                <div>{selectedTask.priority ?? 50}</div>
              </div>
              <div>
                <div className="section-label">入队</div>
                <div title={selectedTask.queuedAt ?? undefined}>
                  {selectedTask.queuedAt ? formatRelative(selectedTask.queuedAt) : "—"}
                </div>
              </div>
              <div>
                <div className="section-label">开始 / 结束</div>
                <div className="muted tiny">
                  {selectedTask.startedAt ? formatRelative(selectedTask.startedAt) : "—"} /{" "}
                  {selectedTask.endedAt ? formatRelative(selectedTask.endedAt) : "—"}
                </div>
              </div>
              <div>
                <div className="section-label">阻塞 / 失败原因</div>
                <div className="muted tiny">
                  {selectedTask.blockedReason
                    ? blockedReasonText(selectedTask.blockedReason)
                    : selectedTask.failureKind
                      ? failureKindText(selectedTask.failureKind)
                      : "—"}
                </div>
              </div>
              <div>
                <div className="section-label">依赖</div>
                <div className="muted tiny">
                  {selectedTask.dependsOn.length === 0
                    ? "无"
                    : `${selectedTask.dependsOn.length} 个（${unfilledDeps.length} 个未完成）`}
                </div>
              </div>
            </div>

            <div className="detail-grid">
              <div>
                <div className="section-label">描述</div>
                <p className="detail-text">{selectedTask.description || "（无）"}</p>
              </div>
              <div>
                <div className="section-label">验收标准</div>
                {selectedTask.acceptance.length === 0 ? (
                  <p className="detail-text">（无）</p>
                ) : (
                  <ul className="detail-list">
                    {selectedTask.acceptance.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="section-label">摘要</div>
                <p className="detail-text">{selectedTask.summary || "（尚未完成）"}</p>
              </div>
                <div>
                  <div className="section-label">执行契约 / 来源</div>
                  <div className="muted tiny task-workspace-contract">
                    <span>负责人：{contract.ownerName}</span>
                    <span>模型：{contract.model}</span>
                    <span>权限：{contract.permissionLabel}</span>
                    <span>FT：{contract.fullThrottle}</span>
                    <span>优先级：{selectedTask.priority ?? 50}</span>
                    <span>来源：任务列表 / {workspaceSource === "team" ? "团队" : "任务页"}</span>
                  </div>
                </div>
              </div>
              </div>
            )}

            {taskTab === "runs" && (
              <div
                className="task-workspace-panel"
                id={taskWorkspacePanelId("runs")}
                role="tabpanel"
                aria-labelledby="task-tab-runs"
                tabIndex={0}
              >
                <RunHistory
                  task={selectedTask}
                  runs={runs}
                  agents={snapshot.agents}
                  events={trace}
                  loading={runsLoading}
                  error={runsError}
                  selectedRunId={selectedRunId}
                  busy={actionBusy}
                  onRetryLoad={onReloadRuns}
                  onSelectRun={(runId) => onSelectRun(runId)}
                  onCancelRun={onCancelRun}
                  onOpenRunPanel={(runId) =>
                    onOpenRuns(selectedTask.id, runId ?? selectedRunId)
                  }
                  onRetryTask={() => onRetryTask(selectedTask)}
                  handoffs={watchdogHandoffs}
                />
              </div>
            )}

            {taskTab === "git" && (
              <div
                className="task-workspace-panel"
                id={taskWorkspacePanelId("git")}
                role="tabpanel"
                aria-labelledby="task-tab-git"
                tabIndex={0}
              >
                <div className="task-git-section" id="task-git-section">
                  <TaskVcsPanel key={selectedTask.id} taskId={selectedTask.id} onOpenGraph={onOpenGitGraph} onOpenMergeQueue={onOpenMergeQueue} />
                </div>
                <div className="muted tiny" role="note" aria-label="合并确认说明">
                  Git / PR / worktree 与入队准备不是合并确认；合并确认只在合并队列中执行。
                </div>
                <div className="row gap task-workspace-git-actions">
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => onOpenRuns(selectedTask.id, selectedRunId)}
                  >
                    打开运行面板
                  </button>
                </div>
              </div>
            )}

            {taskTab === "review" && (
              <div
                className="task-workspace-panel"
                id={taskWorkspacePanelId("review")}
                role="tabpanel"
                aria-labelledby="task-tab-review"
                tabIndex={0}
              >
                <div className="task-workspace-gate-actions">
                  <button
                    className="primary small"
                    disabled={
                      !actionState?.review.enabled ||
                      actionBusy === `task:review:${selectedTask.id}`
                    }
                    onClick={() => onReviewTask(selectedTask, "approve")}
                    title={actionState?.review.reason || "批准任务交付"}
                    aria-label="批准任务交付（任务交付 gate；不是代码评审通过）"
                  >
                    批准任务交付
                  </button>
                  <button
                    className="ghost small run-danger"
                    disabled={
                      !actionState?.review.enabled ||
                      actionBusy === `task:review:${selectedTask.id}`
                    }
                    onClick={() => onReviewTask(selectedTask, "reject")}
                    title={actionState?.review.reason || "拒绝任务交付（REVIEW_REJECTED）"}
                    aria-label="拒绝任务交付（任务交付 gate；不是代码评审拒绝）"
                  >
                    拒绝任务交付
                  </button>
                  <ApprovalTerms />
                </div>
                <div id="task-review-section" className="task-review-section">
                  <ReviewSection key={`review-${selectedTask.id}`} taskId={selectedTask.id} />
                </div>
              </div>
            )}

            {taskTab === "history" && (
              <div
                className="task-workspace-panel"
                id={taskWorkspacePanelId("history")}
                role="tabpanel"
                aria-labelledby="task-tab-history"
                tabIndex={0}
              >
                <div className="task-history-runs">
                  <div className="section-label">最近执行（{runs.length}）</div>
                  {runs.length === 0 ? (
                    <div className="empty small">还没有执行记录。</div>
                  ) : (
                    <ul className="task-history-run-list">
                      {runs.slice(0, 8).map((run) => (
                        <li key={run.id}>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => onSelectRun(run.id)}
                          >
                            {run.id.slice(0, 10)} · {run.status}
                            {run.startedAt ? ` · ${formatRelative(run.startedAt)}` : ""}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="trace-head">
              <div className="section-label">执行 trace（最近）</div>
              <span className="muted tiny">
                {trace.length > 100 ? `最近 100 / 共 ${trace.length} 条` : `${trace.length} 条事件`}
              </span>
            </div>
            <div className="trace">
              {trace.length === 0 && <div className="empty small">还没有执行记录。</div>}
              {trace.slice(-100).map((event) => (
                <TraceItem key={event.seq} event={event} />
              ))}
            </div>
              </div>
            )}
          </>
        )}
      </section>

      {composeOpen && (
        <TaskComposeModal
          busy={busy}
          onClose={() => setComposeOpen(false)}
          onCreate={onCreate}
        />
      )}

      {deleteOpen && selectedTask && (
        <DangerConfirmModal
          title="删除任务？"
          description="任务、运行记录与摘要会被永久删除；事件日志保留。"
          subject={selectedTask.title}
          subjectLabel="任务标题"
          impact={[
            "任务及其运行记录、摘要、行级评审数据会被清理。",
            "事件日志保留，但任务不再出现在任务列表/星图。",
            "仍有其他任务依赖它时，删除会被拒绝。",
            "运行中/排队中的任务需先取消。",
          ]}
          confirmLabel="永久删除任务"
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => onDeleteTask(selectedTask)}
        />
      )}
    </div>
  );
}

export function TaskComposeModal({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string, acceptance: string[]) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const dirty = Boolean(title.trim() || description.trim() || acceptance.trim());

  return (
    <Modal
      title="新建任务"
      description="描述目标、约束与验收标准"
      onClose={onClose}
      confirmClose={dirty}
    >
      <form
        className="form modal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          const created = await onCreate(
            title.trim(),
            description.trim(),
            acceptance
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
          );
          if (created) onClose();
        }}
      >
        <label>
          标题
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：给健康检查接口补测试"
          />
        </label>
        <label>
          描述
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            placeholder="背景、目标、约束、相关文件…"
          />
        </label>
        <label>
          验收标准（一行一条）
          <textarea
            value={acceptance}
            onChange={(event) => setAcceptance(event.target.value)}
            rows={4}
            placeholder="例如：新增接口返回 200&#10;测试覆盖成功与失败路径"
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            创建任务
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TraceItem({ event }: { event: EventRecord }) {
  const payload = event.payload as Record<string, unknown> | null;
  // t69：内核事件优先用统一中文标签 + 一行摘要；旧 tool/assistant 事件保留原有精炼口径。
  const summary = eventSummary(event);
  let body = summary || payloadText(event.payload);
  if (event.type === "assistant.message" && payload?.text) body = String(payload.text);
  if (event.type === "tool.call" && payload?.name) {
    body = `${String(payload.name)} ${String(payload.arguments ?? "").slice(0, 600)}`;
  }
  if (event.type === "tool.result" && payload?.name) {
    body = `${String(payload.name)} → ${payload.ok ? "ok" : `error: ${String(payload.error)}`}`;
  }
  if (event.type === "run.completed" && payload?.usage) {
    body = `usage ${JSON.stringify(payload.usage)}`;
  }
  return (
    <div
      className={`trace-item trace-${event.type.replace(/\./g, "-")} tone-${eventTone(
        event.type,
      )}`}
    >
      <div className="trace-meta">
        <span className="mono tiny">{time(event.createdAt)}</span>
        <span className="trace-type" title={event.type}>
          {eventTypeLabel(event.type)}
        </span>
        <span className="muted tiny">{event.actor}</span>
      </div>
      <pre className="trace-body">{body}</pre>
    </div>
  );
}

// C10：旧 RouterView 已移除；t235 旧 RouterPlanModal 也删除，所有规划入口统一到 Plan Draft。

function mailboxScrollItems(
  container: HTMLElement | null,
  attribute: "data-thread-id" | "data-message-id",
): MailboxScrollItem[] {
  if (!container) return [];
  const containerRect = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`)).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.getAttribute(attribute) ?? "",
      // offsetTop 相对 offsetParent（可能含 panel header），这里换成相对滚动容器的 content offset。
      offsetTop: rect.top - containerRect.top + container.scrollTop,
      offsetHeight: rect.height,
    };
  });
}

function readMailboxScrollState(storageKey: string): MailboxScrollState {
  try {
    if (typeof sessionStorage === "undefined") return parseMailboxScrollState(null);
    return parseMailboxScrollState(sessionStorage.getItem(storageKey));
  } catch {
    return parseMailboxScrollState(null);
  }
}

function writeMailboxScrollState(storageKey: string, state: MailboxScrollState): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(storageKey, serializeMailboxScrollState(state));
    }
  } catch {
    // sessionStorage 不可用时只保留当前会话内存锚点。
  }
}

export function MailboxView({
  snapshot,
  busy,
  selectedMessageId,
  onSelectMessage,
  autoOpenCompose,
  onAutoOpenHandled,
  onSend,
  readIds,
  onMarkRead,
}: {
  snapshot: Snapshot;
  busy: boolean;
  /** C12：选中邮件提升到 App，进入 #/mailbox?m=<id> 深链。 */
  selectedMessageId: string | null;
  onSelectMessage: (messageId: string) => void;
  /** C11：命令面板/「＋新建」触发的自动打开发邮件弹窗（一次性）。 */
  autoOpenCompose: boolean;
  onAutoOpenHandled: () => void;
  onSend: (input: {
    to: string[];
    subject: string;
    body: string;
    kind: MailboxMessage["kind"];
    threadId?: string;
    parentId?: string;
  }) => Promise<boolean>;
  readIds: ReadonlySet<string>;
  onMarkRead: (ids: string[]) => void;
}) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeThread, setComposeThread] = useState<MailboxThread | null>(null);
  const [composeParentId, setComposeParentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [member, setMember] = useState("");
  const threadRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chainRef = useRef<HTMLDivElement | null>(null);
  const scrollStorageKey = `deer.mailbox.scroll.${snapshot.workspace.id}`;
  const scrollStateRef = useRef<MailboxScrollState>(readMailboxScrollState(scrollStorageKey));

  useEffect(() => {
    if (!autoOpenCompose) return;
    setComposeThread(null);
    setComposeParentId(null);
    setComposeOpen(true);
    onAutoOpenHandled();
  }, [autoOpenCompose, onAutoOpenHandled]);

  const threads = useMemo(
    () => deriveMailboxThreads(snapshot.messages, readIds),
    [snapshot.messages, readIds],
  );
  const participants = useMemo(() => mailboxParticipants(threads), [threads]);
  const visibleThreads = useMemo(
    () => filterMailboxThreads(threads, query, member || null),
    [threads, query, member],
  );
  const selectedThreadMatch =
    selectedMessageId === null
      ? null
      : threads.find((thread) =>
          thread.messages.some((entry) => entry.message.id === selectedMessageId),
        ) ?? null;
  const selectedHidden = Boolean(
    selectedThreadMatch &&
      !visibleThreads.some((thread) => thread.threadId === selectedThreadMatch.threadId),
  );
  const selectedThread = selectedHidden
    ? null
    : selectedMessageId === null
      ? visibleThreads[0] ?? null
      : visibleThreads.find((thread) =>
          thread.messages.some((entry) => entry.message.id === selectedMessageId),
        ) ?? null;
  const unreadTotal = useMemo(() => totalMailboxUnread(threads), [threads]);
  const rovingThreadId = selectedThread?.threadId ?? visibleThreads[0]?.threadId ?? null;

  function rememberScroll() {
    const list = listRef.current;
    if (!list) return;
    const chain = chainRef.current;
    const next = captureMailboxScrollState(
      mailboxScrollItems(list, "data-thread-id"),
      list.scrollTop,
      mailboxScrollItems(chain, "data-message-id"),
      chain?.scrollTop ?? 0,
    );
    scrollStateRef.current = next;
    writeMailboxScrollState(scrollStorageKey, next);
  }

  useEffect(() => {
    scrollStateRef.current = readMailboxScrollState(scrollStorageKey);
  }, [scrollStorageKey]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const threadTop = restoreMailboxScrollTop(
      mailboxScrollItems(list, "data-thread-id"),
      scrollStateRef.current.thread,
    );
    if (threadTop !== null) list.scrollTop = threadTop;
    const chain = chainRef.current;
    if (chain) {
      const messageTop = restoreMailboxScrollTop(
        mailboxScrollItems(chain, "data-message-id"),
        scrollStateRef.current.message,
      );
      chain.scrollTop = messageTop ?? 0;
    }
    if (!scrollStateRef.current.thread.id) rememberScroll();
  }, [visibleThreads, selectedThread?.threadId]);

  useEffect(() => () => rememberScroll(), [scrollStorageKey]);

  function selectThread(thread: MailboxThread) {
    onMarkRead(thread.messages.map((entry) => entry.message.id));
    onSelectMessage(thread.threadId);
  }

  function openCompose(thread: MailboxThread | null, parentId: string | null = null) {
    setComposeThread(thread);
    setComposeParentId(parentId);
    setComposeOpen(true);
  }

  function markAllRead() {
    onMarkRead(threads.flatMap((thread) => thread.messages.map((entry) => entry.message.id)));
  }

  function onThreadKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    const count = visibleThreads.length;
    if (count === 0) return;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? count - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    threadRefs.current[next]?.focus();
    selectThread(visibleThreads[next]);
  }

  return (
    <div className="mailbox-layout">
      <section className="panel mailbox-list-panel">
        <div className="panel-head mailbox-thread-head">
          <div>
            <div className="panel-title">邮箱</div>
            <div className="muted tiny">
              {threads.length} 个线程 · {snapshot.messages.length} 封内部消息
            </div>
          </div>
          <div className="row gap mailbox-thread-head-actions">
            <span
              className="mailbox-unread-total"
              role="status"
              aria-live="polite"
              aria-label={`${unreadTotal} 封未读邮件`}
            >
              {unreadTotal > 0 ? `${unreadTotal} 未读` : "全部已读"}
            </span>
            <button
              type="button"
              className="ghost tiny"
              onClick={markAllRead}
              disabled={unreadTotal === 0}
            >
              全部标为已读
            </button>
            <button
              type="button"
              className="primary small"
              onClick={() => openCompose(null)}
              disabled={busy}
            >
              发邮件
            </button>
          </div>
        </div>

        <div className="mailbox-thread-filters">
          <input
            aria-label="搜索邮件线程"
            placeholder="搜索主题 / 摘要 / 成员"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="按成员过滤"
            value={member}
            onChange={(event) => setMember(event.target.value)}
          >
            <option value="">全部成员</option>
            {participants.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div
          ref={listRef}
          className="message-list mailbox-thread-list"
          role="listbox"
          aria-label="邮件线程"
          onScroll={rememberScroll}
        >
          {snapshot.messages.length === 0 && (
            <EmptyState
              icon="✉"
              title="还没有邮件"
              description="给成员或 Router 发第一封内部邮件。"
              actions={[{ label: "发邮件", onClick: () => openCompose(null), primary: true }]}
            />
          )}
          {snapshot.messages.length > 0 && visibleThreads.length === 0 && (
            <EmptyState
              icon="⌕"
              title="没有匹配的线程"
              description="清除搜索或成员过滤，查看全部邮件线程。"
              actions={[
                {
                  label: "清除筛选",
                  onClick: () => {
                    setQuery("");
                    setMember("");
                  },
                  primary: true,
                },
              ]}
            />
          )}
          {visibleThreads.map((thread, index) => (
            <button
              key={thread.threadId}
              ref={(element) => {
                threadRefs.current[index] = element;
              }}
              type="button"
              role="option"
              tabIndex={rovingThreadId === thread.threadId ? 0 : -1}
              data-thread-id={thread.threadId}
              data-expanded={selectedThread?.threadId === thread.threadId}
              aria-selected={selectedThread?.threadId === thread.threadId}
              aria-label={`线程：${thread.subject}，${thread.unreadCount} 封未读，${thread.messages.length} 封`}
              className={`message-row mailbox-thread-row ${
                selectedThread?.threadId === thread.threadId ? "selected" : ""
              }`}
              onClick={() => selectThread(thread)}
              onKeyDown={(event) => onThreadKeyDown(event, index)}
            >
              <div className="row between">
                <span className="ellipsis message-subject">{thread.subject}</span>
                <span className="muted tiny">{time(thread.lastActivity)}</span>
              </div>
              <div className="muted tiny ellipsis">
                {thread.participants.join(" · ")}
              </div>
              <div className="mailbox-thread-summary">{thread.summary || "(无正文)"}</div>
              <div className="row between">
                <span className="badge">{thread.messages.length} 封</span>
                {thread.unreadCount > 0 ? (
                  <span className="badge mailbox-unread-badge">{thread.unreadCount} 未读</span>
                ) : (
                  <span className="muted tiny">已读</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="panel mailbox-detail-panel">
        {selectedThread ? (
          <>
            <div className="mailbox-detail-head">
              <div className="row between">
                <div className="row gap">
                  <span className="badge">
                    {MESSAGE_KIND_LABEL[selectedThread.root.kind] ?? selectedThread.root.kind}
                  </span>
                  <span className="muted tiny">
                    {selectedThread.messages.length} 封 · 最近 {time(selectedThread.lastActivity)}
                  </span>
                  {selectedThread.unreadCount > 0 && (
                    <span className="badge mailbox-unread-badge">
                      {selectedThread.unreadCount} 未读
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="primary small"
                  onClick={() =>
                    openCompose(
                      selectedThread,
                      selectedMessageId &&
                        selectedThread.messages.some(
                          (entry) => entry.message.id === selectedMessageId,
                        )
                        ? selectedMessageId
                        : selectedThread.lastMessage.id,
                    )
                  }
                  disabled={busy}
                >
                  回复线程
                </button>
              </div>
              <div className="panel-title mailbox-detail-subject">{selectedThread.subject}</div>
              <div className="muted tiny">{selectedThread.participants.join(" · ")}</div>
            </div>
            <div
              ref={chainRef}
              className="mailbox-thread-chain"
              role="list"
              aria-label="回复链"
              onScroll={rememberScroll}
            >
              {selectedThread.messages.map((entry) => (
                <article
                  key={entry.message.id}
                  role="listitem"
                  data-message-id={entry.message.id}
                  className={`mailbox-thread-message ${
                    selectedMessageId === entry.message.id ? "selected" : ""
                  }`}
                  aria-label={`${entry.message.from} 发给 ${entry.message.to.join(", ")}，${
                    entry.unread ? "未读" : "已读"
                  }`}
                  data-depth={entry.depth}
                  style={{ marginLeft: `${Math.min(entry.depth, MAILBOX_MAX_INDENT) * 14}px` }}
                >
                  <div className="mailbox-thread-message-head">
                    <strong>{entry.message.from}</strong>
                    <span className="muted tiny">→ {entry.message.to.join(", ")}</span>
                    <span className="muted tiny">{time(entry.message.createdAt)}</span>
                    {entry.unread && <span className="badge mailbox-unread-badge">未读</span>}
                  </div>
                  {entry.message.id === selectedThread.root.id && (
                    <div className="mailbox-thread-message-subject">{entry.message.subject}</div>
                  )}
                  <pre className="mailbox-thread-body">{entry.message.body}</pre>
                </article>
              ))}
            </div>
          </>
        ) : selectedHidden ? (
          <EmptyState
            icon="⌕"
            title="当前选中线程被筛选隐藏"
            description="搜索或成员过滤不包含当前展开/链接的线程；清除筛选即可回到原线程。"
            actions={[
              {
                label: "清除筛选",
                onClick: () => {
                  setQuery("");
                  setMember("");
                },
                primary: true,
              },
            ]}
          />
        ) : (
          <EmptyState
            icon="✉"
            title="选择一个邮件线程"
            description="在线程列表选择会话，查看完整回复链并回复。"
            actions={
              snapshot.messages.length === 0
                ? undefined
                : [{ label: "发邮件", onClick: () => openCompose(null), primary: true }]
            }
          />
        )}
      </section>

      {composeOpen && (
        <MailboxComposeModal
          key={`${composeThread?.threadId ?? "new-mail"}:${composeParentId ?? "root"}`}
          snapshot={snapshot}
          busy={busy}
          thread={composeThread}
          parentId={composeParentId}
          onClose={() => setComposeOpen(false)}
          onSend={onSend}
        />
      )}
    </div>
  );
}

export function MailboxComposeModal({
  snapshot,
  busy,
  onClose,
  onSend,
  thread = null,
  parentId = null,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  thread?: MailboxThread | null;
  parentId?: string | null;
  onSend: (input: {
    to: string[];
    subject: string;
    body: string;
    kind: MailboxMessage["kind"];
    threadId?: string;
    parentId?: string;
  }) => Promise<boolean>;
}) {
  const initialRecipients =
    thread?.participants.filter((participant) => participant !== "user").join(", ") || "Router";
  const initialSubject = thread
    ? /^re:\s*/i.test(thread.subject)
      ? thread.subject
      : `Re: ${thread.subject}`
    : "";
  const initialKind = thread?.root.kind ?? "request";
  const [to, setTo] = useState(initialRecipients);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MailboxMessage["kind"]>(initialKind);
  const recipients = snapshot.agents.map((agent) => agent.name);
  const selectedRecipients = to
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  function toggleRecipient(name: string) {
    const next = selectedRecipients.includes(name)
      ? selectedRecipients.filter((item) => item !== name)
      : [...selectedRecipients, name];
    setTo(next.join(", "));
  }

  const dirty = Boolean(
    to.trim() !== initialRecipients ||
      subject.trim() !== initialSubject ||
      body.trim() ||
      kind !== initialKind,
  );

  return (
    <Modal
      title={thread ? "回复邮件" : "发送邮件"}
      description={
        thread
          ? `回复线程：${thread.subject}（沿用现有 thread_id，不新增数据源）`
          : "团队内部邮箱，不会发送到外部地址"
      }
      onClose={onClose}
      confirmClose={dirty}
      className="mailbox-compose-modal"
    >
      <form
        className="form modal-form"
        aria-label={thread ? "回复邮件表单" : "发送邮件表单"}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!selectedRecipients.length || !subject.trim() || !body.trim()) return;
          const sent = await onSend({
            to: selectedRecipients,
            subject: subject.trim(),
            body: body.trim(),
            kind,
            ...(thread ? { threadId: thread.threadKey } : {}),
            ...(parentId ? { parentId } : {}),
          });
          if (sent) onClose();
        }}
      >
        <label>
          收件人（逗号分隔，也可以点选成员）
          <input
            aria-label="收件人"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="Router, Builder"
          />
        </label>
        <div className="mailbox-recipient-chips">
          {recipients.map((name) => (
            <button
              key={name}
              type="button"
              className={`chip ${selectedRecipients.includes(name) ? "active" : ""}`}
              onClick={() => toggleRecipient(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="provider-grid">
          <label>
            主题
            <input
              aria-label="邮件主题"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="例如：请检查登录接口"
            />
          </label>
          <label>
            类型
            <select
              aria-label="邮件类型"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as MailboxMessage["kind"])
              }
            >
              <option value="request">请求</option>
              <option value="report">汇报</option>
              <option value="question">提问</option>
              <option value="decision">决策</option>
              <option value="artifact">产物</option>
              <option value="review">评审</option>
            </select>
          </label>
        </div>
        <label>
          正文
          <textarea
            aria-label="邮件正文"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={8}
            placeholder="写下需要对方处理或了解的内容…"
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              busy || !selectedRecipients.length || !subject.trim() || !body.trim()
            }
          >
            {thread ? "发送回复" : "发送邮件"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BoardView({
  snapshot,
  busy,
  selectedBoard,
  onSelectBoard,
  autoOpenPublish,
  onAutoOpenHandled,
  onPost,
}: {
  snapshot: Snapshot;
  busy: boolean;
  /** C12：选中板块提升到 App，进入 #/board?b=<board> 深链。 */
  selectedBoard: string | null;
  onSelectBoard: (board: string) => void;
  /** C11：命令面板/「＋新建」触发的自动打开发布弹窗（一次性）。 */
  autoOpenPublish: boolean;
  onAutoOpenHandled: () => void;
  onPost: (input: {
    board: string;
    kind: BoardEntry["kind"];
    content: string;
    confidence: BoardEntry["confidence"];
  }) => void;
}) {
  const boards = [...new Set(snapshot.boardEntries.map((entry) => entry.board))];
  const board =
    selectedBoard && boards.includes(selectedBoard) ? selectedBoard : (boards[0] ?? "general");
  const [publishOpen, setPublishOpen] = useState(false);
  const entries = snapshot.boardEntries.filter((entry) => entry.board === board);

  useEffect(() => {
    if (!autoOpenPublish) return;
    setPublishOpen(true);
    onAutoOpenHandled();
  }, [autoOpenPublish, onAutoOpenHandled]);

  return (
    <div className="board-layout">
      <section className="panel board-panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">黑板</div>
            <div className="muted tiny">{boards.length} 个领域 · 原子化、可追溯</div>
          </div>
          <button
            type="button"
            className="primary small"
            onClick={() => setPublishOpen(true)}
            disabled={busy}
          >
            + 发布条目
          </button>
        </div>
        <div className="board-tabs">
          {boards.map((item) => (
            <button
              key={item}
              className={`chip ${board === item ? "active" : ""}`}
              onClick={() => onSelectBoard(item)}
            >
              {item}
            </button>
          ))}
          {boards.length === 0 && (
            <span className="muted tiny">还没有黑板领域，发布第一条后会出现在这里。</span>
          )}
        </div>
        <div className="board-list">
          {entries.length === 0 && (
            // C24：空状态带行动引导。
            <EmptyState
              icon="◇"
              title={boards.length === 0 ? "还没有黑板条目" : "这个领域还没有条目"}
              description="发布一条原子化的事实、决策、问题或产物，与团队共享上下文。"
              actions={[{ label: "+ 发布条目", onClick: () => setPublishOpen(true), primary: true }]}
            />
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="board-entry">
              <div className="row between">
                <span className="badge">{BOARD_KIND_LABEL[entry.kind] ?? entry.kind}</span>
                <span className="muted tiny">{time(entry.createdAt)}</span>
              </div>
              <p>{entry.content}</p>
              <div className="muted tiny">
                {entry.author} · {BOARD_CONFIDENCE_LABEL[entry.confidence] ?? entry.confidence}
                {entry.pinned ? " · 已置顶" : ""}
              </div>
            </div>
          ))}
        </div>
      </section>

      {publishOpen && (
        <BoardComposeModal
          boards={boards}
          defaultBoard={board}
          busy={busy}
          onClose={() => setPublishOpen(false)}
          onPost={(input) => {
            onSelectBoard(input.board);
            onPost(input);
          }}
        />
      )}
    </div>
  );
}

function BoardComposeModal({
  boards,
  defaultBoard,
  busy,
  onClose,
  onPost,
}: {
  boards: string[];
  defaultBoard: string;
  busy: boolean;
  onClose: () => void;
  onPost: (input: {
    board: string;
    kind: BoardEntry["kind"];
    content: string;
    confidence: BoardEntry["confidence"];
  }) => void;
}) {
  const [board, setBoard] = useState(defaultBoard);
  const [kind, setKind] = useState<BoardEntry["kind"]>("fact");
  const [confidence, setConfidence] =
    useState<BoardEntry["confidence"]>("medium");
  const [content, setContent] = useState("");
  const dirty =
    Boolean(content.trim()) || board !== defaultBoard || kind !== "fact" || confidence !== "medium";

  return (
    <Modal
      title="发布黑板条目"
      description="原子化、带来源、可追溯"
      onClose={onClose}
      confirmClose={dirty}
    >
      <form
          className="form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!content.trim()) return;
            onPost({
              board: board.trim() || "general",
              kind,
              content: content.trim(),
              confidence,
            });
            onClose();
          }}
        >
          <div className="provider-grid">
            <label>
              黑板
              <input
                value={board}
                onChange={(event) => setBoard(event.target.value)}
                placeholder="general"
              />
            </label>
            <label>
              类型
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as BoardEntry["kind"])
                }
              >
                <option value="fact">事实</option>
                <option value="decision">决策</option>
                <option value="question">问题</option>
                <option value="warning">警告</option>
                <option value="artifact">产物</option>
                <option value="link">链接</option>
              </select>
            </label>
            <label>
              置信度
              <select
                value={confidence}
                onChange={(event) =>
                  setConfidence(event.target.value as BoardEntry["confidence"])
                }
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
          </div>
          {boards.length > 0 && (
            <div className="mailbox-recipient-chips">
              {boards.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`chip ${board === item ? "active" : ""}`}
                  onClick={() => setBoard(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
          <label>
            内容
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={7}
              placeholder="一条原子事实、决策、问题或产物…"
            />
          </label>
          <div className="modal-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={busy || !content.trim()}>
              发布
            </button>
          </div>
        </form>
    </Modal>
  );
}

function formatToolPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  } catch {
    return String(value);
  }
}

const CHAT_COMMANDS = [
  { name: "/clear", insert: "/clear", description: "清空当前对话上下文" },
  { name: "/compact", insert: "/compact", description: "压缩上下文，保留最近对话" },
  { name: "/team", insert: "/team ", description: "推荐成员并打开新建成员弹窗（可带描述）" },
] as const;

export function ChatView({
  messages,
  liveStore,
  tools: legacyTools,
  reasoningSegments: legacyReasoningSegments,
  turnByAssistant,
  turnByUser,
  liveTerminals: legacyLiveTerminals,
  onRetryTurn,
  composerRef,
  translateHistoryText,
  translationRevision,
  historyHasMore,
  historyLoading,
  historyError,
  onLoadEarlierHistory,
  loadEarlierMessages,
  view,
  onViewChange,
  trajectory,
  trajectoryLoading,
  onRefreshTrajectory,
  stream: legacyStream,
  reasoning: legacyReasoning,
  busy,
  input,
  onInput,
  onSend,
  onPlanFromChat,
  onStop,
  taskContext,
  taskContextSource,
  onReturnToSource,
  onClearTaskContext,
  onOpenContextPanel,
  contextBusy,
  onClearContext,
  onCompactContext,
  overview,
  routerAgent,
  modelOptions,
  fullThrottle,
  onModelChange,
  onPermissionChange,
  onFullThrottleChange,
  questions,
  questionsLoaded,
  pendingQuestionCount,
  onOpenFirstQuestion,
  onAnswerQuestion,
  onToast,
}: {
  messages: ChatMessage[];
  /** R1：生产路径必传；旧 fixture 可省略并走下方 legacy props 兼容渲染。 */
  liveStore?: ChatLiveStore;
  tools?: ChatToolTrace[];
  reasoningSegments?: ChatReasoningSegment[];
  turnByAssistant: ReadonlyMap<string, ChatAssistantTurn>;
  turnByUser: ReadonlyMap<string, ChatTurn>;
  liveTerminals?: ReadonlyMap<string, ChatTurnTerminal>;
  onRetryTurn: (content: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  translateHistoryText: (text: string) => Promise<string>;
  translationRevision?: number;
  historyHasMore?: boolean;
  historyLoading?: boolean;
  historyError?: string | null;
  onLoadEarlierHistory?: () => Promise<boolean> | boolean | void;
  loadEarlierMessages?: () => Promise<void>;
  view: "chat" | "trajectory";
  onViewChange: (view: "chat" | "trajectory") => void;
  trajectory: ChatTrajectoryEntry[];
  trajectoryLoading: boolean;
  onRefreshTrajectory: () => void;
  stream?: string;
  reasoning?: string;
  busy: boolean;
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onPlanFromChat?: () => void;
  onStop: () => void;
  /** t64：问题状态（按 messageId#bN 索引）与队列入口。 */
  questions: ReadonlyMap<string, ChatQuestionRecord>;
  questionsLoaded: boolean;
  pendingQuestionCount: number;
  onOpenFirstQuestion: () => void;
  onAnswerQuestion: (questionId: string) => void;
  onToast: (toast: { kind: "success" | "error" | "info"; message: string }) => void;
  taskContext: string | null;
  taskContextSource: "tasks" | "team" | null;
  onReturnToSource: (() => void) | undefined;
  onClearTaskContext: () => void;
  /** t50：上下文已抽为独立 dock 面板，此按钮打开「上下文」面板。 */
  onOpenContextPanel: () => void;
  /** t170：/clear 与 /compact 命令（也支持输入框斜杠命令）。 */
  contextBusy: boolean;
  onClearContext: () => void;
  onCompactContext: () => void;
  overview: string | null;
  /** DESIGN §15.5：对话控制条——当前成员（Router）与模型选项。 */
  routerAgent: Agent;
  modelOptions: Array<{ id: string; label: string }>;
  fullThrottle: boolean;
  onModelChange: (modelProfileId: string | null) => void;
  onPermissionChange: (permission: PermissionMode) => void;
  onFullThrottleChange: (enabled: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const CHAT_MESSAGE_PAGE = 40;
  const [visibleMessageCount, setVisibleMessageCount] = useState(() =>
    Math.min(CHAT_MESSAGE_PAGE, messages.length),
  );
  const [messagePageLoading, setMessagePageLoading] = useState(false);
  const [messagePageError, setMessagePageError] = useState<string | null>(null);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandText = input.trim();
  const commandRaw = input.replace(/^\s+/, "");
  const commandOpen =
    commandText.startsWith("/") &&
    !/\s/.test(commandRaw) &&
    !commandDismissed;
  const commandMatches = commandOpen
    ? CHAT_COMMANDS.filter((command) => command.name.startsWith(commandText.toLowerCase()))
    : [];

  useEffect(() => {
    setCommandDismissed(false);
    setCommandIndex(0);
  }, [input]);

  useEffect(() => {
    if (commandIndex >= commandMatches.length) setCommandIndex(0);
  }, [commandMatches.length, commandIndex]);

  function chooseCommand(command: (typeof CHAT_COMMANDS)[number]) {
    onInput(command.insert);
    setCommandDismissed(true);
    setTimeout(() => composerRef.current?.focus(), 0);
  }
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const visibleMessages = messages.slice(-Math.max(0, visibleMessageCount));
  // 旧 fixture 没有 external store：给一个空 store 供 hook 稳定调用，实际终端回退 legacy props。
  const fallbackLiveStoreRef = useRef<ChatLiveStore | null>(null);
  if (!fallbackLiveStoreRef.current) fallbackLiveStoreRef.current = new ChatLiveStore();
  const chatLiveStoreForView = liveStore ?? fallbackLiveStoreRef.current;
  const storeTerminals = useChatLiveTerminals(chatLiveStoreForView);
  // R1：token 只更新 ChatLiveTail；历史 terminal 是低频 Map，ChatView 不订阅 stream/tools。
  const liveTerminals = liveStore ? storeTerminals : legacyLiveTerminals ?? storeTerminals;
  const legacyProcess =
    !liveStore &&
    ((legacyTools?.length ?? 0) > 0 ||
      (legacyReasoningSegments?.length ?? 0) > 0 ||
      Boolean(legacyReasoning?.trim())) ? (
      <ChatTurnProcess
        reasoningSegments={legacyReasoningSegments ?? []}
        tools={legacyTools ?? []}
        liveReasoning={legacyReasoning ?? ""}
        busy={busy}
      />
    ) : undefined;
  const showLegacyLiveBubble =
    !liveStore &&
    (Boolean(legacyStream?.trim() || legacyReasoning?.trim()) ||
      (busy && Boolean(legacyProcess)));

  useEffect(() => {
    setVisibleMessageCount((current) =>
      Math.min(Math.max(current, Math.min(CHAT_MESSAGE_PAGE, messages.length)), messages.length),
    );
  }, [messages.length]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const preserve = preserveScrollRef.current;
    if (preserve) {
      applyHistoryScrollPreservation(node, preserve);
      preserveScrollRef.current = null;
      return;
    }
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 120) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, visibleMessageCount]);

  async function loadEarlierHistory() {
    const hasEarlierMessages = visibleMessageCount < messages.length;
    if (messagePageLoading || (!hasEarlierMessages && !historyHasMore)) return;
    const node = scrollRef.current;
    if (node) {
      preserveScrollRef.current = { height: node.scrollHeight, top: node.scrollTop };
    }
    setMessagePageLoading(true);
    setMessagePageError(null);
    try {
      if (loadEarlierMessages) await loadEarlierMessages();
      if (onLoadEarlierHistory) {
        const committed = await onLoadEarlierHistory();
        if (committed === false) {
          preserveScrollRef.current = null;
          setMessagePageError("更早历史加载失败，可重试");
          return;
        }
      }
      if (hasEarlierMessages) {
        setVisibleMessageCount((current) =>
          nextVisibleMessageCount(current, messages.length, CHAT_MESSAGE_PAGE),
        );
      }
    } catch (error) {
      preserveScrollRef.current = null;
      setMessagePageError(error instanceof Error ? error.message : String(error));
    } finally {
      setMessagePageLoading(false);
    }
  }

  const historyLoadingNow = messagePageLoading || Boolean(historyLoading);
  const historyErrorNow = messagePageError ?? historyError ?? null;
  const hasEarlierHistory = visibleMessageCount < messages.length || Boolean(historyHasMore);

  return (
    <div className="chat-layout">
      <section className="panel chat-panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">
              Router 对话
              {fullThrottle && (
                <span
                  className="badge ft-badge"
                  title="满血模式已开启：仅提高预算/努力，不改变工具权限"
                >
                  FULL THROTTLE
                </span>
              )}
            </div>
            <div className="muted tiny">
              讨论、澄清需求；「上下文」作为独立面板打开 · 权限：{PERMISSION_LABELS[routerAgent.permission]}
            </div>
          </div>
          <div className="row gap">
            {pendingQuestionCount > 0 && (
              <button
                type="button"
                className="badge question-chip"
                onClick={onOpenFirstQuestion}
                title="打开最早待回答的问题"
              >
                待回答 {pendingQuestionCount}
              </button>
            )}
            {taskContext && (
              <span className="badge" title="当前对话锁定在该任务的上下文">
                任务上下文
              </span>
            )}
            {onReturnToSource && (
              <button
                type="button"
                className="ghost tiny"
                onClick={onReturnToSource}
                title="返回进入会话前的页面"
              >
                返回{taskContextSource === "team" ? "团队" : "任务"}
              </button>
            )}
            <button
              type="button"
              className="ghost tiny"
              onClick={onCompactContext}
              disabled={busy || contextBusy}
              title="压缩上下文：保留最近 8 条，较早消息合并为摘要（/compact）"
            >
              {contextBusy ? "处理中…" : "压缩"}
            </button>
            <button
              type="button"
              className="ghost tiny run-danger"
              onClick={onClearContext}
              disabled={busy || contextBusy}
              title="清空上下文：删除当前对话消息、画布索引与提问（/clear）"
            >
              清空
            </button>
            <button type="button" className="ghost tiny" onClick={onOpenContextPanel}>
              上下文
            </button>
          </div>
        </div>

        <div className="chat-view-tabs" role="tablist" aria-label="对话视图">
          <button
            type="button"
            role="tab"
            id="chat-tab-chat"
            aria-controls="chat-panel-chat"
            aria-selected={view === "chat"}
            tabIndex={view === "chat" ? 0 : -1}
            className={view === "chat" ? "active" : ""}
            onClick={() => onViewChange("chat")}
            onKeyDown={(event) => {
              if (event.key === "Home") {
                event.preventDefault();
                onViewChange("chat");
                document.getElementById("chat-tab-chat")?.focus();
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                onViewChange("trajectory");
                document.getElementById("chat-tab-trajectory")?.focus();
                return;
              }
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              onViewChange("trajectory");
              document.getElementById("chat-tab-trajectory")?.focus();
            }}
          >
            对话
          </button>
          <button
            type="button"
            role="tab"
            id="chat-tab-trajectory"
            aria-controls="chat-panel-trajectory"
            aria-selected={view === "trajectory"}
            tabIndex={view === "trajectory" ? 0 : -1}
            className={view === "trajectory" ? "active" : ""}
            onClick={() => onViewChange("trajectory")}
            onKeyDown={(event) => {
              if (event.key === "Home") {
                event.preventDefault();
                onViewChange("chat");
                document.getElementById("chat-tab-chat")?.focus();
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                onViewChange("trajectory");
                document.getElementById("chat-tab-trajectory")?.focus();
                return;
              }
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              onViewChange("chat");
              document.getElementById("chat-tab-chat")?.focus();
            }}
          >
            轨迹
            {trajectory.length > 0 && <span className="chat-view-count">{trajectory.length}</span>}
          </button>
        </div>

        {view === "chat" ? (
          <div
            id="chat-panel-chat"
            className="chat-tab-panel"
            role="tabpanel"
            aria-labelledby="chat-tab-chat"
          >
        {/* C10：工作区概述并入对话页，可折叠卡片 */}
        {overview && (
          <details className="overview-card">
            <summary>
              <span className="panel-title" style={{ fontSize: 12 }}>
                工作区概述
              </span>
              <span className="muted tiny">Router 在打开工作区时生成</span>
            </summary>
            <pre className="overview">{overview}</pre>
          </details>
        )}

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !busy && (
            // C24：空状态给可点击示例，一步发起对话。
            <EmptyState
              icon="◎"
              title="和 Router 说点什么"
              description="讨论目标、澄清需求，Router 会给出建议。"
              actions={[
                {
                  label: "开始对话",
                  onClick: () => composerRef.current?.focus(),
                  primary: true,
                },
              ]}
            />
          )}
          {hasEarlierHistory ? (
            <div className="chat-history-more">
              <button
                type="button"
                className="ghost small"
                onClick={() => void loadEarlierHistory()}
                disabled={historyLoadingNow}
                aria-busy={historyLoadingNow}
              >
                {historyLoadingNow ? "加载更早…" : "加载更早"}
              </button>
              <span className="muted tiny" aria-live="polite">
                {historyErrorNow
                  ? `加载失败：${historyErrorNow}，可重试`
                  : `${messages.length} 条消息，已显示最近 ${visibleMessageCount} 条`}
              </span>
            </div>
          ) : messages.length > 0 ? (
            <div className="chat-history-more muted tiny" aria-live="polite">
              已到最早（{messages.length} 条消息）
            </div>
          ) : null}
          {visibleMessages.map((message) => {
            const historical =
              message.role === "assistant" ? turnByAssistant.get(message.id) : undefined;
            const turn = message.role === "user" ? turnByUser.get(message.id) : undefined;
            const terminal =
              turn?.terminal ??
              (message.role === "user" ? liveTerminals.get(message.id) : undefined) ??
              null;
            const showTerminal =
              !turn || turn.status !== "complete" ? Boolean(terminal) : false;
            const legacyUnresolved = Boolean(
              !terminal && turn?.legacyUnresolved && message.role === "user",
            );
            const legacyError = Boolean(
              !terminal &&
                message.role === "user" &&
                turn?.status === "error" &&
                turn.assistants.length > 0,
            );
            const retryable = terminal
              ? turn?.retryable ?? terminal.retryable
              : Boolean(legacyUnresolved || legacyError);
            return (
              <Fragment key={message.id}>
                <ChatBubble
                  messageId={message.id}
                  role={message.role}
                  content={message.content}
                  reasoning={historical ? "" : message.reasoning}
                  translate={translateHistoryText}
                  translationRevision={translationRevision}
                  process={
                    historical && historical.steps.length > 0 ? (
                      <ChatTurnHistoryProcess
                        assistant={historical}
                        translate={translateHistoryText}
                        translationRevision={translationRevision}
                      />
                    ) : undefined
                  }
                  createdAt={message.createdAt}
                  questions={questions}
                  questionsLoaded={questionsLoaded}
                  onAnswerQuestion={onAnswerQuestion}
                  onToast={onToast}
                />
                {(showTerminal || legacyUnresolved || legacyError) && (
                  <ChatTurnTerminalBubble
                    terminal={terminal}
                    legacyUnresolved={legacyUnresolved}
                    legacyError={legacyError}
                    retryable={retryable}
                    retryDisabled={busy}
                    onRetry={() => onRetryTurn(message.content)}
                  />
                )}
              </Fragment>
            );
          })}
          {liveStore && (
            <ChatLiveTail
              store={liveStore}
              busy={busy}
              scrollRef={scrollRef}
              questions={questions}
              questionsLoaded={questionsLoaded}
              onAnswerQuestion={onAnswerQuestion}
              onToast={onToast}
              translateHistoryText={translateHistoryText}
            />
          )}
          {showLegacyLiveBubble && (
            <ChatBubble
              role="assistant"
              content={legacyStream ?? ""}
              reasoning=""
              process={legacyProcess}
              streaming
              questions={questions}
              questionsLoaded={questionsLoaded}
              onAnswerQuestion={onAnswerQuestion}
              onToast={onToast}
            />
          )}
        </div>

        <div className="chat-composer">
          {commandOpen ? (
            <div
              className="chat-command-menu"
              role="listbox"
              aria-label="聊天命令"
              id="chat-command-listbox"
            >
              {commandMatches.length === 0 ? (
                <div className="chat-command-empty" role="status">无匹配命令</div>
              ) : (
                commandMatches.map((command, index) => (
                  <button
                    key={command.name}
                    id={`chat-command-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === commandIndex}
                    className={`chat-command-item ${index === commandIndex ? "active" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseCommand(command)}
                  >
                    <span className="mono">{command.name}</span>
                    <span className="muted tiny">{command.description}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            role="combobox"
            aria-label="给 Router 发消息"
            aria-describedby="chat-composer-help"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={commandOpen}
            aria-controls={commandOpen ? "chat-command-listbox" : undefined}
            aria-activedescendant={commandOpen && commandMatches[commandIndex] ? `chat-command-${commandIndex}` : undefined}
            value={input}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (commandOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (commandMatches.length > 0) setCommandIndex((index) => (index + 1) % commandMatches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (commandMatches.length > 0) setCommandIndex((index) => (index - 1 + commandMatches.length) % commandMatches.length);
                  return;
                }
                if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault();
                  const command = commandMatches[commandIndex];
                  if (command) chooseCommand(command);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  const command = commandMatches[commandIndex];
                  if (command) chooseCommand(command);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCommandDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={3}
            placeholder="给 Router 发消息… Ctrl+Enter 发送 · /clear 清空 · /compact 压缩 · /team 推荐成员"
          />
          <div className="row between">
            <span className="muted tiny" id="chat-composer-help">
              {busy
                ? "Router 正在回复…"
                : "上下文与工具会随任务变化 · Ctrl+Enter 发送 · /clear 清空 · /compact 压缩 · /team 推荐成员"}
            </span>
            <div className="row gap">
              <button
                type="button"
                className="ghost small"
                onClick={onPlanFromChat}
                disabled={busy || !onPlanFromChat || (!input.trim() && messages.length === 0)}
                title="把当前输入框目标与对话带入可编辑计划草案；确认前不创建任务"
              >
                从这段对话规划
              </button>
              {busy && (
                <button className="ghost small" onClick={onStop}>
                  停止
                </button>
              )}
              <button className="primary small" onClick={onSend} disabled={busy || !input.trim()}>
                {busy ? "回复中…" : "发送"}
              </button>
            </div>
          </div>

          {/* DESIGN §15.5：输入框下方控制条——模型 / 权限 / 满血模式 */}
          <div className="chat-controls" role="group" aria-label="对话控制条">
            <label className="chat-control">
              <span className="muted tiny">模型</span>
              <select
                value={routerAgent.model ?? ""}
                onChange={(event) =>
                  onModelChange(event.target.value === "" ? null : event.target.value)
                }
                disabled={busy}
                aria-label="当前成员模型（下一条消息生效）"
                title="切换当前对话成员的模型，下一条消息生效"
              >
                <option value="">默认模型</option>
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="chat-control">
              <span className="muted tiny">权限</span>
              <select
                value={routerAgent.permission}
                onChange={(event) =>
                  onPermissionChange(event.target.value as PermissionMode)
                }
                disabled={busy}
                aria-label={`权限模式：${PERMISSION_LABELS[routerAgent.permission]}`}
                title={PERMISSION_DESCRIPTIONS[routerAgent.permission]}
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode} title={PERMISSION_DESCRIPTIONS[mode]}>
                    {PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label className="chat-control check" title="满血模式：注入高预算指令，不改变工具权限">
              <input
                type="checkbox"
                checked={fullThrottle}
                onChange={(event) => onFullThrottleChange(event.target.checked)}
                aria-pressed={fullThrottle}
              />
              <span className="muted tiny">满血模式</span>
            </label>
          </div>
        </div>
          </div>
        ) : (
          <div
            id="chat-panel-trajectory"
            className="chat-tab-panel"
            role="tabpanel"
            aria-labelledby="chat-tab-trajectory"
          >
            <ChatTrajectoryPanel
              entries={trajectory}
              loading={trajectoryLoading}
              onRefresh={onRefreshTrajectory}
            />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * t260（R1）：唯一订阅 ChatLiveStore 的渲染组件。
 * token/tool/reasoning 只更新此子树；历史消息、Dock、Rail/Workflow/NeedsMe 不参与。
 */
function ChatLiveTail({
  store,
  busy,
  scrollRef,
  questions,
  questionsLoaded,
  onAnswerQuestion,
  onToast,
  translateHistoryText,
}: {
  store: ChatLiveStore;
  busy: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  questions: ReadonlyMap<string, ChatQuestionRecord>;
  questionsLoaded: boolean;
  onAnswerQuestion: (questionId: string) => void;
  onToast: (toast: { kind: "success" | "error" | "info"; message: string }) => void;
  translateHistoryText: (text: string) => Promise<string>;
}) {
  const live = useChatLiveState(store);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [live.stream, live.reasoning, live.segments, live.tools, scrollRef]);

  // 思考段完成后才翻译；store 记请求 id，避免重挂载/重渲染重复打 Bing。
  useEffect(() => {
    for (const segment of live.segments) {
      if (segment.status !== "loading" || !segment.text.trim()) continue;
      if (!store.beginTranslation(segment.id)) continue;
      void translateHistoryText(segment.text)
        .then((translation) => store.setTranslation(segment.id, translation))
        .catch(() => store.setTranslationError(segment.id));
    }
  }, [live.segments, store, translateHistoryText]);

  const hasProcess =
    live.tools.length > 0 ||
    live.segments.length > 0 ||
    Boolean(live.reasoning.trim());
  const show = Boolean(live.stream.trim() || live.reasoning.trim()) || (busy && hasProcess);
  if (!show) return null;

  const process = hasProcess ? (
    <ChatTurnProcess
      reasoningSegments={[...live.segments]}
      tools={[...live.tools]}
      liveReasoning={live.reasoning}
      busy={busy}
    />
  ) : undefined;

  return (
    <ChatBubble
      role="assistant"
      content={live.stream}
      reasoning=""
      process={process}
      streaming
      questions={questions}
      questionsLoaded={questionsLoaded}
      onAnswerQuestion={onAnswerQuestion}
      onToast={onToast}
    />
  );
}

function ChatTrajectoryPanel({
  entries,
  loading,
  onRefresh,
}: {
  entries: ChatTrajectoryEntry[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<"all" | "conversation" | "reasoning" | "tools">("all");
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, filter]);
  const isConversation = (kind: ChatTrajectoryEntry["kind"]) =>
    kind === "user" || kind === "assistant" || kind === "system" || kind === "context";
  const isTool = (kind: ChatTrajectoryEntry["kind"]) =>
    kind === "tool_call" || kind === "tool_result";
  const visible = entries.filter((entry) =>
    filter === "all"
      ? true
      : filter === "conversation"
        ? isConversation(entry.kind)
        : filter === "reasoning"
          ? entry.kind === "reasoning"
          : isTool(entry.kind),
  );
  const filters: Array<{ id: typeof filter; label: string; count: number }> = [
    { id: "all", label: "全部", count: entries.length },
    {
      id: "conversation",
      label: "对话",
      count: entries.filter((entry) => isConversation(entry.kind)).length,
    },
    {
      id: "reasoning",
      label: "思考",
      count: entries.filter((entry) => entry.kind === "reasoning").length,
    },
    { id: "tools", label: "工具", count: entries.filter((entry) => isTool(entry.kind)).length },
  ];
  return (
    <div className="chat-trajectory-panel">
      <div className="chat-trajectory-toolbar">
        <div>
          <div className="panel-title">运行轨迹</div>
          <div className="muted tiny">
            {visible.length}/{entries.length} 条记录 · 对话、思考与工具
          </div>
        </div>
        <button type="button" className="ghost tiny" onClick={onRefresh} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="chat-trajectory-filters" role="group" aria-label="轨迹分类">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? "active" : ""}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span>{item.count}</span>
          </button>
        ))}
      </div>
      <div className="chat-trajectory-scroll" ref={scrollRef}>
        {loading && entries.length === 0 ? (
          <div className="muted tiny chat-trajectory-loading">正在加载轨迹…</div>
        ) : entries.length === 0 ? (
          <EmptyState
            compact
            icon="▤"
            title="还没有轨迹"
            description="发送一条消息后，这里会按时间记录对话、思考、工具调用与上下文操作。"
          />
        ) : visible.length === 0 ? (
          <div className="muted tiny chat-trajectory-loading">该分类暂无记录。</div>
        ) : (
          <ol className="chat-trajectory-ledger" aria-label="Chat 运行轨迹">
            {visible.map((entry) => (
              <li key={entry.id} className={`chat-trajectory-row kind-${entry.kind}`}>
                <span className="chat-trajectory-time mono">{time(entry.createdAt)}</span>
                <span className="chat-trajectory-marker" aria-hidden="true" />
                <span className="chat-trajectory-body">
                  <span className="chat-trajectory-head">
                    <span className="chat-trajectory-kind">
                      {CHAT_TRAJECTORY_KIND_LABEL[entry.kind]}
                    </span>
                    <strong
                      title={
                        entry.kind === "tool_call" || entry.kind === "tool_result"
                          ? entry.title
                          : undefined
                      }
                    >
                      {entry.kind === "tool_call" || entry.kind === "tool_result"
                        ? toolLabel(entry.title)
                        : entry.title}
                    </strong>
                    {entry.step ? (
                      <span className="chat-trajectory-step">step {entry.step}</span>
                    ) : null}
                    {entry.status && (
                      <span className={`chat-trajectory-status is-${entry.status}`}>
                        {entry.status === "running"
                          ? "运行中"
                          : entry.status === "ok"
                            ? "完成"
                            : "失败"}
                      </span>
                    )}
                  </span>
                  <pre>{entry.detail.length > 6_000 ? `${entry.detail.slice(0, 6_000)}…` : entry.detail}</pre>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function ChatToolItem({ tool }: { tool: ChatToolTrace }) {
  const [open, setOpen] = useState(tool.status === "running");
  useEffect(() => {
    // t178：运行中展开，调用完成后自动折叠；用户之后仍可手动展开。
    if (tool.status !== "running") setOpen(false);
  }, [tool.status]);
  return (
    <details
      className={`chat-tool-item is-${tool.status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={tool.name}>
        <span className="chat-tool-dot" aria-hidden="true" />
        <span className="chat-tool-label">{toolLabel(tool.name)}</span>
        <span className="mono chat-tool-raw">{tool.name}</span>
        <span className={`chat-tool-status is-${tool.status}`}>
          {tool.status === "running"
            ? "运行中"
            : tool.status === "ok"
              ? "完成"
              : tool.status === "unknown"
                ? "未知"
                : "失败"}
        </span>
      </summary>
      <div className="chat-tool-detail">
        <div>
          <div className="section-label">参数</div>
          <pre>{formatToolPayload(tool.arguments)}</pre>
        </div>
        {tool.status !== "running" && (
          <div>
            <div className="section-label">
              {tool.status === "ok" ? "结果" : tool.status === "unknown" ? "结果（旧数据）" : "错误"}
            </div>
            <pre>
              {tool.status === "ok"
                ? formatToolPayload(tool.value) || "（无返回值）"
                : tool.status === "unknown"
                  ? "历史数据缺少工具结果"
                  : tool.error || "工具执行失败"}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function ChatTurnTerminalBubble({
  terminal,
  legacyUnresolved,
  legacyError,
  retryable,
  retryDisabled,
  onRetry,
}: {
  terminal: ChatTurnTerminal | null;
  legacyUnresolved: boolean;
  legacyError: boolean;
  retryable: boolean;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const cancelled = terminal?.status === "cancelled";
  const isError = terminal?.status === "error" || legacyError;
  const title = legacyUnresolved
    ? "未完成（旧数据）"
    : legacyError
      ? "回复失败（旧数据）"
      : cancelled
        ? "已取消"
        : "回复失败";
  const stageText = terminal
    ? terminal.stage === "tool"
      ? `工具执行中${terminal.tool?.name ? `：${toolLabel(terminal.tool.name)}` : ""}`
      : terminal.stage === "approval"
        ? "等待审批"
        : terminal.stage === "persist"
          ? "保存回复中"
          : terminal.stage === "model"
            ? "模型回复中"
            : "执行中"
    : null;
  const role = isError ? "alert" : "status";
  return (
    <div
      className={`chat-turn-terminal ${cancelled ? "is-cancelled" : isError ? "is-error" : "is-legacy"}`}
      role={role}
      aria-live={isError ? "assertive" : "polite"}
    >
      <div className="chat-turn-terminal-head">
        <span className="chat-turn-terminal-icon" aria-hidden="true">
          {isError ? "!" : "·"}
        </span>
        <strong>{title}</strong>
        {terminal && <span className="chat-turn-terminal-time">{time(terminal.at)}</span>}
      </div>
      {terminal ? (
        <>
          {isError && (terminal.code || terminal.message) && (
            <div className="chat-turn-terminal-summary">
              {terminal.code && <span className="mono">{terminal.code}</span>}
              {terminal.message && <span>{terminal.message}</span>}
            </div>
          )}
          {stageText && <div className="chat-turn-terminal-stage">阶段：{stageText}</div>}
        </>
      ) : (
        <div className="chat-turn-terminal-stage">
          {legacyUnresolved
            ? "该轮没有终态记录；可确认后重试。"
            : "旧记录没有错误详情；可确认后重试。"}
        </div>
      )}
      {retryable && (
        <button
          type="button"
          className="ghost tiny chat-turn-terminal-retry"
          aria-label="重试这条消息"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          重试
        </button>
      )}
    </div>
  );
}

export function ChatTurnHistoryProcess({
  assistant,
  translate,
  translationRevision = 0,
}: {
  assistant: ChatAssistantTurn;
  translate: (text: string) => Promise<string>;
  translationRevision?: number;
}) {
  const [open, setOpen] = useState(false);
  const toolCount = assistant.steps.reduce((count, step) => count + step.tools.length, 0);
  return (
    <details
      className="chat-turn-process is-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>执行过程</span>
        <span className="muted tiny">
          {assistant.steps.length} 步 · {toolCount} 次工具 · 历史记录
          {assistant.legacy.reasoningFromMessage ? " · 含旧数据" : ""}
          {assistant.truncated ? " · 已截断" : ""}
        </span>
      </summary>
      {open && (
        <div className="chat-turn-process-body">
          {assistant.steps.map((step) => (
            <ChatTurnHistoryStep
              key={step.step}
              step={step}
              translate={translate}
              translationRevision={translationRevision}
            />
          ))}
        </div>
      )}
    </details>
  );
}

function ChatTurnHistoryStep({
  step,
  translate,
  translationRevision,
}: {
  step: ChatAssistantTurn["steps"][number];
  translate: (text: string) => Promise<string>;
  translationRevision: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-turn-step is-history">
      <button
        type="button"
        className="chat-turn-step-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chat-turn-reasoning-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="chat-turn-step-label">step {step.step}</span>
        <span className="muted tiny">
          {step.reasoning.length} 段思考 · {step.tools.length} 次工具
        </span>
        <span className="chat-turn-step-done">完成</span>
      </button>
      {open && (
        <div className="chat-turn-step-body">
          {step.reasoning.map((reasoning) => (
            <ChatTurnHistoryReasoning
              key={reasoning.id}
              reasoning={reasoning}
              translate={translate}
              translationRevision={translationRevision}
            />
          ))}
          {step.tools.map((tool) => (
            <ChatToolItem key={tool.callId} tool={historyToolTrace(tool)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatTurnHistoryReasoning({
  reasoning,
  translate,
  translationRevision = 0,
}: {
  reasoning: ChatTurnReasoning;
  translate: (text: string) => Promise<string>;
  translationRevision?: number;
}) {
  const [open, setOpen] = useState(false);
  const [segment, setSegment] = useState<ChatReasoningSegment>(() => ({
    id: reasoning.id,
    step: reasoning.step,
    text: reasoning.text,
    status: "done",
  }));
  const requested = useRef(false);
  const revisionRef = useRef(translationRevision);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function requestTranslation() {
    if (!reasoning.text.trim()) return;
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const revisionAtRequest = translationRevision;
    setSegment((prev) => ({ ...prev, status: "loading", translation: undefined }));
    void translate(reasoning.text)
      .then((translation) => {
        if (
          requestId !== requestIdRef.current ||
          controller.signal.aborted ||
          revisionAtRequest !== revisionRef.current
        ) {
          return;
        }
        setSegment((prev) => ({ ...prev, status: "done", translation }));
      })
      .catch(() => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setSegment((prev) => ({ ...prev, status: "error" }));
      });
  }

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open || requested.current || !reasoning.text.trim()) return;
    requested.current = true;
    requestTranslation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reasoning.text, translate]);

  useEffect(() => {
    if (revisionRef.current === translationRevision) return;
    revisionRef.current = translationRevision;
    requestIdRef.current += 1;
    abortRef.current?.abort();
    requested.current = false;
    setSegment((prev) => ({ ...prev, translation: undefined, status: "done" }));
    if (open) {
      requested.current = true;
      requestTranslation();
    }
    // t333：设置指纹变化必须让已挂载译文失效并重新请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationRevision]);

  return (
    <ChatReasoningBlock
      segment={segment}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onRetry={requestTranslation}
      legacy={reasoning.source === "message"}
    />
  );
}

function historyToolTrace(tool: ChatTurnTool): ChatToolTrace {
  return {
    callId: tool.callId,
    name: tool.name,
    arguments: tool.arguments,
    status: tool.status,
    value: tool.value,
    error: tool.error,
    step: tool.step,
  };
}

function ChatTurnProcess({
  reasoningSegments,
  tools,
  liveReasoning,
  busy,
}: {
  reasoningSegments: ChatReasoningSegment[];
  tools: ChatToolTrace[];
  liveReasoning: string;
  busy: boolean;
}) {
  const [open, setOpen] = useState(true);
  const steps = new Map<
    number,
    { step: number; reasoning: ChatReasoningSegment[]; tools: ChatToolTrace[] }
  >();
  const getStep = (step: number) => {
    const existing = steps.get(step);
    if (existing) return existing;
    const created = { step, reasoning: [], tools: [] };
    steps.set(step, created);
    return created;
  };
  for (const segment of reasoningSegments) {
    if (segment.text.trim()) getStep(segment.step).reasoning.push(segment);
  }
  for (const tool of tools) {
    getStep(tool.step ?? 0).tools.push(tool);
  }
  const ordered = [...steps.values()].sort((left, right) => left.step - right.step);
  return (
    <details
      className="chat-turn-process"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>执行过程</span>
        <span className="muted tiny">
          {ordered.length} 步 · {tools.length} 次工具
        </span>
      </summary>
      <div className="chat-turn-process-body">
        {ordered.map((step, index) => {
          const isLast = index === ordered.length - 1;
          const running =
            step.tools.some((tool) => tool.status === "running") || (busy && isLast);
          return (
            <ChatTurnStep
              key={step.step}
              step={step}
              running={running}
            />
          );
        })}
        {liveReasoning.trim() && (
          <div className="chat-turn-live">
            <div className="chat-turn-reasoning-label">思考中…</div>
            <pre>{liveReasoning}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function ChatTurnStep({
  step,
  running,
}: {
  step: { step: number; reasoning: ChatReasoningSegment[]; tools: ChatToolTrace[] };
  running: boolean;
}) {
  const [open, setOpen] = useState(running);
  useEffect(() => {
    // t178：step 结束后思考自动折叠；用户之后仍可手动展开。
    if (!running) setOpen(false);
  }, [running]);
  return (
    <div className="chat-turn-step">
      <div className="chat-turn-step-head">
        <span className="chat-turn-step-label">step {step.step}</span>
        {running ? (
          <span className="chat-turn-step-live">运行中</span>
        ) : (
          <span className="chat-turn-step-done">完成</span>
        )}
      </div>
      {step.reasoning.map((segment) => (
        <ChatReasoningBlock
          key={segment.id}
          segment={segment}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
      ))}
      {step.tools.map((tool) => (
        <ChatToolItem key={tool.callId} tool={tool} />
      ))}
    </div>
  );
}

function ChatReasoningBlock({
  segment,
  open,
  onToggle,
  onRetry,
  legacy,
}: {
  segment: ChatReasoningSegment;
  open: boolean;
  onToggle: () => void;
  onRetry?: () => void;
  /** t168：message.reasoning 降级的旧数据标记。 */
  legacy?: boolean;
}) {
  const [view, setView] = useState<"original" | "translation">("translation");
  const hasTranslation =
    segment.status === "done" &&
    Boolean(segment.translation?.trim()) &&
    segment.translation?.trim() !== segment.text.trim();
  const showTranslation = view === "translation" && hasTranslation;
  return (
    <div className="chat-turn-reasoning">
      <div className="chat-turn-reasoning-head">
        <button
          type="button"
          className="chat-turn-reasoning-collapse"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="chat-turn-reasoning-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span>思考</span>
          {legacy && <span className="chat-turn-legacy-badge">旧数据</span>}
          <span className="muted tiny"> · {segment.text.length} 字</span>
        </button>
        {open && hasTranslation && (
          <div className="chat-turn-view-toggle" role="group" aria-label="思考显示方式">
            <button
              type="button"
              className={view === "original" ? "active" : ""}
              aria-pressed={view === "original"}
              onClick={() => setView("original")}
            >
              原文
            </button>
            <button
              type="button"
              className={view === "translation" ? "active" : ""}
              aria-pressed={view === "translation"}
              onClick={() => setView("translation")}
            >
              译文
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="chat-turn-reasoning-body">
          {showTranslation ? (
            <div className="chat-turn-translation">
              <div className="chat-turn-translation-label">机翻</div>
              <pre>{segment.translation}</pre>
            </div>
          ) : (
            <pre>{segment.text}</pre>
          )}
          {segment.status === "loading" && (
            <div className="chat-turn-translation-status">机翻中…</div>
          )}
          {segment.status === "error" && (
            <div className="chat-turn-translation-status is-error">
              机翻失败，已显示原文
              {onRetry ? (
                <button type="button" className="ghost tiny" onClick={onRetry}>
                  重试翻译
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatMessageReasoning({
  text,
  streaming,
  translate,
  translationRevision = 0,
}: {
  text: string;
  streaming: boolean;
  translate?: (text: string) => Promise<string>;
  translationRevision?: number;
}) {
  const [open, setOpen] = useState(streaming);
  const [segment, setSegment] = useState<ChatReasoningSegment>(() => ({
    id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    step: 0,
    text,
    status: "loading",
  }));
  const requested = useRef(false);
  const revisionRef = useRef(translationRevision);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function requestTranslation() {
    if (!text.trim()) return;
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const revisionAtRequest = translationRevision;
    setSegment((prev) => ({ ...prev, status: "loading", translation: undefined }));
    const run = translate ?? ((value: string) => window.deer.translateText(value));
    void run(text)
      .then((translation) => {
        if (
          requestId !== requestIdRef.current ||
          controller.signal.aborted ||
          revisionAtRequest !== revisionRef.current
        ) {
          return;
        }
        setSegment((prev) => ({ ...prev, status: "done", translation }));
      })
      .catch(() => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setSegment((prev) => ({ ...prev, status: "error" }));
      });
  }

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // t183：历史消息的 reasoning 只在展开时懒翻译，避免启动时批量打 Bing。
  useEffect(() => {
    if (!open || requested.current || !text.trim()) return;
    requested.current = true;
    requestTranslation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, translate]);

  useEffect(() => {
    if (revisionRef.current === translationRevision) return;
    revisionRef.current = translationRevision;
    requestIdRef.current += 1;
    abortRef.current?.abort();
    requested.current = false;
    setSegment((prev) => ({ ...prev, translation: undefined, status: "done" }));
    if (open) {
      requested.current = true;
      requestTranslation();
    }
    // t333：设置指纹变化必须让已挂载译文失效并重新请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationRevision]);

  return (
    <ChatReasoningBlock
      segment={segment}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onRetry={requestTranslation}
    />
  );
}

function ChatBubble({
  messageId,
  role,
  content,
  reasoning,
  translate,
  translationRevision,
  process,
  createdAt,
  streaming,
  questions,
  questionsLoaded,
  onAnswerQuestion,
  onToast,
}: {
  messageId?: string;
  role: ChatMessage["role"];
  content: string;
  reasoning?: string;
  translate?: (text: string) => Promise<string>;
  translationRevision?: number;
  /** t177：思考段 + 工具调用，和最终回复放在同一个 bubble 内。 */
  process?: ReactNode;
  createdAt?: string;
  streaming?: boolean;
  questions?: ReadonlyMap<string, ChatQuestionRecord>;
  questionsLoaded?: boolean;
  onAnswerQuestion?: (questionId: string) => void;
  onToast?: (toast: { kind: "success" | "error" | "info"; message: string }) => void;
}) {
  return (
    <div className={`chat-row ${role}`}>
      <div className="chat-avatar">{role === "user" ? "你" : role === "assistant" ? "R" : "S"}</div>
      <div className="chat-bubble">
        <div className="chat-meta">
          {role === "user" ? "你" : role === "assistant" ? "Router" : "System"}
          {createdAt ? ` · ${time(createdAt)}` : ""}
          {streaming ? " · 生成中" : ""}
        </div>
        {reasoning && (
          <ChatMessageReasoning
            text={reasoning}
            streaming={Boolean(streaming)}
            translate={translate}
            translationRevision={translationRevision}
          />
        )}
        {process}
        {content && (
          <div className="chat-content">
            <ChatContent
              role={role}
              content={content}
              messageId={messageId}
              streaming={streaming}
              questions={questions}
              questionsLoaded={questionsLoaded}
              onAnswerQuestion={onAnswerQuestion}
              onToast={onToast}
            />
            {streaming && <span className="cursor">▍</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextPanel({
  context,
  taskContext,
  onClearTaskContext,
}: {
  context: ContextSnapshot | null;
  taskContext: string | null;
  onClearTaskContext: () => void;
}) {
  if (!context) {
    return (
      <aside className="panel context-panel">
        <div className="empty">上下文加载中…</div>
      </aside>
    );
  }

  const percent = Math.min(100, (context.totalTokens / context.contextWindow) * 100);

  return (
    <aside className="panel context-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">上下文</div>
          <div className="muted tiny">
            {context.agent.name} · {context.providerName} · {context.model}
          </div>
        </div>
        {taskContext && (
          <button className="ghost tiny" onClick={onClearTaskContext}>
            回到 Router
          </button>
        )}
      </div>

      <div className="context-body">
        {context.taskTitle && (
          <div className="notice small">任务上下文：{context.taskTitle}</div>
        )}

        <div className="context-meter">
          <div className="context-meter-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="muted tiny">
          估算 {context.totalTokens.toLocaleString()} / {context.contextWindow.toLocaleString()} tokens
        </div>

        {context.sections.map((section) => (
          <details
            key={section.id}
            className="context-section"
            open={section.kind === "system" || section.kind === "task"}
          >
            <summary>
              <span>{section.title}</span>
              <span className="muted tiny">
                {section.tokens} tk{section.meta ? ` · ${section.meta}` : ""}
              </span>
            </summary>
            <pre>{section.content}</pre>
          </details>
        ))}

        <details className="context-section">
          <summary>
            <span>工具</span>
            <span className="muted tiny">{context.tools.length}</span>
          </summary>
          <div className="context-tools">
            {context.tools.map((tool) => (
              <div key={tool.name}>
                <span className="mono">{tool.name}</span>
                <span className="muted tiny">{tool.description}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </aside>
  );
}
