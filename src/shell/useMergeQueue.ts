import { useCallback, useEffect, useRef, useState } from "react";
import type { MergeQueueItem } from "../git/types.js";

/**
 * P0-3/t226-t228：只读 MergeQueue 快照。
 * - `items=null`：未加载/首次失败，unknown；
 * - `items=[]`：已知为空；
 * - `stale=true`：最近一次读取失败，保留 last-good 而不是伪造成空；
 * - active（队列 Modal 打开）时 2s 短轮询，覆盖 approve/start/waive；
 * - R3：隐藏时不再 5s 背景轮询，由 RefreshCoordinator 的 merge/git 事件域触发 reload。
 * - request token 只接纳最新 workspace/key 响应，避免慢请求覆盖新状态。
 */
export function useMergeQueue(
  workspaceId: string | null | undefined,
  active: boolean,
  refreshKey: string,
) {
  const [items, setItems] = useState<MergeQueueItem[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(
    async (options: { strict?: boolean; guard?: () => boolean } = {}) => {
      const request = ++requestRef.current;
      if (!workspaceId || typeof window.deer.mergeQueue !== "function") {
        setItems(null);
        setStale(false);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const queue = await window.deer.mergeQueue(workspaceId);
        if (options.guard && !options.guard()) return;
        if (request === requestRef.current) {
          setItems(queue.items);
          setStale(false);
          setError(null);
        }
      } catch (cause) {
        if (options.guard && !options.guard()) return;
        // R3：保留 last-good；失败只标记 stale，不把已知队列伪造成空/未知。
        if (request === requestRef.current) {
          setStale(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        if (options.strict) throw cause;
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!active) return;
    void reload();
    const timer = window.setInterval(() => void reload(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, reload]);

  return { items, reload, stale, error, loading };
}
