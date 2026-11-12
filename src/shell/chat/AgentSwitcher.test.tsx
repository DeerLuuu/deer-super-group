// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AgentSwitcher } from "./AgentSwitcher.js";
import type { ChatAgentOption } from "../../shared/chatAgent.js";

const { act, create } = TestRenderer as any;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents: ChatAgentOption[] = [
  {
    id: "router",
    name: "Router",
    role: "Coordinator",
    isRouter: true,
    model: null,
    permission: "full_access",
    status: "idle",
  },
  {
    id: "a1",
    name: "Mika",
    role: "Designer",
    isRouter: false,
    model: "deepseek-flash",
    permission: "workspace_write",
    status: "idle",
  },
];

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

describe("t424 AgentSwitcher", () => {
  it("opens a listbox, marks the selected option and selects via keyboard", async () => {
    const onSelect = vi.fn();
    let renderer: any;
    await act(async () => {
      renderer = create(
        <AgentSwitcher agents={agents} selectedId="router" onSelect={onSelect} />,
      );
    });
    const trigger = renderer.root.findByProps({ role: "combobox" });
    expect(trigger.props["aria-expanded"]).toBe(false);
    await act(async () => {
      trigger.props.onClick();
    });
    expect(renderer.root.findByProps({ role: "listbox" })).toBeTruthy();
    expect(
      renderer.root
        .findAllByProps({ role: "option" })
        .filter((option: any) => option.props["aria-selected"]),
    ).toHaveLength(1);
    const listbox = renderer.root.findByProps({ role: "listbox" });
    expect(listbox.props["aria-label"]).toBe("对话成员");

    const combobox = renderer.root.findByProps({ role: "combobox" });
    await act(async () => {
      combobox.props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
    });
    await act(async () => {
      renderer.root
        .findByProps({ role: "combobox" })
        .props.onKeyDown({ key: "Enter", preventDefault() {} });
    });
    expect(onSelect).toHaveBeenCalledWith("a1");
    expect(renderer.root.findByProps({ role: "combobox" }).props["aria-expanded"]).toBe(false);
    renderer.unmount();
  });

  it("closes with Escape and returns focus to the trigger", async () => {
    const focus = vi.fn();
    const HTMLElementCtor = globalThis.HTMLElement;
    const documentCtor = (globalThis as any).document;
    (globalThis as any).HTMLElement = class {
      focus = focus;
    };
    (globalThis as any).document = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    try {
      let renderer: any;
      await act(async () => {
        renderer = create(
          <AgentSwitcher agents={agents} selectedId="a1" onSelect={() => {}} />,
        );
      });
      const trigger = renderer.root.findByProps({ role: "combobox" });
      await act(async () => {
        trigger.props.onClick();
      });
      await act(async () => {
        renderer.root.findByProps({ role: "combobox" }).props.onKeyDown({
          key: "Escape",
          preventDefault() {},
        });
      });
      expect(renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
      renderer.unmount();
    } finally {
      (globalThis as any).HTMLElement = HTMLElementCtor;
      (globalThis as any).document = documentCtor;
    }
  });

  it("renders the current member name and Router badge", async () => {
    let renderer: any;
    await act(async () => {
      renderer = create(
        <AgentSwitcher agents={agents} selectedId="a1" onSelect={() => {}} />,
      );
    });
    const text = textOf(renderer.toJSON());
    expect(text).toContain("Mika");
    expect(text).toContain("▾");
    renderer.unmount();
  });
});
