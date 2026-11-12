import { useEffect, useId, useRef, useState } from "react";
import type { ChatAgentOption } from "../../shared/chatAgent.js";

/**
 * t424：对话成员 combobox/listbox。
 * Router 固定置顶；无效/空列表时不渲染（调用方回退 Router）。
 */
export function AgentSwitcher({
  agents,
  selectedId,
  onSelect,
}: {
  agents: ChatAgentOption[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = `${useId()}-agent-listbox`;
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null;
  const safeIndex = Math.min(activeIndex, Math.max(0, agents.length - 1));

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!selected) return null;

  function closeAndFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function choose(index: number) {
    const agent = agents[index];
    if (!agent) return;
    onSelect(agent.id);
    closeAndFocus();
  }

  return (
    <div className="chat-agent-switcher" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label="切换对话成员"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${safeIndex}` : undefined}
        className="chat-agent-trigger"
        onClick={() => {
          setActiveIndex(Math.max(0, agents.findIndex((agent) => agent.id === selected.id)));
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const base = open
              ? safeIndex
              : Math.max(0, agents.findIndex((agent) => agent.id === selected.id));
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const next = Math.min(agents.length - 1, Math.max(0, base + delta));
            setOpen(true);
            setActiveIndex(next);
            return;
          }
          if (!open) return;
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setActiveIndex(event.key === "Home" ? 0 : agents.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose(safeIndex);
          } else if (event.key === "Escape") {
            event.preventDefault();
            closeAndFocus();
          }
        }}
      >
        <span className="chat-agent-avatar" aria-hidden="true">
          {selected.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="chat-agent-name">{selected.name}</span>
        {selected.isRouter && <span className="badge">Router</span>}
        <span className="chat-agent-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="chat-agent-popover" role="listbox" id={listboxId} aria-label="对话成员">
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={agent.id === selected.id}
              tabIndex={-1}
              className={`chat-agent-option ${index === safeIndex ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="chat-agent-avatar" aria-hidden="true">
                {agent.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="chat-agent-option-text">
                <strong>{agent.name}</strong>
                <span className="muted tiny">{agent.role}</span>
              </span>
              {agent.isRouter && <span className="badge">Router</span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
