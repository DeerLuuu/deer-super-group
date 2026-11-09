import { contextBridge, ipcRenderer } from "electron";
import type { DeerApi } from "../src/shared/ipc.js";
import type {
  AnswerChatQuestionInput,
  CancelChatQuestionInput,
  ChatEvent,
  CreateAgentInput,
  CreateTaskInput,
  EventRecord,
  RiskApprovalRequest,
  UpdateAgentInput,
  LlmSettings,
  PostBoardInput,
  SendMessageInput,
} from "../src/shared/types.js";

const api: DeerApi = {
  listWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  getSnapshot: (workspaceId: string) => ipcRenderer.invoke("workspace:snapshot", workspaceId),
  createAgent: (input: CreateAgentInput) => ipcRenderer.invoke("agent:create", input),
  updateAgent: (input: UpdateAgentInput) => ipcRenderer.invoke("agent:update", input),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke("task:create", input),
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
  sendMessage: (input: SendMessageInput) => ipcRenderer.invoke("mailbox:send", input),
  postBoard: (input: PostBoardInput) => ipcRenderer.invoke("board:post", input),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: LlmSettings) => ipcRenderer.invoke("settings:save", settings),
  listModels: (settings: LlmSettings, providerId?: string) =>
    ipcRenderer.invoke("llm:models", settings, providerId),
  listChat: (workspaceId: string, agentId?: string) =>
    ipcRenderer.invoke("chat:list", workspaceId, agentId),
  sendChat: (workspaceId: string, message: string) =>
    ipcRenderer.invoke("chat:send", workspaceId, message),
  cancelChat: (workspaceId: string) => ipcRenderer.invoke("chat:cancel", workspaceId),
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
