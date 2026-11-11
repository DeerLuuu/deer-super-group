// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { portalTargets } = vi.hoisted(() => ({ portalTargets: [] as unknown[] }));

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

import type { ToastItem } from "./Toast.js";
import { AppLiveRegions } from "./App.js";
import { hasOpenModal, popModal, pushModal } from "./shared/modalStack.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => AppLiveRenderer;
};

interface AppLiveRenderer {
  root: {
    findAllByType: (type: string) => Array<{ props: Record<string, unknown> }>;
    findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
  };
  unmount: () => void;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalDocument = (globalThis as { document?: unknown }).document;
const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = originalDocument;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  portalTargets.length = 0;
});

describe("t204 live regions outside inert root", () => {
  it("portals toast/announcer to body and keeps them visible/closable/live while root is inert", async () => {
    const root = {
      inert: false,
      toggleAttribute(name: string, force?: boolean) {
        if (name === "inert") this.inert = Boolean(force);
      },
    };
    const body = { style: {} };
    (globalThis as { document?: unknown }).document = {
      body,
      getElementById: (id: string) => (id === "root" ? root : null),
    };
    (globalThis as { window?: unknown }).window = {
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    const token = Symbol("test-modal");
    pushModal(token);
    expect(root.inert).toBe(true);

    const dismiss = vi.fn();
    const backdropClick = vi.fn();
    const toasts: ToastItem[] = [
      { id: 7, kind: "error", message: "后台任务失败", detail: "可重试" },
    ];
    let renderer: AppLiveRenderer | null = null;
    await act(async () => {
      renderer = create(
        <>
          <div className="modal-backdrop" onMouseDown={backdropClick} />
          <AppLiveRegions
            tasks={[]}
            scheduler={null}
            runs={[]}
            actionMessage="后台任务失败"
            toasts={toasts}
            onDismiss={dismiss}
          />
        </>,
      );
      await Promise.resolve();
    });

    expect(portalTargets[0]).toBe(body);
    expect(hasOpenModal()).toBe(true);
    expect(root.inert).toBe(true);

    const toastLayer = renderer!.root.findAllByProps({ className: "app-toast-layer" })[0];
    expect(toastLayer).toBeTruthy();
    const layerStyle = toastLayer.props.style as { zIndex: number; pointerEvents: string };
    expect(layerStyle.zIndex).toBeGreaterThan(1000); // modal-backdrop
    expect(layerStyle.zIndex).toBeGreaterThan(150); // palette-backdrop
    expect(layerStyle.pointerEvents).toBe("none");

    const bodyContent = renderer!.root.findAllByProps({ className: "toast-host" })[0];
    expect(bodyContent).toBeTruthy();
    expect(renderer!.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
    expect(renderer!.root.findAllByProps({ "aria-live": "polite" }).length).toBeGreaterThan(0);
    const close = renderer!.root.findAllByProps({ "aria-label": "关闭提示" })[0];
    expect(close).toBeTruthy();
    await act(() => {
      (close.props.onClick as () => void)();
    });
    expect(dismiss).toHaveBeenCalledWith(7);
    expect(backdropClick).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
    popModal(token);
    expect(root.inert).toBe(false);
  });
});
