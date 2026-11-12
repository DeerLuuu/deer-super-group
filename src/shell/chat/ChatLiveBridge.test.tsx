// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ChatLiveBridge } from "./ChatLiveBridge.js";
import { ChatLiveStore } from "./chatLiveStore.js";

const { act, create } = TestRenderer as any;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("t424 ChatLiveBridge per-agent routing", () => {
  it("dispatches events only to the matching agent store", async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    let listener: ((event: unknown) => void) | null = null;
    (globalThis as { window?: unknown }).window = {
      deer: {
        onChatEvent: (callback: (event: unknown) => void) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
    };
    try {
      const workspaceId = "ws";
      const router = new ChatLiveStore(workspaceId);
      const member = new ChatLiveStore(workspaceId);
      const stores = new Map([
        ["router", router],
        ["a1", member],
      ]);
      let renderer: any;
      await act(async () => {
        renderer = create(
          <ChatLiveBridge stores={stores} workspaceId={workspaceId} />,
        );
      });
      await act(async () => {
        listener?.({
          type: "delta",
          workspaceId,
          agentId: "a1",
          text: "member token",
        });
        listener?.({
          type: "delta",
          workspaceId,
          agentId: "router",
          text: "router token",
        });
      });
      expect(member.getSnapshot().stream).toBe("member token");
      expect(router.getSnapshot().stream).toBe("router token");
      await act(async () => {
        renderer.unmount();
      });
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});
