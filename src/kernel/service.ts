import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Agent,
  BoardEntry,
  ChatEvent,
  ChatMessage,
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
  return [
    "You are Router, the coordinator of an AI team called DeerSuperGroup.",
    `Workspace: ${workspace.name} at ${workspace.path}`,
    workspace.overview ? `Workspace overview:\n${workspace.overview}` : "",
    `Team:\n${agents
      .map((agent) => `- ${agent.name} (${agent.role})${agent.isRouter ? " [Router]" : ""}`)
      .join("\n")}`,
    `Tasks:\n${tasks.map((task) => `- ${task.title} [${task.status}]`).join("\n") || "(none)"}`,
    "You are chatting with the user. Be concise, ask for missing information, and suggest next steps.",
    "If the user wants a task plan, tell them to use the Plan button or describe the goal in detail.",
  ]
    .filter(Boolean)
    .join("\n");
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
    this.kernel = new ExecutionKernel({
      store: this.store,
      dataDir,
      executor: (ctx) => this.executeRun(ctx),
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
    return this.store.createTask({
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      description: input.description,
      acceptance: input.acceptance.filter(Boolean),
    });
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
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: fullThrottle ? withFullThrottle(routerPrompt) : routerPrompt,
      },
      ...history.map(
        (item): LlmMessage => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.content,
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

  getContext(workspaceId: string, agentId?: string, taskId?: string): ContextSnapshot {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const agents = this.store.listAgents(workspaceId);
    const tasks = this.store.listTasks(workspaceId);
    const router = this.ensureRouter(workspaceId);
    const task = taskId ? this.store.getTask(taskId) : null;
    if (taskId && !task) throw new Error(`task not found: ${taskId}`);
    const agent = agentId
      ? this.store.getAgent(agentId)
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
      push("workspace", "工作区概述", "workspace", workspace.overview ?? "");
      push(
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

  /** 内核执行器：一次 Run 的 LLM/工具执行（不含生命周期/状态写入，由 kernel 负责）。 */
  private async executeRun(ctx: RunExecutionContext): Promise<RunExecutionResult> {
    const { run, task, agent, signal, heartbeat, checkpoint, waitingHuman, resumeHuman } = ctx;
    const workspace = this.store.getWorkspace(task.workspaceId);
    if (!workspace) throw new Error("workspace not found");

    const settings = this.store.getLlmSettings();
    const profile = resolveModelProfile(settings, agent.model);
    const provider = resolveProvider(settings, profile.providerId);
    const client = createLlmClientForModel(settings, profile);
    const model = profile.modelId;

    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    // DESIGN §15.4：满血模式预算覆盖（仅提示/预算，不改权限门禁）。
    const fullThrottle = this.isFullThrottle(workspace.id, agent.id);
    const budget = fullThrottle ? fullThrottleBudget(profile) : null;
    const toolContext: ToolContext = {
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      worktreePath: workspace.path,
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
              try {
                return await this.requestRiskApproval({
                  workspaceId: workspace.id,
                  taskId: task.id,
                  agentName: agent.name,
                  ...input,
                });
              } finally {
                resumeHuman();
              }
            }
          : undefined,
    };

    const basePrompt = buildWorkerSystemPrompt(agent, task, workspace);
    const systemPrompt = fullThrottle ? withFullThrottle(basePrompt) : basePrompt;

    const emit = (type: string, payload: unknown) => {
      if (
        type === "run.step" ||
        type === "assistant.message" ||
        type === "tool.call" ||
        type === "tool.result"
      ) {
        this.store.appendEvent({
          aggregateType: "task",
          aggregateId: task.id,
          type,
          actor: `agent:${agent.name}`,
          payload: limitPayload(payload),
        });
        if (type === "run.step") {
          const step =
            payload && typeof payload === "object" && "step" in payload
              ? Number((payload as { step?: unknown }).step)
              : 0;
          heartbeat({ steps: step });
          checkpoint({ step });
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
