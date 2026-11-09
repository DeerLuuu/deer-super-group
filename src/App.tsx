import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  Agent,
  BoardEntry,
  ChatMessage,
  ContextSnapshot,
  EventRecord,
  LlmSettings,
  MailboxMessage,
  PermissionMode,
  RiskApprovalRequest,
  Snapshot,
  Task,
  UpdateAgentInput,
  Workspace,
} from "./shared/types";
import SettingsView from "./SettingsView";
import Modal from "./Modal";
import Markdown from "./Markdown";
import TeamDashboard from "./TeamDashboard";
import StatusBadge from "./StatusBadge";
import EmptyState from "./EmptyState";
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
import DockShell, { type DockHandle } from "./shell/dock/DockShell";
import {
  PANEL_DEFS,
  routeTabFromPanel,
  type PanelKey,
} from "./shell/dock/panelRegistry";

type Tab = RouteTab;

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
  const [bootPanel] = useState<Tab | null>(() =>
    window.location.hash.startsWith("#/") && initialRoute.tab !== "settings"
      ? initialRoute.tab
      : null,
  );
  const [tab, setTab] = useState<Tab>(() =>
    initialRoute.tab === "settings" ? "settings" : bootPanel ?? "chat",
  );
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
  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  // C12：邮箱 / 黑板选中项提升到 App，进入 hash 深链。
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  // DESIGN §15.4：满血模式（会话级，不持久化、不随启动恢复）。
  const [chatFullThrottle, setChatFullThrottle] = useState(false);
  // t58 IF-05：auto_risk 高风险人类审批队列（内存态；刷新即失，主进程超时兜底）。
  // 多个高风险调用并发时按 FIFO 依次弹窗，避免后到请求覆盖先到请求导致误超时。
  const [riskApprovals, setRiskApprovals] = useState<RiskApprovalRequest[]>([]);
  const riskApproval = riskApprovals[0] ?? null;
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
      const route = routeTabFromPanel(key);
      if (route) setTab(route);
      dockRef.current?.openPanel(key);
    },
    [tab],
  );

  function closeSettings() {
    setSettingsOpen(false);
    const back = settingsReturnTab === "settings" ? "chat" : settingsReturnTab;
    setTab(back);
    dockRef.current?.openPanel(back);
  }

  // t50：dock 激活面板 → 派生路由 tab（context 面板不改变 hash）。
  const handleDockActivePanel = useCallback((key: PanelKey) => {
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
    });
    if (window.location.hash === hash) return;
    lastWrittenHashRef.current = hash;
    if (lastTabRef.current !== tab) {
      lastTabRef.current = tab;
      window.location.hash = hash; // 产生 history 条目
    } else {
      history.replaceState(null, "", hash);
    }
  }, [tab, selectedTaskId, contextTaskId, selectedMessageId, selectedBoard]);

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
  }, [contextTaskId]);

  const refresh = useCallback(
    async (workspaceId: string) => {
      const next = await window.deer.getSnapshot(workspaceId);
      setSnapshot(next);
      if (selectedTaskRef.current) {
        await loadTrace(selectedTaskRef.current);
      }
    },
    [loadTrace],
  );

  // C12：初始深链——快照就绪后应用选中对象（任务/邮件/黑板）。
  useEffect(() => {
    if (!snapshot || appliedInitialRouteRef.current) return;
    appliedInitialRouteRef.current = true;
    if (initialRoute.task) {
      setSelectedTaskId(initialRoute.task);
      void loadTrace(initialRoute.task);
    }
    if (initialRoute.chatTask) {
      setContextTaskId(initialRoute.chatTask);
      setContextSource("tasks");
    }
    if (initialRoute.message) setSelectedMessageId(initialRoute.message);
    if (initialRoute.board) setSelectedBoard(initialRoute.board);
  }, [snapshot, initialRoute, loadTrace]);

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
      setContextTaskId(route.chatTask);
      setContextSource(route.chatTask ? "tasks" : null);
      setSelectedMessageId(route.message);
      setSelectedBoard(route.board);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadTrace]);

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
    setTrace([]);
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

  async function handleRunTask(taskId: string) {
    setBusy(true);
    setError(null);
    try {
      await window.deer.runTask(taskId);
      const current = snapshotRef.current;
      if (current) await refresh(current.workspace.id);
      await loadTrace(taskId);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
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

  async function handleSendChat() {
    const current = snapshotRef.current;
    const router = current?.agents.find((agent) => agent.isRouter);
    const text = chatInput.trim();
    if (!current || !router || !text || chatBusy) return;
    setChatInput("");
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
        content: text,
        reasoning: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    try {
      await window.deer.sendChat(current.workspace.id, text);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setChatBusy(false);
      void loadChat().catch((error) => setError(errorText(error)));
    }
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
    openPanel("chat");
  }

  // C14：任务详情 → 在星图中定位（跳团队页并居中该节点）。
  function handleLocateInStarMap(taskId: string) {
    setSelectedTaskId(taskId);
    setStarmapFocus({ taskId, nonce: Date.now() });
    openPanel("team");
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
    void loadTrace(taskId);
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
          {createMenuOpen && (
            <div className="menu-backdrop" onClick={() => setCreateMenuOpen(false)} />
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
              onClick={() => setCreateMenuOpen((open) => !open)}
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
            <div className="section-label">面板</div>
            <p className="muted tiny">
              使用上方 Dock 标签或 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> 切换面板。
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
                        void loadTrace(task.id);
                      }}
                      onRun={handleRunTask}
                      onCreate={handleCreateTask}
                      onContext={(taskId) => {
                        handleShowTaskContext(taskId, "tasks");
                        // 集成修复 IF-04（t52）：上下文抽为独立面板后，任务详情
                        // 「查看上下文」需同时打开上下文面板，否则动作名与结果不符。
                        openPanel("context");
                      }}
                      onLocate={handleLocateInStarMap}
                      onPlan={handlePlan}
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
                        const current = snapshotRef.current;
                        if (taskId && current) {
                          const task = current.tasks.find((entry) => entry.id === taskId);
                          if (task) void loadTrace(task.id);
                        }
                      }}
                      starmapFocus={starmapFocus}
                      autoOpenMemberDialog={createIntent === "member"}
                      onAutoOpenHandled={() => setCreateIntent(null)}
                      onCreate={handleCreateAgent}
                      onUpdate={handleUpdateAgent}
                      onOpenTask={(taskId) => handleShowTaskContext(taskId, "team")}
                      onOpenTaskPage={(taskId) => {
                        setSelectedTaskId(taskId);
                        void loadTrace(taskId);
                        openPanel("tasks");
                      }}
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

      {/* C26：全局 toast */}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

const TASK_FILTERS: Array<TaskStatusFilter> = [
  "all",
  "running",
  "blocked",
  "ready",
  "review",
  "done",
  "failed",
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
  onRun,
  onCreate,
  onContext,
  onLocate,
  onPlan,
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
  onRun: (taskId: string) => void;
  onCreate: (title: string, description: string, acceptance: string[]) => void;
  onContext: (taskId: string) => void;
  onLocate: (taskId: string) => void;
  onPlan: (goal: string) => void;
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
  const hasWorker = snapshot.agents.some((agent) => !agent.isRouter);

  const keyword = search.trim().toLowerCase();
  const filteredTasks = snapshot.tasks.filter((task) => {
    const statusOk = statusFilter === "all" || task.status === statusFilter;
    const searchOk =
      !keyword ||
      task.title.toLowerCase().includes(keyword) ||
      task.id.toLowerCase().includes(keyword) ||
      (task.summary ?? "").toLowerCase().includes(keyword);
    return statusOk && searchOk;
  });

  function countFor(filter: TaskStatusFilter): number {
    return filter === "all"
      ? snapshot.tasks.length
      : snapshot.tasks.filter((task) => task.status === filter).length;
  }

  return (
    <div
      className={`tasks-layout ${listCollapsed ? "collapsed" : ""}`}
      ref={layoutRef}
      style={
        listCollapsed ? undefined : ({ "--task-list-w": `${listWidth}px` } as CSSProperties)
      }
    >
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
                    {task.dependsOn.length > 0 && <span>依赖 {task.dependsOn.length}</span>}
                    <span>{time(task.createdAt)}</span>
                  </div>
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
              <div className="row gap">
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
                  className="primary small"
                  disabled={
                    busy ||
                    selectedTask.status === "running" ||
                    selectedTask.status === "done" ||
                    !hasWorker
                  }
                  onClick={() => onRun(selectedTask.id)}
                  title={!hasWorker ? "请先创建成员" : undefined}
                >
                  {selectedTask.status === "running" ? "运行中…" : "运行任务"}
                </button>
              </div>
            </div>

            {!hasWorker && (
              <div className="notice">还没有成员。请先到「团队」创建一个成员，再运行任务。</div>
            )}

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
  let body = payloadText(event.payload);
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
    <div className={`trace-item trace-${event.type.replace(/\./g, "-")}`}>
      <div className="trace-meta">
        <span className="mono tiny">{time(event.createdAt)}</span>
        <span className="trace-type">{event.type}</span>
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
}: {
  messages: ChatMessage[];
  stream: string;
  reasoning: string;
  busy: boolean;
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
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
              role={message.role}
              content={message.content}
              reasoning={message.reasoning}
              createdAt={message.createdAt}
            />
          ))}
          {(reasoning || stream) && (
            <ChatBubble
              role="assistant"
              content={stream}
              reasoning={reasoning}
              streaming
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
  role,
  content,
  reasoning,
  createdAt,
  streaming,
}: {
  role: ChatMessage["role"];
  content: string;
  reasoning?: string;
  createdAt?: string;
  streaming?: boolean;
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
            {role === "assistant" ? (
              <Markdown content={content} />
            ) : (
              <div className="chat-plain">{content}</div>
            )}
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
