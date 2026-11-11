/**
 * t190：错误展示的共享脱敏层。
 *
 * 服务端（terminal 等）已经做一次脱敏；renderer 的 banner/toast/chat error
 * 仍可能收到 IPC/provider 原文，因此在共享层再做一次防御性清洗。
 *
 * 保留：可行动的错误码/首行摘要；移除：stack、provider 原始 body、凭据、
 * 内部 URL 查询参数；不把整段 JSON 贴进 UI。
 */

const INTERNAL_URL =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|[^\s/:]+\.internal)(?::\d+)?[^\s)"]*/gi;
const FILE_URL = /file:\/\/[^\s)"]*/gi;
const SECRET_KEY = /\bsk-[A-Za-z0-9_-]{6,}\b/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER = /\b(?:Authorization|x-api-key|api-key)\s*:\s*[^\s,;]+/gi;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*[^&\s,;]+/gi;
const URL_SECRET = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s]+/gi;
const PROVIDER_BODY =
  /\{[\s\S]*(?:"error"\s*:|"choices"\s*:|"request_id"\s*:|"provider"\s*:)[\s\S]*\}/gi;

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 清洗一段可能来自 provider/IPC 的错误文本。 */
export function sanitizeErrorText(value: string, max = 1_000): string {
  let text = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n?/g, "\n");

  // 去掉 stack 帧；保留第一行可读摘要。
  text = text
    .split("\n")
    .filter((line) => !/^\s*at\s+\S+/.test(line))
    .join("\n");

  text = text
    .replace(SECRET_KEY, "[REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(AUTH_HEADER, "Authorization: [REDACTED]")
    .replace(ASSIGNED_SECRET, (match) => `${match.split(/[=:]/)[0]}=[REDACTED]`)
    .replace(URL_SECRET, "$1[REDACTED]")
    .replace(INTERNAL_URL, "[内部地址已隐藏]")
    .replace(FILE_URL, "[本地路径已隐藏]")
    .replace(PROVIDER_BODY, "[provider 原始响应已隐藏]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return truncate(text, max) || "操作失败（未提供错误详情）";
}

/** 保留错误码/首行摘要；不返回 stack/provider body。 */
export function safeErrorSummary(error: unknown, max = 1_000): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const code =
    record && (record.code ?? record.name) != null
      ? sanitizeErrorText(String(record.code ?? record.name), 64)
      : "";
  const message = error instanceof Error ? error.message : error == null ? "" : String(error);
  const summary = sanitizeErrorText(message, max);
  return code && !summary.includes(code) ? `${code}: ${summary}` : summary;
}
