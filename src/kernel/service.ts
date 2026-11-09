import { promises as fs } from "node:fs";
import path from "node:path";
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
  ContextSection,
  ContextSnapshot,
  CreateAgentInput,
  CreateTaskInput,
  EventRecord,
  LlmSettings,
  LlmSettingsInfo,
  MailboxMessage,
  ModelListResult,
  PermissionMode,
  PostBoardInput,
  RiskApprovalRequest,
  Run,
  SchedulerSnapshot,
  SendMessageInput,
  Snapshot,
  Task,
  UpdateAgentInput,
  Workspace,
} from "../shared/types.js";
import {
  QUESTION_LIMITS,
  INTERACTIVE_PROMPT_V1,
  compressInteractiveForModel,
  formatQuestionAnswer,
  parseChatContent,
  questionExpiresAt,
  validateQuestionAnswers,
  type InteractiveError,
} from "../shared/interactive.js";
import {
  createLlmClientForModel,
  fetchModelListForProvider,
  resolveApiKey,
  type LlmMessage,
} from "./model.js";
import { resolveModelProfile, resolveProvider } from "../shared/models.js";
import { createBuiltinTools, ToolRegistry, type RiskApprovalOutcome, type ToolContext } from "./tools.js";
import { runAgentLoop } from "./loop.js";
import { Store } from "./store.js";
import { fullThrottleBudget, withFullThrottle } from "./permission.js";
import { RISK_APPROVAL_TIMEOUT_MS } from "../shared/approval.js";
import {
  ExecutionKernel,
  type RunExecutionContext,
  type RunExecutionResult,
} from "./execution/kernel.js";
import { GitService } from "../git/gitService.js";
import type { FinalizeRunInput } from "../git/types.js";
import { WatchdogService } from "../watchdog/service.js";
import type {
  CostSnapshot,
  FallbackChain,
  RunHandoff,
  SetBudgetInput,
  SetFallbackChainInput,
  WatchdogAlert,
  WatchdogHealth,
  WatchdogResult,
  WatchdogSnapshot,
} from "../shared/watchdog.js";
import { MemoryRuntime } from "../shared/memoryRuntime.js";
import { createMemoryTools } from "../shared/memoryTools.js";
import type {
  CastPollRequest,
  ClosePollRequest,
  CreatePollRequest,
  Poll,
  PollStatus,
} from "../shared/poll.js";
import { PollError } from "../shared/poll.js";

const PERMISSION_MODES: PermissionMode[] = [
  "read_only",
  "workspace_write",
  "full_access",
  "auto_risk",
];

/**
 * t58 IF-05：审批超时统一用 shared/approval.ts 的 RISK_APPROVAL_TIMEOUT_MS
 * （主进程与 renderer 共用，renderer 据此自动收起过期弹窗）。
 */

type RiskApprovalResult = RiskApprovalOutcome;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function thinkingStyleFor(
  provider: { name: string; baseUrl: string },
  modelId: string,
): "deepseek" | "openai" {
  const haystack = `${provider.name} ${provider.baseUrl} ${modelId}`.toLowerCase();
  return haystack.includes("deepseek") ? "deepseek" : "openai";
}

function buildRouterSystemPrompt(workspace: Workspace, agents: Agent[], tasks: Task[]): string {
  const base = [
    "You are Router, the coordinator of an AI team called DeerSuperGroup.",
    `Workspace: ${workspace.name} at ${workspace.path}`,
    workspace.overview ? `Workspace overview:\n${workspace.overview}` : "",
    `Team:\n${agents
      .map((agent) => `- ${agent.name} (${agent.role})${agent.isRouter ? " [Router]" : ""}`)
      .join("\n")}`,
    `Tasks:\n${tasks.map((task) => `- ${task.title} [${task.status}]`).join("\n") || "(none)"}`,
    "You are chatting with the user. Be concise, ask for missing information, and suggest next steps.",
    "If the user wants a task plan, tell them to use the Plan button or describe the goal in detail.",
    // t64：交互协议 v1 只注入 Router 对话（worker 循环不注入，见设计 §5.8）。
    INTERACTIVE_PROMPT_V1,
  ]
    .filter(Boolean)
    .join("\n");
  return base;
}

