import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
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
  panelInsertDirection,
  routeTabFromPanel,
  saveStore,
  selectVariant,
  storageKey,
  type DockVariant,
  type PanelKey,
} from "./panelRegistry";
import {
  DOCK_SASH_WIDTH,
  TASKS_MIN_WIDTH,
  TEAM_MIN_WIDTH,
  effectivePanelMinWidth,
} from "./narrowWindow";
import {
  canAddDockGroup,
  dockGroupLimitMessage,
  effectiveMaxDockGroups,
} from "./dockGroups";
import { PanelHost } from "../panel/PanelHost";

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
  getOpenPanelKeys: () => PanelKey[];
  closeActivePanel: () => void;
  resetLayout: () => void;
  resetAllLayouts: () => void;
  moveActivePanel: (direction: "left" | "right" | "above" | "below") => void;
  resizeActiveGroup: (delta: number) => void;
};

type MoveDirection = "left" | "right" | "above" | "below";

type ReconcilePanel = {
  id?: string;
  group: { id?: string; api?: { setSize?: (event: { width?: number }) => void } } | undefined;
  api: { close: () => void; setActive?: () => void };
};

type ReconcileApi = {
  getPanel: (id: string) => ReconcilePanel | undefined;
  activePanel: { id?: string } | null | undefined;
};

/**
 * t194/t212：旧 single 存档可能把 Team 存在右侧独立组（历史 ensurePanel 行为）。
 * 恢复时把 Team 收敛为主组 tab，并保持 active 状态。
 * 抽成导出函数以便 fake dockview API 做回归测试（无需真实渲染 dockview）。
 */
export function reconcileSingleLayout(
  api: ReconcileApi,
  variant: DockVariant,
  addTeamToMain: () => void,
  dockWidth?: number,
): void {
  if (variant !== "single") return;
  const chat = api.getPanel("chat");
  if (!chat) return;
  const team = api.getPanel("team");
  if (team && team.group !== chat.group) {
    const teamWasActive = api.activePanel?.id === "team";
    team.api.close();
    addTeamToMain();
    if (teamWasActive) api.getPanel("team")?.api.setActive?.();
  }
  // t228：从 1440 存档切 single 时主组仍保留旧宽度，右侧会留空。
  // 收敛后把主组设为实测 Dock 宽；宽度未知时不做假设。
  if (dockWidth && dockWidth > 0) {
    const main = api.getPanel("chat");
    main?.group?.api?.setSize?.({ width: dockWidth });
  }
}

