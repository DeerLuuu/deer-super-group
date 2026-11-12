// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import ApprovalTerms from "./ApprovalTerms.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown>; children: unknown[] }> };
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

describe("t251 approval terminology", () => {
  it("renders a note with aria-label distinguishing task delivery/code review/merge", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<ApprovalTerms />);
    });
    const note = renderer!.root.findAllByProps({ role: "note" })[0];
    expect(note!.props["aria-label"]).toBe("批准术语说明");
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("任务交付批准");
    expect(text).toContain("代码评审通过");
    expect(text).toContain("合并确认");
  });
});
