// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import SkipLink from "./SkipLink.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("t296 skip link", () => {
  it("is an anchor to the main landmark", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<SkipLink />);
    });
    const link = renderer!.root.findAllByType("a")[0]!;
    expect(link.props.className).toBe("skip-link");
    expect(link.props.href).toBe("#main-content");
  });
});
