import type { ChatEvent, ChatTurnTerminal } from "./types.js";

/** t260（R1）：流式轮次的可渲染状态；只由 ChatLiveBridge 写入。 */
export interface ChatLiveReasoningSegment {
  id: string;
  step: number;
  text: string;
  status: "loading" | "done" | "error";
  translation?: string;
}

export interface ChatLiveToolTrace {
  callId: string;
  name: string;
  arguments: string;
  status: "running" | "ok" | "error" | "unknown";
  value?: unknown;
  error?: string;
  step?: number;
}

export interface ChatLiveState {
  workspaceId: string | null;
  stream: string;
  reasoning: string;
  segments: readonly ChatLiveReasoningSegment[];
  tools: readonly ChatLiveToolTrace[];
  /** t168/t172/t175：终态按 userMessageId 保留；token 不更新此 Map。 */
  terminals: ReadonlyMap<string, ChatTurnTerminal>;
}

export type ChatLiveSettled =
  | { kind: "done"; event: Extract<ChatEvent, { type: "done" }> }
  | { kind: "cancelled"; event: Extract<ChatEvent, { type: "cancelled" }> }
  | { kind: "error"; event: Extract<ChatEvent, { type: "error" }> };

export interface ChatLiveReducerResult {
  state: ChatLiveState;
  nextSegmentSeq: number;
  settled?: ChatLiveSettled;
}

export function initialChatLiveState(workspaceId: string | null = null): ChatLiveState {
  return {
    workspaceId,
    stream: "",
    reasoning: "",
    segments: [],
    tools: [],
    terminals: new Map(),
  };
}

function upsertTool(
  tools: readonly ChatLiveToolTrace[],
  callId: string,
  patch: ChatLiveToolTrace,
): ChatLiveToolTrace[] {
  const index = tools.findIndex((tool) => tool.callId === callId);
  if (index < 0) return [...tools, patch];
  const next = [...tools];
  next[index] = { ...tools[index], ...patch };
  return next;
}

/**
 * 纯 reducer：ChatEvent → ChatLiveState。不访问 IPC/React，便于 fixture 测试。
 * - reasoning_segment 使用 step+seq 生成稳定 id（不随机，避免 render key 抖动）；
 * - tool_result 找不到 call 时仍生成 tool（保留结果，不丢事件）；
 * - done/cancelled/error 清空 live，但 terminals 按 userMessageId 保留。
 */
export function reduceChatLive(
  state: ChatLiveState,
  event: ChatEvent,
  segmentSeq: number,
): ChatLiveReducerResult {
  if (state.workspaceId !== null && event.workspaceId !== state.workspaceId) {
    return { state, nextSegmentSeq: segmentSeq };
  }

  switch (event.type) {
    case "delta":
      return {
        state: { ...state, stream: state.stream + event.text },
        nextSegmentSeq: segmentSeq,
      };
    case "reasoning":
      return {
        state: { ...state, reasoning: state.reasoning + event.text },
        nextSegmentSeq: segmentSeq,
      };
    case "reasoning_segment": {
      const nextSeq = segmentSeq + 1;
      const segment: ChatLiveReasoningSegment = {
        id: `live-${event.step}-${nextSeq}`,
        step: event.step,
        text: event.text,
        status: "loading",
      };
      return {
        state: {
          ...state,
          reasoning: "",
          segments: [...state.segments, segment],
        },
        nextSegmentSeq: nextSeq,
      };
    }
    case "tool_call":
      return {
        state: {
          ...state,
          tools: upsertTool(state.tools, event.callId, {
            callId: event.callId,
            name: event.name,
            arguments: event.arguments,
            status: "running",
            step: event.step,
          }),
        },
        nextSegmentSeq: segmentSeq,
      };
    case "tool_result": {
      const existing = state.tools.find((tool) => tool.callId === event.callId);
      return {
        state: {
          ...state,
          tools: upsertTool(state.tools, event.callId, {
            callId: event.callId,
            name: event.name,
            arguments: existing?.arguments ?? "",
            status: event.ok ? "ok" : "error",
            value: event.value,
            error: event.error,
            step: event.step ?? existing?.step,
          }),
        },
        nextSegmentSeq: segmentSeq,
      };
    }
    case "done":
      return {
        state: {
          ...state,
          stream: "",
          reasoning: "",
          segments: [],
          tools: [],
        },
        nextSegmentSeq: segmentSeq,
        settled: { kind: "done", event },
      };
    case "cancelled": {
      const terminals =
        event.userMessageId && event.terminal
          ? new Map(state.terminals).set(event.userMessageId, event.terminal)
          : state.terminals;
      return {
        state: {
          ...state,
          stream: "",
          reasoning: "",
          segments: [],
          tools: [],
          terminals,
        },
        nextSegmentSeq: segmentSeq,
        settled: { kind: "cancelled", event },
      };
    }
    case "error": {
      const terminals =
        event.userMessageId && event.terminal
          ? new Map(state.terminals).set(event.userMessageId, event.terminal)
          : state.terminals;
      return {
        state: {
          ...state,
          stream: "",
          reasoning: "",
          segments: [],
          tools: [],
          terminals,
        },
        nextSegmentSeq: segmentSeq,
        settled: { kind: "error", event },
      };
    }
    default:
      return { state, nextSegmentSeq: segmentSeq };
  }
}

export function withLiveTranslation(
  state: ChatLiveState,
  segmentId: string,
  translation: string,
): ChatLiveState {
  let changed = false;
  const segments = state.segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    changed = true;
    return { ...segment, status: "done" as const, translation };
  });
  return changed ? { ...state, segments } : state;
}

export function withLiveTranslationError(
  state: ChatLiveState,
  segmentId: string,
): ChatLiveState {
  let changed = false;
  const segments = state.segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    changed = true;
    return { ...segment, status: "error" as const, translation: undefined };
  });
  return changed ? { ...state, segments } : state;
}
