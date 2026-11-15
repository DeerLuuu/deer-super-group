// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSLATION_SETTINGS } from "../shared/translation.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import type { LayoutSettings, LlmSettings, Snapshot } from "../shared/types.js";
import SettingsView from "../SettingsView.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    };
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const provider = defaultProviderProfile(
  { baseUrl: "https://example.com/v1", apiKey: "sk-test-123456", baseUrlEnv: "", apiKeyEnv: "" },
  "provider_default",
  "Default",
);
const model = defaultModelProfile("deepseek-flash", "provider_default");
const settings: LlmSettings = {
  baseUrl: provider.baseUrl,
  baseUrlEnv: "",
  apiKey: provider.apiKey,
  apiKeyEnv: "",
  providers: [provider],
  model: model.id,
  models: [model],
  mock: true,
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

async function render(layout?: LayoutSettings) {
  (globalThis as { window?: unknown }).window = {
    deer: { getTranslationSettings: async () => ({ ...DEFAULT_TRANSLATION_SETTINGS }) },
  };
  const onSave = vi.fn(async (_next: LlmSettings) => ({ ok: true as const }));
  const onDirtyChange = vi.fn();
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(
      <SettingsView
        snapshot={{ settings: layout ? { ...settings, layout } : settings, agents: [] } as unknown as Snapshot}
        busy={false}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        onReload={() => {}}
        initialSection="interface"
      />,
    );
    await Promise.resolve();
  });
  return { renderer: renderer!, onSave, onDirtyChange };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("t364 interface font scale radios", () => {
  it("defaults to standard and saves the selected scale without waiting for a reload", async () => {
    const { renderer, onSave, onDirtyChange } = await render();
    const radios = renderer.root
      .findAllByType("input")
      .filter((input) => input.props.type === "radio");
    expect(radios.map((radio) => radio.props.value)).toEqual(["small", "standard", "large"]);
    expect(radios.find((radio) => radio.props.value === "standard")?.props.checked).toBe(true);
    expect(textOf(renderer.toJSON())).toContain("正文/控件");
    await act(async () => {
      (radios.find((radio) => radio.props.value === "small")!.props.onChange as () => void)();
      await Promise.resolve();
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const save = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("保存界面设置"))!;
    await act(async () => {
      await (save.props.onClick as () => Promise<void>)();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].layout?.fontScale).toBe("small");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("clamps an invalid stored fontScale to standard", async () => {
    const { renderer } = await render({
      maxDockGroups: 6,
      chatHistoryLimit: 40,
      fontScale: "huge" as unknown as LayoutSettings["fontScale"],
    });
    const radios = renderer.root
      .findAllByType("input")
      .filter((input) => input.props.type === "radio");
    expect(radios.find((radio) => radio.props.value === "standard")?.props.checked).toBe(true);
  });
});
