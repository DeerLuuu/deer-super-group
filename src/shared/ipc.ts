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
  ChatQuestionRecord,
  ContextSnapshot,
  CreateAgentInput,
  CreateTaskInput,
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
  Workspace,
} from "./types.js";
import type {
  GitSettings,
  MergeQueueItem,
  MergeQueueSnapshot,
  RepoDiagnostics,
  TaskVcs,
  TaskVcsSnapshot,
} from "../git/types.js";
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
  CastPollInput,
  ClosePollInput,
  CreatePollInput,
  Poll,
  PollStatus,
} from "./poll.js";

export interface DeerApi {
  listWorkspaces(): Promise<Workspace[]>;
  openWorkspace(): Promise<Workspace | null>;
  getSnapshot(workspaceId: string): Promise<Snapshot>;
  createAgent(input: CreateAgentInput): Promise<Agent>;
  updateAgent(input: UpdateAgentInput): Promise<Agent>;
  createTask(input: CreateTaskInput): Promise<Task>;
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
  sendMessage(input: SendMessageInput): Promise<MailboxMessage>;
  postBoard(input: PostBoardInput): Promise<BoardEntry>;
  getSettings(): Promise<LlmSettingsInfo>;
  saveSettings(settings: LlmSettings): Promise<LlmSettingsInfo>;
  listModels(settings: LlmSettings, providerId?: string): Promise<ModelListResult>;
  listChat(workspaceId: string, agentId?: string): Promise<ChatMessage[]>;
  sendChat(workspaceId: string, message: string): Promise<ChatMessage | null>;
  cancelChat(workspaceId: string): Promise<void>;
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
  getMemoryContext(input: {
    workspaceId: string;
    agentId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    maxTokens?: number;
  }): Promise<MemoryContext>;
  // t136：团队 Poll（正式投票 + decision）
  listPolls(workspaceId: string, status?: PollStatus): Promise<Poll[]>;
  getPoll(pollId: string): Promise<Poll>;
  createPoll(input: CreatePollInput): Promise<Poll>;
  castPoll(input: CastPollInput): Promise<Poll>;
  closePoll(input: ClosePollInput): Promise<Poll>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  onEvent(listener: (event: EventRecord) => void): () => void;
}
