// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "./Toast.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    unmount: () => void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

describe("t296 Toast focus pause", () => {
  it("pauses auto-dismiss while keyboard focus is inside", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    const onDismiss = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <ToastHost
          toasts={[{ id: 1, kind: "error", message: "失败", action: { label: "重试", onClick: () => {} } }]}
          onDismiss={onDismiss}
        />,
      );
    });
    const row = renderer!.root.findAllByProps({ role: "alert" })[0]!;
    await act(() => {
      (row.props.onFocus as () => void)();
    });
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    await act(() => {
      (row.props.onBlur as () => void)();
    });
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(onDismiss).toHaveBeenCalledWith(1);
    await act(async () => {
      renderer!.unmount();
    });
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });
});
