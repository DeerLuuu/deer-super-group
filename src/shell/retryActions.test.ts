import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("t253/t255 write-operation retry wiring", () => {
  it("retries only the idempotent plan confirm; non-idempotent writes keep the form", () => {
    expect(appSource).toContain('label: "重试确认"');
    expect(appSource).toContain("run: () => void handleConfirmPlan");
    expect(appSource).not.toContain('label: "重试创建任务"');
    expect(appSource).not.toContain('label: "重试发送邮件"');
    expect(appSource).toContain("if (created) onClose()");
    expect(appSource).toContain("if (sent) onClose()");
    expect(appSource).toContain("retryAction={");
    expect(appSource).toContain("writeThenRefresh(");
    expect(appSource).toContain("postError");
    expect(appSource).toContain("任务已创建，但刷新失败");
    expect(appSource).toContain("邮件已发送，但刷新失败");
  });
});
