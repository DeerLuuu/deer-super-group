import type {
  ChatAssistantTurn,
  ChatMessage,
  ChatTurn,
  ChatTurnHistoryPage,
  ChatTurnReasoning,
  ChatTurnStatus,
  ChatTurnStep,
  ChatTurnTool,
  EventRecord,
} from "../shared/types.js";

export const CHAT_TURNS_DEFAULT_LIMIT = 20;
export const CHAT_TURNS_MAX_LIMIT = 40;
export const CHAT_TURNS_MESSAGE_LIMIT = 200;
export const CHAT_TURNS_EVENT_LIMIT = 2000;
export const CHAT_TURN_REASONING_MAX = 8_000;
export const CHAT_TURN_TOOL_MAX = 4_000;
export const CHAT_TURN_CONTENT_MAX = 64 * 1024;
export const CHAT_TURNS_RESPONSE_MAX = 512 * 1024;
export const CHAT_TURN_LATE_GRACE_MS = 5_000;

export interface BuildChatTurnsOptions {
  workspaceId: string;
  agentId: string;
  limit?: number;
  includeTools?: boolean;
  includeReasoning?: boolean;
  /** messages 读取窗口已满，可能存在更早轮次。 */
  hasEarlierMessages?: boolean;
}

interface AssistantDraft {
  message: ChatMessage;
  events: EventRecord[];
}

interface TurnDraft {
  turnId: string;
  user: ChatMessage | null;
  assistants: AssistantDraft[];
}

function messageTime(message: ChatMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function eventTime(event: EventRecord): number {
  const value = Date.parse(event.occurredAt ?? event.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
  const timeDiff = messageTime(left) - messageTime(right);
  return timeDiff !== 0 ? timeDiff : left.id.localeCompare(right.id);
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

function stepOf(payload: Record<string, unknown>): { step: number; fallback: boolean } {
  const raw = payload.step;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return { step: Math.floor(raw), fallback: false };
  }
  return { step: 0, fallback: true };
}

function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : CHAT_TURNS_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CHAT_TURNS_MAX_LIMIT, value));
}

function capText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

