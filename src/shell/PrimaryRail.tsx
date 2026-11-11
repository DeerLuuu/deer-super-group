import { useRef, type KeyboardEvent } from "react";
import {
  PRIMARY_RAIL_ENTRIES,
  railFocusIndex,
  type PrimaryRailKey,
} from "./primaryRailData";

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
    >
      {!collapsed && (
        <div className="primary-rail-head">
          <span className="section-label">工作台</span>
        </div>
      )}
      <div className="primary-rail-list">
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
              title={collapsed ? entry.label : entry.title}
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
