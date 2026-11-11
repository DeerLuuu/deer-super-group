import { useCallback, useEffect, useRef, useState } from "react";
import type { MergeQueueItem } from "../git/types.js";

/**
 * P0-3/t226-t228：只读 MergeQueue 快照。
 * - `items=null`：未加载/加载失败，unknown；
 * - `items=[]`：已知为空；
 * - active（队列 Modal 打开）时 2s 短轮询，覆盖 approve/start/waive；
 * - 非 active 时 5s 背景轮询，覆盖 TaskVcs「加入合并队列」等 App 未收到回调的变化。
 * - request token 只接纳最新 workspace/key 响应，避免慢请求覆盖新状态。
 */
export function useMergeQueue(
  workspaceId: string | null | undefined,
  active: boolean,
  refreshKey: string,
) {
  const [items, setItems] = useState<MergeQueueItem[] | null>(null);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    if (!workspaceId || typeof window.deer.mergeQueue !== "function") {
      setItems(null);
      return;
    }
    try {
      const queue = await window.deer.mergeQueue(workspaceId);
      if (request === requestRef.current) setItems(queue.items);
    } catch {
      // 失败是 unknown，不是“已知空”；不能据此伪造无待合并。
      if (request === requestRef.current) setItems(null);
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

  // 背景刷新：TaskVcs enqueue/外部队列变化没有 App callback，靠现有 API 短轮询收敛。
  useEffect(() => {
    if (active || !workspaceId) return;
    const timer = window.setInterval(() => void reload(), 5_000);
    return () => window.clearInterval(timer);
  }, [active, reload, workspaceId]);

  return { items, reload };
}
