import { useEffect, useRef } from "react";
import type { ChatEvent } from "../../shared/types.js";
import type { ChatLiveSettled } from "../../shared/chatLive.js";
import type { ChatLiveStore } from "./chatLiveStore.js";

/**
 * t424：按 agent 路由实时事件。切走的 agent 仍继续接收/保留自己的 live tail，
 * 只有当前选中的 store 渲染到 ChatView。
 */
export function ChatLiveBridge({
  stores,
  workspaceId,
  onSettled,
}: {
  stores: Map<string, ChatLiveStore>;
  workspaceId: string;
  onSettled?: (agentId: string, settled: ChatLiveSettled) => void;
}) {
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    for (const store of stores.values()) store.setWorkspace(workspaceId);
    const off = window.deer.onChatEvent((event: ChatEvent) => {
      if (event.workspaceId !== workspaceId) return;
      const store = stores.get(event.agentId);
      if (!store) return;
      const settled = store.dispatch(event);
      if (settled) onSettledRef.current?.(event.agentId, settled);
    });
    return off;
  }, [stores, workspaceId]);

  return null;
}
