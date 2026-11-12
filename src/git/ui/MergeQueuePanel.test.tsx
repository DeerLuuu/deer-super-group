// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeQueuePanel } from "./MergeQueuePanel";
import type { MergeQueueItem } from "../types.js";

vi.mock("../../Modal.js", () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section role="dialog" aria-label={title}>{children}</section>
  ),
}));

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; toJSON: () => unknown; unmount: () => void };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(overrides: Partial<MergeQueueItem> = {}): MergeQueueItem {
  return {
    id: "q1",
    workspaceId: "ws1",
    taskId: "t3",
    taskTitle: "Ship merge queue panel",
    provider: "github",
    prNumber: 45,
    prUrl: "https://example.test/pr/45",
    branch: "deer/t3-merge-queue",
    state: "ready",
    position: 1,
    headSha: "abc",
    baseSha: "def",
    approvedHeadSha: null,
    checks: { state: "success", summary: "all green" },
    checksWaived: false,
    retryAt: null,
    review: "pass",
    conflictTaskId: null,
    lastError: null,
    mergeCommitSha: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mount(items: MergeQueueItem[] | null, extra: Partial<React.ComponentProps<typeof MergeQueuePanel>> = {}) {
  const onReload = vi.fn(async () => undefined);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <MergeQueuePanel workspaceId="ws1" items={items} onReload={onReload} {...extra} />,
    );
  });
  return { renderer, onReload };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

describe("MergeQueuePanel", () => {
  it("renders summary/list and opens a single confirmation Modal for merge", async () => {
    const mergeStart = vi.fn(async () => undefined);
    (globalThis as { window?: unknown }).window = { deer: { mergeStart, mergeApprove: vi.fn(), mergeWaiveChecks: vi.fn() } };
    const { renderer, onReload } = mount([item()]);
    expect(JSON.stringify(renderer.toJSON())).toContain("Ship merge queue panel");
    const readyBadge = renderer.root.findAllByType("span").find((node: any) => node.children.includes("可合并 "));
    expect(readyBadge?.children).toContain("1");
    const refresh = renderer.root.findAllByType("button").find((node: any) => node.children.includes("刷新"));
    await act(async () => {
      refresh!.props.onClick();
      await Promise.resolve();
    });
    expect(onReload).toHaveBeenCalled();
    const mergeButton = renderer.root.findAllByType("button").find((node: any) => node.children.includes("合并…"));
    expect(mergeButton).toBeTruthy();
    act(() => mergeButton!.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain("确认合并");
    const confirm = renderer.root.findAllByType("button").find((node: any) => node.children.includes("确认合并"));
    await act(async () => {
      confirm!.props.onClick();
      await Promise.resolve();
    });
    expect(mergeStart).toHaveBeenCalledWith("t3");
    expect(onReload).toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("确认将");
  });

  it("approves and waives from the panel without a confirmation Modal", async () => {
    const mergeApprove = vi.fn(async () => undefined);
    const mergeWaiveChecks = vi.fn(async () => undefined);
    (globalThis as { window?: unknown }).window = { deer: { mergeApprove, mergeWaiveChecks, mergeStart: vi.fn() } };
    const { renderer } = mount([item({ state: "waiting_review" })]);
    const buttons = renderer.root.findAllByType("button");
    await act(async () => {
      buttons.find((node: any) => node.children.includes("批准"))!.props.onClick();
      await Promise.resolve();
    });
    expect(mergeApprove).toHaveBeenCalledWith("t3");
    const input = renderer.root.findByType("input");
    act(() => input.props.onChange({ target: { value: "manual review completed" } }));
    const waive = renderer.root.findAllByType("button").find((node: any) => node.children.includes("豁免"));
    await act(async () => {
      waive!.props.onClick();
      await Promise.resolve();
    });
    expect(mergeWaiveChecks).toHaveBeenCalledWith("t3", "manual review completed");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("role=\"dialog\"");
  });

  it("shows an action failure without clearing the queue", async () => {
    (globalThis as { window?: unknown }).window = {
      deer: { mergeApprove: vi.fn(async () => { throw new Error("approve failed"); }) },
    };
    const { renderer } = mount([item({ state: "waiting_review" })]);
    const approve = renderer.root.findAllByType("button").find((node: any) => node.children.includes("批准"));
    await act(async () => {
      approve!.props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("approve failed");
    expect(JSON.stringify(renderer.toJSON())).toContain("Ship merge queue panel");
  });

  it("shows loading, empty and conflict states", () => {
    const loading = mount(null);
    expect(JSON.stringify(loading.renderer.toJSON())).toContain("加载合并队列");
    loading.renderer.unmount();

    const empty = mount([]);
    expect(JSON.stringify(empty.renderer.toJSON())).toContain("队列为空");
    empty.renderer.unmount();

    const conflict = mount([item({ conflictTaskId: "conflict-1", lastError: "merge conflict" })]);
    expect(JSON.stringify(conflict.renderer.toJSON())).toContain("冲突任务");
    expect(JSON.stringify(conflict.renderer.toJSON())).toContain("merge conflict");
    conflict.renderer.unmount();
  });

  it("closes the confirmation Modal without merging", () => {
    (globalThis as { window?: unknown }).window = { deer: { mergeStart: vi.fn() } };
    const { renderer } = mount([item()]);
    const open = renderer.root.findAllByType("button").find((node: any) => node.children.includes("合并…"));
    act(() => open!.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain("确认合并");
    const cancel = renderer.root.findAllByType("button").find((node: any) => node.children.includes("取消"));
    act(() => cancel!.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).not.toContain("确认将");
  });
});
