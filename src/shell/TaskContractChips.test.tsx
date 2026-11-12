// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { TaskContractChips } from "./TaskContractChips.js";
import type { ExecutionContract } from "./executionContract.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> };
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

const contract: ExecutionContract = {
  ownerId: "a1",
  ownerName: "Ren",
  model: "deepseek-flash",
  permission: "workspace_write",
  permissionLabel: "工作区内修改",
  fullThrottle: "开启（会话级）",
  context: "trace 3 条",
  source: "owner",
};

describe("t337 TaskContractChips", () => {
  it("shows read-only contract chips and navigates to model/owner edit", async () => {
    const onOpenModels = vi.fn();
    const onEditOwner = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskContractChips
          contract={contract}
          fullThrottle
          onOpenModels={onOpenModels}
          onEditOwner={onEditOwner}
        />,
      );
    });
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("模型");
    expect(text).toContain("deepseek-flash");
    expect(text).toContain("权限");
    expect(text).toContain("工作区内修改");
    expect(text).toContain("workspace_write");
    expect(text).toContain("开启（会话级）");
    expect(text).toContain("trace 3 条");
    expect(renderer!.root.findByProps({ "aria-label": "执行契约（只读）" })).toBeTruthy();
    const buttons = renderer!.root.findAllByType("button");
    await act(async () => {
      (buttons[0]!.props.onClick as () => void)();
      (buttons[1]!.props.onClick as () => void)();
    });
    expect(onOpenModels).toHaveBeenCalledTimes(1);
    expect(onEditOwner).toHaveBeenCalledWith("a1");
    await act(async () => renderer!.unmount());
  });

  it("shows unknown/default without inventing values", async () => {
    const unknown: ExecutionContract = {
      ...contract,
      ownerId: null,
      ownerName: "未分配",
      model: "未知",
      permission: "未知",
      permissionLabel: "未知",
      context: "无 trace",
      source: "unassigned",
    };
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskContractChips
          contract={unknown}
          fullThrottle={false}
          onOpenModels={() => {}}
          onEditOwner={() => {}}
        />,
      );
    });
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("未知");
    expect(text).toContain("无 trace");
    expect(text).not.toContain("默认模型");
    await act(async () => renderer!.unmount());
  });
});
