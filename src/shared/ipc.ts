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
  UpdateAgentInput,
  EventRecord,
  LlmSettings,
  LlmSettingsInfo,
  MailboxMessage,
  ModelListResult,
  PostBoardInput,
  RiskApprovalRequest,
  SendMessageInput,
  Snapshot,
  Task,
  Workspace,
} from "./types.js";

export interface DeerApi {
  listWorkspaces(): Promise<Workspace[]>;
  openWorkspace(): Promise<Workspace | null>;
  getSnapshot(workspaceId: string): Promise<Snapshot>;
  createAgent(input: CreateAgentInput): Promise<Agent>;
  updateAgent(input: UpdateAgentInput): Promise<Agent>;
  createTask(input: CreateTaskInput): Promise<Task>;
  runTask(taskId: string): Promise<void>;
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
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  onEvent(listener: (event: EventRecord) => void): () => void;
}
