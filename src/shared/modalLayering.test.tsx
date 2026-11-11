// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasOpenModal, topModalToken } from "./modalStack.js";
import Modal from "../Modal.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { unmount: () => void };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("t190 Modal layering", () => {
  it("Esc only closes the top modal; focus returns to the trigger on unmount", async () => {
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
    };

    const closeSettings = vi.fn();
    const closeRisk = vi.fn();
    let renderer: { unmount: () => void } | null = null;
    await act(async () => {
      renderer = create(
        <>
          <Modal title="设置" portal={false} onClose={closeSettings}>
            <button type="button">设置内容</button>
          </Modal>
          <Modal title="风险审批" portal={false} onClose={closeRisk}>
            <button type="button">批准</button>
          </Modal>
        </>,
      );
    });
    expect(hasOpenModal()).toBe(true);
    expect(topModalToken()).not.toBeNull();

    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    for (const handler of keyHandlers) handler(event);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(closeRisk).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer?.unmount();
    });
    expect(trigger.focus).toHaveBeenCalled();
  });

  it("confirmClose blocks Esc until the dirty confirmation is accepted", async () => {
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
    let allowed = false;
    const confirm = vi.fn(() => allowed);
    (globalThis as { window?: unknown }).window = { confirm };

    const onClose = vi.fn();
    let renderer: { unmount: () => void } | null = null;
    await act(async () => {
      renderer = create(
        <Modal title="设置" portal={false} confirmClose onClose={onClose}>
          <button type="button">设置内容</button>
        </Modal>,
      );
    });
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    for (const handler of keyHandlers) handler(event);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    allowed = true;
    for (const handler of keyHandlers) handler(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
    });
  });
});