function capValue(value: unknown, max: number): { value: unknown; truncated: boolean } {
  if (value === undefined || value === null) return { value, truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= max) return { value, truncated: false };
  return { value: `${serialized.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

function encodeCursor(turn: ChatTurn): string | null {
  if (!turn.userMessage) return null;
  return Buffer.from(`${turn.userMessage.createdAt}|${turn.userMessage.id}`, "utf8").toString(
    "base64url",
  );
}

function assistantDraftEvents(draft: AssistantDraft): EventRecord[] {
  return [...draft.events].sort((left, right) => {
    const timeDiff = eventTime(left) - eventTime(right);
    return timeDiff !== 0 ? timeDiff : left.seq - right.seq;
  });
}

function buildAssistant(
  draft: AssistantDraft,
  turnId: string,
  includeTools: boolean,
  includeReasoning: boolean,
): ChatAssistantTurn {
  const message = draft.message;
  const events = assistantDraftEvents(draft);
  const reasoning: ChatTurnReasoning[] = [];
  const tools: ChatTurnTool[] = [];
  const calls = new Map<string, ChatTurnTool>();
  const results = new Map<string, { event: EventRecord; payload: Record<string, unknown> }>();
  const orphanResults: Array<{ event: EventRecord; payload: Record<string, unknown> }> = [];
  let stepFallback = false;
  let hasReasoningEvent = false;

  for (const event of events) {
    const payload = payloadOf(event);
    if (event.type === "chat.reasoning") {
      hasReasoningEvent = true;
      const step = stepOf(payload);
      stepFallback ||= step.fallback;
      const cap = capText(String(payload.text ?? ""), CHAT_TURN_REASONING_MAX);
      reasoning.push({
        id: `${event.id}:reasoning`,
        step: step.step,
        text: cap.text,
        seq: event.seq,
        source: "event",
        ...(cap.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    if (event.type === "chat.tool_call") {
      const step = stepOf(payload);
      stepFallback ||= step.fallback;
      const rawCallId = String(payload.callId ?? "").trim();
      const callId = rawCallId || `synthetic:${event.seq}`;
      if (calls.has(callId)) continue;
      const args = capText(String(payload.arguments ?? ""), CHAT_TURN_TOOL_MAX);
      const tool: ChatTurnTool = {
        callId,
        name: String(payload.name ?? "tool"),
        arguments: args.text,
        status: "running",
        step: step.step,
        callSeq: event.seq,
        ...(args.truncated ? { truncated: { arguments: true } } : {}),
      };
      calls.set(callId, tool);
      tools.push(tool);
      continue;
    }
    if (event.type === "chat.tool_result") {
      const rawCallId = String(payload.callId ?? "").trim();
      if (rawCallId) results.set(rawCallId, { event, payload });
      else orphanResults.push({ event, payload });
    }
  }

  for (const [callId, tool] of calls) {
    const result = results.get(callId);
    if (!result) continue;
    const { event, payload } = result;
    const capped = capValue(payload.value, CHAT_TURN_TOOL_MAX);
    tool.status = payload.ok ? "ok" : "error";
    tool.value = capped.value;
    tool.error = payload.ok ? undefined : String(payload.error ?? "工具执行失败");
    tool.resultSeq = event.seq;
    if (capped.truncated) {
      tool.truncated = { ...(tool.truncated ?? {}), value: true };
    }
    results.delete(callId);
  }

  for (const { event, payload } of orphanResults) {
    const step = stepOf(payload);
    stepFallback ||= step.fallback;
    const capped = capValue(payload.value, CHAT_TURN_TOOL_MAX);
    tools.push({
      callId: `synthetic:${event.seq}`,
      name: String(payload.name ?? "tool"),
      arguments: "",
      status: payload.ok ? "ok" : "error",
      value: capped.value,
      error: payload.ok ? undefined : String(payload.error ?? "工具执行失败"),
      step: step.step,
      callSeq: event.seq,
      resultSeq: event.seq,
      synthetic: true,
      ...(capped.truncated ? { truncated: { value: true } } : {}),
    });
  }
  // A result for a non-synthetic call whose call was outside the event window.
  for (const { event, payload } of results.values()) {
    const step = stepOf(payload);
    stepFallback ||= step.fallback;
    const capped = capValue(payload.value, CHAT_TURN_TOOL_MAX);
    tools.push({
      callId: String(payload.callId ?? `synthetic:${event.seq}`),
      name: String(payload.name ?? "tool"),
      arguments: "",
      status: payload.ok ? "ok" : "error",
      value: capped.value,
      error: payload.ok ? undefined : String(payload.error ?? "工具执行失败"),
      step: step.step,
      callSeq: event.seq,
      resultSeq: event.seq,
      synthetic: true,
      ...(capped.truncated ? { truncated: { value: true } } : {}),
    });
  }

  let reasoningFromMessage = false;
  if (!hasReasoningEvent && message.reasoning.trim()) {
    reasoningFromMessage = true;
    stepFallback = true;
    const cap = capText(message.reasoning, CHAT_TURN_REASONING_MAX);
    reasoning.push({
      id: `${message.id}:reasoning`,
      step: 0,
      text: cap.text,
      source: "message",
      ...(cap.truncated ? { truncated: true } : {}),
    });
  }

  const turnComplete = message.content.trim().length > 0;
  for (const tool of tools) {
    if (tool.status === "running" && turnComplete) tool.status = "unknown";
  }

  const stepMap = new Map<number, ChatTurnStep>();
  const getStep = (step: number): ChatTurnStep => {
    const existing = stepMap.get(step);
    if (existing) return existing;
    const created: ChatTurnStep = { step, reasoning: [], tools: [] };
    stepMap.set(step, created);
    return created;
  };
  if (includeReasoning) {
    for (const segment of reasoning) {
      if (segment.text.trim()) getStep(segment.step).reasoning.push(segment);
    }
  }
  if (includeTools) {
    for (const tool of tools) getStep(tool.step).tools.push(tool);
  }
  const steps = [...stepMap.values()]
    .filter((step) => step.reasoning.length > 0 || step.tools.length > 0)
    .sort((left, right) => left.step - right.step);
  for (const step of steps) {
    step.reasoning.sort((left, right) => {
      const timeDiff = (left.seq ?? 0) - (right.seq ?? 0);
      return timeDiff !== 0 ? timeDiff : left.id.localeCompare(right.id);
    });
    step.tools.sort((left, right) => (left.callSeq ?? 0) - (right.callSeq ?? 0));
  }

  const content = capText(message.content, CHAT_TURN_CONTENT_MAX);
  return {
    id: `${turnId}:assistant:${draft.message.id}`,
    messageId: message.id,
    content: content.text,
    reasoning: capText(message.reasoning, CHAT_TURN_REASONING_MAX).text,
    steps,
    status: content.text.trim() ? "complete" : "error",
    legacy: {
      reasoningFromMessage,
      toolsMissing: tools.length === 0,
      stepFallback,
    },
    truncated: content.truncated,
  };
}

/**
 * t168：只读投影。消息是骨架，事件按时间窗口 + assistant 边界归属；
 * 事件没有显式 turnId 时不伪造，orphan 事件不进入气泡。
 */
export function buildChatTurns(
  messages: ChatMessage[],
  events: EventRecord[],
  options: BuildChatTurnsOptions,
): ChatTurnHistoryPage {
  const limit = clampLimit(options.limit);
  const includeTools = options.includeTools !== false;
  const includeReasoning = options.includeReasoning !== false;
  const sortedMessages = [...messages].sort(compareMessages);

  const drafts: TurnDraft[] = [];
  for (const message of sortedMessages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      drafts.push({
        turnId: `turn:${message.id}`,
        user: message,
        assistants: [],
      });
      continue;
    }
    const last = drafts[drafts.length - 1];
    if (last && last.user) {
      last.assistants.push({ message, events: [] });
    } else {
      drafts.push({
        turnId: `orphan:${message.id}`,
        user: null,
        assistants: [{ message, events: [] }],
      });
    }
  }

  const userDrafts = drafts.filter((draft) => Boolean(draft.user));
  const explicitAssistant = new Map<string, AssistantDraft>();
  const explicitTurn = new Map<string, TurnDraft>();
  for (const draft of drafts) {
    explicitTurn.set(draft.turnId, draft);
    for (const assistant of draft.assistants) {
      explicitAssistant.set(assistant.message.id, assistant);
    }
  }

  const sortedEvents = [...events].sort((left, right) => {
    const timeDiff = eventTime(left) - eventTime(right);
    return timeDiff !== 0 ? timeDiff : left.seq - right.seq;
  });

  for (const event of sortedEvents) {
    if (!["chat.reasoning", "chat.tool_call", "chat.tool_result"].includes(event.type)) {
      continue;
    }
    const payload = payloadOf(event);
    if (String(payload.agentId ?? "") !== options.agentId) continue;

    let target: AssistantDraft | null = null;
    let targetTurn: TurnDraft | null = null;
    const explicitAssistantId = String(payload.assistantMessageId ?? "").trim();
    const explicitTurnId = String(payload.turnId ?? "").trim();
    if (explicitAssistantId) {
      target = explicitAssistant.get(explicitAssistantId) ?? null;
      targetTurn =
        drafts.find((draft) => draft.assistants.some((item) => item === target)) ?? null;
    } else if (explicitTurnId) {
      targetTurn = explicitTurn.get(explicitTurnId) ?? null;
    }

    if (!targetTurn) {
      const at = eventTime(event);
      let candidate: TurnDraft | null = null;
      for (let index = 0; index < userDrafts.length; index += 1) {
        const draft = userDrafts[index]!;
        const start = messageTime(draft.user!);
        const next = userDrafts[index + 1];
        const end = next ? messageTime(next.user!) : Number.POSITIVE_INFINITY;
        if (at >= start && at < end) {
          candidate = draft;
          break;
        }
        if (at === end) {
          candidate = next;
          break;
        }
      }
      targetTurn = candidate;
    }
    if (!targetTurn || !targetTurn.user || targetTurn.assistants.length === 0) continue;

    if (!target) {
      const assistants = [...targetTurn.assistants].sort((left, right) =>
        compareMessages(left.message, right.message),
      );
      const at = eventTime(event);
      target =
        assistants.find((assistant) => messageTime(assistant.message) >= at) ??
        (assistants.length > 0 &&
        at <= messageTime(assistants[assistants.length - 1]!.message) + CHAT_TURN_LATE_GRACE_MS
          ? assistants[assistants.length - 1]!
          : null);
    }
    if (target) target.events.push(event);
  }

  let allTurns: ChatTurn[] = drafts.map((draft) => {
    const assistants = draft.assistants.map((assistant) =>
      buildAssistant(assistant, draft.turnId, includeTools, includeReasoning),
    );
    const status: ChatTurnStatus =
      assistants.length === 0
        ? draft.user
          ? "error"
          : "pending"
        : assistants.some((assistant) => assistant.status === "complete")
          ? "complete"
          : "error";
    return {
      turnId: draft.turnId,
      userMessage: draft.user,
      assistants,
      startedAt: draft.user?.createdAt ?? null,
      endedAt: assistants.length
        ? draft.assistants[draft.assistants.length - 1]!.message.createdAt
        : null,
      status,
    };
  });

  const hasEarlier = Boolean(options.hasEarlierMessages) || allTurns.length > limit;
  let turns = allTurns.slice(-limit);
  let truncated = turns.some((turn) => turn.assistants.some((assistant) => assistant.truncated));
  const nextBefore = hasEarlier && turns.length > 0 ? encodeCursor(turns[0]!) : null;

  // 响应总量兜底：优先裁掉更早的整轮，保留最新；绝不静默超限。
  while (
    turns.length > 1 &&
    Buffer.byteLength(JSON.stringify({ turns }), "utf8") > CHAT_TURNS_RESPONSE_MAX
  ) {
    turns = turns.slice(1);
    truncated = true;
  }

  // 单轮极端超限：保留最近 3 个 step，裁掉大工具负载；仍超限才继续裁旧 assistant。
  if (
    turns.length === 1 &&
    Buffer.byteLength(JSON.stringify({ turns }), "utf8") > CHAT_TURNS_RESPONSE_MAX
  ) {
    const turn = turns[0]!;
    for (const assistant of turn.assistants) {
      if (assistant.steps.length > 3) {
        assistant.steps = assistant.steps.slice(-3);
        assistant.truncated = true;
        truncated = true;
      }
      for (const step of assistant.steps) {
        for (const tool of step.tools) {
          if (tool.value !== undefined || tool.arguments) {
            tool.value = undefined;
            tool.arguments = capText(tool.arguments, 512).text;
            tool.truncated = { ...(tool.truncated ?? {}), arguments: true, value: true };
            truncated = true;
          }
        }
      }
    }
    while (
      turn.assistants.length > 1 &&
      Buffer.byteLength(JSON.stringify({ turns }), "utf8") > CHAT_TURNS_RESPONSE_MAX
    ) {
      turn.assistants = turn.assistants.slice(1);
      truncated = true;
    }
  }

  return {
    workspaceId: options.workspaceId,
    agentId: options.agentId,
    turns,
    hasMore: hasEarlier,
    nextBefore,
    truncated,
    projectionVersion: 1,
    generatedAt: new Date().toISOString(),
  };
}

/** UI 必要的稳定映射：把投影 steps 转成界面消费的步骤（工具/思考分离）。 */
export function chatTurnSteps(
  assistant: ChatAssistantTurn,
): Array<{ step: number; reasoning: ChatTurnReasoning[]; tools: ChatTurnTool[] }> {
  return assistant.steps.map((step) => ({
    step: step.step,
    reasoning: step.reasoning,
    tools: step.tools,
  }));
}
