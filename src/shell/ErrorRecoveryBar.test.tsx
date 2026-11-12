// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import ErrorRecoveryBar from "./ErrorRecoveryBar.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    };
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

describe("t247 ErrorRecoveryBar", () => {
  it("shows one recovery action and calls the matching handler", async () => {
    const onOpenSettings = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ErrorRecoveryBar
          message="401 unauthorized invalid api key"
          onOpenSettings={onOpenSettings}
          onOpenModels={() => {}}
          onRetry={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(textOf(renderer!.toJSON())).toContain("Provider 认证失败");
    const primary = renderer!.root
      .findAllByType("button")
      .filter((button) => button.props.className === "primary tiny");
    expect(primary).toHaveLength(1);
    await act(() => {
      (primary[0]!.props.onClick as () => void)();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(textOf(renderer!.toJSON())).not.toContain("sk-secret");
  });

  it("uses the provided write-retry callback instead of generic refresh", async () => {
    const run = vi.fn();
    const onRetry = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ErrorRecoveryBar
          message="network fetch failed"
          retryAction={{ label: "重试创建任务", run }}
          onOpenSettings={() => {}}
          onOpenModels={() => {}}
          onRetry={onRetry}
          onClose={() => {}}
        />,
      );
    });
    const primary = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.className === "primary tiny");
    expect(textOf(primary!.children)).toContain("重试创建任务");
    await act(() => {
      (primary!.props.onClick as () => void)();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("labels generic retry as refresh and states it will not resend", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ErrorRecoveryBar
          message="network timeout"
          onOpenSettings={() => {}}
          onOpenModels={() => {}}
          onRetry={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(textOf(renderer!.toJSON())).toContain("刷新");
    expect(textOf(renderer!.toJSON())).toContain("不会重发原操作");
  });
});
