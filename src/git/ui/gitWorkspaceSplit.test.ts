import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_WS_DEFAULT,
  GIT_WS_KEY_STEP,
  GIT_WS_MIN,
  clampWorkspaceHeight,
  loadWorkspaceHeight,
  maxWorkspaceHeight,
  saveWorkspaceHeight,
  splitterUsable,
  workspaceHeightAfterKey,
  workspaceHeightFromPointer,
  workspaceHeightStorageKey,
  workspaceHeightStyle,
} from "./gitWorkspaceSplit";

/** Node 环境无 localStorage：注入最小内存实现（load/save 有 try/catch，不依赖真实现）。 */
function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const stub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal("localStorage", stub);
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("t432 clamp：工作区≥160、历史≥180、max 按容器", () => {
  it("默认 300px；非法输入回退默认", () => {
    expect(clampWorkspaceHeight(GIT_WS_DEFAULT, 800)).toBe(300);
    expect(clampWorkspaceHeight(Number.NaN, 800)).toBe(300);
  });

  it("下限 160：更低（含拖出/存档非法值）钳到 160", () => {
    expect(clampWorkspaceHeight(120, 800)).toBe(GIT_WS_MIN);
    expect(clampWorkspaceHeight(-50, 800)).toBe(GIT_WS_MIN);
  });

  it("上限 = 容器 - 历史 180 - 固定行 36", () => {
    expect(maxWorkspaceHeight(800)).toBe(800 - 180 - 36);
    expect(clampWorkspaceHeight(9999, 800)).toBe(584);
  });

  it("容器不可用（< 376）时 splitterUsable=false，clamp 只保下限不放大", () => {
    expect(splitterUsable(800)).toBe(true);
    expect(splitterUsable(375)).toBe(false);
    expect(splitterUsable(0)).toBe(false);
    expect(clampWorkspaceHeight(300, 375)).toBe(300);
  });
});

describe("t432 拖拽与键盘", () => {
  it("拖拽映射：新高度 = 容器高 - 指针相对容器顶部偏移（clamp）", () => {
    // 容器 800：指针在 500px 处 → 工作区 300
    expect(workspaceHeightFromPointer(800, 500)).toBe(300);
    // 指针靠近底部（780）→ 工作区 20 → 钳到 160
    expect(workspaceHeightFromPointer(800, 780)).toBe(160);
    // 指针很高（100）→ 工作区 700 → 钳到上限 584
    expect(workspaceHeightFromPointer(800, 100)).toBe(584);
  });

  it("键盘 ArrowUp/Down 每次 16px，Home 最小，End 最大", () => {
    expect(workspaceHeightAfterKey(300, "ArrowUp", 800)).toBe(300 + GIT_WS_KEY_STEP);
    expect(workspaceHeightAfterKey(300, "ArrowDown", 800)).toBe(300 - GIT_WS_KEY_STEP);
    expect(workspaceHeightAfterKey(300, "Home", 800)).toBe(160);
    expect(workspaceHeightAfterKey(300, "End", 800)).toBe(584);
    // 边界不再越界
    expect(workspaceHeightAfterKey(580, "ArrowUp", 800)).toBe(584);
    expect(workspaceHeightAfterKey(170, "ArrowDown", 800)).toBe(160);
  });
});

describe("t432 按 workspace 持久化（非法值 clamp，无历史兼容要求）", () => {
  it("存取往返", () => {
    const store = stubLocalStorage();
    saveWorkspaceHeight("ws1", 420);
    expect(store.get(workspaceHeightStorageKey("ws1"))).toBe("420");
    expect(loadWorkspaceHeight("ws1", 800)).toBe(420);
  });

  it("未存档 → 默认 300；非法值（NaN/负/字符串）→ 默认并 clamp", () => {
    stubLocalStorage();
    expect(loadWorkspaceHeight("ws2", 800)).toBe(300);
    stubLocalStorage({ [workspaceHeightStorageKey("ws3")]: "abc" });
    expect(loadWorkspaceHeight("ws3", 800)).toBe(300);
    stubLocalStorage({ [workspaceHeightStorageKey("ws4")]: "-9" });
    expect(loadWorkspaceHeight("ws4", 800)).toBe(160);
  });

  it("容器变小后读取旧存档会被 clamp 到新上限", () => {
    stubLocalStorage({ [workspaceHeightStorageKey("ws5")]: "500" });
    expect(loadWorkspaceHeight("ws5", 400)).toBe(400 - 216); // 184
  });

  it("localStorage 不可用时静默回退默认", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("unavailable");
      },
    });
    expect(loadWorkspaceHeight("ws6", 800)).toBe(300);
  });
});

describe("t432 CSS 变量样式", () => {
  it("workspaceHeightStyle 输出 --git-workspace-h", () => {
    expect(workspaceHeightStyle(321.6)).toEqual({ "--git-workspace-h": "322px" });
  });
});
