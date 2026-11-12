import { sanitizeErrorText } from "../shared/errorRedaction.js";

export type ErrorRecoveryKind = "auth" | "quota" | "key" | "network" | "unknown";
export type ErrorRecoveryAction = "settings" | "model" | "retry" | "details";

export interface ErrorRecovery {
  kind: ErrorRecoveryKind;
  title: string;
  summary: string;
  action: { kind: ErrorRecoveryAction; label: string };
}

/** 常见 provider/网络错误分类；只返回脱敏摘要，不引入新敏感字段。 */
export function classifyErrorRecovery(message: string): ErrorRecovery {
  const summary = sanitizeErrorText(message, 260);
  if (
    /未配置.*(?:api\s*)?key|api\s*key\s*(?:为空|缺失|未配置|empty|missing)|key.*(?:为空|缺失|missing|empty)|not configured|missing key/i.test(
      message,
    )
  ) {
    return {
      kind: "key",
      title: "未配置模型 Key",
      summary,
      action: { kind: "settings", label: "去设置 Key" },
    };
  }
  if (/401|403|unauthorized|forbidden|authentication|invalid api.?key|认证|鉴权/i.test(message)) {
    return {
      kind: "auth",
      title: "Provider 认证失败",
      summary,
      action: { kind: "settings", label: "去设置认证" },
    };
  }
  if (
    /429|rate.?limit|quota|usage limit|额度|配额|限额|too many requests|1308/i.test(message)
  ) {
    return {
      kind: "quota",
      title: "Provider 限额/限流",
      summary,
      action: { kind: "model", label: "切换模型" },
    };
  }
  if (/network|fetch|econn|etimedout|timeout|连接|网络|socket/i.test(message)) {
    return {
      kind: "network",
      title: "网络连接失败",
      summary,
      action: { kind: "retry", label: "重试" },
    };
  }
  return {
    kind: "unknown",
    title: "操作失败",
    summary,
    action: { kind: "details", label: "查看详情" },
  };
}
