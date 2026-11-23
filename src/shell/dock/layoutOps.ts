/**
 * DW1-2（t526）：Dock 布局命令 reducer + v2 持久化（纯数据层，不接渲染器）。
 *
 * 依据 docs/team/architecture-batch-v2.md §3.4/§3.5：
 * - `reduceDock(layout, command, context) -> { layout, effects }`：effects 只含
 *   持久化/通知/激活回调信号（不做 DOM）；每个命令先守卫后 normalize，出口 validate 恒空；
 * - 持久化 v2：`deer.dock.layout.v2.<workspaceId>`（64KB 上限、schema/结构校验、
 *   损坏回默认并清理 key）；**不读、不迁移 v1 `deer.dock.state`**；localStorage
 *   不可用时静默降级（读 null / 写 false）；
 * - maxGroups 裁剪：超过上限时把「最深/最后」的多余组逐个并入 active group
 *   （center 语义），直到组数 ≤ limit；断点（wide/medium/narrow/single）沿用
 *   panelRegistry.selectVariant，本模块不改变阈值；
 * - v2 渲染器唯一消费方；旧 renderer 已移除。
 */

import { PANEL_DEFS, type PanelKey } from "./panelRegistry";
import {
  activatePanelInLayout,
  closePanelInLayout,
  countGroups,
  defaultLayout,
  effectiveMaxDockGroups,
  listGroups,
  movePanelInLayout,
  normalizeLayout,
  openPanelInLayout,
  resizeSplitInLayout,
  splitPanelInLayout,
  validateLayout,
  type DockLayout,
  type DockVariant,
  type LayoutNode,
} from "./layoutModel";

// ---------------------------------------------------------------------------
// 命令与效果
// ---------------------------------------------------------------------------

export type { DockLayout, DockVariant, PanelKey };

export type DockCommand =
  | {
      type: "open";
      panel: PanelKey;
      cause: "nav" | "deep-link" | "command" | "restore";
      /**
       * t542：目标组锚点（panel key）——面板插入「包含 anchor 的组」而非 active group，
       * 与 legacy ensurePanel 的 referencePanel:"chat" 对齐（DW1-3 前的 open 目标组契约）。
       */
      anchor?: PanelKey;
    }
  | { type: "close"; panel: PanelKey }
  | { type: "activate"; panel: PanelKey }
  | {
      type: "move";
      panel: PanelKey;
      target: PanelKey;
      position: "center" | "left" | "right" | "above" | "below";
    }
  | {
      type: "split";
      panel: PanelKey;
      direction: "left" | "right" | "above" | "below";
    }
  | { type: "resize"; splitId: string; index: number; delta: number }
  | { type: "dragDrop"; panel: PanelKey; target: PanelKey; position: "center" | "edge"; edge?: "left" | "right" | "above" | "below" }
  | { type: "reset"; variant?: DockVariant | "all" };

/** reducer 输出：effects 只是信号（持久化/通知/激活），由宿主执行。 */
export interface DockEffects {
  /** 布局变化需要持久化（400ms debounce 由宿主做）。 */
  persist: boolean;
  /** 需要向用户提示的消息（如超组数拒绝 / 不可关闭）。 */
  notify: string[];
  /** 激活的面板（open/activate/move center 成功后）。 */
  activatedPanel: PanelKey | null;
}

export interface ReduceContext {
  maxGroups?: number;
  /** 单测注入；默认 PANEL_DEFS。 */
  panelDefs?: typeof PANEL_DEFS;
}

