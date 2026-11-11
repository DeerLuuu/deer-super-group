import { describe, expect, it } from "vitest";
import { formatError } from "./copy.js";
import { safeErrorSummary, sanitizeErrorText } from "./errorRedaction.js";

describe("t190 error redaction", () => {
  it("redacts API keys, bearer/authorization, tokens and secrets", () => {
    const raw =
      "request failed sk-live-ABC123456 Authorization: Bearer abc.def.ghi token=secret-123 password=hunter2";
    const out = sanitizeErrorText(raw);
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("secret-123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("request failed");
  });

  it("redacts internal URLs/file URLs and URL query credentials", () => {
    const raw =
      "GET http://127.0.0.1:8787/internal?token=abc failed; file:///C:/Users/me/secret.txt";
    const out = sanitizeErrorText(raw);
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("C:/Users");
    expect(out).toContain("[内部地址已隐藏]");
    expect(out).toContain("[本地路径已隐藏]");
  });

  it("strips stack frames and provider raw bodies", () => {
    const raw = [
      "provider request failed",
      "    at OpenAiClient.stream (C:/app/src/model.ts:42:9)",
      "    at async run (C:/app/src/service.ts:8:1)",
      '{"error":{"message":"upstream body","request_id":"req_1"}}',
    ].join("\n");
    const out = sanitizeErrorText(raw);
    expect(out).not.toContain("at OpenAiClient");
    expect(out).not.toContain("upstream body");
    expect(out).not.toContain("request_id");
    expect(out).toContain("provider request failed");
    expect(out).toContain("[provider 原始响应已隐藏]");
  });

  it("formatError strips Electron remote prefix and sanitizes copy details", () => {
    const error = new Error(
      'Error invoking remote method chat:send: Error: LLM 401 {"error":"bad key"} key=sk-live-ABC123456',
    );
    const out = formatError(error);
    expect(out).not.toContain("Error invoking remote method");
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain('bad key');
    expect(out).toContain("[REDACTED]");
  });

  it("preserves an actionable code and summary; never returns empty", () => {
    expect(safeErrorSummary(Object.assign(new Error("rate limited"), { code: "RATE_LIMITED" }))).toBe(
      "RATE_LIMITED: rate limited",
    );
    expect(sanitizeErrorText("")).toContain("操作失败");
  });
});
