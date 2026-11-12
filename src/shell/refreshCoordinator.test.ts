import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_REFRESH_DOMAINS,
  RefreshCoordinator,
  domainsForEventType,
  type RefreshFlush,
} from "./refreshCoordinator.js";

afterEach(() => {
  vi.useRealTimers();
});

function event(seq: number, type: string) {
  return { seq, type };
}

describe("t282 R3 RefreshCoordinator", () => {
  it("maps events to domains and coalesces a burst into one flush after 120ms", async () => {
    vi.useFakeTimers();
    const flushes: RefreshFlush[] = [];
    const coordinator = new RefreshCoordinator({
      onFlush: (flush) => {
        flushes.push(flush);
      },
    });

    expect(domainsForEventType("task.created")).toEqual(["snapshot", "scheduler", "runs"]);
    expect(domainsForEventType("merge.enqueued")).toEqual(["mergeQueue", "snapshot"]);
    expect(domainsForEventType("watchdog.alert")).toEqual(["watchdog"]);
    expect(domainsForEventType("run.started")).toEqual(["runs", "snapshot", "scheduler"]);
    expect(domainsForEventType("run.heartbeat")).toEqual(["runs"]);
    expect(domainsForEventType("chat.reasoning")).toEqual([]);

    coordinator.notify(event(1, "task.created"));
    coordinator.notify(event(2, "merge.enqueued"));
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(119);
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].full).toBe(false);
    expect(flushes[0].generation).toBe(1);
    expect([...flushes[0].domains].sort()).toEqual(
      ["mergeQueue", "runs", "scheduler", "snapshot"].sort(),
    );
    coordinator.dispose();
  });

  it("ignores duplicate/out-of-order seq and does one full refresh on a gap", async () => {
    vi.useFakeTimers();
    const flushes: RefreshFlush[] = [];
    const coordinator = new RefreshCoordinator({
      onFlush: (flush) => {
        flushes.push(flush);
      },
    });
    coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(1);

    coordinator.notify(event(1, "task.updated"));
    coordinator.notify(event(0, "task.updated"));
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(1);

    coordinator.notify(event(4, "merge.enqueued"));
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(2);
    expect(flushes[1].full).toBe(true);
    expect([...flushes[1].domains]).toEqual([...ALL_REFRESH_DOMAINS]);
    coordinator.dispose();
  });

  it("keeps a single in-flight flush and batches events that arrive during it", async () => {
    vi.useFakeTimers();
    const flushes: RefreshFlush[] = [];
    let resolveFirst!: () => void;
    let calls = 0;
    const coordinator = new RefreshCoordinator({
      onFlush: (flush) => {
        flushes.push(flush);
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve();
      },
    });
    coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(1);

    coordinator.notify(event(2, "merge.enqueued"));
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(1); // in-flight 时不并发
    expect(coordinator.getPendingCount()).toBeGreaterThan(0);

    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(2);
    expect([...flushes[1].domains]).toEqual(["mergeQueue", "snapshot"]);
    coordinator.dispose();
  });

  it("retries with backoff and stops after maxRetries, marking stale", async () => {
    vi.useFakeTimers();
    let stale = 0;
    let attempts = 0;
    const coordinator = new RefreshCoordinator({
      onFlush: async () => {
        attempts += 1;
        throw new Error("offline");
      },
      onStale: () => {
        stale += 1;
      },
      maxRetries: 1,
    });
    coordinator.notify(event(1, "watchdog.alert"));
    await vi.advanceTimersByTimeAsync(120); // attempt 1 fails; retry at 120
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(120); // attempt 2 fails; stale
    expect(attempts).toBe(2);
    expect(stale).toBe(1);
    expect(coordinator.isStale()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2); // 不无限重试
    coordinator.dispose();
  });

  it("does not reset failure count on new events; offline storm stays stale", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let stale = 0;
    const coordinator = new RefreshCoordinator({
      onFlush: async () => {
        attempts += 1;
        throw new Error("offline");
      },
      onStale: () => {
        stale += 1;
      },
      maxRetries: 1,
    });
    coordinator.notify(event(1, "watchdog.alert"));
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(120);
    expect(attempts).toBe(2);
    expect(coordinator.isStale()).toBe(true);

    for (let seq = 2; seq <= 20; seq += 1) {
      coordinator.notify(event(seq, "watchdog.alert"));
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    expect(stale).toBe(1);
    expect(coordinator.isStale()).toBe(true);
    coordinator.dispose();
  });

  it("reset invalidates an in-flight generation and does not schedule the old batch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolveFirst!: () => void;
    const coordinator = new RefreshCoordinator({
      onFlush: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve();
      },
    });
    coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(calls).toBe(1);

    coordinator.reset();
    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(coordinator.getPendingCount()).toBe(0);
    expect(coordinator.isStale()).toBe(false);

    // 新一代 seq 重新起算并正常 flush。
    coordinator.notify(event(1, "task.created"));
    await vi.advanceTimersByTimeAsync(120);
    expect(calls).toBe(2);
    coordinator.dispose();
  });

  it("invalidateAll forces one full refresh for reconnect/missed events", async () => {
    vi.useFakeTimers();
    const flushes: RefreshFlush[] = [];
    const coordinator = new RefreshCoordinator({
      onFlush: (flush) => {
        flushes.push(flush);
      },
    });
    coordinator.invalidateAll();
    await vi.advanceTimersByTimeAsync(120);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].full).toBe(true);
    expect(new Set(flushes[0].domains)).toEqual(ALL_REFRESH_DOMAINS);
    coordinator.dispose();
  });
});
