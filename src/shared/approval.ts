/**
 * DESIGN §15.3 / t58 IF-05：auto_risk 高风险人类审批的超时（毫秒）。
 *
 * 主进程与 renderer 共用同一常量：
 * - 主进程超时后按「未批准」解析 Promise，由工具层写 `human_required` 风险事件；
 * - renderer 用同一常量做弹窗倒计时/自动收起，避免「已经超时但弹窗仍可批准」的 UI 不一致。
 */
export const RISK_APPROVAL_TIMEOUT_MS = 120_000;
