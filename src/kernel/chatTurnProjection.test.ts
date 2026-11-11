import { describe, expect, it } from "vitest";
import type { ChatMessage, EventRecord } from "../shared/types.js";
import {
  CHAT_TURN_CONTENT_MAX,
  CHAT_TURN_MAX_TOOLS,
  CHAT_TURN_REASONING_MAX,
  CHAT_TURN_TOOL_MAX,
  CHAT_TURN_TOTAL_CONTENT_MAX,
  CHAT_TURN_TOTAL_REASONING_MAX,
  CHAT_TURNS_RESPONSE_MAX,
  buildChatTurns,
  chatTurnSteps,
} from "./chatTurnProjection.js";

const WS = "ws_test";
const AGENT = "agent_router";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  at: string,
  reasoning = "",
): ChatMessage {
  return {
    id,
    workspaceId: WS,
    agentId: AGENT,
    role,
    content,
    reasoning,
    createdAt: at,
  };
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  at: string,
): EventRecord {
  return {
    seq,
    id: `evt_${seq}`,
    aggregateType: "chat",
    aggregateId: WS,
    type,
    actor: "agent:Router",
    payload: { agentId: AGENT, ...payload },
    createdAt: at,
    occurredAt: at,
  };
}

function build(messages: ChatMessage[], events: EventRecord[], limit = 20) {
  return buildChatTurns(messages, events, { workspaceId: WS, agentId: AGENT, limit });
}

