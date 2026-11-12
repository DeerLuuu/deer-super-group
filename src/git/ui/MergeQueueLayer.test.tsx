// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// The repository has no jsdom/RTL; make Modal's portal render in-place for this
// focused stack test while keeping the real component implementation.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: unknown) => node };
});

import Modal from "../../Modal.js";
import { hasOpenModal } from "../../shared/modalStack.js";
import { MergeQueuePanel } from "./MergeQueuePanel.js";
import type { MergeQueueItem } from "../types.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => { root: any; unmount: () => void };
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

function item(): MergeQueueItem {
  return {
    id: "q1",
    workspaceId: "ws1",
    taskId: "t3",
    taskTitle: "Ship merge queue panel",
    provider: "github",
    prNumber: 45,
    prUrl: null,
    branch: "deer/t3-merge-queue",
    state: "ready",
    position: 1,
    headSha: "abc",
    baseSha: "def",
    approvedHeadSha: null,
    checks: { state: "success", summary: "all green" },
    checksWaived: false,
    retryAt: null,
    review: "pass",
    conflictTaskId: null,
    lastError: null,
    mergeCommitSha: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function openConfirm(renderer: { root: any }) {
  const merge = renderer.root.findAllByType("button").find((node: any) => node.children.includes("合并…"));
  expect(merge).toBeTruthy();
  act(() => merge!.props.onClick());
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

function setupDom() {
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
    deer: {},
  };
  return { keyHandlers, root, trigger };
}

describe("t309 MergeQueue confirmation is a single Modal layer", () => {
  it("registers the confirm Modal in the common stack and Esc only closes it", async () => {
    const { keyHandlers, root, trigger } = setupDom();
    const closeSettings = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <>
          <Modal title="设置" portal={false} onClose={closeSettings}>
            <button type="button">设置内容</button>
          </Modal>
          <MergeQueuePanel workspaceId="w1" items={[item()]} onReload={() => undefined} />
        </>,
      );
      await Promise.resolve();
    });
    openConfirm(renderer!);
    expect(hasOpenModal()).toBe(true);
    expect(root.inert).toBe(true);

    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    await act(async () => {
      for (const handler of keyHandlers) handler(event);
      await Promise.resolve();
    });
    expect(closeSettings).not.toHaveBeenCalled();
    // The settings Modal is still open underneath; only the confirmation closes.
    expect(hasOpenModal()).toBe(true);
    expect(root.inert).toBe(true);

    await act(async () => {
      renderer?.unmount();
    });
    expect(trigger.focus).toHaveBeenCalled();
  });

  it("returns focus to the document trigger after closing the confirmation", async () => {
    const { keyHandlers, root, trigger } = setupDom();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<MergeQueuePanel workspaceId="w1" items={[item()]} onReload={() => undefined} />);
      await Promise.resolve();
    });
    openConfirm(renderer!);
    expect(hasOpenModal()).toBe(true);
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    await act(async () => {
      for (const handler of keyHandlers) handler(event);
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(hasOpenModal()).toBe(false);
    expect(root.inert).toBe(false);
    expect(trigger.focus).toHaveBeenCalled();
    await act(async () => {
      renderer?.unmount();
    });
  });
});
