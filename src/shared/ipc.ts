import type {
  Agent,
  AnswerChatQuestionInput,
  AnswerChatQuestionResult,
  BoardEntry,
  CancelChatQuestionInput,
  CancelChatQuestionResult,
  ChatArtifactRecord,
  ChatEvent,
  ChatMessage,
  ChatMessagePageOptions,
  ChatQuestionRecord,
  ChatTrajectoryEntry,
  ChatTurnHistoryOptions,
  ChatTurnHistoryPage,
  ClearChatContextResult,
  CompactChatContextResult,
  ContextSnapshot,
  CreateAgentInput,
  CreateTaskInput,
  RecommendMembersRequest,
  RecommendMembersResponse,
  DeleteAgentResult,
  DeleteTaskResult,
  BoardKind,
  UpdateAgentInput,
  EventRecord,
  KernelResult,
  LlmSettings,
  LlmSettingsInfo,
  MailboxMessage,
  ModelListResult,
  PostBoardInput,
  RiskApprovalRequest,
  Run,
  SchedulerSnapshot,
  SendMessageInput,
  Snapshot,
  Task,
  TranslationSettings,
  Workspace,
} from "./types.js";
import type {
  ConfirmPlanRequest,
  ConfirmPlanResult,
  PlanSource,
  PreviewPlanResult,
} from "./planDraft.js";
import type {
  GitSettings,
  GitResult,
  MergeQueueItem,
  MergeQueueSnapshot,
  RepoDiagnostics,
  TaskVcs,
  TaskVcsSnapshot,
} from "../git/types.js";
import type {
  GitCommitDetail,
  GitDiffParams,
  GitDiffPage,
  GitGraphPage,
  GitReadRepo,
  GitRefsSnapshot,
  GitWorkingStatus,
} from "../git/readTypes.js";
import type { GitInitProbe, GitInitResult } from "../git/initTypes.js";
import type {
  ReviewConfig,
  ReviewConfigPatch,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewDiffPage,
  ReviewSeverity,
  ReviewSummary,
  ReviewTarget,
  ReviewThread,
} from "../review/types.js";
import type {
  BoardArchiveProposal,
  BoardEntry as MemoryBoardEntry,
  Confidence,
  MemoryContext,
  MemoryResult,
  MemorySearchInput,
  MemorySearchResult,
  MemorySnapshot,
  MemorySnapshotOptions,
  Memo,
  MemoKind,
} from "../memory/types.js";
import type {
  BudgetSnapshot,
  CostSnapshot,
  FallbackChain,
  RunHandoff,
  SetBudgetInput,
  SetFallbackChainInput,
  WatchdogAlert,
  WatchdogHealth,
  WatchdogResult,
  WatchdogSnapshot,
} from "./watchdog.js";
import type {
  CastPollRequest,
  ClosePollRequest,
  CreatePollRequest,
  Poll,
  PollStatus,
} from "./poll.js";

