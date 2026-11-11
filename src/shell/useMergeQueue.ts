import { useCallback, useEffect, useState } from "react";
import type { MergeQueueItem } from "../git/types.js";

/**
 * P0-3/t226：只读 MergeQueue 快照。
 * - `items=null`：未加载/加载失败，unknown；
 * - `items=[]`：已知为空；
 * - active（队列 Modal 打开）时短轮询，覆盖 approve/start/waive 后 App 不会被通知的情况。
 */
export function useMergeQueue(
  workspaceId: string | null | undefined,
  active: boolean,
  refreshKey: string,
) {
  const [items, setItems] = useState<MergeQueueItem[] | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId || typeof window.deer.mergeQueue !== "function") {
      setItems(null);
      return;
    }
    try {
      const queue = await window.deer.mergeQueue(workspaceId);
      setItems(queue.items);
    } catch {
      // 失败是 unknown，不是“已知空”；不能据此伪造无待合并。
      setItems(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!active) return;
    void reload();
    const timer = window.setInterval(() => void reload(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, reload]);

  return { items, reload };
}
