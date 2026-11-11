import type {
  DeerCanvas,
  DeerQuestion,
  QuestionAnswers,
  QuestionFieldError,
  QuestionValues,
} from "./interactive.js";

export type Id = string;
export type IsoDate = string;

export interface Workspace {
  id: Id;
  name: string;
  path: string;
  overview: string | null;
  overviewEnabled: boolean;
  createdAt: string;
}

export type AgentStatus = "idle" | "running" | "blocked" | "offline";

/**
 * DESIGN §15.2：Agent 权限模式（执行层硬门禁，不是提示词约束）。
 * - read_only：仅查看（读文件/搜索/列目录/看任务黑板邮箱）；
 * - workspace_write：工作区内修改（受限只读 shell）；
 * - full_access：完全权限；
 * - auto_risk：规则风险分级，低放行/中投票/高人类确认。
 */
export type PermissionMode =
  | "read_only"
  | "workspace_write"
  | "full_access"
  | "auto_risk";

/**
 * DESIGN §15.3 / t58 IF-05：auto_risk 高风险工具调用的人类审批请求（单次生效）。
 * 仅由主进程在执行工具前发出；批准/拒绝只能来自 renderer 的人工输入，Agent 无自行批准路径。
 */
export interface RiskApprovalRequest {
  requestId: string;
  workspaceId: Id;
  taskId: Id;
  agentName: string;
  toolName: string;
  /** 写入目标（路径）或 shell 命令。 */
  target: string;
  risk: "low" | "medium" | "high";
  reason: string;
  createdAt: string;
}

export interface Agent {
  id: Id;
  workspaceId: Id;
  name: string;
  role: string;
  systemPrompt: string;
  persona: string;
  agentsMd: string;
  model: string | null;
  permission: PermissionMode;
  isRouter: boolean;
  status: AgentStatus;
  createdAt: string;
}

export type TaskStatus =
  | "ready"
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: Id;
  workspaceId: Id;
  title: string;
  description: string;
  acceptance: string[];
  status: TaskStatus;
  ownerId: Id | null;
  dependsOn: Id[];
  branch: string | null;
  worktree: string | null;
  summary: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** t68 内核：调度优先级（数字越大越先，默认 50）。 */
  priority?: number;
  /** t68 内核：入队时间（queued）。 */
  queuedAt?: string | null;
  /** t68 内核：blocked 原因（waiting_dependencies/dependency_failed/dependency_cancelled/manual）。 */
  blockedReason?: string | null;
  /** t68 内核：最终失败分类（review_rejected/retry_exhausted/...）。 */
  failureKind?: string | null;
  /** t68 内核：已创建的 Run 数（= 下一次 attempt）。 */
  attemptCount?: number;
  /** t68 内核：自动重试的下一可启动时间。 */
  nextRunAt?: string | null;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  id: Id;
  taskId: Id;
  agentId: Id;
  status: RunStatus;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  tokenIn: number;
  tokenOut: number;
  /** t68 内核：同 Task 内单调递增的尝试序号。 */
  attempt?: number;
  modelProfileId?: string | null;
  modelId?: string | null;
  permissionSnapshot?: PermissionMode | null;
  sandboxId?: string | null;
  retryOfRunId?: string | null;
  heartbeatAt?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  checkpointRef?: string | null;
  checkpointStep?: number;
  costUsd?: number;
  errorCode?: string | null;
  retryable?: boolean;
  steps?: number;
}

export interface EventRecord {
  seq: number;
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  actor: string;
  payload: unknown;
  createdAt: string;
  /** t68 事件 v2 字段（旧事件可为 undefined/默认）。 */
  schemaVersion?: number;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: string;
  recordedAt?: string;
}

export type MessageKind = "request" | "report" | "question" | "decision" | "artifact" | "review";

export interface MailboxMessage {
  id: Id;
  workspaceId: Id;
  threadId: Id;
  from: string;
  to: string[];
  kind: MessageKind;
  subject: string;
  body: string;
  refs: string[];
  createdAt: string;
}

export type BoardKind = "fact" | "decision" | "question" | "warning" | "artifact" | "link";

export interface BoardEntry {
  id: Id;
  workspaceId: Id;
  board: string;
  author: string;
  kind: BoardKind;
  content: string;
  refs: string[];
  confidence: "low" | "medium" | "high";
  pinned: boolean;
  createdAt: string;
}

export interface Memo {
  id: Id;
  workspaceId: Id;
  agentId: Id;
  kind: "lesson" | "failure" | "shortcut" | "preference";
  content: string;
  tags: string[];
  createdAt: string;
}

export interface TaskSummary {
  id: Id;
  taskId: Id;
  runId: Id;
  goal: string;
  changes: string[];
  files: string[];
  tests: Array<{ command: string; status: "passed" | "failed" | "skipped" }>;
  decisions: string[];
  risks: string[];
  openQuestions: string[];
  createdAt: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: Id;
  workspaceId: Id;
  agentId: Id;
  role: ChatRole;
  content: string;
  /** DeepSeek reasoning_content for thinking-mode replies. */
  reasoning: string;
  createdAt: IsoDate;
}