export interface DeerApi {
  listWorkspaces(): Promise<Workspace[]>;
  openWorkspace(): Promise<Workspace | null>;
  getSnapshot(workspaceId: string): Promise<Snapshot>;
  createAgent(input: CreateAgentInput): Promise<Agent>;
  /** t272：只读推荐，不创建成员；createAgent 仍是唯一创建入口。 */
  recommendMembers(input: RecommendMembersRequest): Promise<RecommendMembersResponse>;
  updateAgent(input: UpdateAgentInput): Promise<Agent>;
  /** t167：删除成员；需要二级确认。Router/活跃 Run 会被拒绝。 */
  deleteAgent(agentId: string): Promise<DeleteAgentResult>;
  createTask(input: CreateTaskInput): Promise<Task>;
  /** t167：删除任务；需要二级确认。活跃 Run/被依赖会被拒绝。 */
  deleteTask(taskId: string): Promise<DeleteTaskResult>;
  runTask(taskId: string): Promise<void>;
  /** t69：内核调度命令（KernelResult 携带稳定错误码，UI 不解析 message）。 */
  startTask(taskId: string): Promise<KernelResult<Task>>;
  cancelTask(taskId: string): Promise<KernelResult<Task>>;
  retryTask(taskId: string): Promise<KernelResult<Task>>;
  reviewTask(
    taskId: string,
    decision: "approve" | "reject",
    options?: { reviewer?: string; notes?: string },
  ): Promise<KernelResult<Task>>;
  cancelRun(runId: string): Promise<KernelResult<Run>>;
  listRuns(taskId: string): Promise<KernelResult<Run[]>>;
  getScheduler(workspaceId: string): Promise<KernelResult<SchedulerSnapshot>>;
  pauseScheduler(
    workspaceId: string,
    reason?: string,
  ): Promise<KernelResult<SchedulerSnapshot>>;
  resumeScheduler(workspaceId: string): Promise<KernelResult<SchedulerSnapshot>>;
  getTaskTrace(taskId: string): Promise<EventRecord[]>;
  plan(workspaceId: string, goal: string): Promise<Task[]>;
  previewPlan(workspaceId: string, source: PlanSource): Promise<PreviewPlanResult>;
  confirmPlan(input: ConfirmPlanRequest): Promise<ConfirmPlanResult>;
  sendMessage(input: SendMessageInput): Promise<MailboxMessage>;
  postBoard(input: PostBoardInput): Promise<BoardEntry>;
  getSettings(): Promise<LlmSettingsInfo>;
  saveSettings(settings: LlmSettings): Promise<LlmSettingsInfo>;
  listModels(settings: LlmSettings, providerId?: string): Promise<ModelListResult>;
  listChat(
    workspaceId: string,
    agentId?: string,
    options?: ChatMessagePageOptions,
  ): Promise<ChatMessage[]>;
  sendChat(workspaceId: string, agentId: string, message: string): Promise<ChatMessage | null>;
  cancelChat(workspaceId: string, agentId: string): Promise<void>;
  /** t170：/clear 命令——清空当前 Router 对话、画布索引与提问。 */
  clearChatContext(workspaceId: string): Promise<ClearChatContextResult>;
  /** t170：/compact 命令——保留最近 8 条，其余压缩为 system 摘要。 */
  compactChatContext(workspaceId: string): Promise<CompactChatContextResult>;
  /** t175：Chat 轨迹账本（消息 + 工具事件 + 上下文操作）。 */
  getChatTrajectory(workspaceId: string, agentId?: string): Promise<ChatTrajectoryEntry[]>;
  getChatTurns(
    workspaceId: string,
    agentId?: string,
    options?: ChatTurnHistoryOptions,
  ): Promise<ChatTurnHistoryPage>;
  /** t179：思考文本机翻（默认 Bing，目标简体中文）。 */
  translateText(text: string): Promise<string>;
  /** t181：翻译源与开关设置。 */
  getTranslationSettings(): Promise<TranslationSettings>;
  saveTranslationSettings(settings: TranslationSettings): Promise<TranslationSettings>;
  getContext(workspaceId: string, agentId?: string, taskId?: string): Promise<ContextSnapshot>;
  /** DESIGN §15.4：满血模式开关（会话级提示/预算覆盖，不碰权限）。 */
  setFullThrottle(workspaceId: string, agentId: string, enabled: boolean): Promise<void>;
  /** t58 IF-05：auto_risk 高风险审批请求（主进程 → 人类审批弹窗）。 */
  onRiskApproval(listener: (request: RiskApprovalRequest) => void): () => void;
  /** t58 IF-05：人工回执（单次 requestId；Agent 无自行批准路径）。 */
  respondRiskApproval(requestId: string, approved: boolean): Promise<boolean>;
  // t64：交互画布索引（P0 渲染不依赖，Dock/导出 P1 使用）。
  listChatArtifacts(workspaceId: string, agentId?: string): Promise<ChatArtifactRecord[]>;
  getChatArtifact(workspaceId: string, artifactId: string): Promise<ChatArtifactRecord | null>;
  // t64：提问状态（内联卡片回显 + 队列/自动打开）。
  listChatQuestions(workspaceId: string, agentId?: string): Promise<ChatQuestionRecord[]>;
  answerChatQuestion(input: AnswerChatQuestionInput): Promise<AnswerChatQuestionResult>;
  cancelChatQuestion(input: CancelChatQuestionInput): Promise<CancelChatQuestionResult>;
  // t96：Git 并行开发 / VCS / 合并队列
  gitDiagnose(workspaceId: string): Promise<RepoDiagnostics>;
  getTaskVcs(taskId: string): Promise<TaskVcsSnapshot>;
  gitCreatePr(taskId: string): Promise<TaskVcsSnapshot["vcs"]>;
  gitCleanup(taskId: string): Promise<void>;
  gitOpenPr(taskId: string): Promise<string | null>;
  getGitSettings(workspaceId: string): Promise<GitSettings>;
  saveGitSettings(workspaceId: string, settings: Partial<GitSettings>): Promise<GitSettings>;
  mergeQueue(workspaceId: string): Promise<MergeQueueSnapshot>;
  mergeEnqueue(taskId: string): Promise<MergeQueueItem>;
  mergeApprove(taskId: string): Promise<MergeQueueItem>;
  mergeWaiveChecks(taskId: string, reason: string): Promise<MergeQueueItem>;
  mergeStart(taskId: string): Promise<MergeQueueItem>;
  mergeProcess(workspaceId: string): Promise<MergeQueueItem>;
  gitRecover(workspaceId: string): Promise<number>;
  // t301：只读版本图
  gitRepo(workspaceId: string): Promise<GitResult<GitReadRepo>>;
  /** t348：非 Git 工作区初始化的只读预检/一次性写通道。 */
  gitInitProbe?(workspaceId: string): Promise<GitInitProbe>;
  gitInit?(workspaceId: string): Promise<GitResult<GitInitResult>>;
  gitGraph(workspaceId: string, params: { limit?: number; offset?: number; ref?: string }): Promise<GitResult<GitGraphPage>>;
  gitRefs(workspaceId: string, limit?: number): Promise<GitResult<GitRefsSnapshot>>;
  gitStatus(workspaceId: string): Promise<GitResult<GitWorkingStatus>>;
  gitCommit(workspaceId: string, sha: string): Promise<GitResult<GitCommitDetail>>;
  gitDiff(workspaceId: string, params: GitDiffParams): Promise<GitResult<GitDiffPage>>;
  /** t352 G1：版本图本地写闭环（stage/unstage/commit/.gitignore；无 push/remote）。 */
  gitStage?(workspaceId: string, paths: string[]): Promise<GitResult<import("../git/writeTypes.js").GitWritePathsResult>>;
  gitUnstage?(workspaceId: string, paths: string[]): Promise<GitResult<import("../git/writeTypes.js").GitWritePathsResult>>;
  gitCreateCommit?(
    workspaceId: string,
    title: string,
    body?: string,
  ): Promise<GitResult<import("../git/writeTypes.js").GitCommitCreateResult>>;
  gitIgnorePreview?(workspaceId: string): Promise<GitResult<import("../git/writeTypes.js").GitIgnorePreview>>;
  gitIgnoreApply?(workspaceId: string): Promise<GitResult<import("../git/writeTypes.js").GitIgnoreApplyResult>>;
  // t154：行级评审与合并门禁
  getReviewSummary(taskId: string): Promise<ReviewSummary>;
  getReviewDiff(input: { taskId: string; file?: string; offset?: number; limit?: number }): Promise<ReviewDiffPage>;
  getReviewThreads(input: { taskId: string; file?: string; status?: string }): Promise<ReviewThread[]>;
  createReviewThread(input: {
    taskId: string;
    filePath: string;
    side: "new" | "old";
    lineStart: number;
    lineEnd?: number;
    body: string;
    severity: ReviewSeverity;
  }): Promise<ReviewThread>;
  replyReviewThread(input: { taskId: string; threadId: string; body: string }): Promise<import("../review/types.js").ReviewComment>;
  editReviewComment(input: { taskId: string; commentId: string; body: string }): Promise<import("../review/types.js").ReviewComment>;
  deleteReviewComment(input: { taskId: string; commentId: string }): Promise<import("../review/types.js").ReviewComment>;
  resolveReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
  reopenReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
  setReviewSeverity(input: { taskId: string; threadId: string; severity: ReviewSeverity }): Promise<ReviewThread>;
  getReviewDecisions(taskId: string): Promise<ReviewDecisionRecord[]>;
  submitReviewDecision(input: {
    taskId: string;
    decision: ReviewDecision;
    headSha: string;
    notes?: string;
    clientRequestId?: string;
  }): Promise<ReviewTarget>;
  assignReviewer(input: { taskId: string; reviewerId: string; role?: "reviewer" | "advisory" }): Promise<ReviewTarget>;
  removeReviewer(input: { taskId: string; reviewerId: string; reason: string }): Promise<ReviewTarget>;
  replaceReviewer(input: {
    taskId: string;
    fromReviewerId: string;
    toReviewerId: string;
    role?: "reviewer" | "advisory";
    reason: string;
  }): Promise<ReviewTarget>;
  ensureReviewTarget(taskId: string): Promise<ReviewTarget>;
  getReviewConfig(workspaceId: string): Promise<ReviewConfig>;
  saveReviewConfig(
    workspaceId: string,
    patch: ReviewConfigPatch,
    options?: { confirmResets?: boolean },
  ): Promise<ReviewConfig>;
  // t123：记忆工作台（MemoryService 运行时；人类治理路径）
  getMemorySnapshot(workspaceId: string, options?: MemorySnapshotOptions): Promise<MemorySnapshot>;
  searchMemory(input: MemorySearchInput): Promise<MemorySearchResult>;
  createMemoryBoard(input: {
    workspaceId: string;
    board: string;
    kind: BoardKind;
    content: string;
    refs?: string[];
    confidence?: Confidence;
    ttlDays?: number | null;
  }): Promise<MemoryResult<MemoryBoardEntry>>;
  setBoardPinned(input: { workspaceId: string; entryId: string; pinned: boolean }): Promise<MemoryResult<MemoryBoardEntry>>;
  verifyBoardEntry(input: { workspaceId: string; entryId: string; confidence?: Confidence }): Promise<MemoryResult<MemoryBoardEntry>>;
  setBoardTtl(input: { workspaceId: string; entryId: string; ttlDays: number | null }): Promise<MemoryResult<MemoryBoardEntry>>;
  proposeBoardArchive(input: {
    workspaceId: string;
    entryId: string;
    reason?: "manual" | "stale";
    note?: string;
  }): Promise<MemoryResult<BoardArchiveProposal>>;
  decideBoardArchive(input: {
    workspaceId: string;
    proposalId: string;
    decision: "approve" | "reject";
    note?: string;
  }): Promise<MemoryResult<BoardArchiveProposal>>;
  promoteBoardEntry(input: { workspaceId: string; entryId: string; kind?: "decision" | "fact" }): Promise<MemoryResult<MemoryBoardEntry>>;
  restoreBoardEntry(input: { workspaceId: string; entryId: string }): Promise<MemoryResult<MemoryBoardEntry>>;
  createMemoryMemo(input: {
    workspaceId: string;
    agentId: string;
    kind: MemoKind;
    content: string;
    tags?: string[];
    confidence?: Confidence;
    sourceTaskId?: string | null;
    expiresInDays?: number | null;
  }): Promise<MemoryResult<Memo>>;
  listMemoryMemos(workspaceId: string, agentId: string): Promise<Memo[]>;
  verifyMemoryMemo(input: { workspaceId: string; agentId: string; memoId: string }): Promise<MemoryResult<Memo>>;
  archiveMemoryMemo(input: { workspaceId: string; agentId: string; memoId: string }): Promise<MemoryResult<Memo>>;
  promoteMemoryMemo(input: {
    workspaceId: string;
    agentId: string;
    memoId: string;
    board: string;
  }): Promise<MemoryResult<MemoryBoardEntry>>;
  runMemoryMaintenance(workspaceId?: string): Promise<MemoryResult<unknown>>;
  // t144：看门狗与成本
  getWatchdogSnapshot(workspaceId: string): Promise<WatchdogResult<WatchdogSnapshot>>;
  getWatchdogCosts(workspaceId: string): Promise<WatchdogResult<CostSnapshot>>;
  getRunHandoff(workspaceId: string, runId: string): Promise<WatchdogResult<RunHandoff | null>>;
  ackWatchdogAlert(workspaceId: string, alertId: string): Promise<WatchdogResult<WatchdogAlert>>;
  resolveWatchdogAlert(workspaceId: string, alertId: string): Promise<WatchdogResult<WatchdogAlert>>;
  releaseWatchdogTaskHold(
    workspaceId: string,
    taskId: string,
    reason: import("./watchdog.js").WatchdogHoldReason,
    all?: boolean,
  ): Promise<WatchdogResult<void>>;
  setWatchdogBudget(input: SetBudgetInput): Promise<WatchdogResult<BudgetSnapshot>>;
  setWatchdogFallback(input: SetFallbackChainInput): Promise<WatchdogResult<FallbackChain>>;
  getWatchdogHealth(): Promise<WatchdogHealth>;
  getMemoryContext(input: {
    workspaceId: string;
    agentId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    maxTokens?: number;
  }): Promise<MemoryContext>;
  // t136：团队 Poll（正式投票 + decision）
  listPolls(workspaceId: string, status?: PollStatus): Promise<Poll[]>;
  getPoll(workspaceId: string, pollId: string): Promise<Poll>;
  createPoll(input: CreatePollRequest): Promise<Poll>;
  castPoll(workspaceId: string, input: CastPollRequest): Promise<Poll>;
  closePoll(workspaceId: string, input: ClosePollRequest): Promise<Poll>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  onEvent(listener: (event: EventRecord) => void): () => void;
}
