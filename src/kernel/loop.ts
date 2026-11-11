import {
  collectStream,
  type LlmClient,
  type LlmMessage,
  type LlmToolCall,
} from "./model.js";
import type { ToolContext, ToolPolicy, ToolRegistry } from "./tools.js";

export interface AgentLoopOptions {
  client: LlmClient;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: ToolRegistry;
  toolContext: ToolContext;
  /** t171：按上下文策略过滤工具，而不是按角色。 */
  toolPolicy?: ToolPolicy;
  /** t171：chat 传入完整历史；不传时使用 systemPrompt + userMessage。 */
  initialMessages?: LlmMessage[];
  maxSteps?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingStyle?: "deepseek" | "openai";
  signal?: AbortSignal;
  onEvent?: (type: string, payload: unknown) => void;
  /** t171：chat 流式文本/推理增量。 */
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  /** t144：看门狗/人工 nudge；每步开始时消费一次。 */
  consumeNudges?: () => string[];
}

export interface AgentLoopResult {
  text: string;
  reasoning: string;
  completed: boolean;
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    userMessage,
    tools,
    toolContext,
    toolPolicy,
    initialMessages,
    maxSteps = 30,
    maxOutputTokens,
    reasoningEffort,
    thinkingEnabled,
    thinkingStyle,
    signal,
    onEvent,
    onTextDelta,
    onReasoningDelta,
    consumeNudges,
  } = options;

  const messages: LlmMessage[] = initialMessages
    ? initialMessages.map((message) => ({ ...message }))
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let completed = false;
  let lastText = "";
  let lastReasoning = "";

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal?.aborted) throw new Error("aborted");
    const nudges = consumeNudges?.() ?? [];
    for (const text of nudges) {
      messages.push({
        role: "user",
        content: `[watchdog] ${text}`,
      });
    }
    onEvent?.("run.step", { step });

    const completion = await collectStream(
      client.stream({
        model,
        messages,
        tools: tools.list(toolPolicy),
        maxOutputTokens,
        reasoningEffort,
        thinkingEnabled,
        thinkingStyle,
        signal,
      }),
      { onText: onTextDelta, onReasoning: onReasoningDelta },
    );

    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    // t144：每步上报一次累计 usage，供看门狗/成本 provisional/预算采样。
    onEvent?.("usage", { ...usage, step });

    if (completion.reasoning.trim()) {
      lastReasoning = completion.reasoning;
      // t176：每步思考单独成段；工具调用前后的思考可按 step 区分。
      onEvent?.("assistant.reasoning", { step, text: completion.reasoning });
    }
    if (completion.text.trim()) {
      lastText = completion.text;
      onEvent?.("assistant.message", { text: completion.text, step });
    }

    if (completion.toolCalls.length === 0) {
      break;
    }

    const assistantMessage: LlmMessage = {
      role: "assistant",
      content: completion.text || null,
      toolCalls: completion.toolCalls,
      reasoningContent: completion.reasoning || undefined,
    };
    messages.push(assistantMessage);

    for (const call of completion.toolCalls) {
      if (signal?.aborted) throw new Error("aborted");
      onEvent?.("tool.call", {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        step,
      });

      let args: unknown;
      try {
        args = parseArgs(call.arguments);
      } catch (error) {
        onEvent?.("tool.result", {
          id: call.id,
          name: call.name,
          ok: false,
          error: `invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`,
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, error: "invalid tool arguments" }),
        });
        continue;
      }

      const result = await tools.execute(call.name, args, toolContext, toolPolicy);
      onEvent?.("tool.result", {
        id: call.id,
        name: call.name,
        ok: result.ok,
        value: result.value,
        error: result.error,
        step,
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(result),
      });

      if (call.name === "task.complete" && result.ok) {
        completed = true;
      }
    }

    if (completed) break;
  }

  onEvent?.("usage", usage);
  return { text: lastText, reasoning: lastReasoning, completed, steps: messages.length, usage };
}
