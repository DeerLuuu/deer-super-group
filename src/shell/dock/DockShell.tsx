import {
  createContext,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  MAIN_GROUP_ORDER,
  PANEL_DEFS,
  clearStore,
  loadStore,
  routeTabFromPanel,
  saveStore,
  selectVariant,
  storageKey,
  type DockVariant,
  type PanelKey,
} from "./panelRegistry";

/**
 * t50 VSCode 风格 Dock 容器（dockview-react 8.9.0，按 docs/team/dock-layout-design.md）。
 * App 只通过受控 props / DockHandle 交互，不直接接触 dockview 类型。
 *
 * - 默认布局：对话（主组）+ 团队（右组）同时可见；其余视图为主组 tab；
 * - 拖动 tab 到组边缘拆分 / 拖入组内合并 / 分栏拖动调整（库原生）；
 * - 布局按 workspace × 变体持久化（deer.dock.v1.<workspaceId>）；
 * - settings 不可关闭（草稿保护）；context 默认关闭；
 * - 键盘：Ctrl+Shift+Alt+方向键移动/拆分当前面板、Ctrl+Shift+Alt+[ / ] 调宽、Ctrl+Alt+W 关闭；
 * - 鼠标拖拽与键盘同样受最多 4 组约束（onWillDrop 拒绝超额拆分并提示合并）。
 */

export type DockHandle = {
  openPanel: (key: PanelKey) => void;
  closeActivePanel: () => void;
  resetLayout: () => void;
  resetAllLayouts: () => void;
  moveActivePanel: (direction: "left" | "right" | "above" | "below") => void;
  resizeActiveGroup: (delta: number) => void;
};

type MoveDirection = "left" | "right" | "above" | "below";

const PanelContentContext = createContext<(key: PanelKey) => ReactNode>(
  () => null,
);

function DockPanelBody(props: IDockviewPanelProps) {
  return (
    <PanelContentContext.Consumer>
      {(render) => (
        <div className="dock-panel-body" data-panel={props.api.id}>
          {render(props.api.id as PanelKey)}
        </div>
      )}
    </PanelContentContext.Consumer>
  );
}

/** 自定义默认 tab：settings 隐藏关闭按钮（§7.4），其余沿用库默认拖拽/关闭。 */
const DockTab = (props: IDockviewPanelHeaderProps) => (
  <DockviewDefaultTab {...props} hideClose={props.api.id === "settings"} />
);

const PANEL_COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> =
  Object.fromEntries(
    (Object.keys(PANEL_DEFS) as PanelKey[]).map((key) => [key, DockPanelBody]),
  );

const SAVE_DEBOUNCE_MS = 400;
const MAX_GROUPS = 4;