/** t175：Chat 轨迹账本条目（消息 + 工具事件 + 上下文操作的只读投影）。 */
export type ChatTrajectoryKind =
  | "user"
  | "assistant"
  | "system"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "context";

export interface ChatTrajectoryEntry {
  id: string;
  kind: ChatTrajectoryKind;
  title: string;
  detail: string;
  createdAt: IsoDate;
  status?: "running" | "ok" | "error";
  callId?: string;
  /** 模型 step 序号；思考/工具事件可据此排序。 */
  step?: number;
  /** 事件日志序号；同时间戳时保持工具/思考顺序。 */
  seq?: number;
}

/** t170：清空对话上下文的结果。 */
export interface ClearChatContextResult {
  removedMessages: number;
  removedArtifacts: number;
  removedQuestions: number;
}

/** t170：压缩对话上下文的结果。 */
export interface CompactChatContextResult {
  summarizedMessages: number;
  keptMessages: number;
  summary: string;
}

export type ChatEvent =
  | { type: "delta"; workspaceId: Id; agentId: Id; text: string }
  | { type: "reasoning"; workspaceId: Id; agentId: Id; text: string }
  | {
      type: "reasoning_segment";
      workspaceId: Id;
      agentId: Id;
      step: number;
      text: string;
    }
  | {
      type: "tool_call";
      workspaceId: Id;
      agentId: Id;
      callId: string;
      name: string;
      arguments: string;
      step?: number;
    }
  | {
      type: "tool_result";
      workspaceId: Id;
      agentId: Id;
      callId: string;
      name: string;
      ok: boolean;
      value?: unknown;
      error?: string;
      step?: number;
    }
  | { type: "done"; workspaceId: Id; agentId: Id; message: ChatMessage }
  | { type: "cancelled"; workspaceId: Id; agentId: Id }
  | { type: "error"; workspaceId: Id; agentId: Id; error: string };

// ---------------------------------------------------------------------------
// t64：交互画布 / 提问表单（docs/team/interactive-canvas-design.md §9/§10）
// ---------------------------------------------------------------------------

export interface ChatArtifactRecord {
  /** 稳定键：`${messageId}#b${blockIndex}` */
  id: string;
  workspaceId: Id;
  agentId: Id;
  messageId: Id;
  blockIndex: number;
  kind: DeerCanvas["kind"];
  title: string;
  protocolVersion: number;
  payload: DeerCanvas;
  createdAt: IsoDate;
}

export type ChatQuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface ChatQuestionRecord {
  /** 稳定键：`${messageId}#b${blockIndex}`（与 artifact 同规则，不同表） */
  id: string;
  workspaceId: Id;
  agentId: Id;
  messageId: Id;
  blockIndex: number;
  title: string;
  payload: DeerQuestion;
  status: ChatQuestionStatus;
  answer: QuestionAnswers | null;
  createdAt: IsoDate;
  answeredAt: IsoDate | null;
  expiresAt: IsoDate | null;
}

export interface AnswerChatQuestionInput {
  workspaceId: Id;
  questionId: string;
  values: QuestionValues;
}

export type AnswerErrorCode =
  | "E_NOT_FOUND"
  | "E_WORKSPACE_MISMATCH"
  | "E_BUSY"
  | "E_INVALID_ANSWER"
  | "E_EXPIRED"
  | "E_CLOSED"
  | "E_TOO_LARGE";

export type AnswerChatQuestionResult =
  | { ok: true; changed: boolean; question: ChatQuestionRecord; answerText: string }
  | {
      ok: false;
      code: AnswerErrorCode;
      message: string;
      fieldErrors?: QuestionFieldError[];
    };

export interface CancelChatQuestionInput {
  workspaceId: Id;
  questionId: string;
}

export type CancelChatQuestionResult =
  | { ok: true; question: ChatQuestionRecord }
  | { ok: false; code: AnswerErrorCode; message: string };

export interface ContextSection {
  id: string;
  title: string;
  kind: "system" | "persona" | "agents" | "workspace" | "task" | "history" | "memory";
  content: string;
  tokens: number;
  meta?: string;
}

export interface ContextSnapshot {
  agent: Agent;
  providerName: string;
  model: string;
  contextWindow: number;
  totalTokens: number;
  sections: ContextSection[];
  tools: Array<{ name: string; description: string }>;
  taskTitle: string | null;
}

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface ProviderProfile {
  /** Local provider id, unique inside this app. */
  id: string;
  name: string;
  baseUrl: string;
  baseUrlEnv: string;
  apiKey: string;
  apiKeyEnv: string;
}

export interface ProviderInfo extends ProviderProfile {
  apiKeySource: "env" | "local" | "none";
  apiKeyEnvActive: string | null;
  apiKeyEnvSet: boolean;
  baseUrlSource: "env" | "local";
  baseUrlEnvActive: string | null;
  baseUrlEnvSet: boolean;
  effectiveBaseUrl: string;
}

