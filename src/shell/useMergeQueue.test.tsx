// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergeQueueItem } from "../git/types.js";
import { useMergeQueue } from "./useMergeQueue.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queueItem(): MergeQueueItem {
  return {
    id: "m1",
    workspaceId: "ws",
    taskId: "t1",
    taskTitle: "Demo",
    provider: "local",
    prNumber: null,
    prUrl: null,
    branch: "b",
    state: "ready",
    position: 1,
    headSha: "a",
    baseSha: "b",
    approvedHeadSha: null,
    checks: { state: "passed", summary: "" },
    checksWaived: false,
    retryAt: null,
    review: "",
    conflictTaskId: null,
    lastError: null,
    mergeCommitSha: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

function harness(
  active: boolean,
  onItems: (items: MergeQueueItem[] | null) => void,
  onStale?: (stale: boolean) => void,
) {
  function Harness() {
    const { items, reload, stale } = useMergeQueue("ws", active, "key");
    onItems(items);
    onStale?.(stale);
    return (
      <button type="button" onClick={() => void reload()}>
        reload
      </button>
    );
  }
  return <Harness />;
}

describe("t226 useMergeQueue unknown/empty/refresh", () => {
  it("keeps last-good on failure and marks stale", async () => {
    const mergeQueue = vi
      .fn()
      .mockResolvedValueOnce({ items: [], activeMerge: null })
      .mockResolvedValueOnce({ items: [queueItem()], activeMerge: null })
      .mockRejectedValueOnce(new Error("fail"));
    (globalThis as { window?: unknown }).window = {
      deer: { mergeQueue },
      setInterval: () => 1,
      clearInterval: () => {},
    };
    let items: MergeQueueItem[] | null = null;
    let stale = false;
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(harness(false, (next) => (items = next), (next) => (stale = next)));
      await Promise.resolve();
    });
    expect(items).toEqual([]); // known empty, not null

    const reload = renderer!.root.findAllByType("button")[0];
    await act(async () => {
      (reload.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(items).toHaveLength(1); // pending
    expect((items as unknown as MergeQueueItem[])[0]?.state).toBe("ready");
    expect(stale).toBe(false);

    await act(async () => {
      (reload.props.onClick as () => void)();
      await Promise.resolve();
    });
    // R3：失败保留 last-good，不伪造 unknown/空。
    expect(items).toHaveLength(1);
    expect(stale).toBe(true);
  });

  it("polls while active and reloads on demand/refresh key", async () => {
    let timerCallback: (() => void) | null = null;
    const mergeQueue = vi.fn(async () => ({ items: [] as MergeQueueItem[], activeMerge: null }));
    (globalThis as { window?: unknown }).window = {
      deer: { mergeQueue },
      setInterval: (callback: () => void) => {
        timerCallback = callback;
        return 1;
      },
      clearInterval: () => {},
    };
    let items: MergeQueueItem[] | null = null;
    await act(async () => {
      create(harness(true, (next) => (items = next)));
      await Promise.resolve();
    });
    expect(mergeQueue).toHaveBeenCalled();
    expect(items).toEqual([]);
    expect(timerCallback).not.toBeNull();
    await act(async () => {
      timerCallback?.();
      await Promise.resolve();
    });
    expect(mergeQueue.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not poll while inactive (R3 event-driven)", async () => {
    let intervals = 0;
    const mergeQueue = vi.fn(async () => ({
      items: [] as MergeQueueItem[],
      activeMerge: null,
    }));
    (globalThis as { window?: unknown }).window = {
      deer: { mergeQueue },
      setInterval: () => {
        intervals += 1;
        return 1;
      },
      clearInterval: () => {},
    };
    let items: MergeQueueItem[] | null = null;
    await act(async () => {
      create(harness(false, (next) => (items = next)));
      await Promise.resolve();
    });
    expect(items).toEqual([]);
    expect(intervals).toBe(0);
    expect(mergeQueue).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale response after a newer request", async () => {
    let resolveFirst!: (value: { items: MergeQueueItem[]; activeMerge: null }) => void;
    let resolveSecond!: (value: { items: MergeQueueItem[]; activeMerge: null }) => void;
    const mergeQueue = vi
      .fn()
      .mockResolvedValueOnce({ items: [] as MergeQueueItem[], activeMerge: null })
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
    (globalThis as { window?: unknown }).window = {
      deer: { mergeQueue },
      setInterval: () => 1,
      clearInterval: () => {},
    };
    let items: MergeQueueItem[] | null = null;
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(harness(false, (next) => (items = next)));
      await Promise.resolve();
    });
    const reload = renderer!.root.findAllByType("button")[0];
    await act(async () => {
      (reload.props.onClick as () => void)();
      (reload.props.onClick as () => void)();
      await Promise.resolve();
    });
    await act(async () => {
      resolveSecond({ items: [queueItem()], activeMerge: null });
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst({ items: [], activeMerge: null });
      await Promise.resolve();
    });
    expect((items as unknown as MergeQueueItem[])[0]?.state).toBe("ready");
  });

  it("distinguishes first-load failure and reopens after close", async () => {
    const mergeQueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue down"))
      .mockResolvedValue({ items: [] as MergeQueueItem[], activeMerge: null });
    (globalThis as { window?: unknown }).window = {
      deer: { mergeQueue },
      setInterval: () => 1,
      clearInterval: () => {},
    };
    let state: ReturnType<typeof useMergeQueue> | null = null;
    function Harness({ active }: { active: boolean }) {
      state = useMergeQueue("ws", active, "key");
      return null;
    }
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<Harness active={false} />);
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(state!.items).toBeNull();
    expect(state!.error).toContain("queue down");
    expect(state!.loading).toBe(false);

    await act(async () => {
      await state!.reload();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(state!.items).toEqual([]);
    expect(state!.error).toBeNull();

    const calls = mergeQueue.mock.calls.length;
    await act(async () => {
      (renderer as any).update(<Harness active={true} />);
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(mergeQueue.mock.calls.length).toBeGreaterThan(calls);
    await act(async () => {
      (renderer as any).update(<Harness active={false} />);
    });
  });
});
