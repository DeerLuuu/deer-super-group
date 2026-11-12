import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { PanelKey } from "../dock/panelRegistry";

export type PanelRender = (key: PanelKey) => ReactNode;
export type PanelDeps = Partial<Record<PanelKey, readonly unknown[]>>;

type PanelContextValue = {
  store: PanelVersionStore;
  renderRef: MutableRefObject<PanelRender>;
};

class PanelVersionStore {
  private versions = new Map<PanelKey, number>();
  private listeners = new Map<PanelKey, Set<() => void>>();

  subscribe = (key: PanelKey, listener: () => void): (() => void) => {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(key);
    };
  };

  getVersion = (key: PanelKey): number => this.versions.get(key) ?? 0;

  bump(key: PanelKey): void {
    this.versions.set(key, this.getVersion(key) + 1);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}

const PanelHostContext = createContext<PanelContextValue | null>(null);

function sameDeps(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

/**
 * t265（R2）：稳定面板边界。
 *
 * - 不再把 renderPanel 闭包作为 DockShell context value；
 * - 每个 PanelHost 只在自己的 domain deps 变化时 render；
 * - renderRef 始终指向 App 最新 renderPanelContent，因此 snapshot/rail/Workflow
 *   仍与 panel 共用同一份 App state，不引入第二数据源。
 *
 * depsByKey 是引用数组；App rerender 但某 panel 的依赖引用未变时 version 不 bump，
 * 该 PanelHost（含隐藏 always panel）不 render。
 */
export function PanelHostProvider({
  renderRef,
  depsByKey,
  children,
}: {
  renderRef: MutableRefObject<PanelRender>;
  depsByKey: PanelDeps;
  children: ReactNode;
}) {
  const storeRef = useRef<PanelVersionStore | null>(null);
  if (!storeRef.current) storeRef.current = new PanelVersionStore();
  const contextRef = useRef<PanelContextValue | null>(null);
  if (!contextRef.current) {
    contextRef.current = { store: storeRef.current, renderRef };
  }
  const previousDepsRef = useRef<PanelDeps | null>(null);

  useLayoutEffect(() => {
    const previous = previousDepsRef.current;
    // 首次挂载已由 PanelHost 用最新 renderRef 渲染，无需额外 bump。
    if (previous) {
      const keys = new Set<PanelKey>([
        ...(Object.keys(previous) as PanelKey[]),
        ...(Object.keys(depsByKey) as PanelKey[]),
      ]);
      for (const key of keys) {
        if (!sameDeps(previous[key], depsByKey[key])) {
          storeRef.current?.bump(key);
        }
      }
    }
    previousDepsRef.current = depsByKey;
  }, [depsByKey]);

  return (
    <PanelHostContext.Provider value={contextRef.current}>
      {children}
    </PanelHostContext.Provider>
  );
}

/**
 * 单一 panel 的稳定边界。版本订阅只在该 key bump 时触发；
 * 父 DockShell/Provider 的无关 render 不会让它重新执行 renderRef。
 */
export const PanelHost = memo(function PanelHost({ panelKey }: { panelKey: PanelKey }) {
  const context = useContext(PanelHostContext);
  if (!context) return null;
  const { store, renderRef } = context;
  useSyncExternalStore(
    (listener) => store.subscribe(panelKey, listener),
    () => store.getVersion(panelKey),
    () => store.getVersion(panelKey),
  );
  return <>{renderRef.current(panelKey)}</>;
});
