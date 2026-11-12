import { useEffect, useRef } from "react";
import type { ChatEvent } from "../../shared/types.js";
import type { ChatLiveSettled } from "../../shared/chatLive.js";
import type { ChatLiveStore } from "./chatLiveStore.js";

/**
 * t260（R1）：只做事件桥接，不持有 React state。
 * 挂在 App 顶层，即使 Chat panel 被关闭仍能接收 done/cancel/error；
 * token 只写 external store，不触发 App setState。
 */
export function ChatLiveBridge({
  store,
  workspaceId,
  onSettled,
}: {
  store: ChatLiveStore;
  workspaceId: string;
  onSettled?: (settled: ChatLiveSettled) => void;
}) {
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    store.setWorkspace(workspaceId);
    const off = window.deer.onChatEvent((event: ChatEvent) => {
      if (event.workspaceId !== workspaceId) return;
      const settled = store.dispatch(event);
      if (settled) onSettledRef.current?.(settled);
    });
    return off;
  }, [store, workspaceId]);

  return null;
}
