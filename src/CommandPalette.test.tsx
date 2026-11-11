// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { portalTargets } = vi.hoisted(() => ({ portalTargets: [] as unknown[] }));

// The repository has no jsdom/RTL. Keep the real portal call/body target and
// render the portal payload in place so the test can assert the inert boundary.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    createPortal: (node: unknown, target: unknown) => {
      portalTargets.push(target);
      return node;
    },
  };
});

import type { Snapshot } from "./shared/types.js";
import { hasOpenModal } from "./shared/modalStack.js";
import CommandPalette, { CREATE_LABELS, CREATE_TARGET_TAB } from "./CommandPalette.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (
    element: unknown,
    options?: { createNodeMock?: (element: { type: string }) => unknown },
  ) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown> }>;
      findByProps: (props: Record<string, unknown>) => { props: Record<string, unknown> };
    };
    unmount: () => void;
  };
};

class FakeElement {
  focus = vi.fn();
  inert = false;
  hidden = false;
  style: Record<string, string> = {};
  tagName = "DIV";
  toggleAttribute(name: string, force?: boolean) {
    if (name === "inert") this.inert = Boolean(force);
  }
  setAttribute(name: string, value: string) {
    if (name === "aria-hidden") this.hidden = value === "true";
  }
  removeAttribute(name: string) {
    if (name === "aria-hidden") this.hidden = false;
  }
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
  portalTargets.length = 0;
});

function makeSnapshot(): Snapshot {
  return { tasks: [], agents: [], messages: [], boardEntries: [] } as unknown as Snapshot;
}

describe("t200 CommandPalette inert-root boundary", () => {
  it("t235 plan create routes through Tasks shell (which opens Plan Draft)", () => {
    expect(CREATE_TARGET_TAB.plan).toBe("tasks");
    expect(CREATE_LABELS.plan).toContain("规划任务");
  });

  it("portals to body while #root is inert; input/Esc/Tab/focus work and close restores trigger", async () => {
    const root = new FakeElement();
    const body = new FakeElement();
    body.tagName = "BODY";
    const trigger = new FakeElement();
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
    (globalThis as { document?: unknown }).document = {
      activeElement: trigger,
      body,
      getElementById: (id: string) => (id === "root" ? root : null),
    };

    let inputFocusCalls = 0;
    const inputFocus = vi.fn(() => {
      inputFocusCalls += 1;
    });
    const inputNode = new FakeElement();
    inputNode.focus = inputFocus;
    const first = new FakeElement();
    const last = new FakeElement();
    let dialogItems: FakeElement[] = [];
    const dialogNode: FakeElement & { querySelectorAll: () => FakeElement[] } = Object.assign(
      new FakeElement(),
      { querySelectorAll: () => dialogItems },
    );

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
        {
          createNodeMock: (element) => {
            if (element.type === "input") return inputNode;
            if (element.type === "div") return dialogNode;
            return new FakeElement();
          },
        },
      );
      await Promise.resolve();
    });

    // Real structure: #root exists and the stack sets it inert; palette must be
    // outside it (target body), so the input can still receive focus.
    expect(root.inert).toBe(true);
    expect(portalTargets[0]).toBe(body);
    expect(inputFocusCalls).toBe(1);
    expect(hasOpenModal()).toBe(true);

    const input = renderer!.root.findAllByType("input")[0];
    expect(input).toBeTruthy();

    // Esc works from the portal input.
    (input.props.onKeyDown as (event: unknown) => void)({
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Tab trap uses the portal dialog and wraps from last to first.
    dialogItems = [first, last];
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    (globalThis as unknown as { document: { activeElement: FakeElement } }).document.activeElement =
      last;
    (dialog.props.onKeyDown as (event: unknown) => void)({
      key: "Tab",
      shiftKey: false,
      preventDefault: vi.fn(),
    });
    expect(first.focus).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.unmount();
    });
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(hasOpenModal()).toBe(false);
    expect(root.inert).toBe(false);
  });
});
