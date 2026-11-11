import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasOpenModal,
  isTopModal,
  popModal,
  pushModal,
  registerModalElement,
  subscribeModalStack,
  topModalToken,
} from "./modalStack.js";

const originalDocument = (globalThis as { document?: unknown }).document;

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = originalDocument;
});

describe("t190 modal stack", () => {
  it("is LIFO and only the top token handles Esc", () => {
    const first = Symbol("first");
    const second = Symbol("second");
    pushModal(first);
    pushModal(second);
    expect(hasOpenModal()).toBe(true);
    expect(topModalToken()).toBe(second);
    expect(isTopModal(first)).toBe(false);
    expect(isTopModal(second)).toBe(true);

    popModal(second);
    expect(topModalToken()).toBe(first);
    expect(isTopModal(first)).toBe(true);
    popModal(first);
    expect(hasOpenModal()).toBe(false);
    expect(isTopModal(first)).toBe(false);
  });

  it("notifies subscribers and removes token on pop", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeModalStack(listener);
    const token = Symbol("token");
    pushModal(token);
    expect(listener).toHaveBeenCalled();
    popModal(token);
    unsubscribe();
  });

  it("keeps body locked until the last modal pops (non-top unmount)", () => {
    const root = {
      inert: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === "inert") this.inert = Boolean(force);
      },
    };
    const body = { style: { overflow: "auto" } };
    (globalThis as { document?: unknown }).document = {
      body,
      getElementById: (id: string) => (id === "root" ? root : null),
    };
    const first = Symbol("first");
    const second = Symbol("second");
    pushModal(first);
    pushModal(second);
    expect(body.style.overflow).toBe("hidden");
    popModal(first); // non-top closes first
    expect(body.style.overflow).toBe("hidden");
    popModal(second);
    expect(body.style.overflow).toBe("auto");
    expect(root.inert).toBe(false);
  });

  it("makes the app root and non-top dialogs inert", () => {
    const root = {
      inert: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === "inert") this.inert = Boolean(force);
      },
    };
    const first = {
      inert: false,
      hidden: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === "inert") this.inert = Boolean(force);
      },
      setAttribute(name: string, value: string) {
        if (name === "aria-hidden") this.hidden = value === "true";
      },
      removeAttribute(name: string) {
        if (name === "aria-hidden") this.hidden = false;
      },
    };
    const second = {
      inert: false,
      hidden: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === "inert") this.inert = Boolean(force);
      },
      setAttribute(name: string, value: string) {
        if (name === "aria-hidden") this.hidden = value === "true";
      },
      removeAttribute(name: string) {
        if (name === "aria-hidden") this.hidden = false;
      },
    };
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => (id === "root" ? root : null),
    };

    const firstToken = Symbol("first");
    const secondToken = Symbol("second");
    pushModal(firstToken);
    registerModalElement(firstToken, first as unknown as HTMLElement);
    expect(root.inert).toBe(true);
    expect(first.inert).toBe(false);

    pushModal(secondToken);
    registerModalElement(secondToken, second as unknown as HTMLElement);
    expect(first.inert).toBe(true);
    expect(first.hidden).toBe(true);
    expect(second.inert).toBe(false);

    popModal(secondToken);
    expect(first.inert).toBe(false);
    expect(first.hidden).toBe(false);
    popModal(firstToken);
    expect(root.inert).toBe(false);
  });
});