function DockPanelBody(props: IDockviewPanelProps) {
  return (
    <div className="dock-panel-body" data-panel={props.api.id} tabIndex={-1}>
      <PanelHost panelKey={props.api.id as PanelKey} />
    </div>
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

export default forwardRef<DockHandle, {
  workspaceId: string;
  dockWidth: number;
  windowWidth: number;
  /** t208：全局最大分栏数（2–8，默认 6），来自 LayoutSettings。 */
  maxGroups: number;
  initialPanelKey: PanelKey | null;
  onActivePanelChange: (key: PanelKey) => void;
  /** t237：计划草案面板被 X 关闭时通知 App 做 dirty 确认/恢复。 */
  onPanelClose?: (key: PanelKey) => void;
  onNotify?: (message: string) => void;
}>(function DockShell(
  {
    workspaceId,
    dockWidth,
    windowWidth,
    maxGroups,
    initialPanelKey,
    onActivePanelChange,
    onPanelClose,
    onNotify,
  },
  ref,
) {
  const apiRef = useRef<DockviewApi | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const variantRef = useRef<DockVariant>(selectVariant(dockWidth, windowWidth));
  const workspaceIdRef = useRef(workspaceId);
  const initialKeyRef = useRef<PanelKey | null>(initialPanelKey);
  const activeKeyRef = useRef<PanelKey | null>(initialPanelKey);
  const saveTimerRef = useRef<number | null>(null);
  const variantFrameRef = useRef<number | null>(null);
  const groupLimitRef = useRef(effectiveMaxDockGroups(maxGroups));
  groupLimitRef.current = effectiveMaxDockGroups(maxGroups);
  const suppressSaveUntilRef = useRef(0);
  const [panelCount, setPanelCount] = useState(0);

  const onActivePanelChangeRef = useRef(onActivePanelChange);
  onActivePanelChangeRef.current = onActivePanelChange;
  const onPanelCloseRef = useRef(onPanelClose);
  onPanelCloseRef.current = onPanelClose;
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
    // t212：single 下若 Dock 本身 <560（如 960 窗口 200% zoom 的 480 CSS viewport），
    // 不能再强制 panel minWidth=560 造成横向裁切；改由 ≤640/≤620 容器查询单列降级。
    const minimumWidth = effectivePanelMinWidth(
      def.minWidth,
      variantRef.current === "single",
      measureDockWidth(),
    );
    return {
      id: key,
      component: def.component,
      title: def.title,
      renderer: def.renderer,
      minimumWidth,
      minimumHeight: def.minHeight,
      ...(position ? { position } : {}),
    };
  }

  function ensurePanel(api: DockviewApi, key: PanelKey) {
    if (api.getPanel(key)) return;
    if (!api.getPanel("chat")) {
      api.addPanel(defOptions(key));
      return;
    }
    // t194：single 变体下 Team 不再 right split，所有面板都作为主组 tab（within）。
    const direction = panelInsertDirection(variantRef.current, key);
    api.addPanel(defOptions(key, { referencePanel: "chat", direction }));
    if (direction === "right") {
      // 保证 Team 右组 + sash 不把 Tasks 主组压到 560 以下。
      const width = measureDockWidth();
      const desired = Math.max(TEAM_MIN_WIDTH, Math.round(width * 0.44));
      const teamWidth = Math.max(
        TEAM_MIN_WIDTH,
        Math.min(desired, width - TASKS_MIN_WIDTH - DOCK_SASH_WIDTH),
      );
      const groupApi = api.getPanel(key)?.group?.api as
        | { setSize?: (event: { width?: number }) => void }
        | undefined;
      groupApi?.setSize?.({ width: teamWidth });
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
      const weight = variant === "wide" ? 42 : 44;
      const groupApi = teamPanel?.group?.api as
        | { setSize?: (event: { width?: number }) => void }
        | undefined;
      // t194/t212：Team 右组 + sash 最大宽度不能挤掉 Tasks 主组 560 可读宽度。
      const desired = Math.max(TEAM_MIN_WIDTH, Math.round((width * weight) / 100));
      const teamWidth = Math.max(
        TEAM_MIN_WIDTH,
        Math.min(desired, width - TASKS_MIN_WIDTH - DOCK_SASH_WIDTH),
      );
      groupApi?.setSize?.({ width: teamWidth });
    }
    // t69：默认布局不含 runs（defaultClosed）；深链 #/tasks?...&r= 指向 Runs 时补开，
    // 与 saved layout 分支的 IF-03 行为保持一致。
    if (activateKey && !api.getPanel(activateKey)) {
      ensurePanel(api, activateKey);
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
        // 设置已迁移为独立弹窗；旧布局里的 settings dock 面板在恢复时关闭。
        try {
          api.getPanel("settings")?.api.close();
        } catch {
          /* 旧布局可能没有 settings 或已随分组关闭 */
        }
        // reconcile：必保 chat；非 single 必保 team。single 下 Team 只在需要时作为 tab 打开，
        // 且旧存档中的 right split 会被收敛回主组（t194）。
        ensurePanel(api, "chat");
        if (variant !== "single") ensurePanel(api, "team");
        reconcileSingleLayout(api, variant, () => ensurePanel(api, "team"), measureDockWidth());
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
      buildDefaultLayout(api, variant, activateKey, measureDockWidth());
    }
    setPanelCount(api.panels.length);
  }

  const dockWidthRef = useRef(dockWidth);
  dockWidthRef.current = dockWidth;
  const windowWidthRef = useRef(windowWidth);
  windowWidthRef.current = windowWidth;

  /**
   * t212：优先用 Dock host 的实际测量宽度（刚 resize 时 prop 可能滞后）；仅在尚未布局
   * （0）时退回 prop，避免用旧的 window-width 计算结果给 Team 分宽度。
   */
  function measureDockWidth(): number {
    const measured = hostRef.current?.getBoundingClientRect().width ?? 0;
    return measured > 0 ? measured : dockWidthRef.current;
  }

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
    api.onDidRemovePanel((event) => {
      setPanelCount(api.panels.length);
      const panel = (event as { panel?: { id?: string } }).panel;
      if (panel?.id) onPanelCloseRef.current?.(panel.id as PanelKey);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 变体切换（§11 + t194/t212）：flush 旧变体 → 按新变体缓存/默认重建，保持激活面板。
  // windowWidth 参与判定：≤960 即使 Dock 变宽也固定 single，避免窄窗 Team right split。
  // t212：窗口 resize 时 dockWidth prop 与本帧实际宽度可能短暂不一致；延后到下一帧，
  // 用 host 实测宽度计算变体/Team 宽度，避免用 1440 的 Dock 宽去建 1100/960 布局。
  useEffect(() => {
    if (variantFrameRef.current !== null) {
      cancelAnimationFrame(variantFrameRef.current);
      variantFrameRef.current = null;
    }
    variantFrameRef.current = requestAnimationFrame(() => {
      variantFrameRef.current = null;
      const measured = measureDockWidth();
      const next = selectVariant(measured, windowWidthRef.current);
      if (next === variantRef.current) return;
      flushSave();
      variantRef.current = next;
      rebuild(next, activeKeyRef.current);
    });
    return () => {
      if (variantFrameRef.current !== null) {
        cancelAnimationFrame(variantFrameRef.current);
        variantFrameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockWidth, windowWidth]);

  // 工作区切换：flush 旧存档，按新工作区重建（首用 = 默认布局）。
  useEffect(() => {
    if (workspaceIdRef.current === workspaceId) return;
    flushSave();
    workspaceIdRef.current = workspaceId;
    variantRef.current = selectVariant(measureDockWidth(), windowWidthRef.current);
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
    getOpenPanelKeys() {
      return (apiRef.current?.panels.map((panel) => panel.id as PanelKey) ?? []);
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
      } else if (canAddDockGroup(api.groups.length, groupLimitRef.current)) {
        const splitPosition =
          direction === "above" ? "top" : direction === "below" ? "bottom" : direction;
        panel.api.moveTo({ position: splitPosition });
        notify(`已把「${panel.title ?? panel.id}」拆分到新分栏`);
      } else {
        notify(dockGroupLimitMessage(groupLimitRef.current));
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

  // F3（bb-83）+ t208：鼠标拖拽受 maxGroups（默认 6，2–8 可配）约束——拆分型 drop
  // （left/right/top/bottom/center 以外）在已满时拒绝并提示合并；center 不新增组，放行。
  const onWillDrop = useCallback((event: { preventDefault: () => void; position: string }) => {
    const api = apiRef.current;
    if (!api) return;
    if (event.position === "center") return;
    if (!canAddDockGroup(api.groups.length, groupLimitRef.current)) {
      event.preventDefault();
      notify(dockGroupLimitMessage(groupLimitRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dock-shell" ref={hostRef}>
      <DockviewReact
        components={PANEL_COMPONENTS}
        defaultTabComponent={DockTab}
        onReady={onReady}
        onWillDrop={onWillDrop}
        className="dock-root"
      />
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
