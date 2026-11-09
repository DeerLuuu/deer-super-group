import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  Agent,
  BoardEntry,
  ChatMessage,
  ChatQuestionRecord,
  ContextSnapshot,
  EventRecord,
  KernelResult,
  LlmSettings,
  MailboxMessage,
  PermissionMode,
  RiskApprovalRequest,
  Run,
  SchedulerSnapshot,
  Snapshot,
  Task,
  UpdateAgentInput,
  Workspace,
} from "./shared/types";
import SettingsView from "./SettingsView";
import Modal from "./Modal";
import TeamDashboard from "./TeamDashboard";
import StatusBadge from "./StatusBadge";
import EmptyState from "./EmptyState";
import SchedulerBar from "./SchedulerBar";
import RunHistory from "./RunHistory";
import RunPanel from "./RunPanel";
import KernelAnnouncer from "./KernelAnnouncer";
import ChatContent from "./ChatContent";
import QuestionModal, { type QuestionSubmitResult } from "./interactive/QuestionModal";
import {
  answerAlreadySent,
  isComposerFocusWithin,
  isEditableElement,
  shouldAutoOpenQuestion,
} from "./interactive/questionFlow";
import type { QuestionValues } from "./shared/interactive";
import CommandPalette, {
  CREATE_LABELS,
  CREATE_TARGET_TAB,
  type CreateIntent,
  type PanelAction,
} from "./CommandPalette";
import { ToastHost, useToasts } from "./Toast";
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
import { buildHash, parseHash, type RouteTab } from "./shared/deeplink";
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
  taskNextStep,
  unwrapKernel,
} from "./shared/kernelUi";
import DockShell, { type DockHandle } from "./shell/dock/DockShell";
import {
  PANEL_DEFS,
  routeTabFromPanel,
  type PanelKey,
} from "./shell/dock/panelRegistry";

type Tab = RouteTab;

/** 侧栏「面板」启动器：设置独立为弹窗，不在此列。 */
const PANEL_LAUNCHER_KEYS: PanelKey[] = [
  "chat",
  "tasks",
  "team",
  "runs",
  "mailbox",
  "board",
  "context",
];

// C10：Router 页并入对话（概述）与任务（规划），导航 7→6。
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "tasks", label: "任务", hint: "查看任务、规划目标、运行与回看 trace" },
  { id: "team", label: "团队", hint: "查看总进度、成员与任务星图" },
  { id: "chat", label: "对话", hint: "与 Router 讨论、查看上下文与工作区概述" },
  { id: "mailbox", label: "邮箱", hint: "查看团队内部消息" },
  { id: "board", label: "黑板", hint: "查看领域共享记忆" },
  { id: "settings", label: "设置", hint: "配置模型与运行参数" },
];

