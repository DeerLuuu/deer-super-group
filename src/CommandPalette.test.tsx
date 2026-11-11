// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./shared/types.js";
import { hasOpenModal } from "./shared/modalStack.js";
import CommandPalette from "./CommandPalette.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: { findAllByType: (type: string) => Array<{ props: Record<string, unknown> }> };
    unmount: () => void;
  };
};

class FakeElement {
  focus = vi.fn();
  inert = false;
  hidden = false;
  style: Record<string, string> = {};
  toggleAttribute() {}
  setAttribute() {}
  removeAttribute() {}
  querySelectorAll() {
    return [];
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalDocument = (globalThis as { document?: unknown }).document;
const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = originalDocument;
  if (originalHTMLElement === undefined) delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  else (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
});

function makeSnapshot(): Snapshot {
  return { tasks: [], agents: [], messages: [], boardEntries: [] } as unknown as Snapshot;
}

describe("t198 CommandPalette modal layer", () => {
  it("registers in modalStack and closes through the top-level Escape path", async () => {
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
    (globalThis as { document?: unknown }).document = {
      activeElement: new FakeElement(),
      body: { style: {} },
      getElementById: () => null,
    };
    const onClose = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <CommandPalette
          snapshot={makeSnapshot()}
          onClose={onClose}
          onNavigate={() => {}}
          onOpenTask={() => {}}
          onOpenMessage={() => {}}
          onOpenBoard={() => {}}
          onCreate={() => {}}
        />,
      );
    });
    expect(hasOpenModal()).toBe(true);
    const input = renderer!.root.findAllByType("input")[0];
    expect(input).toBeTruthy();
    await act(() => {
      (input.props.onKeyDown as (event: unknown) => void)({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.unmount();
    });
    expect(hasOpenModal()).toBe(false);
  });
});