export default forwardRef<DockHandle, {
  workspaceId: string;
  dockWidth: number;
  initialPanelKey: PanelKey | null;
  renderPanel: (key: PanelKey) => ReactNode;
  onActivePanelChange: (key: PanelKey) => void;
  onNotify?: (message: string) => void;
}>(function DockShell(
  { workspaceId, dockWidth, initialPanelKey, renderPanel, onActivePanelChange, onNotify },
  ref,
) {
  const apiRef = useRef<DockviewApi | null>(null);
  const variantRef = useRef<DockVariant>(selectVariant(dockWidth));
  const workspaceIdRef = useRef(workspaceId);
  const initialKeyRef = useRef<PanelKey | null>(initialPanelKey);
  const activeKeyRef = useRef<PanelKey | null>(initialPanelKey);
  const saveTimerRef = useRef<number | null>(null);
  const suppressSaveUntilRef = useRef(0);
  const [panelCount, setPanelCount] = useState(0);

  const onActivePanelChangeRef = useRef(onActivePanelChange);
  onActivePanelChangeRef.current = onActivePanelChange;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  function notify(message: string) {
    onNotifyRef.current?.(message);
  }

  function defOptions(key: PanelKey, position?: {
    referencePanel: string;
    direction: "within" | "left" | "right" | "above" | "below";
  }) {
    const def = PANEL_DEFS[key];
    return {
      id: key,
      component: def.component,
      title: def.title,
      renderer: def.renderer,
      minimumWidth: def.minWidth,
      minimumHeight: def.minHeight,
      ...(position ? { position } : {}),
    };
  }

  function ensurePanel(api: DockviewApi, key: PanelKey) {
    if (api.getPanel(key)) return;
    if (key === "team" && api.getPanel("chat")) {
      api.addPanel(defOptions(key, { referencePanel: "chat", direction: "right" }));
    } else if (api.getPanel("chat")) {
      api.addPanel(defOptions(key, { referencePanel: "chat", direction: "within" }));
    } else {
      api.addPanel(defOptions(key));
    }
  }

  function buildDefaultLayout(
    api: DockviewApi,
    variant: DockVariant,
    activateKey: PanelKey | null,
    width: number,
  ) {
    api.clear();
    // 主组：chat 为锚，其余 tab within（context 默认关闭不创建）
    api.addPanel(defOptions("chat"));
    for (const key of MAIN_GROUP_ORDER) {
      if (key === "chat" || PANEL_DEFS[key].defaultClosed) continue;
      api.addPanel(defOptions(key, { referencePanel: "chat", direction: "within" }));
    }
    if (variant !== "single") {
      api.addPanel(defOptions("team", { referencePanel: "chat", direction: "right" }));
      const teamPanel = api.getPanel("team");
      const weight = variant === "wide" ? 42 : variant === "medium" ? 44 : 48;
      const groupApi = teamPanel?.group?.api as
        | { setSize?: (event: { width?: number }) => void }
        | undefined;
      groupApi?.setSize?.({ width: Math.max(360, Math.round((width * weight) / 100)) });
    }
    const target =
      activateKey && api.getPanel(activateKey)
        ? activateKey
        : api.getPanel("chat")
          ? "chat"
          : (Object.keys(PANEL_DEFS) as PanelKey[]).find((key) => api.getPanel(key)) ?? null;
    if (target) api.getPanel(target)?.api.setActive();
  }

  function rebuild(variant: DockVariant, activateKey: PanelKey | null) {
    const api = apiRef.current;
    if (!api) return;
    suppressSaveUntilRef.current = Date.now() + 500;
    const wsId = workspaceIdRef.current;
    const store = loadStore(wsId);
    const saved = store?.variants[variant];
    let restored = false;
    if (saved?.layout && typeof saved.layout === "object") {
      try {
        api.fromJSON(saved.layout as Parameters<DockviewApi["fromJSON"]>[0], {
          reuseExistingPanels: true,
        });
        // reconcile：必保 chat/team；未知面板由 fromJSON 丢弃（组件缺失会抛错走 catch）
        ensurePanel(api, "chat");
        ensurePanel(api, "team");
        if (activateKey && !api.getPanel(activateKey)) {
          // 集成修复 IF-03（t52）：首帧深链指向的面板若在用户保存布局中被关闭，
          // 按设计 §9「关闭的面板在 hash 命中时自动重开」补开，避免深链被静默改写。
          ensurePanel(api, activateKey);
        }
        const target =
          (activateKey && api.getPanel(activateKey) ? activateKey : null) ??
          (saved.activePanel && api.getPanel(saved.activePanel)
            ? (saved.activePanel as PanelKey)
            : "chat");
        api.getPanel(target)?.api.setActive();
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      buildDefaultLayout(api, variant, activateKey, dockWidthRef.current);
    }
    setPanelCount(api.panels.length);
  }

  const dockWidthRef = useRef(dockWidth);
  dockWidthRef.current = dockWidth;

  function flushSave() {
    const api = apiRef.current;
    if (!api) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (Date.now() < suppressSaveUntilRef.current) return;
    const wsId = workspaceIdRef.current;
    const store = loadStore(wsId) ?? {
      schema: "deer.dock.state" as const,
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      variants: {},
    };
    store.updatedAt = new Date().toISOString();
    store.variants[variantRef.current] = {
      layout: api.toJSON(),
      activePanel: api.activePanel?.id ?? null,
    };
    if (!saveStore(wsId, store)) {
      notify("布局无法保存，将使用默认布局");
    }
  }

  function scheduleSave() {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    rebuild(variantRef.current, initialKeyRef.current);
    api.onDidActivePanelChange((event) => {
      const panel = (event as { panel?: { id?: string } }).panel;
      const id = panel?.id ?? null;
      if (id) {
        activeKeyRef.current = id as PanelKey;
        onActivePanelChangeRef.current(id as PanelKey);
      }
    });
    api.onDidLayoutChange(() => {
      setPanelCount(api.panels.length);
      if (Date.now() < suppressSaveUntilRef.current) return;
      scheduleSave();
    });
    api.onDidAddPanel(() => setPanelCount(api.panels.length));
    api.onDidRemovePanel(() => setPanelCount(api.panels.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 变体切换（§11）：flush 旧变体 → 按新变体缓存/默认重建，保持激活面板。
  useEffect(() => {
    const next = selectVariant(dockWidth);
    if (next === variantRef.current) return;
    flushSave();
    variantRef.current = next;
    rebuild(next, activeKeyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockWidth]);

  // 工作区切换：flush 旧存档，按新工作区重建（首用 = 默认布局）。
  useEffect(() => {
    if (workspaceIdRef.current === workspaceId) return;
    flushSave();
    workspaceIdRef.current = workspaceId;
    variantRef.current = selectVariant(dockWidthRef.current);
    rebuild(variantRef.current, activeKeyRef.current ?? initialKeyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 卸载 / beforeunload flush。
  useEffect(() => {
    function onBeforeUnload() {
      flushSave();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      flushSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    openPanel(key) {
      const api = apiRef.current;
      if (!api) return;
      if (!api.getPanel(key)) {
        suppressSaveUntilRef.current = 0;
        ensurePanel(api, key);
      }
      api.getPanel(key)?.api.setActive();
    },
    closeActivePanel() {
      const api = apiRef.current;
      const panel = api?.activePanel;
      if (!api || !panel) return;
      if (panel.id === "settings") {
        notify("设置面板不可关闭（保护未保存的配置草稿）");
        return;
      }
      panel.api.close();
    },
    resetLayout() {
      const api = apiRef.current;
      if (!api) return;
      const active = api.activePanel?.id as PanelKey | undefined;
      suppressSaveUntilRef.current = Date.now() + 500;
      buildDefaultLayout(api, variantRef.current, active ?? null, dockWidthRef.current);
      setPanelCount(api.panels.length);
      notify("已恢复默认布局");
    },
    resetAllLayouts() {
      clearStore(workspaceIdRef.current);
      const api = apiRef.current;
      if (!api) return;
      const active = api.activePanel?.id as PanelKey | undefined;
      suppressSaveUntilRef.current = Date.now() + 500;
      buildDefaultLayout(api, variantRef.current, active ?? null, dockWidthRef.current);
      setPanelCount(api.panels.length);
      notify("已重置所有布局");
    },
    moveActivePanel(direction: MoveDirection) {
      const api = apiRef.current;
      const panel = api?.activePanel;
      if (!api || !panel) return;
      const navDirection =
        direction === "left"
          ? "left"
          : direction === "right"
            ? "right"
            : direction === "above"
              ? "up"
              : "down";
      const adjacent = api.adjacentGroupInDirection(panel.group, navDirection);
      if (adjacent) {
        panel.api.moveTo({ group: adjacent as never, position: "center" });
      } else if (api.groups.length < MAX_GROUPS) {
        const splitPosition =
          direction === "above" ? "top" : direction === "below" ? "bottom" : direction;
        panel.api.moveTo({ position: splitPosition });
        notify(`已把「${panel.title ?? panel.id}」拆分到新分栏`);
      } else {
        notify(`最多 ${MAX_GROUPS} 个分栏，请先拖回合并`);
      }
    },
    resizeActiveGroup(delta) {
      const api = apiRef.current;
      const group = api?.activePanel?.group;
      if (!group) return;
      // 集成修复 IF-02（t52）：dockview 的 group.api 没有 width 属性（旧实现恒回退 480，
      // 按一次就把组宽拉到 400/560）；改用公开的 boundingBox 实时宽度。
      const groupApi = group.api as unknown as {
        setSize?: (event: { width?: number }) => void;
        boundingBox?: { width: number; height: number };
      };
      const currentWidth = groupApi.boundingBox?.width ?? 480;
      groupApi?.setSize?.({ width: Math.max(280, currentWidth + delta) });
    },
  }));

  // 键盘（t56 改键，裁决 bb-83）：
  //   移动/拆分：Ctrl+Shift+Alt+方向键（原 Ctrl+Alt+方向键与 Windows 屏幕旋转/输入法冲突）；
  //   组宽调整：Ctrl+Shift+Alt+[ / ]（缩小 / 放大）；
  //   关闭当前面板：Ctrl+Alt+W（保持）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const handle = ref as React.RefObject<DockHandle | null>;
      // Ctrl+Alt+W：关闭当前面板（无 Shift）。
      if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey) {
        if (event.key.toLowerCase() === "w") {
          event.preventDefault();
          handle.current?.closeActivePanel();
        }
        return;
      }
      // 其余 dock 快捷键统一要求 Ctrl+Shift+Alt（三修饰键，避开系统/输入法组合）。
      if (!(event.ctrlKey && event.altKey && event.shiftKey) || event.metaKey) return;
      const dirMap: Record<string, MoveDirection> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "above",
        ArrowDown: "below",
      };
      if (dirMap[event.key]) {
        event.preventDefault();
        handle.current?.moveActivePanel(dirMap[event.key]);
        return;
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        handle.current?.resizeActiveGroup(event.key === "[" ? -80 : 80);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F3（bb-83）：鼠标拖拽同样受 4 组上限约束——拆分型 drop（left/right/top/bottom/center 以外）
  // 在已满 4 组时拒绝并提示合并；center（并入现有组）不新增组，放行。
  const onWillDrop = useCallback((event: { preventDefault: () => void; position: string }) => {
    const api = apiRef.current;
    if (!api) return;
    if (event.position === "center") return;
    if (api.groups.length >= MAX_GROUPS) {
      event.preventDefault();
      notify(`最多 ${MAX_GROUPS} 个分栏，请先拖回合并`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dock-shell">
      <PanelContentContext.Provider value={renderPanel}>
        <DockviewReact
          components={PANEL_COMPONENTS}
          defaultTabComponent={DockTab}
          onReady={onReady}
          onWillDrop={onWillDrop}
          className="dock-root"
        />
      </PanelContentContext.Provider>
      {panelCount === 0 && (
        <div className="dock-watermark">
          <div className="panel-title">所有面板已关闭</div>
          <div className="row gap" style={{ justifyContent: "center" }}>
            <button
              type="button"
              className="primary small"
              onClick={() => {
                const handle = ref as React.RefObject<DockHandle | null>;
                handle.current?.openPanel("chat");
              }}
            >
              打开对话
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                const handle = ref as React.RefObject<DockHandle | null>;
                handle.current?.resetLayout();
              }}
            >
              恢复默认布局
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