export interface ReduceResult {
  layout: DockLayout;
  effects: DockEffects;
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

/** 纯命令 reducer：守卫 → 操作 → 裁剪 → normalize → 出口断言。 */
export function reduceDock(
  layout: DockLayout,
  command: DockCommand,
  context: ReduceContext = {},
): ReduceResult {
  const defs = context.panelDefs ?? PANEL_DEFS;
  const notify: string[] = [];
  let activatedPanel: PanelKey | null = null;
  let next: DockLayout = layout;
  let persist = false;

  switch (command.type) {
    case "open": {
      if (!(command.panel in defs)) {
        notify.push(`未知面板：${command.panel}`);
        break;
      }
      const existed = listGroups(layout.root).some((group) =>
        (group.panels as string[]).includes(command.panel),
      );
      next = openPanelInLayout(layout, command.panel, command.anchor);
      if (next !== layout || !existed) {
        activatedPanel = command.panel;
        persist = true;
      }
      break;
    }
    case "close": {
      if (!(command.panel in defs)) {
        notify.push(`未知面板：${command.panel}`);
        break;
      }
      if (!defs[command.panel].closable) {
        // 运行时拒绝（settings 草稿保护；planDraft 的 dirty 确认由宿主 onPanelClose 做）。
        notify.push(`「${defs[command.panel].title}」不可关闭`);
        break;
      }
      const existed = listGroups(layout.root).some((group) =>
        (group.panels as string[]).includes(command.panel),
      );
      if (!existed) break;
      next = closePanelInLayout(layout, command.panel);
      persist = true;
      break;
    }
    case "activate": {
      next = activatePanelInLayout(layout, command.panel);
      if (next !== layout) {
        activatedPanel = command.panel;
        persist = true;
      }
      break;
    }
    case "move": {
      const before = JSON.stringify(layout.root);
      next = movePanelInLayout(layout, command.panel, command.target, command.position, context.maxGroups);
      if (JSON.stringify(next.root) !== before) {
        if (command.position === "center") activatedPanel = command.panel;
        persist = true;
      } else if (
        command.panel !== command.target &&
        listGroups(layout.root).some((g) => (g.panels as string[]).includes(command.panel)) &&
        listGroups(layout.root).some((g) => (g.panels as string[]).includes(command.target)) &&
        command.position !== "center"
      ) {
        // 守卫通过但组数达上限 → 拒绝（与 onWillDrop 语义一致）。
        notify.push(`最多 ${effectiveMaxDockGroups(context.maxGroups, layout.variant)} 个分栏，请先拖回合并`);
      }
      break;
    }
    case "split": {
      const before = JSON.stringify(layout.root);
      next = splitPanelInLayout(layout, command.panel, command.direction, context.maxGroups);
      if (JSON.stringify(next.root) !== before) {
        activatedPanel = command.panel;
        persist = true;
      } else if (
        listGroups(layout.root).some((g) => (g.panels as string[]).includes(command.panel))
      ) {
        notify.push(`最多 ${effectiveMaxDockGroups(context.maxGroups, layout.variant)} 个分栏，请先拖回合并`);
      }
      break;
    }
    case "resize": {
      next = resizeSplitInLayout(layout, command.splitId, command.index, command.delta);
      if (next !== layout) persist = true;
      break;
    }
    case "dragDrop": {
      // 拖放语义：center = 合并 tab；edge = 相对 target 拆分。
      if (command.position === "center") {
        return reduceDock(
          layout,
          { type: "move", panel: command.panel, target: command.target, position: "center" },
          context,
        );
      }
      const edge = command.edge ?? "right";
      return reduceDock(
        layout,
        { type: "move", panel: command.panel, target: command.target, position: edge },
        context,
      );
    }
    case "reset": {
      if (command.variant === "all") {
        // 宿主负责清空全部 v2 key；reducer 只回当前 variant 默认。
        next = defaultLayout(layout.variant);
      } else {
        next = defaultLayout(command.variant ?? layout.variant);
      }
      activatedPanel = "chat";
      persist = true;
      break;
    }
    default: {
      // 未知命令：no-op。
      break;
    }
  }

  // maxGroups 裁剪 + normalize + 出口断言（守恒不变量）。
  // 引用不变优化：布局与根节点均未变时保持原引用（调用方可据此 no-op）。
  const candidate = clampGroups(normalizeLayout(next), context.maxGroups);
  const unchanged =
    next === layout &&
    JSON.stringify(candidate.root) === JSON.stringify(layout.root) &&
    candidate.variant === layout.variant;
  next = unchanged ? layout : candidate;
  // t530 F2：生产环境也跑轻量不变量（panel 唯一 + 组数 + sizes 有限）；
  // 完整 validateLayout 仅开发期（性能考虑，见 docs §F2）。
  assertLightweightInvariants(next, context.maxGroups);
  if (process.env.NODE_ENV !== "production") {
    const issues = validateLayout(next, { maxGroups: context.maxGroups });
    if (issues.length > 0) {
      throw new Error(
        `reduceDock invariant violated: ${command.type} ${JSON.stringify(issues)}`,
      );
    }
  }

  return {
    layout: next,
    effects: { persist, notify, activatedPanel },
  };
}

/** t530 F2：轻量出口不变量——生产也执行（O(panels+groups)，无全树字符串化）。 */
function assertLightweightInvariants(layout: DockLayout, maxGroups?: number): void {
  const groups = listGroups(layout.root);
  const seen = new Set<PanelKey>();
  for (const group of groups) {
    for (const panel of group.panels) {
      if (seen.has(panel)) {
        throw new Error(`reduceDock light invariant violated: duplicate panel ${panel}`);
      }
      seen.add(panel);
    }
  }
  if (groups.length > effectiveMaxDockGroups(maxGroups, layout.variant)) {
    throw new Error(
      `reduceDock light invariant violated: ${groups.length} > max groups`,
    );
  }
  function checkSizes(node: DockLayout["root"]): void {
    if (node.kind === "group") return;
    for (const size of node.sizes) {
      if (!Number.isFinite(size) || size < 0) {
        throw new Error("reduceDock light invariant violated: bad size");
      }
    }
    node.children.forEach(checkSizes);
  }
  checkSizes(layout.root);
}

// ---------------------------------------------------------------------------
// maxGroups 裁剪
// ---------------------------------------------------------------------------

/**
 * 组数超过上限时降组：从「最深的边缘组」开始，把它的面板按 tab 顺序并入
 * active group（center 语义），直到满足上限。默认布局（≤2 组）天然不触发。
 */
export function clampGroups(layout: DockLayout, maxGroups?: number): DockLayout {
  const limit = effectiveMaxDockGroups(maxGroups, layout.variant);
  let current = layout;
  let guard = 0;
  while (countGroups(current.root) > limit && guard < 32) {
    guard += 1;
    const groups = listGroups(current.root);
    // active group 优先保留；取「最后一个非 active 且非唯一面板为 settings 的组」。
    const activeGroupId = findActiveGroupId(current.root);
    const victim =
      [...groups].reverse().find((group) => group.id !== activeGroupId) ?? groups[0];
    const target =
      groups.find((group) => group.id === activeGroupId) ?? groups.find((g) => g !== victim);
    if (!victim || !target || victim === target) {
      // 结构异常：保守返回 normalize 结果。
      return normalizeLayout(current);
    }
    for (const panel of [...victim.panels]) {
      current = movePanelInLayout(current, panel, target.panels[0], "center", maxGroups);
    }
  }
  return normalizeLayout(current);
}

function findActiveGroupId(node: LayoutNode): string | null {
  // active group = 包含「某个 group 的 active 面板被全树最后一次 activate」——模型不存
  // 全局 active；这里取「第一个 active 非空的 group」（与 findActiveGroup 一致）。
  if (node.kind === "group") return node.active !== null ? node.id : null;
  for (const child of node.children) {
    const found = findActiveGroupId(child);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// v2 持久化
// ---------------------------------------------------------------------------

export interface DockLayoutStore {
  schema: "deer.dock.layout";
  version: 2;
  updatedAt: string;
  variants: Partial<Record<DockVariant, DockLayout>>;
  activePanel: PanelKey | null;
}

export const V2_SCHEMA = "deer.dock.layout" as const;
export const V2_VERSION = 2;
const MAX_STORE_BYTES = 64 * 1024;

/** t530 F4：按字节长度计量（UTF-8，含多字节字符的准确 64KB 上限）。 */
function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

/** v2 key：`deer.dock.layout.v2.<workspaceId>`（不与 v1 `deer.dock.state` 相交）。 */
export function v2StorageKey(workspaceId: string): string {
  return `deer.dock.layout.v2.${workspaceId}`;
}

/** localStorage 不可用时返回 null storage（测试/SSR 降级）。 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 读取 v2 布局存档；损坏/超限/版本不符 → 删除 key、返回 null（调用方回默认）。 */
export function loadV2Store(workspaceId: string): DockLayoutStore | null {
  const storage = safeStorage();
  if (!storage) return null;
  const key = v2StorageKey(workspaceId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    if (byteLength(raw) > MAX_STORE_BYTES) throw new Error("oversized");
    const parsed = JSON.parse(raw) as DockLayoutStore;
    if (parsed?.schema !== V2_SCHEMA || parsed?.version !== V2_VERSION) {
      throw new Error("schema mismatch");
    }
    if (typeof parsed.variants !== "object" || parsed.variants === null) {
      throw new Error("bad variants");
    }
    // 每个 variant 的布局结构必须通过 validate（含 maxGroups 上下文）；
    // t530 F3：layout.variant 必须与其在 variants 中的 key 一致，不一致视为损坏。
    for (const [variant, layout] of Object.entries(parsed.variants)) {
      if (!layout) continue;
      if (layout.variant !== variant) {
        throw new Error(`variant mismatch: ${variant} != ${layout.variant}`);
      }
      const issues = validateLayout(layout, { variant: variant as DockVariant });
      if (issues.length > 0) throw new Error(`invalid layout: ${issues[0]?.code}`);
    }
    return parsed;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** 写入 v2 存档；超限/不可用返回 false（不抛错）。 */
export function saveV2Store(workspaceId: string, store: DockLayoutStore): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    const payload = JSON.stringify(store);
    if (byteLength(payload) > MAX_STORE_BYTES) return false;
    storage.setItem(v2StorageKey(workspaceId), payload);
    return true;
  } catch {
    return false;
  }
}

/** 清除 v2 key（reset all）。 */
export function clearV2Store(workspaceId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(v2StorageKey(workspaceId));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 变体切换（沿用 selectVariant 断点；不迁移 v1）
// ---------------------------------------------------------------------------

export interface VariantSwitchResult {
  layout: DockLayout;
  /** t530 F5：携带旧变体的完整 store——持久化归属明确：调用方负责 saveV2Store。 */
  store: DockLayoutStore;
  /** 旧变体布局已写入返回的 store（savedPrevious 恒 true，保留兼容）。 */
  savedPrevious: boolean;
}

/** 切换变体：保存当前 → 加载目标变体的 v2 存档或默认。持久化由调用方执行（saveV2Store）。 */
export function switchVariant(
  store: DockLayoutStore | null,
  current: DockLayout,
  nextVariant: DockVariant,
): VariantSwitchResult {
  const nextStore: DockLayoutStore = store
    ? { ...store, variants: { ...store.variants, [current.variant]: current } }
    : {
        schema: V2_SCHEMA,
        version: V2_VERSION,
        updatedAt: new Date().toISOString(),
        variants: { [current.variant]: current },
        activePanel: null,
      };
  const restored = nextStore.variants[nextVariant];
  return {
    layout: restored ? clampGroups(normalizeLayout(restored)) : defaultLayout(nextVariant),
    store: nextStore,
    savedPrevious: true,
  };
}

// ---------------------------------------------------------------------------
// React 接线（t530 F1）：v2 布局状态控制器——reduceDock 唯一命令入口
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";

export interface DockLayoutController {
  layout: DockLayout;
  /** v2 命令唯一入口：dispatch → reduceDock → effects（persist/notify/activate）。 */
  dispatch: (command: DockCommand) => void;
  /** 变体切换（断点）：内部保存旧变体并持久化，加载目标变体存档或默认。 */
  setVariant: (variant: DockVariant) => void;
  /** t542：重置全部变体——清 v2 store 并只保留当前 variant 的默认布局。 */
  resetAll: () => void;
  /** 立即 flush 持久化（卸载/beforeunload 用）。 */
  flush: () => void;
}

export interface UseDockLayoutOptions {
  workspaceId: string;
  variant: DockVariant;
  maxGroups?: number;
  onNotify?: (message: string) => void;
  onActivatedPanel?: (panel: PanelKey) => void;
  /** 测试注入时钟/存储刷新延迟。 */
  debounceMs?: number;
}

/**
 * v2 布局状态控制器（真实生产消费方，t530 F1）：
 * - 初始化：loadV2Store(workspaceId) 的当前 variant 存档或 defaultLayout(variant)；
 * - dispatch：reduceDock 唯一入口；effects.persist → 400ms debounce saveV2Store；
 *   effects.notify → onNotify；effects.activatedPanel → onActivePanelChange；
 * - setVariant：switchVariant（保存旧变体 + 持久化 + 恢复/默认）；
 * - 卸载 flush（React 19 严格模式双挂载安全：cleanup 清定时器）。
 * 渲染器不消费 layout（DW1-3 接入 DockTree 后才渲染）——当前作为 DockShell
 * 的 shadow-sync 状态源，把 v2 存档逐步构建起来，为 DW1-3 切换准备数据。
 */
export function useDockLayoutController(options: UseDockLayoutOptions): DockLayoutController {
  const { workspaceId, variant, maxGroups, debounceMs = 400 } = options;
  const [layout, setLayout] = useState<DockLayout>(() => {
    const store = loadV2Store(workspaceId);
    const restored = store?.variants[variant];
    return restored ? clampGroups(normalizeLayout(restored)) : defaultLayout(variant);
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const storeRef = useRef<DockLayoutStore | null>(null);
  const timerRef = useRef<number | null>(null);
  // t548：pending 标记——卸载时即使 storeRef 仍为 null（首次 dispatch 后未 flush）也不丢持久化。
  const dirtyRef = useRef(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current && storeRef.current === null) return;
    dirtyRef.current = false;
    const store: DockLayoutStore = storeRef.current ?? {
      schema: V2_SCHEMA,
      version: V2_VERSION,
      updatedAt: new Date().toISOString(),
      variants: {},
      activePanel: null,
    };
    store.variants[layoutRef.current.variant] = layoutRef.current;
    store.updatedAt = new Date().toISOString();
    if (!saveV2Store(workspaceId, store)) {
      optionsRef.current.onNotify?.("布局无法保存，将使用默认布局");
    }
    storeRef.current = store;
  }, [workspaceId]);

  const dispatch = useCallback(
    (command: DockCommand) => {
      const result = reduceDock(layoutRef.current, command, { maxGroups });
      if (result.layout !== layoutRef.current) {
        layoutRef.current = result.layout;
        setLayout(result.layout);
      }
      for (const message of result.effects.notify) {
        optionsRef.current.onNotify?.(message);
      }
      if (result.effects.activatedPanel) {
        optionsRef.current.onActivatedPanel?.(result.effects.activatedPanel);
      }
      if (result.effects.persist) {
        dirtyRef.current = true;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        // node 测试环境无 window——用全局 setTimeout（浏览器等价）。
        timerRef.current = setTimeout(flush, debounceMs) as unknown as number;
      }
    },
    [maxGroups, flush, debounceMs],
  );

  const setVariantCallback = useCallback(
    (nextVariant: DockVariant) => {
      const store = storeRef.current ?? loadV2Store(workspaceId);
      const switched = switchVariant(store, layoutRef.current, nextVariant);
      // 把切换后的新变体布局也写入 store（否则下次 restore 找不到该变体）。
      switched.store.variants[switched.layout.variant] = switched.layout;
      switched.store.updatedAt = new Date().toISOString();
      storeRef.current = switched.store;
      layoutRef.current = switched.layout;
      setLayout(switched.layout);
      // 变体切换立即持久化（归属：controller 内部完成，调用方无需再存）。
      if (!saveV2Store(workspaceId, switched.store)) {
        optionsRef.current.onNotify?.("布局无法保存，将使用默认布局");
      }
    },
    [workspaceId],
  );

  // t542：重置全部变体——清空 v2 store（其他 variant 不残留），storeRef 重建为
  // 只含当前 variant 的默认布局并立即持久化。
  const resetAllCallback = useCallback(() => {
    clearV2Store(workspaceId);
    const fresh: DockLayoutStore = {
      schema: V2_SCHEMA,
      version: V2_VERSION,
      updatedAt: new Date().toISOString(),
      variants: {},
      activePanel: null,
    };
    const freshLayout = defaultLayout(layoutRef.current.variant);
    fresh.variants[freshLayout.variant] = freshLayout;
    storeRef.current = fresh;
    layoutRef.current = freshLayout;
    setLayout(freshLayout);
    saveV2Store(workspaceId, fresh);
  }, [workspaceId]);

  // t542：断点变化（selectVariant 输出）自动切换变体——保存旧变体、加载新变体。
  const variantRef = useRef(variant);
  useEffect(() => {
    if (variantRef.current === variant) return;
    variantRef.current = variant;
    setVariantCallback(variant);
  }, [variant, setVariantCallback]);

  // 卸载 flush。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      // t548：pending 变更（dirtyRef）也 flush——避免首次 dispatch 后卸载丢数据。
      if (storeRef.current !== null || dirtyRef.current) flush();
    };
  }, [flush]);

  return { layout, dispatch, setVariant: setVariantCallback, resetAll: resetAllCallback, flush };
}
