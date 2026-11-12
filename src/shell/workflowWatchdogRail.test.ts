import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const rail = readFileSync(new URL("./WorkflowRail.tsx", import.meta.url), "utf8");

describe("t428 watchdog in workflow rail", () => {
  it("removes the standalone watchdog topbar and feeds the rail", () => {
    expect(appSource).not.toContain('className="watchdog-topbar"');
    expect(appSource).toContain("watchdog={");
    expect(appSource).toContain("openAlerts: watchdogSnapshot.alerts");
    expect(styles).not.toContain(".watchdog-topbar");
    expect(styles).toContain(".workflow-watchdog");
  });

  it("keeps the rail data optional and preserves the budget a11y contract", () => {
    expect(rail).toContain("watchdog?: WorkflowWatchdog | null");
    expect(rail).toContain("watchdog ? (");
    expect(rail).toContain("BudgetBar");
    expect(rail).toContain("aria-label={`打开看门狗，${watchdog.openAlerts} 个未处理告警`}");
  });
});
