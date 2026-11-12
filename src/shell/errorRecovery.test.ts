import { describe, expect, it } from "vitest";
import { classifyErrorRecovery } from "./errorRecovery.js";

describe("t247 provider error recovery", () => {
  it("classifies key/auth/quota/network and picks one recovery action", () => {
    expect(classifyErrorRecovery("未配置 Key")).toMatchObject({
      kind: "key",
      action: { kind: "settings", label: "去设置 Key" },
    });
    expect(classifyErrorRecovery("401 invalid api key")).toMatchObject({
      kind: "auth",
      action: { kind: "settings" },
    });
    expect(classifyErrorRecovery("429 rate limit, quota exceeded")).toMatchObject({
      kind: "quota",
      action: { kind: "model", label: "切换模型" },
    });
    expect(classifyErrorRecovery("fetch failed: ECONNRESET")).toMatchObject({
      kind: "network",
      action: { kind: "retry", label: "重试" },
    });
    expect(classifyErrorRecovery("unexpected parser failure")).toMatchObject({
      kind: "unknown",
      action: { kind: "details", label: "查看详情" },
    });
  });

  it("redacts secrets in the summary", () => {
    const recovery = classifyErrorRecovery(
      "401 invalid key sk-abcdef123456 Authorization: Bearer secret-token",
    );
    expect(recovery.summary).not.toContain("sk-abcdef123456");
    expect(recovery.summary).not.toContain("secret-token");
    expect(recovery.summary).toContain("401");
  });
});