export interface ModelPricing {
  currency: "USD";
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  reasoningPer1M?: number;
  source?: "manual" | "catalog";
  version?: string;
}

export interface ModelProfile {
  /** Unique profile id: `${providerId}:${modelId}`. */
  id: string;
  providerId: string;
  /** Model id sent to the API (for example deepseek-v4-pro). */
  modelId: string;
  /** Display label; defaults to modelId. */
  label: string;
  supportsImages: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  /** t144：可选成本价格；未配置时成本 unknown，预算默认不阻塞。 */
  pricing?: ModelPricing | null;
}

export interface LlmSettings {
  /** Legacy single-provider fields; kept for migration and mirrored from the first provider. */
  baseUrl: string;
  baseUrlEnv: string;
  apiKey: string;
  apiKeyEnv: string;
  /** Providers added in Settings. */
  providers: ProviderProfile[];
  /** Default model profile id; must exist in models when models is non-empty. */
  model: string;
  /** Models added in Settings, across all providers. Members can only choose from this list. */
  models: ModelProfile[];
  mock: boolean;
}

export interface LlmSettingsInfo extends LlmSettings {
  /** Provider details with derived env detection. */
  providers: ProviderInfo[];
  /** Derived from the first provider, for compatibility. */
  apiKeySource: "env" | "local" | "none";
  apiKeyEnvActive: string | null;
  apiKeyEnvSet: boolean;
  baseUrlSource: "env" | "local";
  baseUrlEnvActive: string | null;
  baseUrlEnvSet: boolean;
  effectiveBaseUrl: string;
}

export interface ModelListResult {
  models: string[];
  source: "env" | "local" | "none";
  providerId?: string;
  error?: string;
}

export interface Snapshot {
  workspace: Workspace;
  agents: Agent[];
  tasks: Task[];
  messages: MailboxMessage[];
  boardEntries: BoardEntry[];
  settings: LlmSettingsInfo;
  /** t68：最近 Run（可选，UI 逐步接入）。 */
  runs?: Run[];
  /** t68：调度器快照（可选，UI 逐步接入）。 */
  scheduler?: SchedulerSnapshot;
}

export interface SchedulerQueueItem {
  taskId: Id;
  title: string;
  priority: number;
  queuedAt: string | null;
  ownerId: Id | null;
}

export interface RunSummary {
  id: Id;
  taskId: Id;
  attempt: number;
  agentId: Id;
  status: RunStatus;
  startedAt: string;
  heartbeatAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
}

export interface SchedulerSnapshot {
  workspaceId: Id;
  paused: boolean;
  pausedReason: string | null;
  limits: {
    maxGlobal: number;
    maxWorkspace: number;
    maxPerAgent: number;
  };
  counts: Record<TaskStatus, number>;
  activeRuns: RunSummary[];
  queue: SchedulerQueueItem[];
  updatedAt: IsoDate;
}

export type KernelErrorCode =
  | "INVALID_TRANSITION"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_LOCKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAUSED"
  | "LIMIT_REACHED"
  | "NO_AVAILABLE_AGENT"
  | "HOOK_REJECTED"
  | "IDEMPOTENT_REPLAY"
  | "INTERNAL";

export type KernelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: KernelErrorCode; message: string; details?: unknown } };

export interface CreateAgentInput {
  workspaceId: Id;
  name: string;
  role: string;
  systemPrompt: string;
  persona: string;
  agentsMd: string;
  model: string | null;
}

export interface UpdateAgentInput {
  id: Id;
  name?: string;
  role?: string;
  systemPrompt?: string;
  persona?: string;
  agentsMd?: string;
  model?: string | null;
  /** DESIGN §15：权限模式变更（写 agent.permission_changed 事件）。 */
  permission?: PermissionMode;
}

export interface CreateTaskInput {
  workspaceId: Id;
  title: string;
  description: string;
  acceptance: string[];
  /** t96：软所有权声明（glob；P1 UI，API 先落）。 */
  scopePaths?: string[];
}

/** t167：删除任务的结果；任务事件保留，投影/Run/摘要/评审数据被清理。 */
export interface DeleteTaskResult {
  taskId: Id;
  removedRuns: number;
  removedSummaries: number;
}

/** t167：删除成员的结果；已归属任务变为未分配，历史消息保留。 */
export interface DeleteAgentResult {
  agentId: Id;
  reassignedTasks: number;
}

export interface PlanTask {
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: number[];
}

export interface PlanResult {
  tasks: PlanTask[];
}

export interface SendMessageInput {
  workspaceId: Id;
  from: string;
  to: string[];
  subject: string;
  body: string;
  kind: MessageKind;
}

export interface PostBoardInput {
  workspaceId: Id;
  board: string;
  author: string;
  kind: BoardKind;
  content: string;
  confidence: "low" | "medium" | "high";
}
