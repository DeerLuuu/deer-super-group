# 首用就绪 / 错误恢复 / 空态 · 独立验证报告（t248）

- **任务**：t248 [verification] 独立验证 t247 P0-7
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #39 `feature/t247-first-run`，HEAD `15b8c60`（OPEN/MERGEABLE；worktree `branches/t247-first-run`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 firstRunData/ErrorRecovery/空态/术语代码与测试 + 对照真实错误文案。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

FirstRunCard 的四项检查/唯一 CTA、空态/术语主体成立；但 **P0-7 的 Key 错误恢复在真实错误文案上失效**：

- 真实未配置 Key 的文案是 `未配置 API Key：请在设置中填写…`（`src/kernel/model.ts:585/601/649`）和 `API Key 为空`（`:650`）。
- `classifyErrorRecovery` 的 key 正则只覆盖 `未配置 Key` / `api key missing|未配置` 等（`errorRecovery.ts:11`）；对真实文案实测为 **unknown**，恢复动作变成「查看详情」，不是「去设置 Key」。
- 现有测试仅用短串「未配置 Key」，没有覆盖真实 UI 文案。**F1 blocker**。

另外 Tasks 的空态/头部仍有「规划任务」与「+新建任务」并存（F2 medium，与 t247 输出的“Tasks=唯一新建任务”不符）。其余首用/空态/术语/960 主体通过；三命令 typecheck/build 0，plain test 2 个既有 5s timeout（F5）。

---

## 2. 命令（worktree HEAD `15b8c60`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 425 modules；css 258.38 kB (gzip 31.63)；js 1,271.85 kB (gzip 351.24)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（plain） | **1** | 2 个既有 5s timeout：`openai.test`、`watchdog pauses`；78/80 文件、707/709 用例通过 |
| `pnpm exec vitest run --testTimeout=10000`（参考 t247） | **0** | 80 文件/709 用例全绿（t247 记录；本次未重复完整长跑） |

---

## 3. 逐项

### 3.1 首用就绪（PASS）

- `deriveFirstRunState` 从现有 snapshot 派生 workspace/model/credentials/member 四项；Router 不计成员；App `workers.filter(status!=="offline")` 只计可执行成员。
- 缺 Key → `settings-key` CTA；无成员 → team；就绪空工作区 → chat；已有内容隐藏；`FirstRunCard` 唯一 primary + “稍后”折叠 chip；未就绪不阻塞主界面。
- `firstRunData.test` 3 项、`FirstRunCard.test` 1 项通过；1440/960 截图。

### 3.2 四类错误恢复（FAIL）

| 类别 | 期望 | 实际 |
|------|------|------|
| key | 去设置 Key | 真实 `未配置 API Key：...` → **unknown**（见下）；测试只覆盖 `未配置 Key` |
| auth | 去设置 | 401/403/unauthorized/invalid api key → auth/settings；PASS |
| quota | 切换模型 | 429/rate limit/quota/1308 → quota/model；PASS |
| network | 重试 | network/fetch/ECONN/timeout → network/retry；PASS |

实测正则：

```text
"未配置 API Key：请在设置中填写" -> key rule False
"API Key 为空"                    -> key rule False
"未配置 Key"                      -> key rule True
```

`classifyErrorRecovery("未配置 API Key：...")` 因此走 unknown → `{action:{kind:"details"}}`，ErrorRecoveryBar 只显示「查看详情」，用户拿不到「去设置 Key」的直接动作——这正是 P0-7 要解决的常见首次错误。**F1 blocker**。

脱敏本身成立：`sanitizeErrorText` 覆盖 sk-/Bearer/Authorization；ErrorRecoveryBar/测试无泄漏。

### 3.3 空态/CTA（部分 FAIL）

- Chat：EmptyState「开始对话」，onClick focus composer；PASS。
- Team：仅 Router 时新建成员；`TeamDashboard` 改动；PASS。
- Tasks：
  - 列表空态只有「+ 新建任务」（App.tsx:4137）；PASS。
  - **但任务详情空态仍有两个 actions：「规划任务」+「+ 新建任务」**（App.tsx:4250-4251），头部也仍有「规划任务」+「新建」（`:4094/4096`）。与 t247 输出“Tasks=唯一新建任务”不一致；**F2 medium**（规划现在走 Plan Draft，安全性已由 t235 解决，但“唯一 CTA”不成立）。
- Memory/Mail 保留既有 CTA；空态不写数据；WorkflowRail/NeedsMe 未改；PASS。

### 3.4 三类批准术语（PASS）

- 任务交付：`aria-label="批准任务交付（任务交付 gate；不是代码评审通过）"` + note「批准术语说明」（App.tsx:4582-4600）。
- 代码评审：ReviewSection「行级评审 / 合并前代码评审」、diff/decision；与任务交付区分。
- 合并确认：Git tab note「Git / PR / worktree 与入队准备不是合并确认；合并确认只在合并队列中执行」（App.tsx:4551-4552）；Team 合并队列 aria-label「合并确认在此执行」。
- gate 未改；review/merge 权限/状态机无变更；terminology.test 静态守卫通过。

### 3.5 1440/960/键盘/aria/回归（PASS，命令见 §2）

- FirstRunCard 四 checks + 唯一 primary + chip；ErrorRecoveryBar role=alert/aria-live、唯一 primary + 关闭/详情；空态 buttons 原生。
- 1440/960 截图；无横向裁切。
- Build/typecheck pass；plain test 有既有 5s timeout（openai/watchdog），非本功能（F5）；t247 extended 709/709。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| **F1** | **blocker** | Key 分类不识别真实 `未配置 API Key` / `API Key 为空`，落到 unknown/「查看详情」，不是去设置 Key | key 正则增加「未配置 ... API Key」「API Key 为空/未填写/not configured」；用 kernel model 的真实文案测试 ErrorRecoveryBar 动作=settings |
| F2 | medium | Tasks 详情空态/头部仍「规划任务」+「+新建任务」并存，与“唯一新建任务”不符 | 详情空态只留唯一主 CTA，规划入口收到二级/命令面板；或更新 t247 交付口径 |
| F3 | medium | `ErrorRecoveryBar` 的模型动作 `onOpenModels` 实际 `openPanel("settings")`，未聚焦模型分区；quota 用户需二次寻找 | Settings 支持初始 section=models；onOpenModels 传 model section |
| F4 | low | FirstRunState 接收 `dismissed` 但未使用；折叠由 App firstRunCollapsed 控制，语义重复 | 删除参数或纳入 show/缩略 |
| F5 | low | plain test 2 个既有 5s timeout（openai/watchdog），非本功能；extended 709 全绿 | CI 单独超时/串行 |
| F6 | low | 术语测试为源码字符串守卫，非渲染 aria 断言 | 补组件级 aria 断言 |

---

## 5. 结论

- 首用清单/唯一 CTA、Chat/Team/Memory/Mail 空态、三术语/gate 主体成立；Build/typecheck 绿，extended 709。
- **F1 是 P0-7 的 core blocker**：真实未配置 Key 错误得不到 Key 恢复动作；F2 与 t247 的 Tasks 唯一 CTA 口径不符。
- PR #39 需 repair F1（建议 F2/F3 同批）后重验；本次未修改生产代码。

*本次验证仅新增本报告。*
