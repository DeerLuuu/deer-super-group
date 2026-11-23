/**
 * DW1 回滚后的 Dock 渲染引擎开关。
 *
 * - 默认 "dockview"（旧成熟交互）；
 * - `VITE_DOCK_ENGINE=v2` 或 localStorage["deer.dock.engine"]="v2" 显式启用自研 v2；
 * - 自研 DockTree/v2 代码与 deer.dock.layout.v2 保留为 opt-in，不删除。
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
  return "dockview";
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
