// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { memo } from "react";
import { describe, expect, it } from "vitest";
import { ChatLiveStore, useChatLiveState } from "./chatLiveStore.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { toJSON: () => unknown; unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws-1";
const delta = (text: string) => ({
  type: "delta" as const,
  workspaceId: WS,
  agentId: "router",
  text,
});

let parentRenders = 0;
let childRenders = 0;
let historyRenders = 0;
let siblingRenders = 0;

const History = memo(function History() {
  historyRenders += 1;
  return (
    <div data-testid="history">
      {Array.from({ length: 150 }, (_, index) => (
        <p key={index}>历史消息 {index}</p>
      ))}
    </div>
  );
});

const SiblingPanels = memo(function SiblingPanels() {
  siblingRenders += 1;
  return (
    <div data-testid="siblings">
      {Array.from({ length: 6 }, (_, index) => (
        <section key={index}>面板 {index}</section>
      ))}
    </div>
  );
});

function LiveChild({ store }: { store: ChatLiveStore }) {
  childRenders += 1;
  const live = useChatLiveState(store);
  return <span data-testid="live">{live.stream}</span>;
}

function Harness({ store }: { store: ChatLiveStore }) {
  parentRenders += 1;
  return (
    <div>
      <SiblingPanels />
      <History />
      <LiveChild store={store} />
    </div>
  );
}

describe("t260 R1 render isolation", () => {
  it("20 token deltas do not re-render App shell, 150-message history, or 6 sibling panels", async () => {
    parentRenders = 0;
    childRenders = 0;
    historyRenders = 0;
    siblingRenders = 0;
    const store = new ChatLiveStore(WS);
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(<Harness store={store} />);
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    expect(parentRenders).toBe(1);
    expect(historyRenders).toBe(1);
    expect(siblingRenders).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        store.dispatch(delta(String(index % 10)));
      });
    }

    expect(store.getSnapshot().stream).toHaveLength(20);
    expect(parentRenders).toBe(1);
    expect(historyRenders).toBe(1);
    expect(siblingRenders).toBe(1);
    // 每个 token 至少一次 live tail commit；React 19 可能把相邻提交合并。
    expect(childRenders).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(renderer.toJSON())).toContain("01234567890123456789");
    await act(async () => {
      renderer.unmount();
    });
  });
});
