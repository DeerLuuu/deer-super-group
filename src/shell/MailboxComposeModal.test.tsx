// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
vi.mock("../Modal.js", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
import { MailboxComposeModal } from "../App.js";
import type { Snapshot } from "../shared/types.js";

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

describe("t255 MailboxComposeModal failure retention", () => {
  it("keeps the compose form open when send fails", async () => {
    const onClose = vi.fn();
    const onSend = vi.fn(async () => false);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <MailboxComposeModal
          snapshot={{ agents: [] } as unknown as Snapshot}
          busy={false}
          onClose={onClose}
          onSend={onSend}
        />,
      );
    });
    const inputs = renderer!.root.findAllByType("input");
    const subject = inputs[1]!;
    const body = renderer!.root.findAllByType("textarea")[0]!;
    await act(() => {
      (subject.props.onChange as (event: unknown) => void)({ target: { value: "保留主题" } });
      (body.props.onChange as (event: unknown) => void)({ target: { value: "保留正文" } });
    });
    const form = renderer!.root.findAllByType("form")[0]!;
    await act(async () => {
      await (form.props.onSubmit as (event: unknown) => Promise<void>)({
        preventDefault: vi.fn(),
      });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(subject.props.value).toBe("保留主题");
    expect(body.props.value).toBe("保留正文");
  });
});
