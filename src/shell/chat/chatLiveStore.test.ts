import { describe, expect, it } from "vitest";
import { ChatLiveStore } from "./chatLiveStore.js";

const WS = "ws-1";
const delta = (text: string) => ({
  type: "delta" as const,
  workspaceId: WS,
  agentId: "router",
  text,
});

describe("t260 R1 ChatLiveStore", () => {
  it("notifies subscribers per event and keeps an immutable snapshot", () => {
    const store = new ChatLiveStore(WS);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    const before = store.getSnapshot();
    store.dispatch(delta("a"));
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.stream).toBe("a");
    expect(calls).toBe(1);

    store.dispatch(delta("b"));
    expect(store.getSnapshot().stream).toBe("ab");
    expect(calls).toBe(2);
    off();
    store.dispatch(delta("c"));
    expect(calls).toBe(2);
  });

  it("ignores other workspace and resets on workspace switch", () => {
    const store = new ChatLiveStore(WS);
    store.dispatch(delta("a"));
    store.dispatch({ ...delta("leak"), workspaceId: "other" });
    expect(store.getSnapshot().stream).toBe("a");

    store.setWorkspace("other");
    expect(store.getSnapshot().workspaceId).toBe("other");
    expect(store.getSnapshot().stream).toBe("");
  });

  it("clearLive resets stream/tools/segments but preserves terminal history", () => {
    const store = new ChatLiveStore(WS);
    store.dispatch(delta("a"));
    store.dispatch({
      type: "tool_call",
      workspaceId: WS,
      agentId: "router",
      callId: "c1",
      name: "fs.read",
      arguments: "{}",
    });
    store.dispatch({
      type: "error",
      workspaceId: WS,
      agentId: "router",
      error: "failed",
      userMessageId: "u1",
      terminal: {
        status: "error",
        stage: "unknown",
        code: null,
        message: "failed",
        at: "2026-11-12T00:00:00.000Z",
        retryable: true,
        tool: null,
        source: "event",
      },
    });
    store.clearLive();
    const snapshot = store.getSnapshot();
    expect(snapshot.stream).toBe("");
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.terminals.has("u1")).toBe(true);
  });

  it("requests each translation once and applies success/error", () => {
    const store = new ChatLiveStore(WS);
    store.dispatch({
      type: "reasoning_segment",
      workspaceId: WS,
      agentId: "router",
      step: 1,
      text: "思考",
    });
    const id = store.getSnapshot().segments[0].id;
    expect(store.beginTranslation(id)).toBe(true);
    expect(store.beginTranslation(id)).toBe(false);

    store.setTranslation(id, "译文");
    expect(store.getSnapshot().segments[0]).toMatchObject({
      status: "done",
      translation: "译文",
    });

    store.dispatch({
      type: "reasoning_segment",
      workspaceId: WS,
      agentId: "router",
      step: 2,
      text: "第二段",
    });
    const second = store.getSnapshot().segments[1].id;
    expect(store.beginTranslation(second)).toBe(true);
    store.setTranslationError(second);
    expect(store.getSnapshot().segments[1].status).toBe("error");
  });
});
