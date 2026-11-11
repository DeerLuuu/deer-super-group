// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSLATION_SETTINGS } from "./shared/translation.js";
import { defaultModelProfile, defaultProviderProfile } from "./shared/models.js";
import type { LlmSettings, Snapshot } from "./shared/types.js";
import SettingsView from "./SettingsView.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => SettingsRenderer;
};

interface SettingsRenderer {
  root: {
    findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
  };
  toJSON: () => unknown;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

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

function makeSnapshot(): Snapshot {
  return { settings } as Snapshot;
}

const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

async function renderSettings(
  onSave: (next: LlmSettings) => Promise<{ ok: true } | { ok: false; error: string }>,
  onDirtyChange = vi.fn(),
  windowApi: Record<string, unknown> = {},
) {
  (globalThis as { window?: unknown }).window = {
    deer: {
      getTranslationSettings: async () => ({ ...DEFAULT_TRANSLATION_SETTINGS }),
    },
    ...windowApi,
  };
  let renderer: SettingsRenderer | null = null;
  await act(async () => {
    renderer = create(
      <SettingsView
        snapshot={makeSnapshot()}
        busy={false}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        onReload={() => {}}
      />,
    );
    await Promise.resolve();
  });
  if (!renderer) throw new Error("renderer not created");
  return { renderer: renderer as SettingsRenderer, onDirtyChange };
}

describe("t190 Settings draft/save safety", () => {
  it("marks dirty after an edit and keeps the draft when save fails", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "保存失败（测试）" }));
    const { renderer, onDirtyChange } = await renderSettings(onSave);
    const nameInput = renderer.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "供应商名称");
    expect(nameInput).toBeTruthy();
    await act(() => {
      (nameInput!.props.onChange as (event: unknown) => void)({
        target: { value: "Changed Provider" },
      });
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const saveButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("保存"));
    expect(saveButton).toBeTruthy();
    await act(async () => {
      await (saveButton!.props.onClick as () => Promise<void>)();
    });
    const output = textOf(renderer.toJSON());
    expect(output).toContain("保存失败");
    expect(
      renderer.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "供应商名称")?.props.value,
    ).toBe("Changed Provider");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows success inside Settings and clears dirty after a successful save", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    const { renderer, onDirtyChange } = await renderSettings(onSave);
    const nameInput = renderer.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "供应商名称");
    await act(() => {
      (nameInput!.props.onChange as (event: unknown) => void)({
        target: { value: "Saved Provider" },
      });
    });
    const saveButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("保存"));
    await act(async () => {
      await (saveButton!.props.onClick as () => Promise<void>)();
    });
    const output = textOf(renderer.toJSON());
    expect(output).toContain("已保存");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("registers a beforeunload guard while Settings is dirty", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const onSave = vi.fn(async () => ({ ok: true as const }));
    const { renderer } = await renderSettings(onSave, vi.fn(), {
      addEventListener,
      removeEventListener,
    });
    const nameInput = renderer.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "供应商名称");
    await act(() => {
      (nameInput!.props.onChange as (event: unknown) => void)({
        target: { value: "Dirty Provider" },
      });
    });
    expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const handler = addEventListener.mock.calls.find((call) => call[0] === "beforeunload")?.[1] as
      | ((event: { preventDefault: () => void; returnValue: string }) => void)
      | undefined;
    const event = { preventDefault: vi.fn(), returnValue: "" };
    handler?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
