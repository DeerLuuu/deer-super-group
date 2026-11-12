// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ChatMessage } from "../../shared/types.js";
import { ChatView } from "../../App.js";
import { ChatLiveStore } from "./chatLiveStore.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws-1";
const created = "2026-11-12T00:00:00.000Z";
const messages: ChatMessage[] = Array.from({ length: 150 }, (_, index) => ({
  id: `m${index}`,
  workspaceId: WS,
  agentId: "router",
  role: index % 2 === 0 ? "user" : "assistant",
  content: `fixture message ${index}`,
  reasoning: "",
  createdAt: created,
}));

let viewRenders = 0;

function ChatViewProbe({
  store,
  onViewChange = () => {},
  loadEarlierMessages,
  onLoadEarlierHistory,
}: {
  store: ChatLiveStore;
  onViewChange?: (view: "chat" | "trajectory") => void;
  loadEarlierMessages?: () => Promise<void>;
  onLoadEarlierHistory?: () => Promise<boolean>;
}) {
  viewRenders += 1;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <ChatView
      liveStore={store}
      messages={messages}
      turnByAssistant={new Map()}
      turnByUser={new Map()}
      onRetryTurn={() => {}}
      composerRef={composerRef}
      translateHistoryText={async (text) => text}
      view="chat"
      onViewChange={onViewChange}
      loadEarlierMessages={loadEarlierMessages}
      onLoadEarlierHistory={onLoadEarlierHistory}
      trajectory={[]}
      trajectoryLoading={false}
      onRefreshTrajectory={() => {}}
      busy={false}
      input=""
      onInput={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      questions={new Map()}
      questionsLoaded
      pendingQuestionCount={0}
      onOpenFirstQuestion={() => {}}
      onAnswerQuestion={() => {}}
      onToast={() => {}}
      taskContext={null}
      taskContextSource={null}
      onReturnToSource={undefined}
      onClearTaskContext={() => {}}
      onOpenContextPanel={() => {}}
      contextBusy={false}
      onClearContext={() => {}}
      onCompactContext={() => {}}
      overview={null}
      routerAgent={{ permission: "full_access" } as Agent}
      modelOptions={[]}
      fullThrottle={false}
      onModelChange={() => {}}
      onPermissionChange={() => {}}
      onFullThrottleChange={() => {}}
    />
  );
}

describe("t260 R1 actual ChatView isolation", () => {
  it("keeps ChatView/history stable across token deltas", async () => {
    viewRenders = 0;
    const store = new ChatLiveStore(WS);
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(<ChatViewProbe store={store} />);
    });
    const renderer = treeRef.current;
    if (!renderer) throw new Error("renderer not created");
    expect(viewRenders).toBe(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("fixture message 149");

    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        store.dispatch({
          type: "delta",
          workspaceId: WS,
          agentId: "router",
          text: "x",
        });
      });
    }

    expect(viewRenders).toBe(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("xxxxxxxxxxxxxxxxxxxx");
    await act(async () => {
      renderer.unmount();
    });
  });

  it("supports Home/End on Chat tabs", async () => {
    const onViewChange = vi.fn();
    const store = new ChatLiveStore(WS);
    const originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      getElementById: () => ({ focus: vi.fn() }),
    };
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(
        <ChatViewProbe store={store} onViewChange={onViewChange} />,
      );
    });
    const chatTab = treeRef.current!.root.findAllByProps({ role: "tab" })[0]!;
    await act(() => {
      (chatTab.props.onKeyDown as (event: unknown) => void)({
        key: "End",
        preventDefault: vi.fn(),
      });
    });
    expect(onViewChange).toHaveBeenLastCalledWith("trajectory");
    await act(() => {
      (chatTab.props.onKeyDown as (event: unknown) => void)({
        key: "Home",
        preventDefault: vi.fn(),
      });
    });
    expect(onViewChange).toHaveBeenLastCalledWith("chat");
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  });

  it("loads earlier messages and keeps newest messages", async () => {
    const store = new ChatLiveStore(WS);
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(<ChatViewProbe store={store} />);
    });
    const renderer = treeRef.current!;
    const initial = JSON.stringify(renderer.toJSON());
    expect(initial).toContain("fixture message 149");
    expect(initial).not.toContain("fixture message 0");
    for (let page = 0; page < 3; page += 1) {
      const more = renderer.root
        .findAllByType("button")
        .find((button) => JSON.stringify(button.children).includes("加载更早"))!;
      await act(async () => {
        await (more.props.onClick as () => Promise<void>)();
      });
    }
    const loaded = JSON.stringify(renderer.toJSON());
    expect(loaded).toContain("fixture message 0");
    expect(loaded).toContain("fixture message 149");
    expect(loaded).toContain("已到最早");
  });

  it("shows a retryable error when earlier history fails", async () => {
    const store = new ChatLiveStore(WS);
    const loadEarlierMessages = vi.fn(async () => {
      throw new Error("history network failed");
    });
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(
        <ChatViewProbe store={store} loadEarlierMessages={loadEarlierMessages} />,
      );
    });
    const renderer = treeRef.current!;
    const more = renderer.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.children).includes("加载更早"))!;
    await act(async () => {
      await (more.props.onClick as () => Promise<void>)();
    });
    const failed = JSON.stringify(renderer.toJSON());
    expect(failed).toContain("加载失败");
    expect(failed).toContain("可重试");
    expect(loadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("does not advance visible messages when server pagination rejects", async () => {
    const store = new ChatLiveStore(WS);
    const onLoadEarlierHistory = vi.fn(async () => false);
    const treeRef: { current?: ReturnType<typeof create> } = {};
    await act(async () => {
      treeRef.current = create(
        <ChatViewProbe store={store} onLoadEarlierHistory={onLoadEarlierHistory} />,
      );
    });
    const renderer = treeRef.current!;
    const more = renderer.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.children).includes("加载更早"))!;
    await act(async () => {
      await (more.props.onClick as () => Promise<void>)();
    });
    const output = JSON.stringify(renderer.toJSON());
    expect(onLoadEarlierHistory).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("fixture message 0");
    expect(output).toContain("加载失败");
    expect(output).toContain("重试");
  });
});
