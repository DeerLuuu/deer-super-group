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
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

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

export type ChatEvent =
  | { type: "delta"; workspaceId: Id; agentId: Id; text: string }
  | { type: "reasoning"; workspaceId: Id; agentId: Id; text: string }
  | { type: "done"; workspaceId: Id; agentId: Id; message: ChatMessage }
  | { type: "cancelled"; workspaceId: Id; agentId: Id }
  | { type: "error"; workspaceId: Id; agentId: Id; error: string };

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
}

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
