import type {
  LlmSettings,
  ModelProfile,
  PlanResult,
  ProviderProfile,
} from "../shared/types.js";
import { resolveProvider } from "../shared/models.js";
import { resolveApiKeyEnv, resolveBaseUrlEnv } from "./env.js";

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
  /** DeepSeek requires this to be replayed for tool-call turns when thinking is on. */
  reasoningContent?: string;
}

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingStyle?: "deepseek" | "openai";
  signal?: AbortSignal;
}

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: string };

export interface LlmCompletion {
  text: string;
  reasoning: string;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

/**
 * t172：OpenAI-compatible providers only accept `^[a-zA-Z0-9_-]+$` for
 * function names, while internal tools use dots (`fs.read`). Encode dots as
 * `__` on the wire; decode tool-call names before execution.
 */
export function encodeToolName(name: string): string {
  return name.replaceAll(".", "__").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function decodeToolName(name: string): string {
  return name.replaceAll("__", ".");
}

export async function collectStream(
  stream: AsyncIterable<LlmStreamEvent>,
  handlers: { onText?: (text: string) => void; onReasoning?: (text: string) => void } = {},
): Promise<LlmCompletion> {
  let text = "";
  let reasoning = "";
  const calls = new Map<number, LlmToolCall>();
  let usage = { inputTokens: 0, outputTokens: 0 };

  for await (const event of stream) {
    if (event.type === "text") {
      text += event.text;
      handlers.onText?.(event.text);
    } else if (event.type === "reasoning") {
      reasoning += event.text;
      handlers.onReasoning?.(event.text);
    } else if (event.type === "tool_call") {
      const current =
        calls.get(event.index) ??
        ({ id: event.id ?? `call_${event.index}`, name: "", arguments: "" } as LlmToolCall);
      if (event.id) current.id = event.id;
      if (event.name) current.name = event.name;
      if (event.argumentsDelta) current.arguments += event.argumentsDelta;
      calls.set(event.index, current);
    } else if (event.type === "usage") {
      usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    }
  }

  return {
    text,
    reasoning,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ ...call, name: decodeToolName(call.name) })),
    usage,
  };
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content ?? "" };
  }
  if (message.role === "assistant" && (message.toolCalls?.length || message.reasoningContent)) {
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: encodeToolName(call.name), arguments: call.arguments },
            })),
          }
        : {}),
      ...(message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

export class OpenAiClient implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const baseUrl = this.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toWireMessage),
        tools: request.tools?.map((tool) => ({
          type: "function",
          function: {
            name: encodeToolName(tool.name),
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens,
        reasoning_effort: request.reasoningEffort,
        ...(request.thinkingStyle === "deepseek"
          ? { thinking: { type: request.thinkingEnabled ? "enabled" : "disabled" } }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM ${response.status}: ${body.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("LLM response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          for (const line of chunk.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (parsed.usage) {
              yield {
                type: "usage",
                inputTokens: Number(parsed.usage.prompt_tokens ?? 0),
                outputTokens: Number(parsed.usage.completion_tokens ?? 0),
              };
            }
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              yield { type: "text", text: delta.content };
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
              yield { type: "reasoning", text: delta.reasoning_content };
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const call of delta.tool_calls) {
                yield {
                  type: "tool_call",
                  index: Number(call.index ?? 0),
                  id: call.id,
                  name: call.function?.name,
                  argumentsDelta: call.function?.arguments,
                };
              }
            }
            if (choice.finish_reason) {
              yield { type: "finish", reason: String(choice.finish_reason) };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  complete(request: LlmRequest): Promise<LlmCompletion> {
    return collectStream(this.stream(request));
  }
}

function lastUser(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i].content ?? "";
  }
  return "";
}

function planFor(goal: string): PlanResult {
  return {
    tasks: [
      {
        title: "勘察工作区",
        description:
          "阅读 README、清单文件与目录结构，确认技术栈、启动命令与测试方式，给出简短结论。",
        acceptance: ["说明技术栈", "给出可运行的测试/构建命令"],
        dependsOn: [],
      },
      {
        title: `实现：${goal.slice(0, 60)}`,
        description: `围绕目标「${goal}」完成实现；先读相关文件，再做最小改动，最后运行可用的检查命令。`,
        acceptance: ["完成代码或文档改动", "运行可用的测试/构建命令并记录结果"],
        dependsOn: [0],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// t64：Mock 模式的交互协议夹具（离线演示/手工验收；不影响真实模型路径）
// ---------------------------------------------------------------------------

function fence(language: "deer-canvas" | "deer-question", payload: unknown): string {
  return ["```" + language, JSON.stringify(payload, null, 2), "```"].join("\n");
}

const MOCK_FLOWCHART = {
  protocol: "deer-canvas",
  version: 1,
  kind: "flowchart",
  title: "实现流程（Mock）",
  summary: "从协议到上线的 5 个阶段",
  direction: "TB",
  groups: [
    { id: "p0", label: "P0 对话内", order: 0, tone: "accent" },
    { id: "p1", label: "P1 面板与导出", order: 1, tone: "purple" },
  ],
  nodes: [
    { id: "schema", label: "协议与校验", kind: "step", status: "done", groupId: "p0" },
    { id: "parse", label: "消息解析", kind: "step", status: "active", groupId: "p0" },
    {
      id: "render",
      label: "画布渲染",
      kind: "decision",
      status: "active",
      groupId: "p0",
      note: "合法→渲染；非法→回退卡片",
    },
    { id: "ask", label: "提问表单", kind: "step", status: "planned", groupId: "p0" },
    { id: "dock", label: "Dock 面板", kind: "step", status: "planned", groupId: "p1" },
    { id: "export", label: "Mermaid / SVG 导出", kind: "note", status: "planned", groupId: "p1" },
  ],
  edges: [
    { from: "schema", to: "parse", kind: "flow" },
    { from: "parse", to: "render", kind: "flow" },
    { from: "render", to: "ask", kind: "flow" },
    { from: "render", to: "dock", kind: "relates" },
    { from: "dock", to: "export", kind: "flow" },
  ],
};

const MOCK_MINDMAP = {
  protocol: "deer-canvas",
  version: 1,
  kind: "mindmap",
  title: "交互画布范围（Mock）",
  nodes: [
    { id: "root", label: "交互画布", kind: "root", status: "active" },
    { id: "types", label: "四类图", kind: "topic" },
    { id: "flow", label: "流程图", kind: "topic" },
    { id: "mind", label: "思维导图", kind: "topic" },
    { id: "road", label: "路线图", kind: "topic" },
    { id: "dep", label: "依赖图", kind: "topic" },
    { id: "safety", label: "安全", kind: "topic", status: "review" },
    { id: "white", label: "白名单", kind: "note", note: "节点/边/字段枚举 + 纯文本" },
    { id: "nohtml", label: "不执行 HTML/JS", kind: "note" },
  ],
  edges: [
    { from: "root", to: "types", kind: "contains" },
    { from: "types", to: "flow", kind: "contains" },
    { from: "types", to: "mind", kind: "contains" },
    { from: "types", to: "road", kind: "contains" },
    { from: "types", to: "dep", kind: "contains" },
    { from: "root", to: "safety", kind: "contains" },
    { from: "safety", to: "white", kind: "contains" },
    { from: "safety", to: "nohtml", kind: "contains" },
  ],
};

const MOCK_ROADMAP = {
  protocol: "deer-canvas",
  version: 1,
  kind: "roadmap",
  title: "交互画布路线图（Mock）",
  direction: "LR",
  groups: [
    { id: "p0", label: "P0 · 对话内", order: 0, tone: "accent", status: "active" },
    { id: "p1", label: "P1 · 面板与导出", order: 1, tone: "purple", status: "planned" },
    { id: "p2", label: "P2 · 编辑与协作", order: 2, tone: "neutral", status: "planned" },
  ],
  nodes: [
    { id: "p0-schema", label: "协议/校验", kind: "step", status: "done", groupId: "p0", order: 0 },
    { id: "p0-ui", label: "画布 + 表单", kind: "step", status: "active", groupId: "p0", order: 1 },
    {
      id: "p0-ga",
      label: "安全与可达性测试",
      kind: "milestone",
      status: "planned",
      groupId: "p0",
      order: 2,
    },
    { id: "p1-panel", label: "Dock 画布面板", kind: "step", status: "planned", groupId: "p1", order: 0 },
    { id: "p1-png", label: "PNG/导出增强", kind: "step", status: "planned", groupId: "p1", order: 1 },
    { id: "p2-edit", label: "节点拖拽/批注", kind: "step", status: "planned", groupId: "p2", order: 0 },
  ],
  edges: [
    { from: "p0-schema", to: "p0-ui", kind: "flow" },
    { from: "p0-ui", to: "p0-ga", kind: "flow" },
    { from: "p0-ga", to: "p1-panel", kind: "flow" },
    { from: "p1-panel", to: "p1-png", kind: "flow" },
    { from: "p1-png", to: "p2-edit", kind: "flow" },
  ],
};

const MOCK_DEPENDENCY = {
  protocol: "deer-canvas",
  version: 1,
  kind: "dependency",
  title: "交互画布任务依赖（Mock）",
  nodes: [
    { id: "t63", label: "设计协议与交互", kind: "task", status: "done" },
    { id: "t64", label: "实现画布与提问", kind: "task", status: "active" },
    { id: "t65", label: "评审：安全与可达性", kind: "task", status: "planned" },
    { id: "t66", label: "集成验收", kind: "task", status: "planned" },
    { id: "ship", label: "可交付", kind: "milestone", status: "planned" },
  ],
  edges: [
    { from: "t63", to: "t64", kind: "depends" },
    { from: "t64", to: "t65", kind: "depends" },
    { from: "t65", to: "t66", kind: "depends" },
    { from: "t66", to: "ship", kind: "depends" },
  ],
};

const MOCK_QUESTION = {
  protocol: "deer-question",
  version: 1,
  title: "确认 P0 实现范围（Mock）",
  description: "回答后我会按你的选择继续推进；可稍后再答。",
  timeoutSec: 900,
  fields: [
    {
      id: "platform",
      kind: "single",
      label: "优先平台",
      required: true,
      options: [
        { id: "desktop", label: "桌面 Electron（默认）" },
        { id: "web", label: "浏览器 Web" },
      ],
    },
    {
      id: "features",
      kind: "multi",
      label: "P0 必须包含",
      description: "可多选；至少 1 项",
      required: true,
      min: 1,
      max: 4,
      options: [
        { id: "flow", label: "流程图" },
        { id: "mind", label: "思维导图" },
        { id: "road", label: "路线图" },
        { id: "ask", label: "提问表单" },
      ],
    },
    {
      id: "notes",
      kind: "text",
      label: "补充说明",
      required: false,
      placeholder: "可留空",
      maxLength: 500,
      multiline: true,
    },
    {
      id: "confirm",
      kind: "confirm",
      label: "按以上范围开始实现",
      required: true,
      danger: false,
    },
  ],
};

function mockCanvasReply(user: string): string | null {
  if (!/画布|流程图|流程|思维导图|路线图|依赖图/.test(user)) return null;
  if (user.includes("思维导图")) {
    return `下面是一张思维导图：\n\n${fence("deer-canvas", MOCK_MINDMAP)}`;
  }
  if (user.includes("路线图")) {
    return `下面是一张路线图：\n\n${fence("deer-canvas", MOCK_ROADMAP)}`;
  }
  if (user.includes("依赖图") || user.includes("依赖")) {
    return `下面是任务依赖图：\n\n${fence("deer-canvas", MOCK_DEPENDENCY)}`;
  }
  return `下面是实现流程：\n\n${fence("deer-canvas", MOCK_FLOWCHART)}`;
}

function mockQuestionReply(user: string): string | null {
  if (!/提问|表单|确认|问我|收集/.test(user)) return null;
  return `有 4 个点需要你确认：\n\n${fence("deer-question", MOCK_QUESTION)}`;
}

/** Deterministic offline model used for demos and tests. */
export class MockClient implements LlmClient {
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const user = lastUser(request.messages);
    const toolResults = request.messages.filter((message) => message.role === "tool").length;

    if (system.includes("ROUTER_PLANNER")) {
      const match = user.match(/GOAL:\s*([\s\S]*)$/);
      const goal = (match?.[1] ?? user).trim() || "完成一个任务";
      yield { type: "text", text: JSON.stringify(planFor(goal), null, 2) };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (system.includes("You are Router")) {
      // t64：离线演示夹具——用户提到画布/提问关键词时返回合法 deer-* 块。
      const canvasReply = mockCanvasReply(user);
      if (canvasReply) {
        yield { type: "text", text: canvasReply };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const questionReply = mockQuestionReply(user);
      if (questionReply) {
        yield { type: "text", text: questionReply };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const text = [
        "我是这个工作区的 Router。",
        "",
        "你可以直接跟我对话，也可以让我把目标拆成任务：",
        "1. 告诉我你想完成什么；",
        "2. 我会先确认工作区上下文；",
        "3. 然后在「Router」页生成任务 DAG。",
        "",
        user.trim() ? `你刚才说：「${user.trim()}」` : "给我一个目标即可。",
      ].join("\n");
      yield { type: "text", text };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (toolResults === 0) {
      yield {
        type: "tool_call",
        index: 0,
        id: "call_mock_list",
        name: "fs.list",
        argumentsDelta: JSON.stringify({ path: ".", depth: 1 }),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }

    if (toolResults === 1) {
      yield {
        type: "tool_call",
        index: 0,
        id: "call_mock_complete",
        name: "task.complete",
        argumentsDelta: JSON.stringify({
          summary: `已完成任务：${user.split("\n")[0]?.slice(0, 120) || "当前任务"}。`,
          changes: ["完成一次工作区检查"],
          files: [],
          tests: [],
          decisions: ["Mock 模式：确定性的工具调用演示完整闭环"],
          risks: ["Mock 模式不会真正修改代码"],
          openQuestions: [],
        }),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }

    yield { type: "text", text: "任务已完成，结果已写入任务摘要。" };
    yield { type: "finish", reason: "stop" };
  }

  complete(request: LlmRequest): Promise<LlmCompletion> {
    return collectStream(this.stream(request));
  }
}

export function resolveApiKey(settings: Pick<LlmSettings, "apiKey" | "apiKeyEnv">): {
  key: string;
  source: "env" | "local" | "none";
} {
  const env = resolveApiKeyEnv(settings);
  if (env) return { key: env.value, source: "env" };
  const local = settings.apiKey?.trim();
  if (local) return { key: local, source: "local" };
  return { key: "", source: "none" };
}

export function resolveBaseUrl(
  settings: Pick<LlmSettings, "baseUrl" | "baseUrlEnv">,
): string {
  const env = resolveBaseUrlEnv(settings);
  return (env?.value ?? settings.baseUrl).replace(/\/+$/, "");
}

export function createLlmClient(settings: LlmSettings): LlmClient {
  if (settings.mock) return new MockClient();
  const { key } = resolveApiKey(settings);
  if (!key) {
    throw new Error(
      "未配置 API Key：请在设置中填写，或配置环境变量后重启应用；也可以勾选 Mock 模式离线演示",
    );
  }
  return new OpenAiClient(resolveBaseUrl(settings), key);
}

/** Build a client for one configured model, using its provider's credentials. */
export function createLlmClientForModel(
  settings: LlmSettings,
  profile: ModelProfile,
): LlmClient {
  if (settings.mock) return new MockClient();
  const provider = resolveProvider(settings, profile.providerId);
  const { key } = resolveApiKey(provider);
  if (!key) {
    throw new Error(
      `供应商「${provider.name}」未配置 API Key：请在设置中填写，或配置环境变量后重启应用`,
    );
  }
  return new OpenAiClient(resolveBaseUrl(provider), key);
}

export function providerClientConfig(provider: ProviderProfile): {
  baseUrl: string;
  apiKey: string;
} {
  return {
    baseUrl: resolveBaseUrl(provider),
    apiKey: resolveApiKey(provider).key,
  };
}

function extractModels(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids = raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        return (item as { id: string }).id;
      }
      return "";
    })
    .filter((id) => id.length > 0);
  return [...new Set(ids)].sort();
}

/**
 * Ask an OpenAI-compatible endpoint for its model list.
 * Tries `${baseUrl}/models`, then `${baseUrl}/v1/models` when the base URL
 * does not already carry a version segment.
 */
export async function fetchModelList(
  settings: Pick<LlmSettings, "baseUrl" | "baseUrlEnv" | "apiKey" | "apiKeyEnv">,
): Promise<string[]> {
  const { key, source } = resolveApiKey(settings);
  if (!key) {
    throw new Error(
      source === "none"
        ? "未配置 API Key：请填写 Key，或在系统环境变量中设置对应变量后重启应用"
        : "API Key 为空",
    );
  }

  const base = resolveBaseUrl(settings);
  if (!base) throw new Error("Base URL 为空");
  const candidates = [`${base}/models`];
  if (!/\/v\d+$/i.test(base)) candidates.push(`${base}/v1/models`);

  let lastError: Error | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index];
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `GET ${url} → HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        );
        if (response.status === 404 && index < candidates.length - 1) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const data = (await response.json()) as unknown;
      const models = extractModels(data);
      if (models.length === 0) throw new Error(`GET ${url} 没有返回可用模型`);
      return models;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (index === candidates.length - 1) throw lastError;
    }
  }
  throw lastError ?? new Error("无法获取模型列表");
}

export function fetchModelListForProvider(provider: ProviderProfile): Promise<string[]> {
  return fetchModelList(provider);
}
