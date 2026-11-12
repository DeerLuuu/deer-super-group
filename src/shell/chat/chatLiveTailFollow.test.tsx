// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ChatLiveTail } from "../../App.js";
import { ChatLiveStore } from "./chatLiveStore.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws-perf";
const node = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 };

describe("t443 streaming follow", () => {
  it("does not pull down while reading, then follows near bottom", async () => {
    const store = new ChatLiveStore(WS);
    const stick = { current: false };
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ChatLiveTail
          store={store}
          assistantName="Router"
          busy
          scrollRef={{ current: node as unknown as HTMLDivElement }}
          stickToBottomRef={stick}
          questions={new Map()}
          questionsLoaded
          onAnswerQuestion={() => {}}
          onToast={() => {}}
          translateHistoryText={async (text) => text}
        />,
      );
    });
    await act(async () => {
      store.dispatch({ type: "delta", workspaceId: WS, agentId: "router", text: "hello" });
    });
    expect(node.scrollTop).toBe(0);
    stick.current = true;
    await act(async () => {
      store.dispatch({ type: "delta", workspaceId: WS, agentId: "router", text: " world" });
    });
    expect(node.scrollTop).toBe(1200);
    await act(() => renderer!.unmount());
  });
});
