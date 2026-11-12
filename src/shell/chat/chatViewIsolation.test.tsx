// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import type { Agent, ChatMessage } from "../../shared/types.js";
import { ChatView } from "../../App.js";
import { ChatLiveStore } from "./chatLiveStore.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { toJSON: () => unknown; unmount: () => void };
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

function ChatViewProbe({ store }: { store: ChatLiveStore }) {
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
      onViewChange={() => {}}
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
});
