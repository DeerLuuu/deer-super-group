import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PanelKey } from "./dock/panelRegistry";
import {
  PRIMARY_RAIL_ENTRIES,
  railFocusIndex,
  type PrimaryRailKey,
} from "./primaryRailData";

/**
 * t220：rail 打开后的聚焦编排。
 * 每次 requestFocus 生成新 token，旧 timer/递归 timer 全部取消；pointerdown/keydown/
 * activePanelKey 变化会 invalidate；仅当 activePanelKey 仍是目标面板且 focusPanel 成功时停止。
 * App 直接用这个 hook；测试用 Harness 模拟 App 的序列。
 */
export function usePrimaryRailFocus(
  activePanelKey: PanelKey | null,
  focusPanel: (key: PrimaryRailKey) => boolean,
) {
  const focusRef = useRef(focusPanel);
  focusRef.current = focusPanel;
  const activeRef = useRef(activePanelKey);
  activeRef.current = activePanelKey;
  const generationRef = useRef(0);
  const timersRef = useRef<Set<number>>(new Set());
  const requestRef = useRef<{ key: PrimaryRailKey; token: number } | null>(null);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) globalThis.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    requestRef.current = null;
    clearTimers();
  }, [clearTimers]);

  const schedule = useCallback((callback: () => void, delay: number) => {
    const timer = globalThis.setTimeout(() => {
      timersRef.current.delete(timer as unknown as number);
      callback();
    }, delay);
    timersRef.current.add(timer as unknown as number);
  }, []);

  const attempt = useCallback(
    (key: PrimaryRailKey, token: number, remaining: number) => {
      if (token !== generationRef.current) return;
      if (requestRef.current?.key !== key) return;
      if (activeRef.current !== key) {
        // 等 React 提交 activePanelKey；若用户已切到别的面板，active effect 会 invalidate。
        if (remaining > 0) schedule(() => attempt(key, token, remaining - 1), 80);
        return;
      }
      if (focusRef.current(key)) {
        clearTimers();
        requestRef.current = null;
        return;
      }
      if (remaining > 0) {
        schedule(() => attempt(key, token, remaining - 1), 80);
      } else {
        requestRef.current = null;
      }
    },
    [clearTimers, schedule],
  );

  const requestFocus = useCallback(
    (key: PrimaryRailKey) => {
      invalidate();
      const token = generationRef.current;
      requestRef.current = { key, token };
      schedule(() => attempt(key, token, 40), 0);
    },
    [attempt, invalidate, schedule],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onInput = () => invalidate();
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    return () => {
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
    };
  }, [invalidate]);

  useEffect(() => {
    const request = requestRef.current;
    if (request && activePanelKey !== request.key) invalidate();
  }, [activePanelKey, invalidate]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return { requestFocus, invalidate };
}

export default function PrimaryRail({
  activeKey,
  collapsed,
  onOpen,
}: {
  activeKey: PrimaryRailKey | null;
  collapsed: boolean;
  onOpen: (key: PrimaryRailKey) => void;
}) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [shortViewport, setShortViewport] = useState(
    () => typeof window !== "undefined" && window.innerHeight <= 820,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setShortViewport(window.innerHeight <= 820);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      onOpen(PRIMARY_RAIL_ENTRIES[index].key);
      return;
    }
    const next = railFocusIndex(index, event.key, PRIMARY_RAIL_ENTRIES.length);
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  }

  return (
    <nav
      className={`primary-rail ${collapsed ? "is-collapsed" : ""}`}
      aria-label="一级入口"
      style={
        collapsed
          ? undefined
          : {
              paddingTop: shortViewport ? 2 : 6,
              paddingBottom: shortViewport ? 2 : 6,
              gap: shortViewport ? 2 : 4,
            }
      }
    >
      {!collapsed && (
        <div className="primary-rail-head">
          <span className="section-label">工作台</span>
        </div>
      )}
      <div
        className="primary-rail-list"
        style={collapsed ? undefined : { gap: shortViewport ? 1 : 2 }}
      >
        {PRIMARY_RAIL_ENTRIES.map((entry, index) => {
          const active = entry.key === activeKey;
          return (
            <button
              key={entry.key}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              className={`primary-rail-item ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={entry.label}
              title={collapsed ? entry.label : entry.title}
              style={
                collapsed
                  ? undefined
                  : {
                      paddingTop: shortViewport ? 4 : 6,
                      paddingBottom: shortViewport ? 4 : 6,
                    }
              }
              onClick={() => onOpen(entry.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="primary-rail-icon" aria-hidden="true">
                {entry.icon}
              </span>
              <span className="primary-rail-label">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export type { PrimaryRailKey };
