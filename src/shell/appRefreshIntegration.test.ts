import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshCoordinator, ALL_REFRESH_DOMAINS, type RefreshDomain } from "./refreshCoordinator.js";

/**
 * t286 F6：App 级 event→IPC 集成测（fake IPC，复刻 App 的 token/generation/域读取）。
 * 不渲染整个 6k 行 App，但验证 App 接线契约：coalesce、不重复、不漏、旧响应丢弃。
 */
afterEach(() => {
  vi.useRealTimers();
});

type SnapshotState = { version: number };

function makeAppPipeline() {
  let appToken = 0;
  let generation = 0;
  let lastSeq = 0;
  let stale = false;
  let selectedTask: string | null = null;
  const state: SnapshotState = { version: 0 };
  const ipc = {
    getSnapshot: vi.fn(async (): Promise<SnapshotState> => ({ version: 99 })),
    getScheduler: vi.fn(async () => ({ ok: true as const, value: {} })),
    getWatchdog: vi.fn(async () => ({ ok: true as const, value: {} })),
    mergeQueue: vi.fn(async () => ({ items: [] })),
    getTrace: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ ok: true as const, value: [] })),
  };

  async function refreshDomains(domains: ReadonlySet<RefreshDomain>, token: number) {
    const isCurrent = () => token === appToken;
    if (domains.has("snapshot")) {
      const next = await ipc.getSnapshot();
      if (!isCurrent()) return;
      state.version = next.version;
    }
    const jobs: Promise<unknown>[] = [];
    if (domains.has("scheduler")) {
      jobs.push(
        ipc.getScheduler().then((result) => {
          if (!isCurrent() || !result.ok) throw new Error("scheduler failed");
        }),
      );
    }
    if (domains.has("watchdog")) jobs.push(ipc.getWatchdog());
    if (domains.has("mergeQueue")) jobs.push(ipc.mergeQueue());
    if ((domains.has("runs") || domains.has("trace")) && selectedTask) {
      jobs.push(ipc.getTrace());
      jobs.push(ipc.listRuns());
    }
    await Promise.all(jobs);
  }

  const coordinator = new RefreshCoordinator({
    onFlush: async (flush) => {
      const token = ++appToken;
      generation = flush.generation;
      lastSeq = flush.lastSeq;
      await refreshDomains(flush.domains, token);
      if (token === appToken) stale = false;
    },
    onStale: () => {
      stale = true;
    },
    maxRetries: 1,
  });

  return {
    coordinator,
    state,
    ipc,
    getToken: () => appToken,
    getGeneration: () => generation,
    getLastSeq: () => lastSeq,
    isStale: () => stale,
    setSelectedTask: (taskId: string | null) => {
      selectedTask = taskId;
    },
    manualRefresh: async () => {
      const token = ++appToken;
      try {
        await refreshDomains(ALL_REFRESH_DOMAINS, token);
        if (token === appToken) {
          stale = false;
          coordinator.markRecovered();
        }
      } catch (error) {
        if (token === appToken) {
          stale = true;
          coordinator.invalidateAll();
        }
        throw error;
      }
    },
    reset: () => {
      appToken += 1;
      coordinator.reset();
      stale = false;
    },
  };
}

function event(seq: number, type: string) {
  return { seq, type };
}

describe("t286 App-level event→IPC integration", () => {
  it("coalesces burst to one dirty-domain read set and keeps generation/lastSeq", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();
    app.coordinator.notify(event(1, "task.created"));
    app.coordinator.notify(event(2, "merge.enqueued"));
    app.coordinator.notify(event(3, "watchdog.alert"));
    await vi.advanceTimersByTimeAsync(120);

    expect(app.ipc.getSnapshot).toHaveBeenCalledTimes(1);
    expect(app.ipc.getScheduler).toHaveBeenCalledTimes(1);
    expect(app.ipc.mergeQueue).toHaveBeenCalledTimes(1);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(1);
    expect(app.ipc.listRuns).not.toHaveBeenCalled(); // 无 selectedTask
    expect(app.getGeneration()).toBe(1);
    expect(app.getLastSeq()).toBe(3);
    app.coordinator.dispose();
  });

  it("maps cost/provider/handoff/pr events to expected dirty IPC domains", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();

    app.coordinator.notify(event(1, "cost.updated"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getSnapshot).toHaveBeenCalledTimes(1);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(1);

    app.coordinator.notify(event(2, "provider.updated"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getSnapshot).toHaveBeenCalledTimes(2);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(2);

    app.coordinator.notify(event(3, "pr.opened"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getSnapshot).toHaveBeenCalledTimes(3);
    expect(app.ipc.mergeQueue).toHaveBeenCalledTimes(1);

    app.setSelectedTask("t1");
    app.coordinator.notify(event(4, "run.handoff_created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getTrace).toHaveBeenCalledTimes(1);
    expect(app.ipc.listRuns).toHaveBeenCalledTimes(1);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(3);
    app.coordinator.dispose();
  });

  it("manual full refresh shares stale/token and retries via coordinator on failure", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();
    app.ipc.getScheduler.mockRejectedValueOnce(new Error("offline"));
    await expect(app.manualRefresh()).rejects.toThrow("offline");
    expect(app.isStale()).toBe(true);
    expect(app.getToken()).toBe(1);

    app.ipc.getSnapshot.mockResolvedValue({ version: 8 });
    await app.manualRefresh();
    expect(app.isStale()).toBe(false);
    expect(app.state.version).toBe(8);
    app.coordinator.dispose();
  });

  it("manual success marks coordinator recovered and next event can flush", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();
    await app.manualRefresh();
    expect(app.isStale()).toBe(false);
    expect(app.coordinator.isStale()).toBe(false);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(1);

    app.coordinator.notify(event(1, "watchdog.alert"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getWatchdog).toHaveBeenCalledTimes(2);
    expect(app.coordinator.isStale()).toBe(false);
    app.coordinator.dispose();
  });

  it("drops old in-flight response after reset and applies the new generation only", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();
    let resolveOld!: (value: SnapshotState) => void;
    app.ipc.getSnapshot.mockReturnValueOnce(
      new Promise<SnapshotState>((resolve) => {
        resolveOld = resolve;
      }),
    );
    app.coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.ipc.getSnapshot).toHaveBeenCalledTimes(1);

    app.reset();
    resolveOld({ version: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.state.version).toBe(0); // 旧响应不得覆盖

    app.ipc.getSnapshot.mockResolvedValueOnce({ version: 2 });
    app.coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(app.state.version).toBe(2);
    app.coordinator.dispose();
  });

  it("propagates domain failure to coordinator backoff/stale without clearing last-good snapshot", async () => {
    vi.useFakeTimers();
    const app = makeAppPipeline();
    app.state.version = 7;
    app.ipc.getSnapshot.mockResolvedValue({ version: 7 });
    app.ipc.getScheduler.mockResolvedValue({ ok: false } as never);
    app.coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(120);
    expect(app.isStale()).toBe(true);
    expect(app.state.version).toBe(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.isStale()).toBe(true);
    app.coordinator.dispose();
  });
});
