import { describe, expect, it } from "vitest";
import type { ChatEvent } from "./types.js";
import {
  initialChatLiveState,
  reduceChatLive,
  type ChatLiveState,
} from "./chatLive.js";

const WS = "ws-1";

function state(): ChatLiveState {
  return initialChatLiveState(WS);
}

function apply(
  current: ChatLiveState,
  event: ChatEvent,
  seq = 0,
): ReturnType<typeof reduceChatLive> {
  return reduceChatLive(current, event, seq);
}

describe("t260 R1 ChatLive reducer", () => {
  it("appends delta/reasoning without touching terminals", () => {
    const terminals = new Map();
    let live: ChatLiveState = { ...state(), terminals };
    live = apply(live, { type: "delta", workspaceId: WS, agentId: "router", text: "你" }).state;
    live = apply(live, { type: "delta", workspaceId: WS, agentId: "router", text: "好" }).state;
    live = apply(live, { type: "reasoning", workspaceId: WS, agentId: "router", text: "想" }).state;

    expect(live.stream).toBe("你好");
    expect(live.reasoning).toBe("想");
    expect(live.terminals).toBe(terminals);
  });

  it("uses stable step+seq ids for reasoning segments and resets live reasoning", () => {
    const first = apply(
      state(),
      { type: "reasoning", workspaceId: WS, agentId: "router", text: "思考" },
      0,
    );
    const second = apply(
      first.state,
      { type: "reasoning_segment", workspaceId: WS, agentId: "router", step: 2, text: "段一" },
      first.nextSegmentSeq,
    );
    expect(second.state.reasoning).toBe("");
    expect(second.state.segments[0]).toMatchObject({
      id: "live-2-1",
      step: 2,
      text: "段一",
      status: "loading",
    });
    expect(second.nextSegmentSeq).toBe(1);
  });

  it("upserts tool_call/tool_result by callId and keeps arguments/error", () => {
    let live = apply(state(), {
      type: "tool_call",
      workspaceId: WS,
      agentId: "router",
      callId: "c1",
      name: "fs.read",
      arguments: '{"path":"a"}',
      step: 1,
    }).state;
    live = apply(live, {
      type: "tool_result",
      workspaceId: WS,
      agentId: "router",
      callId: "c1",
      name: "fs.read",
      ok: false,
      error: "nope",
      step: 1,
    }).state;

    expect(live.tools).toHaveLength(1);
    expect(live.tools[0]).toMatchObject({
      callId: "c1",
      arguments: '{"path":"a"}',
      status: "error",
      error: "nope",
      step: 1,
    });
  });

  it("keeps tool_result even when tool_call was missed", () => {
    const live = apply(state(), {
      type: "tool_result",
      workspaceId: WS,
      agentId: "router",
      callId: "c-missed",
      name: "fs.list",
      ok: true,
      value: { entries: [] },
    }).state;
    expect(live.tools[0]).toMatchObject({
      callId: "c-missed",
      arguments: "",
      status: "ok",
      step: undefined,
    });
  });

  it("done clears live but preserves terminals and settled kind", () => {
    const terminals = new Map([
      [
        "u-old",
        {
          status: "cancelled" as const,
          stage: "unknown" as const,
          code: null,
          message: "old",
          at: "2026-11-12T00:00:00.000Z",
          retryable: true,
          tool: null,
          source: "event" as const,
        },
      ],
    ]) as ChatLiveState["terminals"];
    const before: ChatLiveState = {
      ...state(),
      stream: "abc",
      reasoning: "why",
      segments: [{ id: "s1", step: 1, text: "x", status: "done" }],
      tools: [{ callId: "c1", name: "x", arguments: "", status: "ok" }],
      terminals,
    };
    const result = apply(before, {
      type: "done",
      workspaceId: WS,
      agentId: "router",
      message: {} as never,
    });
    expect(result.state.stream).toBe("");
    expect(result.state.reasoning).toBe("");
    expect(result.state.segments).toEqual([]);
    expect(result.state.tools).toEqual([]);
    expect(result.state.terminals).toBe(terminals);
    expect(result.settled?.kind).toBe("done");
  });

  it("cancelled/error stores terminal by userMessageId and clears live", () => {
    const terminal = {
      status: "cancelled" as const,
      stage: "unknown" as const,
      code: null,
      message: "已取消",
      at: "2026-11-12T00:00:00.000Z",
      retryable: true,
      tool: null,
      source: "event" as const,
    };
    const cancelled = apply(
      { ...state(), stream: "x" },
      {
        type: "cancelled",
        workspaceId: WS,
        agentId: "router",
        userMessageId: "u1",
        terminal,
        terminalPersisted: true,
      },
    );
    expect(cancelled.state.stream).toBe("");
    expect(cancelled.state.terminals.get("u1")).toBe(terminal);
    expect(cancelled.settled?.kind).toBe("cancelled");

    const errorTerminal = { ...terminal, status: "error" as const, summary: "失败" };
    const errored = apply(
      { ...state(), stream: "y" },
      {
        type: "error",
        workspaceId: WS,
        agentId: "router",
        error: "provider failed",
        userMessageId: "u2",
        terminal: errorTerminal,
        terminalPersisted: true,
      },
    );
    expect(errored.state.terminals.get("u2")).toBe(errorTerminal);
    expect(errored.settled?.kind).toBe("error");
    expect(errored.settled?.event).toMatchObject({ error: "provider failed" });
  });

  it("ignores events from another workspace", () => {
    const original = state();
    const result = apply(original, {
      type: "delta",
      workspaceId: "other",
      agentId: "router",
      text: "leak",
    });
    expect(result.state).toBe(original);
  });
});