type TaskStatusFilter = "all" | TaskStatus;

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

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // C12：初始 tab 来自 hash 深链（旧 #/router 由 parseHash 重定向到 tasks）。
  const [initialRoute] = useState(() => parseHash(window.location.hash));
  // t52 集成修复 IF-01：冷启动（无显式深链）默认激活「对话」主面板，满足验收
  // 「对话与团队默认同时可见」与设计 §4 activePanel=chat；显式深链（#/tasks 等）
  // 仍优先。deeplink 模块与其默认路由契约不变（tests 不受影响）。
  // t69：带 r=<runId> 的深链优先打开 Run 面板（Run 面板挂在 tasks 路由下）。
  const [bootPanel] = useState<PanelKey | null>(() =>
    initialRoute.run
      ? "runs"
      : window.location.hash.startsWith("#/") && initialRoute.tab !== "settings"
        ? initialRoute.tab
        : null,
  );
  const [tab, setTab] = useState<Tab>(() => {
    if (initialRoute.tab === "settings") return "settings";
    if (initialRoute.run) return "tasks";
    if (!bootPanel) return "chat";
    return bootPanel === "runs" ? "tasks" : (bootPanel as Tab);
  });
  const [settingsOpen, setSettingsOpen] = useState(
    () => initialRoute.tab === "settings",
  );
  const [settingsReturnTab, setSettingsReturnTab] = useState<Tab>(() =>
    initialRoute.tab === "settings" ? "chat" : initialRoute.tab,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [trace, setTrace] = useState<EventRecord[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStream, setChatStream] = useState("");
  const [chatReasoning, setChatReasoning] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [contextTaskId, setContextTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("deer.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 250;
  });
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
  const [openPanelKeys, setOpenPanelKeys] = useState<PanelKey[]>([]);
  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  // C12：邮箱 / 黑板选中项提升到 App，进入 hash 深链。
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  // t69：调度与 Run 可观测状态（调度器快照 + 当前任务 Run 历史）。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerSnapshot | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(true);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [taskRuns, setTaskRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmIntent | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [kernelAnnouncement, setKernelAnnouncement] = useState<string | null>(null);
  const [activePanelKey, setActivePanelKey] = useState<PanelKey | null>(bootPanel);
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
  const { toasts, pushToast, dismissToast } = useToasts();
  // t50：Dock 布局（对话/团队双主面板）。
  const dockRef = useRef<DockHandle | null>(null);
  const dockHostRef = useRef<HTMLDivElement | null>(null);
  const [dockWidth, setDockWidth] = useState(() =>
    Math.max(320, window.innerWidth - 300),
  );
  const snapshotRef = useRef<Snapshot | null>(null);
  const selectedTaskRef = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizingRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("deer.sidebarCollapsed") === "1",
  );

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
      setSettingsOpen(false);
      setPanelMenuOpen(false);
      const route = routeTabFromPanel(key);
      if (route) setTab(route);
      setActivePanelKey(key);
      dockRef.current?.openPanel(key);
    },
    [tab],
  );

  function togglePanelMenu() {
    if (!panelMenuOpen) {
      setOpenPanelKeys(dockRef.current?.getOpenPanelKeys() ?? []);
    }
    setCreateMenuOpen(false);
    setPanelMenuOpen((open) => !open);
  }

  function closeSettings() {
    setSettingsOpen(false);
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
  ]);

  // C09：窄窗自动折叠侧栏；Ctrl/⌘+B 手动切换。
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    let wasNarrow = query.matches;
    if (query.matches) {
      setSidebarCollapsed(true);
      localStorage.setItem("deer.sidebarCollapsed", "1");
    }
    function onChange(event: MediaQueryListEvent) {
      const enteringNarrow = event.matches && !wasNarrow;
      wasNarrow = event.matches;
      if (enteringNarrow) {
        setSidebarCollapsed(true);
        localStorage.setItem("deer.sidebarCollapsed", "1");
      }
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // C09/C11：全局快捷键——Ctrl/⌘+B 折叠侧栏、Ctrl/⌘+K 命令面板、Alt+1–6 切换页面。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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
      const next = Math.min(480, Math.max(180, event.clientX));
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    }
    function onUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("deer.sidebarWidth", String(sidebarWidthRef.current));
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
    sidebarWidthRef.current = 250;
    setSidebarWidth(250);
    localStorage.setItem("deer.sidebarWidth", "250");
  }

  const loadTrace = useCallback(async (taskId: string) => {
    try {
      setTrace(await window.deer.getTaskTrace(taskId));
    } catch (error) {
      setError(errorText(error));
    }
  }, []);

  /** t69：调度器快照；silent 用于事件刷新，避免每 220ms 出现骨架闪烁。 */
  const loadScheduler = useCallback(
    async (workspaceId: string, silent = false) => {
      const requestId = ++schedulerRequestRef.current;
      if (!silent) setSchedulerLoading(true);
      try {
        const result = await window.deer.getScheduler(workspaceId);
        if (schedulerRequestRef.current !== requestId) return;
        if (result.ok) {
          setScheduler(result.value);
          setSchedulerError(null);
        } else {
          setSchedulerError(kernelErrorText(result.error));
        }
      } catch (error) {
        if (schedulerRequestRef.current === requestId) {
          setSchedulerError(errorText(error));
        }
      } finally {
        if (schedulerRequestRef.current === requestId) setSchedulerLoading(false);
      }
    },
    [],
  );

  /** t69：当前任务的 Run 历史；silent 同上。 */
  const loadRuns = useCallback(async (taskId: string, silent = false) => {
    const requestId = ++runsRequestRef.current;
    if (!silent) {
      setRunsLoading(true);
      setTaskRuns([]);
    }
    try {
      const result = await window.deer.listRuns(taskId);
      if (runsRequestRef.current !== requestId) return;
      if (result.ok) {
        setTaskRuns(result.value);
        setRunsError(null);
      } else {
        setTaskRuns([]);
        setRunsError(kernelErrorText(result.error));
      }
    } catch (error) {
      if (runsRequestRef.current === requestId) {
        setTaskRuns([]);
        setRunsError(errorText(error));
      }
    } finally {
      if (runsRequestRef.current === requestId) setRunsLoading(false);
    }
  }, []);

  const loadChat = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return;
    const router = current.agents.find((agent) => agent.isRouter);
    if (!router) return;
    const [messages, contextSnapshot] = await Promise.all([
      window.deer.listChat(current.workspace.id, router.id),
      window.deer.getContext(
        current.workspace.id,
        contextTaskId ? undefined : router.id,
        contextTaskId ?? undefined,
      ),
    ]);
    setChatMessages(messages);
    setContext(contextSnapshot);
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

  const refresh = useCallback(
    async (workspaceId: string) => {
      const next = await window.deer.getSnapshot(workspaceId);
      setSnapshot(next);
      // t69：事件刷新同时更新调度快照与当前任务 Run（静默，不闪骨架）。
      void loadScheduler(workspaceId, true);
      if (selectedTaskRef.current) {
        await loadTrace(selectedTaskRef.current);
        void loadRuns(selectedTaskRef.current, true);
      }
    },
    [loadTrace, loadScheduler, loadRuns],
  );

  // t69：工作区切换/首屏就绪后加载调度快照（与 snapshot 解耦，避免每次 refresh 重载）。
  useEffect(() => {
    if (!snapshot) return;
    void loadScheduler(snapshot.workspace.id);
  }, [snapshot?.workspace.id, loadScheduler]);

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
  }, [snapshot, initialRoute, loadTrace, loadRuns]);

  // C12：浏览器前进/后退或外部 hash 变更 → 恢复视图（自己写入的 hash 跳过）。
  useEffect(() => {
    function onHashChange() {
      if (window.location.hash === lastWrittenHashRef.current) return;
      lastWrittenHashRef.current = window.location.hash;
      const route = parseHash(window.location.hash);
      lastTabRef.current = route.tab;
      if (route.tab === "settings") {
        setSettingsOpen(true);
        setTab("settings");
      } else {
        setSettingsOpen(false);
        setSettingsReturnTab(route.tab);
        setTab(route.tab);
        dockRef.current?.openPanel(route.tab);
      }
      if (route.task) {
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
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadTrace, loadRuns]);

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
    const off = window.deer.onEvent(() => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        const current = snapshotRef.current;
        if (current) void refresh(current.workspace.id);
      }, 220);
    });
    return () => {
      off();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

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

  useEffect(() => {
    const off = window.deer.onChatEvent((event) => {
      const current = snapshotRef.current;
      if (!current || event.workspaceId !== current.workspace.id) return;
      if (event.type === "delta") {
        setChatStream((prev) => prev + event.text);
      } else if (event.type === "reasoning") {
        setChatReasoning((prev) => prev + event.text);
      } else if (event.type === "done") {
        setChatStream("");
        setChatReasoning("");
        setChatBusy(false);
        void loadChat().catch((error) => setError(errorText(error)));
      } else if (event.type === "cancelled") {
        setChatStream("");
        setChatReasoning("");
        setChatBusy(false);
        void loadChat().catch(() => {});
      } else if (event.type === "error") {
        setChatStream("");
        setChatReasoning("");
        setChatBusy(false);
        setError(event.error);
        void loadChat().catch(() => {});
      }
    });
    return off;
  }, [loadChat]);

  function resetForWorkspace() {
    setSelectedTaskId(null);
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
    setChatStream("");
    setChatReasoning("");
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
          `已取消 Run #${intent.run.attempt ?? 1}（${intent.taskTitle}）`,
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

  async function handleCreateTask(title: string, description: string, acceptance: string[]) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const task = await window.deer.createTask({
        workspaceId: current.workspace.id,
        title,
        description,
        acceptance,
      });
      await refresh(current.workspace.id);
      setSelectedTaskId(task.id);
      await loadTrace(task.id);
      openPanel("tasks");
      // C26：成功 toast + 下一步动作。
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
    } catch (error) {
      setError(errorText(error));
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
  }) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await window.deer.createAgent({ workspaceId: current.workspace.id, ...input });
      await refresh(current.workspace.id);
      // C26：成功 toast。
      pushToast({
        kind: "success",
        message: `已创建成员 ${input.name}`,
        action: { label: "查看", onClick: () => openPanel("team") },
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
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

  async function handlePlan(goal: string) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const tasks = await window.deer.plan(current.workspace.id, goal);
      await refresh(current.workspace.id);
      if (tasks[0]) {
        setSelectedTaskId(tasks[0].id);
        await loadTrace(tasks[0].id);
      }
      openPanel("tasks");
      // C26：成功 toast + 下一步动作。
      pushToast({
        kind: "success",
        message: `已规划 ${tasks.length} 个任务`,
        action: { label: "查看", onClick: () => openPanel("tasks") },
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
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
    setChatStream("");
    setChatReasoning("");
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

  async function handleSendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
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
  function openRunsPanel(taskId?: string | null, runId?: string | null) {
    if (taskId) {
      setSelectedTaskId(taskId);
      void loadTrace(taskId);
      void loadRuns(taskId);
    }
    setSelectedRunId(runId ?? null);
    openPanel("runs");
  }

  function handleOpenTaskPage(taskId: string) {
    setSelectedTaskId(taskId);
    setSelectedRunId(null);
    void loadTrace(taskId);
    void loadRuns(taskId);
    openPanel("tasks");
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

  // t50：命令面板「面板」组动作 → DockHandle。
  function handlePanelAction(action: PanelAction) {
    const dock = dockRef.current;
    if (!dock) return;
    switch (action) {
      case "open-context":
        openPanel("context");
        break;
      case "open-runs":
        openPanel("runs");
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

  async function handleSendMessage(input: {
    to: string[];
    subject: string;
    body: string;
    kind: MailboxMessage["kind"];
  }) {
    const current = snapshotRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await window.deer.sendMessage({
        workspaceId: current.workspace.id,
        from: "user",
        ...input,
      });
      await refresh(current.workspace.id);
      // C26：成功 toast + 下一步动作。
      pushToast({
        kind: "success",
        message: `已发送邮件「${input.subject}」`,
        action: { label: "查看", onClick: () => openPanel("mailbox") },
      });
    } catch (error) {
      setError(errorText(error));
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

  async function handleSaveSettings(settings: LlmSettings) {
    setBusy(true);
    setError(null);
    try {
      await window.deer.saveSettings(settings);
      const current = snapshotRef.current;
      if (current) await refresh(current.workspace.id);
      // C26：成功 toast。
      pushToast({ kind: "success", message: "设置已保存" });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  // C03：页面地标——窗口标题随工作区/页面更新。
  // 集成修复 IF-01（t24）：本 effect 必须位于下面的 `if (!snapshot)` 提前返回之前。
  // 原实现放在提前返回之后：首屏（无快照）少调一个 hook，快照就绪后的渲染多调一个，
  // React 会抛 "Rendered more hooks than during the previous render"（开发构建）。
  useEffect(() => {
    const pageLabel = TABS.find((item) => item.id === tab)?.label ?? "";
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
  const failedCount = snapshot.tasks.filter((task) => task.status === "failed").length;

  return (
    <div className="app">
      <aside
        className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
        style={sidebarCollapsed ? undefined : { width: `${sidebarWidth}px` }}
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
            onClick={() => void refresh(snapshot.workspace.id)}
            title="刷新"
          >
            <span className="sidebar-action-icon">↻</span>
            <span className="sidebar-action-label">刷新</span>
          </button>
          <div className="panel-menu-wrap">
            <button
              type="button"
              className="ghost small sidebar-action"
              onClick={togglePanelMenu}
              aria-expanded={panelMenuOpen}
              aria-haspopup="menu"
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
                {PANEL_LAUNCHER_KEYS.map((key) => {
                  const def = PANEL_DEFS[key];
                  const isOpen = openPanelKeys.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="menuitem"
                      className={`panel-menu-item ${isOpen ? "is-open" : ""}`}
                      onClick={() => openPanel(key)}
                    >
                      <span className="panel-menu-title">{def.title}</span>
                      <span className="panel-menu-state">
                        {isOpen ? "已打开" : "打开"}
                      </span>
                    </button>
                  );
                })}
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

      <div
        className="resizer"
        role="separator"
        aria-orientation="vertical"
        title="拖动调整侧栏宽度，双击恢复默认"
        onMouseDown={startResize}
        onDoubleClick={resetSidebarWidth}
      />

      <main className="main">
        {error && (
          <div className="error banner" role="alert">
            {/* C26：格式化后的错误文案 + 复制详情 */}
            <span className="error-banner-text">{error}</span>
            <div className="row gap">
              <button
                className="ghost tiny"
                onClick={() => {
                  void navigator.clipboard?.writeText(error).catch(() => {});
                }}
              >
                复制详情
              </button>
              <button className="ghost tiny" onClick={() => setError(null)}>
                关闭
              </button>
            </div>
          </div>
        )}

        {/* t50：VSCode 风格 Dock 布局——对话/团队双主面板，其余视图为可拖动面板 */}
        <div className="dock-host" ref={dockHostRef}>
          <DockShell
            ref={dockRef}
            workspaceId={snapshot.workspace.id}
            dockWidth={dockWidth}
            initialPanelKey={bootPanel}
            onActivePanelChange={handleDockActivePanel}
            onNotify={(message) => pushToast({ kind: "success", message })}
            renderPanel={(key) => {
              switch (key) {
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
                      onPlan={handlePlan}
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
                      onOpenRuns={openRunsPanel}
                      onStartTask={handleStartTask}
                      onRetryTask={handleRequestRetry}
                      onCancelTask={handleRequestCancelTask}
                      onCancelRun={handleRequestCancelRun}
                      onReviewTask={handleRequestReview}
                      onPause={handleRequestPauseScheduler}
                      onResume={handleRequestResumeScheduler}
                    />
                  );
                case "team":
                  return (
                    <TeamDashboard
                      snapshot={snapshot}
                      busy={busy}
                      selectedTaskId={selectedTaskId}
                      onSelectTask={(taskId) => {
                        setSelectedTaskId(taskId);
                        setSelectedRunId(null);
                        const current = snapshotRef.current;
                        if (taskId && current) {
                          const task = current.tasks.find((entry) => entry.id === taskId);
                          if (task) {
                            void loadTrace(task.id);
                            void loadRuns(task.id);
                          }
                        }
                      }}
                      starmapFocus={starmapFocus}
                      autoOpenMemberDialog={createIntent === "member"}
                      onAutoOpenHandled={() => setCreateIntent(null)}
                      onCreate={handleCreateAgent}
                      onUpdate={handleUpdateAgent}
                      onOpenTask={(taskId) => handleShowTaskContext(taskId, "team")}
                      onOpenTaskPage={handleOpenTaskPage}
                      scheduler={scheduler}
                      onOpenRuns={(taskId) =>
                        openRunsPanel(taskId ?? selectedTaskId, null)
                      }
                    />
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
                      onOpenTaskPage={handleOpenTaskPage}
                      onOpenTaskChat={(taskId) => handleShowTaskContext(taskId, "team")}
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
                      stream={chatStream}
                      reasoning={chatReasoning}
                      busy={chatBusy}
                      input={chatInput}
                      onInput={setChatInput}
                      onSend={handleSendChat}
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
                    />
                  );
                case "board":
                  return (
                    <BoardView
                      snapshot={snapshot}
                      busy={busy}
                      selectedBoard={selectedBoard}
                      onSelectBoard={setSelectedBoard}
                      autoOpenPublish={createIntent === "board"}
                      onAutoOpenHandled={() => setCreateIntent(null)}
                      onPost={handlePostBoard}
                    />
                  );
                default:
                  return null;
              }
            }}
          />
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
          description="模型、插件、MCP、Skills 与团队"
          onClose={closeSettings}
          className="settings-modal"
        >
          <SettingsView
            snapshot={snapshot}
            busy={busy}
            onSave={handleSaveSettings}
            onReload={() => void refresh(snapshot.workspace.id)}
          />
        </Modal>
      )}

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

      {/* t69：任务/Run/调度状态变化的 aria-live 播报（视觉隐藏） */}
      <KernelAnnouncer
        tasks={snapshot.tasks}
        scheduler={scheduler}
        runs={taskRuns}
        actionMessage={kernelAnnouncement}
      />

      {/* C26：全局 toast */}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
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
            取消不会删除任务与已有 Run 记录；需要重跑请新建任务或使用「重试」（仅失败任务）。
          </div>
        )}
        {intent.kind === "cancelRun" && (
          <div className="notice small">
            Run 级取消只影响本次执行；任务可选择「重试」重新入队。
          </div>
        )}
        {intent.kind === "resume" && (
          <div className="notice small">
            恢复不是危险操作，此处确认用于避免误触；运行中的 Run 不受影响。
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
  onPlan,
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
  onReviewTask,
  onPause,
  onResume,
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
  onCreate: (title: string, description: string, acceptance: string[]) => void;
  onContext: (taskId: string) => void;
  onLocate: (taskId: string) => void;
  onPlan: (goal: string) => void;
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
  onReviewTask: (task: Task, decision: "approve" | "reject") => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  // C11：从顶栏/命令面板进入时自动打开对应弹窗（一次性）。
  useEffect(() => {
    if (!autoOpen) return;
    if (autoOpen === "task") setComposeOpen(true);
    if (autoOpen === "plan") setPlanOpen(true);
    onAutoOpenHandled();
  }, [autoOpen, onAutoOpenHandled]);
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
  const resizingListRef = useRef(false);

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
  const nextStep = selectedTask
    ? taskNextStep(selectedTask, taskById, hasWorker)
    : null;
  const selectedTaskDeps = selectedTask
    ? selectedTask.dependsOn
        .map((id) => taskById.get(id))
        .filter((item): item is Task => Boolean(item))
    : [];
  const unfilledDeps = selectedTaskDeps.filter((task) => task.status !== "done");

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
              <button
                type="button"
                className="ghost small"
                onClick={() => setPlanOpen(true)}
                disabled={busy}
                title="让 Router 把一个目标拆成任务 DAG"
              >
                规划任务
              </button>
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
                  { label: "规划任务", onClick: () => setPlanOpen(true) },
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

      {!listCollapsed && (
        <div
          className="task-resizer"
          role="separator"
          aria-orientation="vertical"
          title="拖动调整任务列表宽度，双击恢复默认"
          onMouseDown={startListResize}
          onDoubleClick={resetListWidth}
        />
      )}

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
            </div>
          )}
        </div>

        {!selectedTask && (
          <EmptyState
            icon="☰"
            title={snapshot.tasks.length === 0 ? "创建第一个任务" : "选择一个任务"}
            description={
              snapshot.tasks.length === 0
                ? "用「规划任务」让 Router 拆解目标，或直接「+ 新建」。"
                : "在左侧列表选择任务，查看详情与执行 trace。"
            }
            actions={
              snapshot.tasks.length === 0
                ? [
                    { label: "规划任务", onClick: () => setPlanOpen(true) },
                    { label: "+ 新建任务", onClick: () => setComposeOpen(true), primary: true },
                  ]
                : undefined
            }
          />
        )}
        {selectedTask && (
          <>
            <div className="task-detail-headrow">
              <div className="row gap wrap">
                <StatusBadge status={selectedTask.status} />
                <span className="muted tiny mono">{selectedTask.id}</span>
              </div>
              <div className="row gap wrap">
                <button
                  className="ghost small"
                  onClick={() => onLocate(selectedTask.id)}
                  title="在团队页星图中定位该任务"
                >
                  在星图中定位
                </button>
                <button
                  className="ghost small"
                  onClick={() => onContext(selectedTask.id)}
                  title="在对话页查看这次任务的上下文"
                >
                  查看上下文
                </button>
                <button
                  className="ghost small"
                  onClick={() => onOpenRuns(selectedTask.id, selectedRunId)}
                  title="打开运行面板：队列、Run 历史与时间线"
                >
                  运行详情
                </button>
                {/* t107 F3：主要操作常驻渲染，不可用时 disabled + title/aria-describedby 原因（与 RunPanel 一致）。 */}
                <button
                  className="primary small"
                  disabled={
                    !actionState?.start.enabled ||
                    actionBusy === `task:start:${selectedTask.id}`
                  }
                  onClick={() => onStartTask(selectedTask)}
                  title={actionState?.start.reason || "入队运行（默认手动入队）"}
                  aria-describedby={
                    actionState?.start.enabled ? undefined : "task-action-hint"
                  }
                >
                  {actionBusy === `task:start:${selectedTask.id}` ? "入队中…" : "运行任务"}
                </button>
                <button
                  className="primary small"
                  disabled={
                    !actionState?.retry.enabled ||
                    actionBusy === `task:retry:${selectedTask.id}`
                  }
                  onClick={() => onRetryTask(selectedTask)}
                  title={actionState?.retry.reason || "重新入队：会新建一次 attempt"}
                  aria-describedby={
                    actionState?.retry.enabled ? undefined : "task-action-hint"
                  }
                >
                  {actionBusy === `task:retry:${selectedTask.id}` ? "重试中…" : "重试任务"}
                </button>
                <button
                  className="primary small"
                  disabled={
                    !actionState?.review.enabled ||
                    actionBusy === `task:review:${selectedTask.id}`
                  }
                  onClick={() => onReviewTask(selectedTask, "approve")}
                  title={actionState?.review.reason || "批准：任务标记为已交付"}
                  aria-describedby={
                    actionState?.review.enabled ? undefined : "task-action-hint"
                  }
                >
                  批准
                </button>
                <button
                  className="ghost small run-danger"
                  disabled={
                    !actionState?.review.enabled ||
                    actionBusy === `task:review:${selectedTask.id}`
                  }
                  onClick={() => onReviewTask(selectedTask, "reject")}
                  title={actionState?.review.reason || "拒绝：任务标记失败（REVIEW_REJECTED）"}
                  aria-describedby={
                    actionState?.review.enabled ? undefined : "task-action-hint"
                  }
                >
                  拒绝
                </button>
                <button
                  className="ghost small run-danger"
                  disabled={
                    !actionState?.cancel.enabled ||
                    actionBusy === `task:cancel:${selectedTask.id}`
                  }
                  onClick={() => onCancelTask(selectedTask)}
                  title={actionState?.cancel.reason || "取消任务：运行中的 Run 会中止，取消是终态"}
                  aria-describedby={
                    actionState?.cancel.enabled ? undefined : "task-action-hint"
                  }
                >
                  {actionBusy === `task:cancel:${selectedTask.id}` ? "取消中…" : "取消任务"}
                </button>
              </div>
            </div>

            {/* t107 F3：不可用操作的原因（可见 inline 说明，供 aria-describedby 引用）。 */}
            {actionState && (
              <div id="task-action-hint" className="muted tiny task-action-hint">
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
                <span>操作失败：{actionError}</span>
              </div>
            )}

            {!hasWorker && (
              <div className="notice">还没有可用成员。请先到「团队」创建成员或把成员设为非离线，再运行任务。</div>
            )}

            {nextStep && nextStep.kind !== "none" && (
              <div className={`task-next-step tone-${nextStep.kind}`}>
                <strong>{nextStep.label}</strong>
                <span>{nextStep.detail}</span>
                {unfilledDeps.length > 0 && (
                  <span className="muted tiny">
                    上游：{" "}
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
                  </span>
                )}
              </div>
            )}

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
            </div>

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
            />

            <div className="trace-head">
              <div className="section-label">执行 trace</div>
              <span className="muted tiny">{trace.length} 条事件</span>
            </div>
            <div className="trace">
              {trace.length === 0 && <div className="empty small">还没有执行记录。</div>}
              {trace.map((event) => (
                <TraceItem key={event.seq} event={event} />
              ))}
            </div>
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

      {planOpen && (
        <RouterPlanModal
          busy={busy}
          onClose={() => setPlanOpen(false)}
          onPlan={onPlan}
        />
      )}
    </div>
  );
}

function TaskComposeModal({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string, acceptance: string[]) => void;
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
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onCreate(
            title.trim(),
            description.trim(),
            acceptance
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
          );
          onClose();
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

// C10：旧 RouterView 已移除——工作区概述并入对话页（ChatView），「规划任务」移入任务页头部。

function RouterPlanModal({
  busy,
  onClose,
  onPlan,
}: {
  busy: boolean;
  onClose: () => void;
  onPlan: (goal: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const dirty = Boolean(goal.trim());

  return (
    <Modal
      title="让 Router 规划"
      description="目标会被拆成 2–4 个带依赖的任务"
      onClose={onClose}
      confirmClose={dirty}
    >
      <form
        className="form modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!goal.trim()) return;
          onPlan(goal.trim());
          onClose();
        }}
      >
        <label>
          目标
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={7}
            placeholder="例如：给这个项目加一个健康检查接口，并补上测试。"
          />
        </label>
        <div className="notice small">
          规划完成后会自动跳到「任务」页；任务默认按依赖顺序执行。
        </div>
        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !goal.trim()}>
            {busy ? "规划中…" : "开始规划"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MailboxView({
  snapshot,
  busy,
  selectedMessageId,
  onSelectMessage,
  autoOpenCompose,
  onAutoOpenHandled,
  onSend,
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
  }) => void;
}) {
  const [composeOpen, setComposeOpen] = useState(false);

  useEffect(() => {
    if (!autoOpenCompose) return;
    setComposeOpen(true);
    onAutoOpenHandled();
  }, [autoOpenCompose, onAutoOpenHandled]);

  const selected =
    snapshot.messages.find((message) => message.id === selectedMessageId) ??
    snapshot.messages[0] ??
    null;

  return (
    <div className="mailbox-layout">
      <section className="panel mailbox-list-panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">邮箱</div>
            <div className="muted tiny">{snapshot.messages.length} 封内部消息</div>
          </div>
          <button
            type="button"
            className="primary small"
            onClick={() => setComposeOpen(true)}
            disabled={busy}
          >
            发邮件
          </button>
        </div>
        <div className="message-list">
          {snapshot.messages.length === 0 && (
            // C24：空状态带行动引导。
            <EmptyState
              icon="✉"
              title="还没有邮件"
              description="给成员或 Router 发第一封内部邮件。"
              actions={[{ label: "发邮件", onClick: () => setComposeOpen(true), primary: true }]}
            />
          )}
          {snapshot.messages.map((message) => (
            <button
              key={message.id}
              className={`message-row ${selected?.id === message.id ? "selected" : ""}`}
              onClick={() => onSelectMessage(message.id)}
            >
              <div className="row between">
                <span className="ellipsis message-subject">{message.subject}</span>
                <span className="muted tiny">{time(message.createdAt)}</span>
              </div>
              <div className="muted tiny ellipsis">
                {message.from} → {message.to.join(", ")}
              </div>
              <div className="row between">
                <span className="badge">{MESSAGE_KIND_LABEL[message.kind] ?? message.kind}</span>
                <span className="muted tiny">{message.to.length} 位收件人</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="panel mailbox-detail-panel">
        {selected ? (
          <>
            <div className="mailbox-detail-head">
              <div className="row gap">
                <span className="badge">{MESSAGE_KIND_LABEL[selected.kind] ?? selected.kind}</span>
                <span className="muted tiny">{time(selected.createdAt)}</span>
              </div>
              <div className="panel-title mailbox-detail-subject">{selected.subject}</div>
              <div className="muted tiny">
                {selected.from} → {selected.to.join(", ")}
              </div>
            </div>
            <pre className="mailbox-body">{selected.body}</pre>
          </>
        ) : (
          <EmptyState
            icon="✉"
            title="选择一封邮件"
            description="在左侧选择邮件查看内容，或发送新消息。"
            actions={
              snapshot.messages.length === 0
                ? undefined
                : [{ label: "发邮件", onClick: () => setComposeOpen(true), primary: true }]
            }
          />
        )}
      </section>

      {composeOpen && (
        <MailboxComposeModal
          snapshot={snapshot}
          busy={busy}
          onClose={() => setComposeOpen(false)}
          onSend={onSend}
        />
      )}
    </div>
  );
}

function MailboxComposeModal({
  snapshot,
  busy,
  onClose,
  onSend,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  onSend: (input: {
    to: string[];
    subject: string;
    body: string;
    kind: MailboxMessage["kind"];
  }) => void;
}) {
  const [to, setTo] = useState("Router");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MailboxMessage["kind"]>("request");
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
    (to.trim() !== "Router" && to.trim() !== "") || subject.trim() || body.trim(),
  );

  return (
    <Modal
      title="发邮件"
      description="团队内部邮箱，不会发送到外部地址"
      onClose={onClose}
      confirmClose={dirty}
      className="mailbox-compose-modal"
    >
      <form
          className="form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedRecipients.length || !subject.trim() || !body.trim()) return;
            onSend({
              to: selectedRecipients,
              subject: subject.trim(),
              body: body.trim(),
              kind,
            });
            onClose();
          }}
        >
          <label>
            收件人（逗号分隔，也可以点选成员）
            <input
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
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="例如：请检查登录接口"
              />
            </label>
            <label>
              类型
              <select
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
              发送邮件
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

function ChatView({
  messages,
  stream,
  reasoning,
  busy,
  input,
  onInput,
  onSend,
  onStop,
  taskContext,
  taskContextSource,
  onReturnToSource,
  onClearTaskContext,
  onOpenContextPanel,
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
  stream: string;
  reasoning: string;
  busy: boolean;
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
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

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, stream]);

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
            <button type="button" className="ghost tiny" onClick={onOpenContextPanel}>
              上下文
            </button>
          </div>
        </div>

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
          {messages.length === 0 && !stream && (
            // C24：空状态给可点击示例，一步发起对话。
            <EmptyState
              icon="◎"
              title="和 Router 说点什么"
              description="讨论目标、澄清需求，Router 会给出建议。"
              actions={[
                {
                  label: "这个项目怎么跑起来？",
                  onClick: () => onInput("这个项目怎么跑起来？"),
                },
                {
                  label: "帮我加一个健康检查接口",
                  onClick: () => onInput("帮我加一个健康检查接口"),
                },
                {
                  label: "总结当前任务进展",
                  onClick: () => onInput("总结当前任务进展"),
                },
              ]}
            />
          )}
          {messages.map((message) => (
            <ChatBubble
              key={message.id}
              messageId={message.id}
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              createdAt={message.createdAt}
              questions={questions}
              questionsLoaded={questionsLoaded}
              onAnswerQuestion={onAnswerQuestion}
              onToast={onToast}
            />
          ))}
          {(reasoning || stream) && (
            <ChatBubble
              role="assistant"
              content={stream}
              reasoning={reasoning}
              streaming
              questions={questions}
              questionsLoaded={questionsLoaded}
              onAnswerQuestion={onAnswerQuestion}
              onToast={onToast}
            />
          )}
        </div>

        <div className="chat-composer">
          <textarea
            value={input}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={3}
            placeholder="给 Router 发消息… Ctrl+Enter 发送"
          />
          <div className="row between">
            <span className="muted tiny">
              {busy ? "Router 正在回复…" : "上下文与工具会随任务变化"}
            </span>
            <div className="row gap">
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
      </section>
    </div>
  );
}

function ChatBubble({
  messageId,
  role,
  content,
  reasoning,
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
          <details className="chat-reasoning" open={streaming}>
            <summary>
              {streaming ? "深度思考中…" : "深度思考"}
              <span className="muted tiny"> · {reasoning.length} 字</span>
            </summary>
            <pre>{reasoning}</pre>
          </details>
        )}
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
