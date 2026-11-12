export type RefreshDomain =
  | "snapshot"
  | "scheduler"
  | "watchdog"
  | "mergeQueue"
  | "runs"
  | "trace";

export const REFRESH_DOMAINS: readonly RefreshDomain[] = [
  "snapshot",
  "scheduler",
  "watchdog",
  "mergeQueue",
  "runs",
  "trace",
];

export const ALL_REFRESH_DOMAINS: ReadonlySet<RefreshDomain> = new Set(REFRESH_DOMAINS);

export type RefreshEventLike = {
  seq: number;
  type: string;
};

export type RefreshFlush = {
  domains: ReadonlySet<RefreshDomain>;
  /** seq gap / reconnect：本次必须做一次 full refresh。 */
  full: boolean;
  /** 单调递增；旧响应应被 App 忽略。 */
  generation: number;
  lastSeq: number;
};

export type RefreshCoordinatorOptions = {
  onFlush: (flush: RefreshFlush) => void | Promise<void>;
  onStale?: () => void;
  coalesceMs?: number;
  maxRetries?: number;
};

export function domainsForEventType(type: string): readonly RefreshDomain[] {
  if (type.startsWith("task.")) return ["snapshot", "scheduler", "runs"];
  if (type.startsWith("scheduler.")) return ["snapshot", "scheduler"];
  if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") {
    return ["runs", "snapshot", "scheduler"];
  }
  if (type.startsWith("run.")) return ["runs"];
  if (type.startsWith("merge.") || type.startsWith("git.")) {
    return ["mergeQueue", "snapshot"];
  }
  if (type.startsWith("watchdog.")) return ["watchdog"];
  if (
    type.startsWith("agent.") ||
    type.startsWith("mailbox.") ||
    type.startsWith("board.") ||
    type.startsWith("memory.") ||
    type.startsWith("approval.")
  ) {
    return ["snapshot"];
  }
  // chat.* 走 ChatLiveBridge；这里不触达 snapshot，避免 token/思考事件触发 5–7 IPC。
  return [];
}

/**
 * t282（R3）：事件驱动的刷新协调器。
 *
 * - event → domain 映射；
 * - 120ms coalesce（同一窗口内所有域合并一次）；
 * - 单飞 in-flight；期间事件进入下一批；
 * - seq gap → 一次 full refresh；
 * - 失败有限重试 + 指数 backoff，超过上限标记 stale，不无限重试。
 */
export class RefreshCoordinator {
  private pending = new Set<RefreshDomain>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingWhileInFlight = false;
  private full = false;
  private lastSeq = 0;
  private failures = 0;
  private generation = 0;
  private stale = false;
  private disposed = false;
  private retryDelay: number | null = null;

  constructor(private readonly options: RefreshCoordinatorOptions) {}

  getLastSeq(): number {
    return this.lastSeq;
  }

  isStale(): boolean {
    return this.stale;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  notify(event: RefreshEventLike): void {
    if (this.disposed) return;
    if (!Number.isFinite(event.seq) || event.seq <= this.lastSeq) return;

    const gap = this.lastSeq > 0 && event.seq !== this.lastSeq + 1;
    this.lastSeq = event.seq;
    this.failures = 0;
    this.stale = false;

    if (gap) {
      this.full = true;
      for (const domain of REFRESH_DOMAINS) this.pending.add(domain);
    } else {
      for (const domain of domainsForEventType(event.type)) this.pending.add(domain);
    }
    if (this.pending.size === 0) return;
    this.schedule(this.coalesceMs());
  }

  /** 重连/漏事件演练：强制一次 full refresh，不依赖 seq。 */
  invalidateAll(): void {
    if (this.disposed) return;
    this.full = true;
    for (const domain of REFRESH_DOMAINS) this.pending.add(domain);
    this.failures = 0;
    this.stale = false;
    this.retryDelay = null;
    this.schedule(this.coalesceMs());
  }

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.inFlight = false;
    this.pendingWhileInFlight = false;
    this.full = false;
    this.lastSeq = 0;
    this.failures = 0;
    this.stale = false;
    this.retryDelay = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private coalesceMs(): number {
    return this.options.coalesceMs ?? 120;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer !== null || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      this.pendingWhileInFlight = true;
      return;
    }
    if (this.pending.size === 0) return;

    const domains = new Set(this.pending);
    const full = this.full;
    this.pending.clear();
    this.full = false;
    this.inFlight = true;
    const generation = ++this.generation;

    try {
      await this.options.onFlush({
        domains,
        full,
        generation,
        lastSeq: this.lastSeq,
      });
      this.failures = 0;
      this.stale = false;
      this.retryDelay = null;
    } catch {
      this.failures += 1;
      if (this.failures <= (this.options.maxRetries ?? 3)) {
        for (const domain of domains) this.pending.add(domain);
        this.retryDelay = this.coalesceMs() * 2 ** (this.failures - 1);
      } else {
        this.stale = true;
        this.retryDelay = null;
        this.options.onStale?.();
      }
    } finally {
      this.inFlight = false;
      if (this.pendingWhileInFlight) {
        this.pendingWhileInFlight = false;
        if (this.pending.size > 0) this.schedule(this.coalesceMs());
      } else if (this.pending.size > 0) {
        this.schedule(this.retryDelay ?? this.coalesceMs());
        this.retryDelay = null;
      }
    }
  }
}
