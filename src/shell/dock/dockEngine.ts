/**
 * DW1-3（t548）：Dock 渲染引擎开关。
 *
 * - 编译期常量（vite build 时可通过 VITE_DOCK_ENGINE=dockview 覆盖），默认 "v2"；
 * - 运行时兜底：localStorage["deer.dock.engine"] = "dockview" 可强制切回旧引擎
 *   （失败回滚路径，DW1-4 删除 dockview 前保留）；
 * - 旧 renderer（dockview）保留不删。
 */
export type DockEngine = "v2" | "dockview";

const RUNTIME_KEY = "deer.dock.engine";

function resolveEngine(): DockEngine {
  try {
    const override = (import.meta as { env?: { VITE_DOCK_ENGINE?: string } }).env
      ?.VITE_DOCK_ENGINE;
    if (override === "dockview" || override === "v2") return override;
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(RUNTIME_KEY);
      if (stored === "dockview" || stored === "v2") return stored;
    }
  } catch {
    /* ignore */
  }
  return "v2";
}

/** 当前引擎（模块加载时解析一次；测试可用 setDockEngineForTests 覆盖）。 */
let current: DockEngine = resolveEngine();

export function getDockEngine(): DockEngine {
  return current;
}

/** 切换引擎（写 localStorage 持久化；页面刷新后生效于下次加载）。 */
export function setDockEngine(engine: DockEngine): void {
  current = engine;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(RUNTIME_KEY, engine);
  } catch {
    /* ignore */
  }
}
