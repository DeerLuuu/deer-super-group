import { useSyncExternalStore } from "react";
import type { ChatEvent, ChatTurnTerminal } from "../../shared/types.js";
import {
  initialChatLiveState,
  reduceChatLive,
  withLiveTranslation,
  withLiveTranslationError,
  type ChatLiveReasoningSegment,
  type ChatLiveSettled,
  type ChatLiveState,
  type ChatLiveToolTrace,
} from "../../shared/chatLive.js";

/**
 * t260（R1）：流式轮次的 external store。
 * App 不订阅此 store；只有 ChatLiveTail/Bridge/终态选择器订阅。
 * token 不 setState App，也不触发 Dock/其他 panel render。
 */
export class ChatLiveStore {
  private state: ChatLiveState;
  private segmentSeq = 0;
  private readonly listeners = new Set<() => void>();
  private readonly requestedTranslations = new Set<string>();

  constructor(workspaceId: string | null = null) {
    this.state = initialChatLiveState(workspaceId);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ChatLiveState => this.state;

  readonly getTerminals = (): ReadonlyMap<string, ChatTurnTerminal> => this.state.terminals;

  setWorkspace(workspaceId: string): void {
    if (this.state.workspaceId === workspaceId) return;
    this.reset(workspaceId);
  }

  reset(workspaceId: string | null = null): void {
    this.state = initialChatLiveState(workspaceId ?? this.state.workspaceId);
    this.segmentSeq = 0;
    this.requestedTranslations.clear();
    this.emit();
  }

  /** 开始新 turn / clear / compact：清空 live，但保留 terminal 历史。 */
  clearLive(): void {
    if (
      !this.state.stream &&
      !this.state.reasoning &&
      this.state.segments.length === 0 &&
      this.state.tools.length === 0
    ) {
      return;
    }
    this.state = {
      ...this.state,
      stream: "",
      reasoning: "",
      segments: [],
      tools: [],
    };
    this.segmentSeq = 0;
    this.emit();
  }

  dispatch(event: ChatEvent): ChatLiveSettled | null {
    const result = reduceChatLive(this.state, event, this.segmentSeq);
    if (result.state !== this.state) {
      this.state = result.state;
      this.segmentSeq = result.nextSegmentSeq;
      this.emit();
    }
    return result.settled ?? null;
  }

  /** 每段最多请求一次；返回 false 表示已请求/已结束。 */
  beginTranslation(segmentId: string): boolean {
    if (this.requestedTranslations.has(segmentId)) return false;
    this.requestedTranslations.add(segmentId);
    return true;
  }

  setTranslation(segmentId: string, translation: string): void {
    const next = withLiveTranslation(this.state, segmentId, translation);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  setTranslationError(segmentId: string): void {
    const next = withLiveTranslationError(this.state, segmentId);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不能阻断其他订阅者（外部 store 契约）。
      }
    }
  }
}

/** 订阅完整 live state；只有 ChatLiveTail 使用。 */
export function useChatLiveState(store: ChatLiveStore): ChatLiveState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * 只订阅 terminals（低频 done/cancel/error）；token 期间 Map identity 不变，
 * 因此历史消息列表不会因 delta 重渲染。
 */
export function useChatLiveTerminals(
  store: ChatLiveStore,
): ReadonlyMap<string, ChatTurnTerminal> {
  return useSyncExternalStore(store.subscribe, store.getTerminals, store.getTerminals);
}

export type { ChatLiveReasoningSegment, ChatLiveState, ChatLiveToolTrace };
