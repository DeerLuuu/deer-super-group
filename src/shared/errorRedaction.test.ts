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

  it("redacts complete Authorization values for Basic/Token/Digest/Bearer", () => {
    const cases = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Authorization: Token abc.def.ghi",
      'Authorization: Digest username="u", realm="r", nonce="n", uri="/", response="deadbeef"',
      "Authorization: Bearer abc.def.ghi",
      "authorization: Basic dXNlcjpwYXNz",
    ];
    for (const raw of cases) {
      const out = sanitizeErrorText(`request failed ${raw}`);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("dXNlcjpwYXNz");
      expect(out).not.toContain("abc.def.ghi");
      expect(out).not.toContain("deadbeef");
      expect(out).not.toContain("username=");
      expect(out).toContain("request failed");
    }
  });

  it("redacts common private/internal IP and host forms", () => {
    const raw = [
      "http://192.168.1.20:8787/api",
      "http://10.0.0.5/v1",
      "http://172.20.3.4/health",
      "http://169.254.1.2/meta",
      "http://db.corp.local:5432",
      "http://host.docker.internal:3000",
      "http://[fe80::1]:8080",
    ].join(" ");
    const out = sanitizeErrorText(raw);
    expect(out).not.toContain("192.168.1.20");
    expect(out).not.toContain("10.0.0.5");
    expect(out).not.toContain("172.20.3.4");
    expect(out).not.toContain("169.254.1.2");
    expect(out).not.toContain("db.corp.local");
    expect(out).not.toContain("host.docker.internal");
    expect(out).not.toContain("fe80::1");
    expect(out.match(/\[内部地址已隐藏\]/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("redacts key aliases and Cookie/Set-Cookie headers", () => {
    const raw = [
      "client_secret=cs_123 clientSecret=csCamel access_token=at_123 accessToken=atCamel",
      "private_key=pk_123 access_key=ak_123 password=pw_123",
      "Cookie: session=abc; csrf=def",
      "Set-Cookie: sid=ghi; HttpOnly",
    ].join(" ");
    const out = sanitizeErrorText(raw);
    for (const secret of ["cs_123", "csCamel", "at_123", "atCamel", "pk_123", "ak_123", "pw_123", "abc", "def", "ghi"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[REDACTED]");
  });

  it("extended key aliases are redacted in URL queries and provider bodies", () => {
    const raw =
      'GET https://example.com/x?client_secret=cs_url&accessToken=at_url&private_key=pk_url ' +
      '{"error":{"client_secret":"cs_body","accessToken":"at_body","password":"pw_body"}}';
    const out = sanitizeErrorText(raw);
    expect(out).not.toContain("cs_url");
    expect(out).not.toContain("at_url");
    expect(out).not.toContain("pk_url");
    expect(out).not.toContain("cs_body");
    expect(out).not.toContain("at_body");
    expect(out).not.toContain("pw_body");
    expect(out).toContain("[provider 原始响应已隐藏]");
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
    expect(safeErrorSummary(new Error("plain failure"))).toBe("plain failure");
    expect(sanitizeErrorText("")).toContain("操作失败");
  });
});