function buildWorkerSystemPrompt(agent: Agent, task: Task, workspace: Workspace): string {
  return [
    `You are ${agent.name} (${agent.role}) in DeerSuperGroup, an AI team.`,
    `Workspace: ${workspace.name} at ${workspace.path}`,
    `Task: ${task.title}`,
    `Description: ${task.description || "(none)"}`,
    `Acceptance: ${task.acceptance.length ? task.acceptance.join("; ") : "(none)"}`,
    "",
    "Rules:",
    "- Work only inside the workspace directory.",
    "- Inspect files before editing; keep changes minimal.",
    "- Use shell.run for tests/builds when useful.",
    "- When finished, call task.complete with a structured summary.",
    "- If blocked, use mailbox.send to report to Router.",
    "",
    agent.persona ? `Persona:\n${agent.persona}` : "",
    agent.agentsMd ? `AGENTS.md:\n${agent.agentsMd}` : "",
    workspace.overview ? `Workspace overview:\n${workspace.overview}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function limitPayload(payload: unknown): unknown {
  const raw = JSON.stringify(payload ?? {});
  if (raw.length <= 6000) return payload;
  return { truncated: true, preview: raw.slice(0, 6000) };
}

function parsePlan(text: string): Array<{
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: number[];
}> {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("plan is not JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    tasks?: Array<{
      title?: unknown;
      description?: unknown;
      acceptance?: unknown;
      dependsOn?: unknown;
    }>;
  };
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("plan has no tasks");
  }
  return parsed.tasks.map((task, index) => ({
    title: String(task.title ?? `任务 ${index + 1}`),
    description: String(task.description ?? ""),
    acceptance: Array.isArray(task.acceptance)
      ? task.acceptance.map((item) => String(item))
      : [],
    dependsOn: Array.isArray(task.dependsOn)
      ? task.dependsOn
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item >= 0 && item < parsed.tasks!.length)
      : [],
  }));
}

export class AppService {
  readonly store: Store;
  private readonly listeners = new Set<(event: EventRecord) => void>();
  private readonly chatListeners = new Set<(event: ChatEvent) => void>();
  private readonly chatAborts = new Map<string, AbortController>();
  /** t68：执行内核（事件/状态机/调度/重试/恢复）。 */
  private readonly kernel: ExecutionKernel;
  /** t96：Git 并行开发（worktree/PR/合并队列）；与内核通过 service 包装协作。 */
  readonly git: GitService;
  /** t123：记忆工作台运行时（MemoryStore/Service 适配，不改核心 schema）。 */
  readonly memory: MemoryRuntime;
  /** t144：看门狗/成本（独立 watchdog 表，不侵入内核投影）。 */
  readonly watchdog: WatchdogService;
  /**
   * DESIGN §15.4：Full Throttle 会话级状态（key = `workspaceId:agentId`）。
   * 仅会话级：不持久化、不写回 Agent 默认值、不随应用启动恢复；Agent 无工具可自行开启。
   */
  private readonly fullThrottle = new Set<string>();
  /**
   * t58 IF-05：高风险人类审批的待决请求（内存态，requestId 单次生效）。
   * 刷新/重开会话不残留批准——渲染层丢失即超时 human_required，绝不静默放行。
   */
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (result: RiskApprovalResult) => void; timer: NodeJS.Timeout }
  >();
  private readonly approvalListeners = new Set<(request: RiskApprovalRequest) => void>();

  constructor(dataDir: string) {
    this.store = new Store(path.join(dataDir, "deer.db"));
    this.store.onEvent((event) => {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // ignore listener errors
        }
      }
    });
    this.git = new GitService({ dataDir, store: this.store });
    this.memory = new MemoryRuntime(this.store);
    this.kernel = new ExecutionKernel({
      store: this.store,
      dataDir,
      executor: (ctx) => this.executeRun(ctx),
      hooks: {
        // Budget must be checked before Git prepares a worktree; Git capacity
        // still defers the task without consuming an attempt.
        beforeStart: (info) => {
          if (!this.watchdog.beforeStart(info)) return false;
          return this.git.beforeStart(info);
        },
        onRunStarted: (info) => this.watchdog.onRunStarted(info),
        onRunActivity: (info) => this.watchdog.onRunActivity(info),
        onRunHeartbeat: (info) => this.watchdog.onRunHeartbeat(info),
        onRunFinished: (info) => this.watchdog.onRunFinished(info),
      },
    });
    this.watchdog = new WatchdogService({
      store: this.store,
      kernel: this.kernel,
      dataDir,
    });
  }

  onEvent(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChatEvent(listener: (event: ChatEvent) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  private emitChat(event: ChatEvent): void {
    for (const listener of this.chatListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  close(): void {
    this.watchdog.close();
    this.git.close();
    this.kernel.dispose();
    this.store.close();
  }

  listWorkspaces(): Workspace[] {
    return this.store.listWorkspaces();
  }

  async openWorkspace(folderPath: string): Promise<Workspace> {
    const resolved = path.resolve(folderPath);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);
    const workspace = this.store.createWorkspace(path.basename(resolved), resolved);
    this.ensureRouter(workspace.id);
    if (!workspace.overview) {
      await this.summarizeWorkspace(workspace.id);
    }
    return this.store.getWorkspace(workspace.id) ?? workspace;
  }

  ensureRouter(workspaceId: string): Agent {
    const existing = this.store.listAgents(workspaceId).find((agent) => agent.isRouter);
    if (existing) return existing;
    return this.store.createAgent(
      {
        workspaceId,
        name: "Router",
        role: "coordinator",
        systemPrompt: [
          "You are Router, the coordinator of an AI team called DeerSuperGroup.",
          "You understand the user's goal, inspect the workspace, propose a task DAG, and dispatch work.",
          "You do not edit files or run commands yourself; workers do that.",
          "Prefer small, independently verifiable tasks with explicit acceptance criteria.",
        ].join("\n"),
        persona: "",
        agentsMd: "",
        model: null,
      },
      true,
    );
  }

  createAgent(input: CreateAgentInput): Agent {
    const existing = this.store
      .listAgents(input.workspaceId)
      .find((agent) => agent.name.toLowerCase() === input.name.trim().toLowerCase());
    if (existing) throw new Error(`member already exists: ${input.name}`);
    if (!input.name.trim()) throw new Error("member name is required");
    let model = input.model;
    if (model) {
      const settings = this.store.getLlmSettings();
      const profile =
        settings.models.find((item) => item.id === model) ??
        settings.models.find((item) => item.modelId === model);
      if (!profile) {
        throw new Error(`model is not in the configured model list: ${model}`);
      }
      model = profile.id;
    }
    return this.store.createAgent({
      ...input,
      model,
      name: input.name.trim(),
      role: input.role.trim() || "engineer",
    });
  }

  updateAgent(input: UpdateAgentInput): Agent {
    const agent = this.store.getAgent(input.id);
    if (!agent) throw new Error(`member not found: ${input.id}`);

    // DESIGN §15：权限变更校验 + agent.permission_changed 事件。
    if (input.permission !== undefined) {
      if (!PERMISSION_MODES.includes(input.permission)) {
        throw new Error(`unknown permission mode: ${input.permission}`);
      }
    }

    const patch: Partial<
      Pick<
        Agent,
        "name" | "role" | "systemPrompt" | "persona" | "agentsMd" | "model" | "permission"
      >
    > = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("member name is required");
      const duplicate = this.store
        .listAgents(agent.workspaceId)
        .find(
          (item) =>
            item.id !== agent.id && item.name.toLowerCase() === name.toLowerCase(),
        );
      if (duplicate) throw new Error(`member already exists: ${name}`);
      patch.name = name;
    }
    if (input.role !== undefined) patch.role = input.role.trim() || "engineer";
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
    if (input.persona !== undefined) patch.persona = input.persona;
    if (input.agentsMd !== undefined) patch.agentsMd = input.agentsMd;

    if (input.model !== undefined) {
      if (!input.model) {
        patch.model = null;
      } else {
        const settings = this.store.getLlmSettings();
        const profile =
          settings.models.find((item) => item.id === input.model) ??
          settings.models.find((item) => item.modelId === input.model);
        if (!profile) {
          throw new Error(`model is not in the configured model list: ${input.model}`);
        }
        patch.model = profile.id;
      }
    }

    if (input.permission !== undefined) {
      patch.permission = input.permission;
    }

    const updated = this.store.updateAgent(agent.id, patch);

    // DESIGN §15.6：专项审计事件（store 另写通用 agent.updated）。
    if (patch.permission !== undefined && patch.permission !== agent.permission) {
      this.store.appendEvent({
        aggregateType: "agent",
        aggregateId: agent.id,
        type: "agent.permission_changed",
        actor: "user",
        payload: { from: agent.permission, to: patch.permission },
      });
    }
    if (patch.model !== undefined && patch.model !== agent.model) {
      this.store.appendEvent({
        aggregateType: "agent",
        aggregateId: agent.id,
        type: "agent.model_changed",
        actor: "user",
        payload: { from: agent.model, to: patch.model },
      });
    }

    return updated;
  }

  createTask(input: CreateTaskInput): Task {
    if (!input.title.trim()) throw new Error("task title is required");
    const task = this.store.createTask({
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      description: input.description,
      acceptance: input.acceptance.filter(Boolean),
    });
    if (input.scopePaths?.length) {
      this.git.recordScope(task.id, input.workspaceId, input.scopePaths);
    }
    return task;
  }

  getSnapshot(workspaceId: string): Snapshot {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    return {
      workspace,
      agents: this.store.listAgents(workspaceId),
      tasks: this.store.listTasks(workspaceId),
      messages: this.store.listMessages(workspaceId),
      boardEntries: this.store.listBoard(workspaceId),
      settings: this.store.getLlmSettings(),
    };
  }

  listChat(workspaceId: string, agentId?: string): ChatMessage[] {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const router = this.ensureRouter(workspaceId);
    return this.store.listChatMessages(workspaceId, agentId ?? router.id, 100);
  }

  async sendChat(workspaceId: string, content: string): Promise<ChatMessage | null> {
    const message = content.trim();
    if (!message) throw new Error("message is required");
    if (this.chatAborts.has(workspaceId)) throw new Error("chat is already running");

    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const router = this.ensureRouter(workspaceId);
    const settings = this.store.getLlmSettings();
    const profile = resolveModelProfile(settings, router.model);
    const provider = resolveProvider(settings, profile.providerId);
    const client = createLlmClientForModel(settings, profile);

    this.store.addChatMessage({
      workspaceId,
      agentId: router.id,
      role: "user",
      content: message,
    });

    const history = this.store.listChatMessages(workspaceId, router.id, 30);
    // DESIGN §15.4：满血模式注入（不改权限；预算覆盖：输出翻倍、思考拉满）。
    const fullThrottle = this.isFullThrottle(workspaceId, router.id);
    const budget = fullThrottle ? fullThrottleBudget(profile) : null;
    const routerPrompt = buildRouterSystemPrompt(
      workspace,
      this.store.listAgents(workspaceId),
      this.store.listTasks(workspaceId),
    );
    // t64 §5.9：画布/问题块进入模型上下文前压缩为摘要，避免 JSON 挤爆上下文；
    // 同时把最近 5 张画布摘要附加到单条 system 消息末尾（不同 provider 对多 system 处理不一致）。
    const recentCanvases = this.recentCanvasSummary(workspaceId, router.id);
    const systemContent = [
      fullThrottle ? withFullThrottle(routerPrompt) : routerPrompt,
      recentCanvases,
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: systemContent,
      },
      ...history.map(
        (item): LlmMessage => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content:
            item.role === "assistant"
              ? compressInteractiveForModel(item.content, item.id)
              : item.content,
        }),
      ),
    ];

    const controller = new AbortController();
    this.chatAborts.set(workspaceId, controller);
    let text = "";
    let reasoning = "";

    try {
      for await (const event of client.stream({
        model: profile.modelId,
        messages,
        maxOutputTokens: budget?.maxOutputTokens ?? profile.maxOutputTokens,
        reasoningEffort:
          budget?.reasoningEffort ??
          (profile.thinkingEnabled ? profile.thinkingEffort : undefined),
        thinkingEnabled: profile.thinkingEnabled,
        thinkingStyle: thinkingStyleFor(provider, profile.modelId),
        signal: controller.signal,
      })) {
        if (event.type === "text") {
          text += event.text;
          this.emitChat({ type: "delta", workspaceId, agentId: router.id, text: event.text });
        } else if (event.type === "reasoning") {
          reasoning += event.text;
          this.emitChat({
            type: "reasoning",
            workspaceId,
            agentId: router.id,
            text: event.text,
          });
        }
      }
      const assistant = this.store.addChatMessage({
        workspaceId,
        agentId: router.id,
        role: "assistant",
        content: text.trim() || "（无回复）",
        reasoning: reasoning.trim(),
      });
      // t64 §9.4：落库后 ingest 画布/提问（幂等）；任何异常只写审计事件，不阻断 done。
      try {
        this.ingestAssistantInteractive(workspaceId, router.id, assistant);
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 120) : "unknown";
        this.store.appendEvent({
          aggregateType: "chat",
          aggregateId: assistant.id,
          type: "chat.interactive_ingest_failed",
          actor: "Router",
          payload: { messageId: assistant.id, code },
        });
      }
      this.emitChat({ type: "done", workspaceId, agentId: router.id, message: assistant });
      return assistant;
    } catch (error) {
      if (controller.signal.aborted) {
        this.emitChat({ type: "cancelled", workspaceId, agentId: router.id });
        return null;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitChat({
        type: "error",
        workspaceId,
        agentId: router.id,
        error: errorMessage,
      });
      throw error;
    } finally {
      this.chatAborts.delete(workspaceId);
    }
  }

  cancelChat(workspaceId: string): void {
    this.chatAborts.get(workspaceId)?.abort();
  }

  /** DESIGN §15.4：满血模式开关——只注入提示/预算，不碰权限；无工具暴露给 Agent。 */
  setFullThrottle(workspaceId: string, agentId: string, enabled: boolean): void {
    const key = `${workspaceId}:${agentId}`;
    if (enabled) this.fullThrottle.add(key);
    else this.fullThrottle.delete(key);
    this.store.appendEvent({
      aggregateType: "workspace",
      aggregateId: workspaceId,
      type: "session.full_throttle_changed",
      actor: "user",
      payload: { agentId, enabled },
    });
  }

  isFullThrottle(workspaceId: string, agentId: string): boolean {
    return this.fullThrottle.has(`${workspaceId}:${agentId}`);
  }

  // ---------- t58 IF-05：auto_risk 高风险人类审批（DESIGN §15.3 第 4 条） ----------

  /** 主进程 → renderer 审批弹窗（仅监听器是人类 UI 链路，Agent 无法触达）。 */
  onRiskApproval(listener: (request: RiskApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  /** 发起一次审批请求：renderer 人工批准/拒绝；超时（默认 120s）按未批准处理。单次生效。 */
  requestRiskApproval(input: {
    workspaceId: string;
    taskId: string;
    agentName: string;
    toolName: string;
    target: string;
    risk: "low" | "medium" | "high";
    reason: string;
  }): Promise<RiskApprovalResult> {
    return new Promise((resolve) => {
      const requestId = `appr_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const request: RiskApprovalRequest = {
        requestId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        agentName: input.agentName,
        toolName: input.toolName,
        target: input.target,
        risk: input.risk,
        reason: input.reason,
        createdAt: new Date().toISOString(),
      };
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve({ approved: false, outcome: "timeout" });
      }, RISK_APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(requestId, { resolve, timer });
      for (const listener of this.approvalListeners) {
        try {
          listener(request);
        } catch {
          // ignore listener errors
        }
      }
    });
  }

  /** renderer 人工回执：requestId 一次性消费（不存在的 id 直接拒绝，防重放/残留）。 */
  respondRiskApproval(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ approved, outcome: approved ? "approved" : "denied" });
    return true;
  }

  // ---------- t64：交互画布 / 提问表单（设计 §9.4） ----------

  /**
   * 主进程 ingest：解析 assistant 消息中的 deer-canvas / deer-question 块。
   * - 合法画布 → chat_artifacts 索引（P0 渲染不依赖）；
   * - 合法提问 → chat_questions（pending，可带 expiresAt）；
   * - 非法块 → chat.interactive_invalid 审计事件（不落库、不阻塞对话）；
   * - 幂等：同一 (messageId, blockIndex) 只写一次、只发一次事件。
   */
  ingestAssistantInteractive(
    workspaceId: string,
    agentId: string,
    message: ChatMessage,
  ): { artifacts: number; questions: number; errors: InteractiveError[] } {
    const blocks = parseChatContent(message.content, {
      role: "assistant",
      messageId: message.id,
      complete: true,
    });
    let artifacts = 0;
    let questions = 0;
    const errors: InteractiveError[] = [];

    for (const block of blocks) {
      if (block.type === "canvas") {
        if (this.store.getCanvasArtifact(workspaceId, block.key)) continue;
        this.store.saveCanvasArtifact({
          id: block.key,
          workspaceId,
          agentId,
          messageId: message.id,
          blockIndex: block.blockIndex,
          kind: block.artifact.kind,
          title: block.artifact.title,
          protocolVersion: block.artifact.version,
          payload: block.artifact,
          createdAt: message.createdAt,
        });
        artifacts += 1;
        this.store.appendEvent({
          aggregateType: "chat",
          aggregateId: block.key,
          type: "chat.artifact_ingested",
          actor: "Router",
          payload: {
            artifactId: block.key,
            kind: block.artifact.kind,
            nodes: block.artifact.nodes.length,
            edges: block.artifact.edges.length,
          },
        });
        continue;
      }
      if (block.type === "question") {
        if (this.store.getChatQuestion(block.key)) continue;
        const expiresAt = questionExpiresAt(message.createdAt, block.question.timeoutSec);
        this.store.saveChatQuestion({
          id: block.key,
          workspaceId,
          agentId,
          messageId: message.id,
          blockIndex: block.blockIndex,
          title: block.question.title,
          payload: block.question,
          createdAt: message.createdAt,
          expiresAt,
        });
        questions += 1;
        this.store.appendEvent({
          aggregateType: "chat",
          aggregateId: block.key,
          type: "chat.question_created",
          actor: "Router",
          payload: {
            questionId: block.key,
            fieldCount: block.question.fields.length,
            expiresAt,
          },
        });
        continue;
      }
      if (block.type === "canvas_error" || block.type === "question_error") {
        errors.push(block.error);
        this.store.appendEvent({
          aggregateType: "chat",
          aggregateId: message.id,
          type: "chat.interactive_invalid",
          actor: "Router",
          payload: {
            messageId: message.id,
            blockIndex: block.blockIndex,
            kind: block.type === "canvas_error" ? "canvas" : "question",
            code: block.error.code,
          },
        });
      }
    }
    return { artifacts, questions, errors };
  }

  /** 问题列表（含惰性过期清算；设计 §6.4）。 */
  listChatQuestions(workspaceId: string, agentId?: string): ChatQuestionRecord[] {
    this.expireQuestions(workspaceId);
    return this.store.listChatQuestions(workspaceId, agentId);
  }

  private expireQuestions(workspaceId: string): string[] {
    const expired = this.store.expireChatQuestions(workspaceId, new Date().toISOString());
    for (const questionId of expired) {
      this.store.appendEvent({
        aggregateType: "chat",
        aggregateId: questionId,
        type: "chat.question_expired",
        actor: "system",
        payload: { questionId },
      });
    }
    return expired;
  }

  answerChatQuestion(input: AnswerChatQuestionInput): AnswerChatQuestionResult {
    const question = this.store.getChatQuestion(input.questionId);
    if (!question) {
      return { ok: false, code: "E_NOT_FOUND", message: "问题不存在或已被清理" };
    }
    if (question.workspaceId !== input.workspaceId) {
      return { ok: false, code: "E_WORKSPACE_MISMATCH", message: "问题不属于当前工作区" };
    }
    // E_BUSY 在标记 answered 之前检查：避免「答案已存但消息发不出」的状态。
    if (this.chatAborts.has(input.workspaceId)) {
      return { ok: false, code: "E_BUSY", message: "Router 正在回复，请稍后再提交" };
    }
    const now = new Date().toISOString();
    if (question.status === "answered") {
      return {
        ok: true,
        changed: false,
        question,
        answerText: formatQuestionAnswer(question.payload, question.answer?.values ?? {}),
      };
    }
    if (question.status === "cancelled") {
      return { ok: false, code: "E_CLOSED", message: "该问题已取消" };
    }
    if (question.status === "expired") {
      return { ok: false, code: "E_EXPIRED", message: "该问题已过期" };
    }
    if (question.expiresAt && question.expiresAt <= now) {
      this.expireQuestions(question.workspaceId);
      return { ok: false, code: "E_EXPIRED", message: "该问题已过期" };
    }

    const validated = validateQuestionAnswers(question.payload, input.values);
    if (!validated.ok) {
      return {
        ok: false,
        code: "E_INVALID_ANSWER",
        message: "回答未通过校验",
        fieldErrors: validated.errors,
      };
    }
    const answer = { values: validated.values, answeredAt: now };
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).length;
    if (bytes > QUESTION_LIMITS.answerBytes) {
      return { ok: false, code: "E_TOO_LARGE", message: "回答内容过长，请精简" };
    }

    const changed = this.store.answerChatQuestion({
      questionId: question.id,
      answer,
      answeredAt: now,
    });
    if (!changed) {
      const latest = this.store.getChatQuestion(question.id);
      if (!latest) {
        return { ok: false, code: "E_NOT_FOUND", message: "问题不存在或已被清理" };
      }
      if (latest.status === "answered") {
        this.store.appendEvent({
          aggregateType: "chat",
          aggregateId: latest.id,
          type: "chat.question_answered",
          actor: "user",
          payload: { questionId: latest.id, changed: false, fieldIds: [] },
        });
        return {
          ok: true,
          changed: false,
          question: latest,
          answerText: formatQuestionAnswer(latest.payload, latest.answer?.values ?? {}),
        };
      }
      if (latest.status === "expired") {
        return { ok: false, code: "E_EXPIRED", message: "该问题已过期" };
      }
      return { ok: false, code: "E_CLOSED", message: "该问题已结束" };
    }

    const updated = this.store.getChatQuestion(question.id);
    if (!updated) {
      return { ok: false, code: "E_NOT_FOUND", message: "问题不存在或已被清理" };
    }
    const answerText = formatQuestionAnswer(updated.payload, validated.values);
    this.store.appendEvent({
      aggregateType: "chat",
      aggregateId: updated.id,
      type: "chat.question_answered",
      actor: "user",
      payload: { questionId: updated.id, changed: true, fieldIds: Object.keys(validated.values) },
    });
    return { ok: true, changed: true, question: updated, answerText };
  }

  cancelChatQuestion(input: CancelChatQuestionInput): CancelChatQuestionResult {
    const question = this.store.getChatQuestion(input.questionId);
    if (!question) {
      return { ok: false, code: "E_NOT_FOUND", message: "问题不存在或已被清理" };
    }
    if (question.workspaceId !== input.workspaceId) {
      return { ok: false, code: "E_WORKSPACE_MISMATCH", message: "问题不属于当前工作区" };
    }
    if (question.status === "cancelled") {
      return { ok: true, question };
    }
    if (question.status === "answered") {
      return { ok: false, code: "E_CLOSED", message: "该问题已回答，不能取消" };
    }
    if (question.status === "expired") {
      return { ok: false, code: "E_EXPIRED", message: "该问题已过期" };
    }
    const finishedAt = new Date().toISOString();
    const changed = this.store.cancelChatQuestion({
      questionId: question.id,
      finishedAt,
    });
    if (!changed) {
      const latest = this.store.getChatQuestion(question.id);
      if (latest?.status === "cancelled") return { ok: true, question: latest };
      if (latest?.status === "expired") {
        return { ok: false, code: "E_EXPIRED", message: "该问题已过期" };
      }
      return { ok: false, code: "E_CLOSED", message: "该问题已结束" };
    }
    const updated = this.store.getChatQuestion(question.id);
    if (!updated) {
      return { ok: false, code: "E_NOT_FOUND", message: "问题不存在或已被清理" };
    }
    this.store.appendEvent({
      aggregateType: "chat",
      aggregateId: updated.id,
      type: "chat.question_cancelled",
      actor: "user",
      payload: { questionId: updated.id },
    });
    return { ok: true, question: updated };
  }

  listChatArtifacts(workspaceId: string, agentId?: string): ChatArtifactRecord[] {
    return this.store.listCanvasArtifacts(workspaceId, agentId, 100);
  }

  getChatArtifact(workspaceId: string, artifactId: string): ChatArtifactRecord | null {
    return this.store.getCanvasArtifact(workspaceId, artifactId);
  }

  /** 最近画布摘要（进入 Router system 消息末尾；设计 §5.9）。 */
  private recentCanvasSummary(workspaceId: string, agentId: string): string {
    const artifacts = this.store.listCanvasArtifacts(workspaceId, agentId, 5);
    if (artifacts.length === 0) return "";
    return [
      "Recent canvases for this conversation:",
      ...artifacts.map(
        (artifact) =>
          `- ${artifact.id} "${artifact.title}" (${artifact.kind}, ${artifact.payload.nodes.length} nodes)`,
      ),
    ].join("\n");
  }

  getContext(workspaceId: string, agentId?: string, taskId?: string): ContextSnapshot {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const agents = this.store.listAgents(workspaceId);
    const tasks = this.store.listTasks(workspaceId);
    const router = this.ensureRouter(workspaceId);
    const task = taskId ? this.store.getTask(taskId) : null;
    if (taskId && (!task || task.workspaceId !== workspaceId)) {
      throw new Error(`task not found in workspace: ${taskId}`);
    }
    const explicitAgent = agentId ? this.store.getAgent(agentId) : null;
    if (agentId && (!explicitAgent || explicitAgent.workspaceId !== workspaceId)) {
      throw new Error(`agent not found in workspace: ${agentId}`);
    }
    const agent = agentId
      ? explicitAgent
      : task?.ownerId
        ? this.store.getAgent(task.ownerId)
        : router;
    if (!agent) throw new Error(`agent not found: ${agentId ?? "unknown"}`);

    const settings = this.store.getLlmSettings();
    const profile = resolveModelProfile(settings, agent.model);
    const provider = resolveProvider(settings, profile.providerId);
    const sections: ContextSection[] = [];
    const push = (
      id: string,
      title: string,
      kind: ContextSection["kind"],
      content: string,
      meta?: string,
    ) => {
      const text = content.trim();
      if (!text) return;
      sections.push({
        id,
        title,
        kind,
        content: text,
        tokens: estimateTokens(text),
        meta,
      });
    };

    if (task) {
      push("system", "任务系统提示", "system", buildWorkerSystemPrompt(agent, task, workspace));
      push("persona", "人格", "persona", agent.persona);
      push("agents", "AGENTS.md", "agents", agent.agentsMd);
      push("workspace", "工作区概述", "workspace", workspace.overview ?? "");      push(
        "task",
        "任务上下文",
        "task",
        [
          `Task: ${task.title}`,
          `Status: ${task.status}`,
          `Description: ${task.description || "(none)"}`,
          `Acceptance:\n${
            task.acceptance.length
              ? task.acceptance.map((item) => `- ${item}`).join("\n")
              : "(none)"
          }`,
          `Depends on: ${task.dependsOn.length ? task.dependsOn.join(", ") : "(none)"}`,
        ].join("\n"),
      );
    } else {
      push("system", "Router 系统提示", "system", buildRouterSystemPrompt(workspace, agents, tasks));
      push("workspace", "工作区概述", "workspace", workspace.overview ?? "");
    }

    if (this.memory.available) {
      try {
        const memoryContext = this.memory.buildContext({
          workspaceId,
          agentId: agent.id,
          taskId: task?.id ?? null,
          maxTokens: 600,
        });
        push(
          "memory",
          "记忆上下文",
          "memory",
          memoryContext.text,
          `${memoryContext.hits.length} 条命中 · ${memoryContext.usedTokens}/${memoryContext.maxTokens} tokens${
            memoryContext.truncated ? ` · 已截断 ${memoryContext.omitted}` : ""
          }`,
        );
      } catch {
        // Memory is optional; context panel must not fail.
      }
    }

    push(
      "model",
      "模型参数",
      "system",
      [
        `Provider: ${provider.name}`,
        `Model: ${profile.modelId}`,
        `Images: ${profile.supportsImages ? "enabled" : "disabled"}`,
        `Context window: ${profile.contextWindow}`,
        `Max output: ${profile.maxOutputTokens}`,
        `Thinking: ${profile.thinkingEnabled ? profile.thinkingEffort : "off"}`,
      ].join("\n"),
    );

    const history = this.store.listChatMessages(workspaceId, agent.id, 20);
    push(
      "history",
      "对话历史",
      "history",
      history.map((item) => `${item.role}: ${item.content}`).join("\n\n"),
      `${history.length} 条`,
    );

    // t64 §5.9：交互画布与提问摘要（复用 kind=history，上下文面板无需新增 UI 类型）。
    const artifacts = this.store.listCanvasArtifacts(workspaceId, agent.id, 5);
    const questions = this.listChatQuestions(workspaceId, agent.id);
    const pendingQuestions = questions.filter((question) => question.status === "pending");
    const answeredQuestions = questions.filter((question) => question.status === "answered");
    push(
      "interactive",
      "交互画布与提问",
      "history",
      [
        ...artifacts.map(
          (artifact) =>
            `[画布] ${artifact.title}（${artifact.kind}，${artifact.payload.nodes.length} 节点）id=${artifact.id}`,
        ),
        ...pendingQuestions.map(
          (question) =>
            `[待回答] ${question.title}（${question.payload.fields.length} 字段）id=${question.id}`,
        ),
        ...answeredQuestions
          .slice(-3)
          .map((question) => `[已回答] ${question.title} id=${question.id}`),
      ].join("\n"),
      `${artifacts.length} 张画布 · ${pendingQuestions.length} 个待回答`,
    );

    const board = this.store.listBoard(workspaceId, undefined, 10);
    push(
      "board",
      "团队黑板",
      "memory",
      board.map((entry) => `[${entry.board}/${entry.kind}] ${entry.content}`).join("\n\n"),
      `${board.length} 条`,
    );

    const memos = this.store.searchMemos(workspaceId, "", 10);
    push(
      "memos",
      "成员备忘录",
      "memory",
      memos.map((memo) => `[${memo.kind}] ${memo.content}`).join("\n\n"),
      `${memos.length} 条`,
    );

    const tools = createBuiltinTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));

    return {
      agent,
      providerName: provider.name,
      model: profile.modelId,
      contextWindow: profile.contextWindow,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      sections,
      tools,
      taskTitle: task?.title ?? null,
    };
  }

  async plan(workspaceId: string, goal: string): Promise<Task[]> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    if (!goal.trim()) throw new Error("goal is required");

    const settings = this.store.getLlmSettings();
    const profile = resolveModelProfile(settings, settings.model);
    const provider = resolveProvider(settings, profile.providerId);
    const client = createLlmClientForModel(settings, profile);
    const completion = await client.complete({
      model: profile.modelId,
      maxOutputTokens: profile.maxOutputTokens,
      reasoningEffort: profile.thinkingEnabled ? profile.thinkingEffort : undefined,
      thinkingEnabled: profile.thinkingEnabled,
      thinkingStyle: thinkingStyleFor(provider, profile.modelId),
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "ROUTER_PLANNER",
            "You are the planning mode of Router in DeerSuperGroup.",
            "Return JSON only, with this shape:",
            '{"tasks":[{"title":"...","description":"...","acceptance":["..."],"dependsOn":[]}]}',
            "dependsOn contains zero-based indexes of earlier tasks.",
            "Keep the plan small: 2-4 tasks.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `WORKSPACE: ${workspace.name}`,
            `PATH: ${workspace.path}`,
            `OVERVIEW:\n${workspace.overview ?? "(no overview yet)"}`,
            `GOAL:\n${goal.trim()}`,
          ].join("\n\n"),
        },
      ],
    });

    let plan: ReturnType<typeof parsePlan>;
    try {
      plan = parsePlan(completion.text);
    } catch {
      plan = [
        {
          title: goal.trim().slice(0, 80),
          description: goal.trim(),
          acceptance: ["完成目标并给出结果说明"],
          dependsOn: [],
        },
      ];
    }

    const created = plan.map((item) =>
      this.store.createTask({
        workspaceId,
        title: item.title,
        description: item.description,
        acceptance: item.acceptance,
      }),
    );

    plan.forEach((item, index) => {
      const dependsOn = item.dependsOn
        .map((depIndex) => created[depIndex]?.id)
        .filter((id): id is string => Boolean(id));
      if (dependsOn.length) {
        this.store.updateTask(created[index].id, { dependsOn });
      }
    });

    this.store.appendEvent({
      aggregateType: "workspace",
      aggregateId: workspaceId,
      type: "router.plan",
      actor: "Router",
      payload: { goal, tasks: created.map((task) => task.id) },
    });
    return created.map((task) => this.store.getTask(task.id) ?? task);
  }

  // ---------------------------------------------------------------- kernel
  // t68：任务执行统一走 ExecutionKernel（事件/状态机/调度/重试/恢复）。
  // runTask 保留为兼容别名（入队 + 等待终态）；旧 UI/IPC 无需改动。

  async runTask(taskId: string): Promise<void> {
    await this.kernel.runTask(taskId);
  }

  startTask(taskId: string): Task {
    return this.kernel.startTask(taskId);
  }

  cancelTask(taskId: string): Task {
    return this.kernel.cancelTask(taskId);
  }

  retryTask(taskId: string): Task {
    return this.kernel.retryTask(taskId);
  }

  /** t83 F5：reviewPolicy=required 的批准/拒绝（IPC/UI 由 t69 接入）。 */
  reviewTask(
    taskId: string,
    decision: "approve" | "reject",
    options: { reviewer?: string; notes?: string } = {},
  ): Task {
    return this.kernel.reviewTask(taskId, decision, options);
  }

  cancelRun(runId: string): Run {
    return this.kernel.cancelRun(runId);
  }

  listRuns(taskId: string): Run[] {
    return this.kernel.listRuns(taskId);
  }

  pauseScheduler(workspaceId: string, reason?: string): SchedulerSnapshot {
    return this.kernel.pauseScheduler(workspaceId, reason);
  }

  resumeScheduler(workspaceId: string): SchedulerSnapshot {
    return this.kernel.resumeScheduler(workspaceId);
  }

  getScheduler(workspaceId: string): SchedulerSnapshot {
    return this.kernel.getScheduler(workspaceId);
  }

  rebuildProjections(): ReturnType<ExecutionKernel["rebuildProjections"]> {
    return this.kernel.rebuildProjections();
  }

  // ---------------------------------------------------------- watchdog API

  getWatchdogSnapshot(workspaceId: string): WatchdogResult<WatchdogSnapshot> {
    return this.watchdog.getSnapshot(workspaceId);
  }

  getWatchdogCosts(workspaceId: string): WatchdogResult<CostSnapshot> {
    return this.watchdog.getCosts(workspaceId);
  }

  getRunHandoff(workspaceId: string, runId: string): WatchdogResult<RunHandoff | null> {
    return this.watchdog.getRunHandoff(workspaceId, runId);
  }

  ackWatchdogAlert(workspaceId: string, alertId: string): WatchdogResult<WatchdogAlert> {
    return this.watchdog.ackAlert(workspaceId, alertId);
  }

  resolveWatchdogAlert(workspaceId: string, alertId: string): WatchdogResult<WatchdogAlert> {
    return this.watchdog.resolveAlert(workspaceId, alertId);
  }

  releaseWatchdogTaskHold(workspaceId: string, taskId: string): WatchdogResult<void> {
    return this.watchdog.releaseTaskHold(workspaceId, taskId);
  }

  setWatchdogBudget(input: SetBudgetInput) {
    return this.watchdog.setBudget(input);
  }

  setWatchdogFallback(input: SetFallbackChainInput): WatchdogResult<FallbackChain> {
    return this.watchdog.setFallbackChain(input);
  }

  getWatchdogHealth(): WatchdogHealth {
    return this.watchdog.getHealth();
  }

  /** 内核执行器：一次 Run 的 LLM/工具执行（不含生命周期/状态写入，由 kernel 负责）。 */
  private async executeRun(ctx: RunExecutionContext): Promise<RunExecutionResult> {
    const { run, task, agent } = ctx;
    // The beforeStart hook prepared the runtime worktree synchronously and the
    // kernel wrote it into run.started/run projection; consume it here.
    const worktreePath = run.sandboxId?.startsWith("git:") ? run.sandboxId.slice(4) : null;
    const finalize = (status: FinalizeRunInput["status"]) => {
      void this.git.finalizeRun({ runId: run.id, taskId: task.id, status }).catch(() => {
        // Git finalization must never change kernel terminal state
      });
    };
    try {
      const result = await this.executeRunCore(ctx, worktreePath);
      finalize(ctx.signal.aborted ? "cancelled" : "completed");
      return result;
    } catch (error) {
      finalize(ctx.signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  private async executeRunCore(
    ctx: RunExecutionContext,
    worktreeOverride: string | null,
  ): Promise<RunExecutionResult> {
    const { run, task, agent, signal, heartbeat, checkpoint, waitingHuman, resumeHuman, activity, consumeNudges } = ctx;
    const workspace = this.store.getWorkspace(task.workspaceId);
    if (!workspace) throw new Error("workspace not found");

    const settings = this.store.getLlmSettings();
    // t144：watchdog fallback 时 run.modelProfileId 覆盖成员默认模型。
    const profile = resolveModelProfile(settings, run.modelProfileId ?? agent.model);
    const provider = resolveProvider(settings, profile.providerId);
    const client = createLlmClientForModel(settings, profile);
    const model = profile.modelId;

    const registry = new ToolRegistry()
      .registerAll(createBuiltinTools())
      .registerAll(createMemoryTools(this.memory));
    // DESIGN §15.4：满血模式预算覆盖（仅提示/预算，不改权限门禁）。
    const fullThrottle = this.isFullThrottle(workspace.id, agent.id);
    const budget = fullThrottle ? fullThrottleBudget(profile) : null;
    const toolContext: ToolContext = {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      worktreePath: worktreeOverride ?? workspace.path,
      taskId: task.id,
      runId: run.id,
      agentId: agent.id,
      agentName: agent.name,
      store: this.store,
      signal,
      // DESIGN §15.2：权限是执行层硬门禁。
      permission: agent.permission,
      // t58 IF-05：auto_risk 高风险 → 人类审批 UI（renderer 弹窗，单次生效；Agent 无自行批准路径）。
      // t83 F5：等待审批期间 Run 进入 waiting_human，由内核 lease keeper 续租，避免 120s 超时被回收。
      requestApproval:
        agent.permission === "auto_risk"
          ? async (input) => {
              waitingHuman("risk_approval");
              activity("run.waiting_human", { reason: "risk_approval" });
              try {
                return await this.requestRiskApproval({
                  workspaceId: workspace.id,
                  taskId: task.id,
                  agentName: agent.name,
                  ...input,
                });
              } finally {
                resumeHuman();
                activity("run.resumed", { reason: "risk_approval" });
              }
            }
          : undefined,
    };

    const memoryContext = (() => {
      if (!this.memory.available) return null;
      try {
        return this.memory.buildContext({
          workspaceId: workspace.id,
          agentId: agent.id,
          taskId: task.id,
          maxTokens: 600,
        });
      } catch {
        return null;
      }
    })();
    const basePrompt = buildWorkerSystemPrompt(agent, task, workspace);
    const handoffResult = this.watchdog.getRunHandoff(workspace.id, run.id);
    const handoff =
      handoffResult.ok && handoffResult.value
        ? [
            "",
            "## HANDOFF (watchdog)",
            handoffResult.value.summary,
            `Next step: ${handoffResult.value.nextStep}`,
            handoffResult.value.files.length
              ? `Files: ${handoffResult.value.files.slice(0, 20).join(", ")}`
              : "",
            handoffResult.value.diffStat
              ? `Diff stat:\n${handoffResult.value.diffStat.slice(0, 2_000)}`
              : "",
            "Continue from the next step; verify before editing; do not repeat finished work.",
          ]
            .filter(Boolean)
            .join("\n")
        : "";
    const promptWithHandoff = handoff ? `${basePrompt}\n${handoff}` : basePrompt;
    const promptWithMemory = memoryContext?.text ? `${promptWithHandoff}\n\n${memoryContext.text}` : promptWithHandoff;
    const systemPrompt = fullThrottle ? withFullThrottle(promptWithMemory) : promptWithMemory;
    if (memoryContext) {
      this.store.appendEvent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "memory.context_injected",
        actor: "system",
        payload: {
          workspaceId: workspace.id,
          agentId: agent.id,
          taskId: task.id,
          runId: run.id,
          hitCount: memoryContext.hits.length,
          usedTokens: memoryContext.usedTokens,
          omitted: memoryContext.omitted,
          truncated: memoryContext.truncated,
        },
      });
    }

    const emit = (type: string, payload: unknown) => {
      if (
        type === "run.step" ||
        type === "assistant.message" ||
        type === "tool.call" ||
        type === "tool.result" ||
        type === "usage"
      ) {
        this.store.appendEvent({
          aggregateType: "task",
          aggregateId: task.id,
          type,
          actor: `agent:${agent.name}`,
          payload: limitPayload(payload),
        });
        activity(type, payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
        if (type === "run.step") {
          const step =
            payload && typeof payload === "object" && "step" in payload
              ? Number((payload as { step?: unknown }).step)
              : 0;
          heartbeat({ steps: step });
          checkpoint({ step });
        }
        if (type === "usage" && payload && typeof payload === "object") {
          const usage = payload as { inputTokens?: unknown; outputTokens?: unknown; step?: unknown };
          heartbeat({
            tokenIn: Number(usage.inputTokens ?? 0),
            tokenOut: Number(usage.outputTokens ?? 0),
            steps: Number(usage.step ?? 0),
          });
        }
      }
    };

    const result = await (async () => {
      // 独立心跳：长模型调用期间也保持租约；waiting_human 由内核 watchdog keeper 续租。
      const heartbeatTimer = setInterval(() => heartbeat(), 15_000);
      (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
      try {
        return await runAgentLoop({
          client,
          model,
          maxSteps: budget ? 30 * budget.maxStepsFactor : undefined,
          maxOutputTokens: budget?.maxOutputTokens ?? profile.maxOutputTokens,
          reasoningEffort:
            budget?.reasoningEffort ??
            (profile.thinkingEnabled ? profile.thinkingEffort : undefined),
          thinkingEnabled: profile.thinkingEnabled,
          thinkingStyle: thinkingStyleFor(provider, profile.modelId),
          systemPrompt,
          userMessage: `Start now. Task id: ${task.id}\nTitle: ${task.title}`,
          tools: registry,
          toolContext,
          signal,
          onEvent: emit,
          consumeNudges,
        });
      } finally {
        clearInterval(heartbeatTimer);
      }
    })();

    this.store.saveSummary({
      taskId: task.id,
      runId: run.id,
      goal: task.title,
      changes: [],
      files: [],
      tests: [],
      decisions: [],
      risks: [],
      openQuestions: [],
    });

    return {
      summary: result.text || "任务完成。",
      tokenIn: result.usage.inputTokens,
      tokenOut: result.usage.outputTokens,
      steps: result.steps,
    };
  }

  getTaskTrace(taskId: string): EventRecord[] {
    return this.store.listEventsForTask(taskId, 2000);
  }

  sendMessage(input: SendMessageInput): MailboxMessage {
    return this.store.addMessage(input);
  }

  postBoard(input: PostBoardInput): BoardEntry {
    return this.store.postBoard(input);
  }

  listPolls(workspaceId: string, status?: PollStatus): Poll[] {
    if (!this.store.getWorkspace(workspaceId)) throw new Error(`workspace not found: ${workspaceId}`);
    return this.store.listPolls(workspaceId, status).map((poll) => this.sanitizePoll(poll));
  }

  getPoll(workspaceId: string, pollId: string): Poll {
    this.requirePollWorkspace(workspaceId, pollId);
    return this.sanitizePoll(this.store.getPoll(pollId) as Poll);
  }

  createPoll(input: CreatePollRequest): Poll {
    // 主进程可信身份：渲染层不能指定 createdBy。
    const poll = this.store.createPoll({ ...input, createdBy: "user" });
    return this.getPoll(poll.workspaceId, poll.id);
  }

  castPoll(workspaceId: string, input: CastPollRequest): Poll {
    const poll = this.getPoll(workspaceId, input.pollId);
    const voterId = input.voterType === "human" ? "user" : input.voterId?.trim();
    if (!voterId) throw new PollError("POLL_INVALID_INPUT", "agent voterId required");
    const updated = this.store.castPoll({
      pollId: poll.id,
      voterId,
      voterType: input.voterType,
      selections: input.selections,
    });
    return this.sanitizePoll(updated);
  }

  closePoll(workspaceId: string, input: ClosePollRequest): Poll {
    const poll = this.getPoll(workspaceId, input.pollId);
    if (poll.createdBy !== "user") {
      throw new PollError("POLL_FORBIDDEN", "only local creator can close poll");
    }
    // 主进程可信身份：渲染层不能指定 actor；decision 走 MemoryStore 写完整列/domain/FTS。
    const closed = this.store.closePoll(
      { pollId: poll.id, actor: "user", reason: input.reason },
      {
        boardWriter: (entry) => {
          const result = this.memory.postBoard({
            workspaceId: entry.workspaceId,
            board: entry.board,
            kind: entry.kind,
            content: entry.content,
            refs: entry.refs,
            confidence: entry.confidence,
          });
          if (!result.ok) {
            throw new Error(`${result.error.code}: ${result.error.message}`);
          }
          return result.value;
        },
      },
    );
    return this.sanitizePoll(closed);
  }

  private requirePollWorkspace(workspaceId: string, pollId: string): Poll {
    const poll = this.store.getPoll(pollId);
    if (!poll || poll.workspaceId !== workspaceId) {
      throw new PollError("POLL_NOT_FOUND", "poll not found in workspace");
    }
    return poll;
  }

  private sanitizePoll(poll: Poll, viewerId = "user"): Poll {
    if (!poll.anonymous) return poll;
    return {
      ...poll,
      ballots: poll.ballots.filter((ballot) => ballot.voterId === viewerId),
    };
  }

  getSettings(): LlmSettingsInfo {
    return this.store.getLlmSettings();
  }

  saveSettings(settings: LlmSettings): LlmSettingsInfo {
    this.store.saveLlmSettings(settings);
    return this.store.getLlmSettings();
  }

  async listModels(settings: LlmSettings, providerId?: string): Promise<ModelListResult> {
    const provider = resolveProvider(settings, providerId);
    const { source } = resolveApiKey(provider);
    try {
      const models = await fetchModelListForProvider(provider);
      return { models, source, providerId: provider.id };
    } catch (error) {
      return {
        models: [],
        source,
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async summarizeWorkspace(workspaceId: string): Promise<string> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const entries = await fs.readdir(workspace.path, { withFileTypes: true }).catch(() => []);
    const top = entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .slice(0, 40)
      .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);

    const parts = [`Workspace: ${workspace.name}`, `Path: ${workspace.path}`, `Top level:\n${top.join("\n")}`];
    for (const name of ["README.md", "readme.md", "package.json", "pyproject.toml", "go.mod"]) {
      try {
        const raw = await fs.readFile(path.join(workspace.path, name), "utf8");
        parts.push(`${name} (first 1200 chars):\n${raw.slice(0, 1200)}`);
      } catch {
        // ignore missing files
      }
    }
    const overview = parts.join("\n\n").slice(0, 6000);
    this.store.updateWorkspaceOverview(workspaceId, overview);
    this.store.appendEvent({
      aggregateType: "workspace",
      aggregateId: workspaceId,
      type: "workspace.overview",
      actor: "Router",
      payload: { length: overview.length },
    });
    return overview;
  }
}
