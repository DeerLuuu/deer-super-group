// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The repository has no jsdom/RTL; make Modal's portal render in-place for this
// focused stack test while keeping the real component implementation.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

import Modal from "../../Modal.js";
import { hasOpenModal } from "../../shared/modalStack.js";
import { MergeQueueModal } from "./GitPanels.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { unmount: () => void };
};

class FakeElement {
  focus = vi.fn();
  inert = false;
  hidden = false;
  style: Record<string, string> = {};
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

/** Mirrors App.tsx's guarded global shortcut handler; this is a contract probe,
 * not a second implementation: the gate is the production hasOpenModal(). */
function guardedShortcut(
  event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  onNavigate: () => void,
  onPalette: () => void,
) {
  if (hasOpenModal()) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-6]$/.test(event.key)) {
    onNavigate();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    onPalette();
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalDocument = (globalThis as { document?: unknown }).document;
const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = originalDocument;
  if (originalHTMLElement === undefined) delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  else (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe("t198 MergeQueue is a first-class modal layer", () => {
  it("registers in the common stack and Esc only closes the queue on top", async () => {
    const keyHandlers: Array<(event: KeyboardEvent) => void> = [];
    const root = new FakeElement();
    const trigger = new FakeElement();
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
    (globalThis as { document?: unknown }).document = {
      activeElement: trigger,
      body: { style: {} },
      getElementById: (id: string) => (id === "root" ? root : null),
      addEventListener: (type: string, handler: (event: KeyboardEvent) => void) => {
        if (type === "keydown") keyHandlers.push(handler);
      },
      removeEventListener: () => {},
    };
    (globalThis as { window?: unknown }).window = {
      confirm: () => true,
      setInterval: () => 0,
      clearInterval: () => {},
      deer: {
        mergeQueue: async () => ({ items: [], activeMerge: null }),
      },
    };
    const closeSettings = vi.fn();
    const closeQueue = vi.fn();
    let renderer: { unmount: () => void } | null = null;
    await act(async () => {
      renderer = create(
        <>
          <Modal title="设置" portal={false} onClose={closeSettings}>
            <button type="button">设置内容</button>
          </Modal>
          <MergeQueueModal workspaceId="w1" open onClose={closeQueue} />
        </>,
      );
      await Promise.resolve();
    });
    expect(hasOpenModal()).toBe(true);
    // The fake root now has a real inert representation; modalStack must set it.
    expect(root.inert).toBe(true);

    // App's global shortcuts are guarded by hasOpenModal(); while the queue is
    // open, neither Alt+1–6 nor Ctrl+K may navigate/open the palette.
    const navigate = vi.fn();
    const palette = vi.fn();
    guardedShortcut({ key: "1", altKey: true }, navigate, palette);
    guardedShortcut({ key: "k", ctrlKey: true }, navigate, palette);
    guardedShortcut({ key: "k", metaKey: true }, navigate, palette);
    expect(navigate).not.toHaveBeenCalled();
    expect(palette).not.toHaveBeenCalled();

    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    for (const handler of keyHandlers) handler(event);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(closeQueue).toHaveBeenCalledTimes(1);

    // Closing the top queue (unmounting the stack) releases root inert and
    // returns focus to the element that was active before the Modal opened.
    await act(async () => {
      renderer?.unmount();
    });
    expect(root.inert).toBe(false);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("releases inert and restores trigger focus when the queue is closed", async () => {
    const keyHandlers: Array<(event: KeyboardEvent) => void> = [];
    const root = new FakeElement();
    const trigger = new FakeElement();
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
    (globalThis as { document?: unknown }).document = {
      activeElement: trigger,
      body: { style: {} },
      getElementById: (id: string) => (id === "root" ? root : null),
      addEventListener: (type: string, handler: (event: KeyboardEvent) => void) => {
        if (type === "keydown") keyHandlers.push(handler);
      },
      removeEventListener: () => {},
    };
    (globalThis as { window?: unknown }).window = {
      confirm: () => true,
      setInterval: () => 0,
      clearInterval: () => {},
      deer: {
        mergeQueue: async () => ({ items: [], activeMerge: null }),
      },
    };

    function QueueHarness({ onClosed }: { onClosed: () => void }) {
      const [open, setOpen] = useState(true);
      return (
        <MergeQueueModal
          workspaceId="w1"
          open={open}
          onClose={() => {
            onClosed();
            setOpen(false);
          }}
        />
      );
    }

    const onClosed = vi.fn();
    let renderer: { unmount: () => void } | null = null;
    await act(async () => {
      renderer = create(<QueueHarness onClosed={onClosed} />);
      await Promise.resolve();
    });
    expect(root.inert).toBe(true);
    expect(hasOpenModal()).toBe(true);
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    await act(async () => {
      for (const handler of keyHandlers) handler(event);
      await Promise.resolve();
    });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(root.inert).toBe(false);
    expect(hasOpenModal()).toBe(false);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
    });
  });
});
