// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
vi.mock("../Modal.js", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
import { TaskComposeModal } from "../App.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("t255 TaskComposeModal failure retention", () => {
  it("keeps the form open and its input after a failed create", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn(async () => false);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskComposeModal busy={false} onClose={onClose} onCreate={onCreate} />,
      );
    });
    const title = renderer!.root
      .findAllByType("input")
      .find((input) => String(input.props.placeholder ?? "").includes("健康检查"))!;
    await act(() => {
      (title.props.onChange as (event: unknown) => void)({
        target: { value: "失败时保留的任务" },
      });
    });
    const form = renderer!.root.findAllByType("form")[0]!;
    await act(async () => {
      await (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault: vi.fn(),
      });
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(title.props.value).toBe("失败时保留的任务");
  });

  it("closes after a successful create", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn(async () => true);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <TaskComposeModal busy={false} onClose={onClose} onCreate={onCreate} />,
      );
    });
    const title = renderer!.root.findAllByType("input")[0]!;
    await act(() => {
      (title.props.onChange as (event: unknown) => void)({ target: { value: "成功任务" } });
    });
    const form = renderer!.root.findAllByType("form")[0]!;
    await act(async () => {
      await (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault: vi.fn(),
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
