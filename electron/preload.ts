import { contextBridge, ipcRenderer } from "electron";
import type { DeerApi } from "../src/shared/ipc.js";
import type {
  AnswerChatQuestionInput,
  CancelChatQuestionInput,
  ChatEvent,
  CreateAgentInput,
  CreateTaskInput,
  BoardKind,
  EventRecord,
  RiskApprovalRequest,
  UpdateAgentInput,
  LlmSettings,
  PostBoardInput,
  SendMessageInput,
} from "../src/shared/types.js";
import type { GitSettings } from "../src/git/types.js";
import type {
  SetBudgetInput,
  SetFallbackChainInput,
  WatchdogHoldReason,
} from "../src/shared/watchdog.js";
import type {
  Confidence,
  MemoryResult,
  MemorySearchInput,
  MemorySnapshotOptions,
  MemoKind,
} from "../src/memory/types.js";
import type {
  CastPollRequest,
  ClosePollRequest,
  CreatePollRequest,
  PollStatus,
} from "../src/shared/poll.js";

const api: DeerApi = {
  listWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  getSnapshot: (workspaceId: string) => ipcRenderer.invoke("workspace:snapshot", workspaceId),
  createAgent: (input: CreateAgentInput) => ipcRenderer.invoke("agent:create", input),
  updateAgent: (input: UpdateAgentInput) => ipcRenderer.invoke("agent:update", input),
  deleteAgent: (agentId: string) => ipcRenderer.invoke("agent:delete", agentId),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke("task:create", input),
  deleteTask: (taskId: string) => ipcRenderer.invoke("task:delete", taskId),
  runTask: (taskId: string) => ipcRenderer.invoke("task:run", taskId),
  // t69：内核调度命令（返回 KernelResult，业务失败不 reject）。
  startTask: (taskId: string) => ipcRenderer.invoke("kernel:startTask", taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke("kernel:cancelTask", taskId),
  retryTask: (taskId: string) => ipcRenderer.invoke("kernel:retryTask", taskId),
  reviewTask: (
    taskId: string,
    decision: "approve" | "reject",
    options?: { reviewer?: string; notes?: string },
  ) => ipcRenderer.invoke("kernel:reviewTask", taskId, decision, options),
  cancelRun: (runId: string) => ipcRenderer.invoke("kernel:cancelRun", runId),
  listRuns: (taskId: string) => ipcRenderer.invoke("kernel:listRuns", taskId),
  getScheduler: (workspaceId: string) =>
    ipcRenderer.invoke("kernel:getScheduler", workspaceId),
  pauseScheduler: (workspaceId: string, reason?: string) =>
    ipcRenderer.invoke("kernel:pauseScheduler", workspaceId, reason),
  resumeScheduler: (workspaceId: string) =>
    ipcRenderer.invoke("kernel:resumeScheduler", workspaceId),
  getTaskTrace: (taskId: string) => ipcRenderer.invoke("task:trace", taskId),
  plan: (workspaceId: string, goal: string) => ipcRenderer.invoke("router:plan", workspaceId, goal),
  previewPlan: (workspaceId: string, source: unknown) =>
    ipcRenderer.invoke("plan:preview", workspaceId, source),
  confirmPlan: (input: unknown) => ipcRenderer.invoke("plan:confirm", input),
  sendMessage: (input: SendMessageInput) => ipcRenderer.invoke("mailbox:send", input),
  postBoard: (input: PostBoardInput) => ipcRenderer.invoke("board:post", input),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: LlmSettings) => ipcRenderer.invoke("settings:save", settings),
  listModels: (settings: LlmSettings, providerId?: string) =>
    ipcRenderer.invoke("llm:models", settings, providerId),
  listChat: (workspaceId: string, agentId?: string) =>
    ipcRenderer.invoke("chat:list", workspaceId, agentId),
  getChatTrajectory: (workspaceId: string, agentId?: string) =>
    ipcRenderer.invoke("chat:trajectory", workspaceId, agentId),
  getChatTurns: (workspaceId: string, agentId?: string, options?: unknown) =>
    ipcRenderer.invoke("chat:turns", workspaceId, agentId, options),
  translateText: (text: string) => ipcRenderer.invoke("chat:translate", text),
  getTranslationSettings: () => ipcRenderer.invoke("translation:get"),
  saveTranslationSettings: (settings) => ipcRenderer.invoke("translation:save", settings),
  sendChat: (workspaceId: string, message: string) =>
    ipcRenderer.invoke("chat:send", workspaceId, message),
  cancelChat: (workspaceId: string) => ipcRenderer.invoke("chat:cancel", workspaceId),
  clearChatContext: (workspaceId: string) =>
    ipcRenderer.invoke("chat:clear-context", workspaceId),
  compactChatContext: (workspaceId: string) =>
    ipcRenderer.invoke("chat:compact-context", workspaceId),
  getContext: (workspaceId: string, agentId?: string, taskId?: string) =>
    ipcRenderer.invoke("context:get", workspaceId, agentId, taskId),
  setFullThrottle: (workspaceId: string, agentId: string, enabled: boolean) =>
    ipcRenderer.invoke("session:setFullThrottle", workspaceId, agentId, enabled),
  // t58 IF-05：高风险审批（主进程 → 人类弹窗 → 人工回执）。
  onRiskApproval: (listener: (request: RiskApprovalRequest) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RiskApprovalRequest) =>
      listener(payload);
    ipcRenderer.on("risk:approval", wrapped);
    return () => ipcRenderer.removeListener("risk:approval", wrapped);
  },
  respondRiskApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke("risk:approval_response", requestId, approved),
  // t64：交互画布与提问表单（只做类型转发，业务校验在主进程）。
  listChatArtifacts: (workspaceId: string, agentId?: string) =>
    ipcRenderer.invoke("chat:artifacts:list", workspaceId, agentId),
  getChatArtifact: (workspaceId: string, artifactId: string) =>
    ipcRenderer.invoke("chat:artifact:get", workspaceId, artifactId),
  listChatQuestions: (workspaceId: string, agentId?: string) =>
    ipcRenderer.invoke("chat:questions:list", workspaceId, agentId),
  answerChatQuestion: (input: AnswerChatQuestionInput) =>
    ipcRenderer.invoke("chat:question:answer", input),
  cancelChatQuestion: (input: CancelChatQuestionInput) =>
    ipcRenderer.invoke("chat:question:cancel", input),
  // t96：Git 并行开发 / VCS / 合并队列
  gitDiagnose: (workspaceId: string) => ipcRenderer.invoke("git:diagnose", workspaceId),
  getTaskVcs: (taskId: string) => ipcRenderer.invoke("git:task-vcs", taskId),
  gitCreatePr: (taskId: string) => ipcRenderer.invoke("git:create-pr", taskId),
  gitCleanup: (taskId: string) => ipcRenderer.invoke("git:cleanup", taskId),
  gitOpenPr: (taskId: string) => ipcRenderer.invoke("git:open-pr", taskId),
  getGitSettings: (workspaceId: string) => ipcRenderer.invoke("git:settings:get", workspaceId),
  saveGitSettings: (workspaceId: string, settings: Partial<GitSettings>) =>
    ipcRenderer.invoke("git:settings:save", workspaceId, settings),
  mergeQueue: (workspaceId: string) => ipcRenderer.invoke("git:merge-queue", workspaceId),
  mergeEnqueue: (taskId: string) => ipcRenderer.invoke("git:merge-enqueue", taskId),
  mergeApprove: (taskId: string) => ipcRenderer.invoke("git:merge-approve", taskId),
  mergeWaiveChecks: (taskId: string, reason: string) =>
    ipcRenderer.invoke("git:merge-waive", taskId, reason),
  mergeStart: (taskId: string) => ipcRenderer.invoke("git:merge-start", taskId),
  mergeProcess: (workspaceId: string) => ipcRenderer.invoke("git:merge-process", workspaceId),
  gitRecover: (workspaceId: string) => ipcRenderer.invoke("git:recover", workspaceId),
  // t154：行级评审
  getReviewSummary: (taskId: string) => ipcRenderer.invoke("review:summary", taskId),
  getReviewDiff: (input: { taskId: string; file?: string; offset?: number; limit?: number }) =>
    ipcRenderer.invoke("review:diff", input),
  getReviewThreads: (input: { taskId: string; file?: string; status?: string }) =>
    ipcRenderer.invoke("review:threads", input),
  createReviewThread: (input: {
    taskId: string;
    filePath: string;
    side: "new" | "old";
    lineStart: number;
    lineEnd?: number;
    body: string;
    severity: import("../src/review/types.js").ReviewSeverity;
  }) => ipcRenderer.invoke("review:thread:create", input),
  replyReviewThread: (input: { taskId: string; threadId: string; body: string }) =>
    ipcRenderer.invoke("review:thread:reply", input),
  editReviewComment: (input: { taskId: string; commentId: string; body: string }) =>
    ipcRenderer.invoke("review:comment:edit", input),
  deleteReviewComment: (input: { taskId: string; commentId: string }) =>
    ipcRenderer.invoke("review:comment:delete", input),
  resolveReviewThread: (input: { taskId: string; threadId: string; note?: string }) =>
    ipcRenderer.invoke("review:thread:resolve", input),
  reopenReviewThread: (input: { taskId: string; threadId: string; note?: string }) =>
    ipcRenderer.invoke("review:thread:reopen", input),
  setReviewSeverity: (input: {
    taskId: string;
    threadId: string;
    severity: import("../src/review/types.js").ReviewSeverity;
  }) => ipcRenderer.invoke("review:thread:severity", input),
  getReviewDecisions: (taskId: string) => ipcRenderer.invoke("review:decisions", taskId),
  submitReviewDecision: (input: {
    taskId: string;
    decision: import("../src/review/types.js").ReviewDecision;
    headSha: string;
    notes?: string;
    clientRequestId?: string;
  }) => ipcRenderer.invoke("review:decision", input),
  assignReviewer: (input: { taskId: string; reviewerId: string; role?: "reviewer" | "advisory" }) =>
    ipcRenderer.invoke("review:reviewer:assign", input),
  removeReviewer: (input: { taskId: string; reviewerId: string; reason: string }) =>
    ipcRenderer.invoke("review:reviewer:remove", input),
  replaceReviewer: (input: {
    taskId: string;
    fromReviewerId: string;
    toReviewerId: string;
    role?: "reviewer" | "advisory";
    reason: string;
  }) => ipcRenderer.invoke("review:reviewer:replace", input),
  ensureReviewTarget: (taskId: string) => ipcRenderer.invoke("review:ensure", taskId),
  getReviewConfig: (workspaceId: string) => ipcRenderer.invoke("review:config:get", workspaceId),
  saveReviewConfig: (
    workspaceId: string,
    patch: import("../src/review/types.js").ReviewConfigPatch,
    options?: { confirmResets?: boolean },
  ) => ipcRenderer.invoke("review:config:save", workspaceId, patch, options),
  // t123：记忆工作台
  getMemorySnapshot: (workspaceId: string, options?: MemorySnapshotOptions) =>
    ipcRenderer.invoke("memory:snapshot", workspaceId, options),
  searchMemory: (input: MemorySearchInput) => ipcRenderer.invoke("memory:search", input),
  createMemoryBoard: (input: {
    workspaceId: string;
    board: string;
    kind: BoardKind;
    content: string;
    refs?: string[];
    confidence?: Confidence;
    ttlDays?: number | null;
  }) => ipcRenderer.invoke("board:create", input),
  setBoardPinned: (input: { workspaceId: string; entryId: string; pinned: boolean }) =>
    ipcRenderer.invoke("board:pin", input),
  verifyBoardEntry: (input: { workspaceId: string; entryId: string; confidence?: Confidence }) =>
    ipcRenderer.invoke("board:verify", input),
  setBoardTtl: (input: { workspaceId: string; entryId: string; ttlDays: number | null }) =>
    ipcRenderer.invoke("board:ttl", input),
  proposeBoardArchive: (input: {
    workspaceId: string;
    entryId: string;
    reason?: "manual" | "stale";
    note?: string;
  }) => ipcRenderer.invoke("board:archive-propose", input),
  decideBoardArchive: (input: {
    workspaceId: string;
    proposalId: string;
    decision: "approve" | "reject";
    note?: string;
  }) => ipcRenderer.invoke("board:archive-decide", input),
  promoteBoardEntry: (input: { workspaceId: string; entryId: string; kind?: "decision" | "fact" }) =>
    ipcRenderer.invoke("board:promote", input),
  restoreBoardEntry: (input: { workspaceId: string; entryId: string }) =>
    ipcRenderer.invoke("board:restore", input),
  createMemoryMemo: (input: {
    workspaceId: string;
    agentId: string;
    kind: MemoKind;
    content: string;
    tags?: string[];
    confidence?: Confidence;
    sourceTaskId?: string | null;
    expiresInDays?: number | null;
  }) => ipcRenderer.invoke("memo:create", input),
  listMemoryMemos: (workspaceId: string, agentId: string) =>
    ipcRenderer.invoke("memo:list", workspaceId, agentId),
  verifyMemoryMemo: (input: { workspaceId: string; agentId: string; memoId: string }) =>
    ipcRenderer.invoke("memo:verify", input),
  archiveMemoryMemo: (input: { workspaceId: string; agentId: string; memoId: string }) =>
    ipcRenderer.invoke("memo:archive", input),
  promoteMemoryMemo: (input: { workspaceId: string; agentId: string; memoId: string; board: string }) =>
    ipcRenderer.invoke("memo:promote", input),
  runMemoryMaintenance: (workspaceId?: string) => ipcRenderer.invoke("memory:maintenance", workspaceId),
  getMemoryContext: (input: {
    workspaceId: string;
    agentId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    maxTokens?: number;
  }) => ipcRenderer.invoke("memory:context", input),
  // t144：看门狗与成本
  getWatchdogSnapshot: (workspaceId: string) =>
    ipcRenderer.invoke("watchdog:getSnapshot", workspaceId),
  getWatchdogCosts: (workspaceId: string) => ipcRenderer.invoke("watchdog:getCosts", workspaceId),
  getRunHandoff: (workspaceId: string, runId: string) =>
    ipcRenderer.invoke("watchdog:getHandoff", workspaceId, runId),
  ackWatchdogAlert: (workspaceId: string, alertId: string) =>
    ipcRenderer.invoke("watchdog:ackAlert", workspaceId, alertId),
  resolveWatchdogAlert: (workspaceId: string, alertId: string) =>
    ipcRenderer.invoke("watchdog:resolveAlert", workspaceId, alertId),
  releaseWatchdogTaskHold: (
    workspaceId: string,
    taskId: string,
    reason: WatchdogHoldReason,
    all?: boolean,
  ) => ipcRenderer.invoke("watchdog:releaseHold", workspaceId, taskId, reason, all),
  setWatchdogBudget: (input: SetBudgetInput) =>
    ipcRenderer.invoke("watchdog:setBudget", input),
  setWatchdogFallback: (input: SetFallbackChainInput) =>
    ipcRenderer.invoke("watchdog:setFallback", input),
  getWatchdogHealth: () => ipcRenderer.invoke("watchdog:health"),
  listPolls: (workspaceId: string, status?: PollStatus) =>
    ipcRenderer.invoke("poll:list", workspaceId, status),
  getPoll: (workspaceId: string, pollId: string) => ipcRenderer.invoke("poll:get", workspaceId, pollId),
  createPoll: (input: CreatePollRequest) => ipcRenderer.invoke("poll:create", input),
  castPoll: (workspaceId: string, input: CastPollRequest) =>
    ipcRenderer.invoke("poll:cast", workspaceId, input),
  closePoll: (workspaceId: string, input: ClosePollRequest) =>
    ipcRenderer.invoke("poll:close", workspaceId, input),
  onChatEvent: (listener: (event: ChatEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatEvent) => listener(payload);
    ipcRenderer.on("chat:event", wrapped);
    return () => ipcRenderer.removeListener("chat:event", wrapped);
  },
  onEvent: (listener: (event: EventRecord) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventRecord) => listener(payload);
    ipcRenderer.on("app:event", wrapped);
    return () => ipcRenderer.removeListener("app:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("deer", api);
