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

export async function collectStream(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmCompletion> {
  let text = "";
  let reasoning = "";
  const calls = new Map<number, LlmToolCall>();
  let usage = { inputTokens: 0, outputTokens: 0 };

  for await (const event of stream) {
    if (event.type === "text") {
      text += event.text;
    } else if (event.type === "reasoning") {
      reasoning += event.text;
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
    toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
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
              function: { name: call.name, arguments: call.arguments },
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
            name: tool.name,
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