describe("t168 chat turn projection", () => {
  it("groups user → assistant, reasoning and a paired tool into one bubble", () => {
    const page = build(
      [
        message("u1", "user", "检查项目", "2026-01-01T00:00:00.000Z"),
        message(
          "a1",
          "assistant",
          "配置正常。",
          "2026-01-01T00:00:04.000Z",
          "整段旧思考不应出现",
        ),
      ],
      [
        event(1, "chat.reasoning", { step: 1, text: "先看目录" }, "2026-01-01T00:00:01.000Z"),
        event(
          2,
          "chat.tool_call",
          { step: 1, callId: "call_1", name: "fs.list", arguments: '{"path":"."}' },
          "2026-01-01T00:00:02.000Z",
        ),
        event(
          3,
          "chat.tool_result",
          { step: 1, callId: "call_1", name: "fs.list", ok: true, value: { entries: 3 } },
          "2026-01-01T00:00:03.000Z",
        ),
      ],
    );
    expect(page.turns).toHaveLength(1);
    expect(page.projectionVersion).toBe(1);
    const turn = page.turns[0]!;
    expect(turn.turnId).toBe("turn:u1");
    expect(turn.userMessage?.id).toBe("u1");
    expect(turn.status).toBe("complete");
    expect(turn.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(turn.endedAt).toBe("2026-01-01T00:00:04.000Z");
    const assistant = turn.assistants[0]!;
    expect(assistant.messageId).toBe("a1");
    expect(assistant.content).toBe("配置正常。");
    expect(assistant.legacy).toEqual({
      reasoningFromMessage: false,
      toolsMissing: false,
      stepFallback: false,
    });
    expect(assistant.steps).toHaveLength(1);
    expect(assistant.steps[0]!.step).toBe(1);
    expect(assistant.steps[0]!.reasoning[0]).toMatchObject({
      id: "evt_1:reasoning",
      text: "先看目录",
      source: "event",
    });
    expect(assistant.steps[0]!.tools[0]).toMatchObject({
      callId: "call_1",
      name: "fs.list",
      status: "ok",
      arguments: '{"path":"."}',
      value: { entries: 3 },
      step: 1,
    });
    expect(chatTurnSteps(assistant)[0]).toMatchObject({
      step: 1,
      reasoning: [{ source: "event", text: "先看目录" }],
      tools: [{ callId: "call_1", status: "ok" }],
    });
  });

  it("keeps multiple assistants under one user as independent bubbles", () => {
    const page = build(
      [
        message("u1", "user", "重试一下", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "第一次", "2026-01-01T00:00:02.000Z"),
        message("a2", "assistant", "第二次", "2026-01-01T00:00:04.000Z"),
      ],
      [
        event(1, "chat.reasoning", { step: 0, text: "第一轮思考" }, "2026-01-01T00:00:01.000Z"),
        event(2, "chat.reasoning", { step: 0, text: "第二轮思考" }, "2026-01-01T00:00:03.000Z"),
      ],
    );
    const turn = page.turns[0]!;
    expect(turn.assistants.map((assistant) => assistant.messageId)).toEqual(["a1", "a2"]);
    expect(turn.assistants[0]!.steps[0]!.reasoning[0]?.text).toBe("第一轮思考");
    expect(turn.assistants[1]!.steps[0]!.reasoning[0]?.text).toBe("第二轮思考");
  });

  it("falls back to step 0 and seq order for old events without step", () => {
    const page = build(
      [
        message("u1", "user", "旧数据", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "完成", "2026-01-01T00:00:03.000Z"),
      ],
      [
        event(1, "chat.tool_call", { callId: "c1", name: "fs.read", arguments: "{}" }, "2026-01-01T00:00:01.000Z"),
        event(2, "chat.tool_result", { callId: "c1", name: "fs.read", ok: true, value: "ok" }, "2026-01-01T00:00:02.000Z"),
      ],
    );
    const assistant = page.turns[0]!.assistants[0]!;
    expect(assistant.legacy.stepFallback).toBe(true);
    expect(assistant.steps.map((step) => step.step)).toEqual([0]);
    expect(assistant.steps[0]!.tools[0]).toMatchObject({ callId: "c1", status: "ok", step: 0 });
  });

  it("uses synthetic ids for missing callIds and synthetic tools for orphan results", () => {
    const page = build(
      [
        message("u1", "user", "工具", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "完成", "2026-01-01T00:00:05.000Z"),
      ],
      [
        event(1, "chat.tool_call", { name: "fs.list", arguments: "{}" }, "2026-01-01T00:00:01.000Z"),
        event(2, "chat.tool_call", { name: "fs.list", arguments: "{}" }, "2026-01-01T00:00:02.000Z"),
        event(3, "chat.tool_result", { callId: "missing", name: "shell.run", ok: false, error: "denied" }, "2026-01-01T00:00:03.000Z"),
      ],
    );
    const tools = page.turns[0]!.assistants[0]!.steps.flatMap((step) => step.tools);
    expect(tools).toHaveLength(3);
    expect(tools.filter((tool) => tool.callId.startsWith("synthetic:"))).toHaveLength(2);
    expect(tools.find((tool) => tool.name === "shell.run")).toMatchObject({
      status: "error",
      error: "denied",
      synthetic: true,
    });
  });

  it("ignores orphan events without a user turn and does not create fake bubbles", () => {
    const page = build(
      [message("a1", "assistant", "无 user 的旧回答", "2026-01-01T00:00:04.000Z")],
      [event(1, "chat.reasoning", { step: 1, text: "孤立思考" }, "2026-01-01T00:00:01.000Z")],
    );
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]!.userMessage).toBeNull();
    expect(page.turns[0]!.assistants[0]!.steps).toEqual([]);
  });

  it("uses message.reasoning only when no reasoning event exists", () => {
    const page = build(
      [
        message("u1", "user", "旧数据", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "回复", "2026-01-01T00:00:02.000Z", "旧思考"),
      ],
      [],
    );
    const assistant = page.turns[0]!.assistants[0]!;
    expect(assistant.steps[0]!.reasoning[0]).toMatchObject({
      text: "旧思考",
      source: "message",
      id: "a1:reasoning",
    });
    expect(assistant.legacy.reasoningFromMessage).toBe(true);
    expect(assistant.legacy.stepFallback).toBe(true);
  });

  it("event reasoning wins over message.reasoning without duplicating it", () => {
    const page = build(
      [
        message("u1", "user", "问题", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "回复", "2026-01-01T00:00:02.000Z", "整段旧思考"),
      ],
      [event(1, "chat.reasoning", { step: 1, text: "分段思考" }, "2026-01-01T00:00:01.000Z")],
    );
    const assistant = page.turns[0]!.assistants[0]!;
    expect(assistant.legacy.reasoningFromMessage).toBe(false);
    expect(assistant.steps.flatMap((step) => step.reasoning)).toHaveLength(1);
    expect(assistant.steps[0]!.reasoning[0]!.text).toBe("分段思考");
  });

  it("paginates recent turns and encodes a before cursor", () => {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 3; index += 1) {
      messages.push(message(`u${index}`, "user", `q${index}`, `2026-01-01T00:00:0${index}.000Z`));
      messages.push(
        message(`a${index}`, "assistant", `a${index}`, `2026-01-01T00:00:0${index}.500Z`),
      );
    }
    const page = build(messages, [], 2);
    expect(page.turns.map((turn) => turn.turnId)).toEqual(["turn:u2", "turn:u3"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBeTruthy();
    expect(Buffer.from(page.nextBefore!, "base64url").toString("utf8")).toBe(
      "2026-01-01T00:00:02.000Z|u2",
    );
  });

  it("caps reasoning, tool payloads and assistant content with truncation flags", () => {
    const page = build(
      [
        message("u1", "user", "长文本", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "x".repeat(CHAT_TURN_CONTENT_MAX + 10), "2026-01-01T00:00:04.000Z"),
      ],
      [
        event(
          1,
          "chat.reasoning",
          { step: 1, text: "r".repeat(CHAT_TURN_REASONING_MAX + 10) },
          "2026-01-01T00:00:01.000Z",
        ),
        event(
          2,
          "chat.tool_call",
          { step: 1, callId: "c1", name: "fs.write", arguments: "a".repeat(CHAT_TURN_TOOL_MAX + 10) },
          "2026-01-01T00:00:02.000Z",
        ),
      ],
    );
    const assistant = page.turns[0]!.assistants[0]!;
    expect(assistant.truncated).toBe(true);
    expect(assistant.content.length).toBeLessThanOrEqual(CHAT_TURN_CONTENT_MAX + 1);
    expect(assistant.steps[0]!.reasoning[0]!.truncated).toBe(true);
    expect(assistant.steps[0]!.tools[0]!.truncated?.arguments).toBe(true);
    expect(page.truncated).toBe(true);
  });

  it("supports disabling tools/reasoning projections", () => {
    const page = buildChatTurns(
      [
        message("u1", "user", "问题", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "回复", "2026-01-01T00:00:03.000Z", "旧思考"),
      ],
      [
        event(1, "chat.reasoning", { step: 1, text: "思考" }, "2026-01-01T00:00:01.000Z"),
        event(2, "chat.tool_call", { step: 1, callId: "c1", name: "fs.list", arguments: "{}" }, "2026-01-01T00:00:02.000Z"),
      ],
      {
        workspaceId: WS,
        agentId: AGENT,
        includeTools: false,
        includeReasoning: false,
      },
    );
    const assistant = page.turns[0]!.assistants[0]!;
    expect(assistant.steps).toEqual([]);
    expect(assistant.legacy.toolsMissing).toBe(false);
  });

  it("caps user content/reasoning totals and tool count with truncated", () => {
    const events = Array.from({ length: CHAT_TURN_MAX_TOOLS + 20 }, (_, index) =>
      event(
        index + 1,
        "chat.tool_call",
        { callId: `c${index}`, name: "fs.list", arguments: "{}", step: 0 },
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      ),
    );
    const page = build(
      [
        message(
          "u1",
          "user",
          "u".repeat(CHAT_TURN_CONTENT_MAX + 10_000),
          "2026-01-01T00:00:00.000Z",
          "r".repeat(CHAT_TURN_REASONING_MAX + 1_000),
        ),
        message(
          "a1",
          "assistant",
          "a".repeat(CHAT_TURN_CONTENT_MAX + 10_000),
          "2026-01-01T00:10:00.000Z",
        ),
      ],
      events,
    );
    const turn = page.turns[0]!;
    const assistant = turn.assistants[0]!;
    expect(turn.truncated).toBe(true);
    expect(page.truncated).toBe(true);
    expect(turn.userMessage?.content.length).toBeLessThanOrEqual(CHAT_TURN_CONTENT_MAX);
    expect(turn.userMessage?.reasoning.length).toBeLessThanOrEqual(CHAT_TURN_REASONING_MAX);
    expect(assistant.content.length).toBeLessThanOrEqual(CHAT_TURN_CONTENT_MAX);
    expect(assistant.steps.flatMap((step) => step.tools).length).toBeLessThanOrEqual(
      CHAT_TURN_MAX_TOOLS,
    );
    expect(CHAT_TURN_TOTAL_CONTENT_MAX).toBeGreaterThanOrEqual(
      (turn.userMessage?.content.length ?? 0) + assistant.content.length,
    );
    expect(CHAT_TURN_TOTAL_REASONING_MAX).toBeGreaterThanOrEqual(
      (turn.userMessage?.reasoning.length ?? 0) +
        assistant.steps.flatMap((step) => step.reasoning).reduce((sum, item) => sum + item.text.length, 0),
    );
  });

  it("keeps the full response under 512KiB for one oversized turn", () => {
    const events: EventRecord[] = [];
    for (let index = 0; index < 100; index += 1) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      events.push(
        event(
          index + 1,
          "chat.tool_call",
          {
            callId: `big-${index}`,
            name: "fs.write",
            arguments: "x".repeat(CHAT_TURN_TOOL_MAX),
            step: 0,
          },
          at,
        ),
        event(
          index + 101,
          "chat.tool_result",
          {
            callId: `big-${index}`,
            name: "fs.write",
            ok: true,
            value: "y".repeat(CHAT_TURN_TOOL_MAX),
            step: 0,
          },
          at,
        ),
      );
    }
    const page = build(
      [
        message("u1", "user", "big turn", "2026-01-01T00:00:00.000Z"),
        message("a1", "assistant", "done", "2026-01-01T00:02:00.000Z"),
      ],
      events,
    );
    expect(page.turns).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.turns[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      CHAT_TURNS_RESPONSE_MAX,
    );
  });

  it("recomputes nextBefore after response trimming so before keeps older turns", () => {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const at = `2026-01-01T00:00:${String(index * 2).padStart(2, "0")}.000Z`;
      const answerAt = `2026-01-01T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
      messages.push(message(`u${index}`, "user", `q${index}-${"u".repeat(60_000)}`, at));
      messages.push(message(`a${index}`, "assistant", `a${index}-${"a".repeat(55_000)}`, answerAt));
    }
    const page = build(messages, [], 20);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBeTruthy();
    const first = page.turns[0]!;
    const cursor = Buffer.from(page.nextBefore!, "base64url").toString("utf8");
    expect(cursor).toBe(`${first.userMessage?.createdAt}|${first.userMessage?.id}`);
    expect(first.userMessage?.content.startsWith("q1-")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      CHAT_TURNS_RESPONSE_MAX,
    );
  });

  it("projects cancelled/error terminal events and keeps old user-only turns pending", () => {
    const user = message("u1", "user", "跑一下", "2026-01-01T00:00:00.000Z");
    const cancelled = build(
      [user],
      [
        event(
          1,
          "chat.turn_cancelled",
          {
            userMessageId: "u1",
            turnId: "turn:u1",
            agentId: AGENT,
            status: "cancelled",
            stage: "tool",
            code: "ABORTED",
            message: null,
            retryable: true,
            step: 2,
            toolCallId: "c1",
            toolName: "fs.read",
            at: "2026-01-01T00:00:02.000Z",
          },
          "2026-01-01T00:00:02.000Z",
        ),
      ],
    );
    const cancelledTurn = cancelled.turns[0]!;
    expect(cancelledTurn.status).toBe("cancelled");
    expect(cancelledTurn.assistants).toHaveLength(0);
    expect(cancelledTurn.terminal).toMatchObject({
      status: "cancelled",
      stage: "tool",
      code: "ABORTED",
      retryable: true,
      tool: { callId: "c1", name: "fs.read", step: 2 },
    });
    expect(cancelledTurn.retryable).toBe(true);
    expect(cancelledTurn.endedAt).toBe("2026-01-01T00:00:02.000Z");

    const error = build(
      [user],
      [
        event(
          1,
          "chat.turn_error",
          {
            userMessageId: "u1",
            turnId: "turn:u1",
            agentId: AGENT,
            status: "error",
            stage: "model",
            code: "PROVIDER_500",
            message: "Authorization: Bearer sk-secret-123 failed token=abc",
            retryable: false,
            step: null,
            toolCallId: null,
            toolName: null,
            at: "2026-01-01T00:00:03.000Z",
          },
          "2026-01-01T00:00:03.000Z",
        ),
      ],
    );
    const errorTurn = error.turns[0]!;
    expect(errorTurn.status).toBe("error");
    expect(errorTurn.terminal).toMatchObject({ status: "error", stage: "model", retryable: false });
    expect(errorTurn.terminal?.message).not.toContain("sk-secret");
    expect(errorTurn.terminal?.message).toContain("[REDACTED]");
    expect(errorTurn.terminal?.message).not.toContain("token=abc");

    const old = build([user], []);
    expect(old.turns[0]!.status).toBe("pending");
    expect(old.turns[0]!.legacyUnresolved).toBe(true);
    expect(old.turns[0]!.terminal).toBeNull();
    expect(old.turns[0]!.retryable).toBe(true);
  });

  it("complete assistant wins over a conflicting terminal; invalid terminal bindings are ignored", () => {
    const messages = [
      message("u1", "user", "问", "2026-01-01T00:00:00.000Z"),
      message("a1", "assistant", "答", "2026-01-01T00:00:02.000Z"),
    ];
    const terminal = (agentId: string, userMessageId = "u1", turnId = "turn:u1") =>
      event(
        1,
        "chat.turn_error",
        {
          userMessageId,
          turnId,
          agentId,
          status: "error",
          stage: "model",
          code: "E",
          message: "fail",
          retryable: true,
          at: "2026-01-01T00:00:03.000Z",
        },
        "2026-01-01T00:00:03.000Z",
      );
    const complete = build(messages, [terminal(AGENT)]);
    expect(complete.turns[0]!.status).toBe("complete");
    expect(complete.turns[0]!.retryable).toBe(false);
    expect(complete.turns[0]!.terminal?.status).toBe("error");

    const wrongAgent = build([messages[0]!], [terminal("agent_other")]);
    expect(wrongAgent.turns[0]!.status).toBe("pending");
    expect(wrongAgent.turns[0]!.terminal).toBeNull();

    const wrongTurn = build([messages[0]!], [terminal(AGENT, "u1", "turn:other")]);
    expect(wrongTurn.turns[0]!.terminal).toBeNull();

    const wrongWorkspaceEvent = { ...terminal(AGENT), aggregateId: "ws_other" };
    const wrongWorkspace = build([messages[0]!], [wrongWorkspaceEvent]);
    expect(wrongWorkspace.turns[0]!.terminal).toBeNull();
  });
});
