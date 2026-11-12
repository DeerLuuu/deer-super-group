import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");
const toast = readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("t292 accessibility baseline", () => {
  it("has a first skip link to a labelled main landmark and labelled sidebar", () => {
    expect(app).toContain('className="skip-link" href="#main-content"');
    expect(app).toContain('id="main-content" aria-label="主内容" tabIndex={-1}');
    expect(app).toContain('aria-label="侧栏"');
    expect(app.indexOf('className="skip-link"')).toBeLessThan(app.indexOf("<aside"));
  });

  it("keeps composer, Chat tabs and resizers semantically labelled", () => {
    expect(app).toContain('aria-label="给 Router 发消息"');
    expect(app).toContain('aria-describedby="chat-composer-help"');
    expect(app).toContain('id="chat-panel-chat"');
    expect(app).toContain('role="tabpanel"');
    expect(app).toContain('aria-controls="chat-panel-chat"');
    expect(app).toContain('aria-label="调整侧栏宽度"');
    expect(app).toContain('aria-label="调整任务列表宽度"');
    expect(app).toContain("aria-valuenow={effectiveSidebarWidth}");
    expect(app).toContain("aria-valuenow={listWidth}");
    expect(app).toContain('event.key === "ArrowRight"');
  });

  it("has visible focus, reduced motion and single-column 480 fallbacks", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) !important");
    expect(css).toContain(".skip-link:focus");
  });

  it("exposes Settings current section and Toast focus pause", () => {
    expect(settings).toContain('aria-current={section === item.id ? "page" : undefined}');
    expect(toast).toContain("onFocus={pause}");
    expect(toast).toContain("onBlur={resume}");
  });

  it("keeps body and secondary text at 4.5:1 or better", () => {
    expect(contrast("#e6edf3", "#0d1117")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#8b98a9", "#0d1117")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#8b98a9", "#151b24")).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain("color: var(--muted);");
    expect(css).not.toContain("color: #6e7681;");
  });
});
