# P0-7 复验：Key 恢复与空态唯一 CTA（t252）

- **任务**：t252 [verification] 独立复验 t251
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #39 `feature/t247-first-run`，HEAD `b4fb94c`（OPEN/MERGEABLE；worktree `branches/t247-first-run`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 errorRecovery/firstRunData/Settings/ApprovalTerms/App + 真实错误文案探针 + 测试。

---

## 1. 结论：**PASS（通过，无 blocker）**

- 真实 Key 错误 `未配置 API Key：…`、`API Key 为空`、`API key missing/empty` 均命中 key → `去设置 Key`（settings），不是 unknown。
- Tasks 详情空态只保留唯一 primary「+ 新建任务」；「规划任务」不再出现在详情空态（仍作为头部 ghost 二级入口打开 Plan Draft，不是 primary）。
- `onOpenModels`/`onOpenSettings` 走 `openSettingsSection("models")`；SettingsView `initialSection` active=模型；首用缺模型/Key CTA 同样聚焦模型分区。
- `FirstRunState.dismissed` 已删除，折叠由 `collapsed` prop 承载；ApprovalTerms 以 `role=note`/`aria-label=批准术语说明` 渲染在 Review tab，三类批准术语有渲染断言。
- 首用/错误/空态其余项无回退；1440/960 截图；gate/权限/状态机/数据层未改。
- 三命令最终全绿（81 文件/714）；首轮 plain test 因并发 10 个既有 5s timeout，重跑 714/714 通过（N3）。

---

## 2. 命令（worktree HEAD `b4fb94c`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 426 modules；css 258.38 kB (gzip 31.63)；js 1,271.97 kB (gzip 351.34)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（最终重跑） | **0** | **81 文件 / 714 用例**全绿 |
| `pnpm exec vitest run --testTimeout=10000` | **0** | 81/714 全绿（与 t251 记录一致） |

首轮 plain `pnpm test` 在负载下出现 10 个既有 5s timeout（openai/watchdog/git 等）；同一 worktree 重跑与 extended 均 714/714，非本功能回归（N3）。

---

## 3. 逐项

### 3.1 真实 Key 文案 → 去设置 Key（PASS）

`errorRecovery.ts` key 分支现匹配：

```text
未配置 API Key：请在设置中填写 -> key/settings (true)
API Key 为空                 -> key/settings (true)
API Key is empty             -> key/settings (true)
API key missing              -> key/settings (true)
未配置 Key                    -> key/settings (true)
No API key configured        -> unknown（非当前 UI 真实文案，N2）
```

- `errorRecovery.test` 新增 4 条真实 UI key 文案断言。
- `ErrorRecoveryBar` key 只渲染一个 primary「去设置 Key」+ 关闭；sk-/Bearer 摘要仍脱敏；`role=alert`/aria-live。
- auth/quota/network 分支无回退（401→settings、429→model、fetch→retry）。

### 3.2 Tasks 空态唯一 primary（PASS）

- 任务详情空态 actions 只有 `{ label: "+ 新建任务", primary: true }`（App.tsx:4259）；列表空态同样只有 +新建。
- `terminology.test` 增加静态 guard：截取详情空态 block，断言含「+ 新建任务」且不含「规划任务」。
- 头部仍保留 ghost「规划任务」入口（打开 Plan Draft，不是直接建任务），不是 primary；与“唯一 primary”口径一致。**N1 low**：若“唯一新建任务”按所有 CTA 计数，头部仍有规划入口，需在文案上明确“唯一 primary”。

### 3.3 onOpenModels/设置聚焦/dismissed/术语（PASS）

- `openSettingsSection(section="models")`：set `settingsInitialSection` + `openPanel("settings")`；`initialSection={gitSettingsFocus ? "git" : settingsInitialSection}`；ErrorRecoveryBar 的 settings/model、首用缺模型/Key CTA 均走 models。
- `SettingsView.test` 新增 `initialSection="models"` 渲染断言：active nav 文本含「模型」。
- `FirstRunState.dismissed` 已从类型/App/tests 删除；折叠由 `FirstRunCard collapsed` + App `firstRunCollapsed` 控制。
- `ApprovalTerms` 新组件 `role=note` + `aria-label=批准术语说明`，文本含「任务交付批准/代码评审通过/合并确认」；Review tab 渲染（App.tsx:4607）。组件测试通过。

### 3.4 首用/错误/空态无回退（PASS）

- 首用四项 checks、唯一 CTA、非 Router+非 offline 成员、稍后 chip、不阻塞；`firstRunData.test` 4 + `FirstRunCard.test` 1。
- Chat 开始对话 focus composer、Team 仅 Router 新建成员、Memory/Mail 既有 CTA；Tasks 空态 +新建。
- ErrorRecoveryBar 关闭/详情/单一动作；无敏感信息；不写数据；WorkflowRail/NeedsMe 未改。
- 1440/960 截图沿用 t247（CSS 无变化），无横向裁切；键盘/aria 原生按钮。

### 3.5 范围/gate（PASS）

- 仅 UI/派生逻辑/tests/styles/docs；未改 review/merge gate、权限、任务状态机、数据层/schema。
- 81/714 全绿；permission 44、approval 9/2、execution 43、review 17 通过。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | low | Tasks 头部仍保留 ghost「规划任务」（打开 Plan Draft）；详情空态只有 +新建 primary。若按“所有 CTA 唯一”理解，头部仍有规划入口 | 保持 primary 唯一；文案明确“新建任务为唯一主行动” |
| N2 | low | `No API key configured` 英文文案仍归 unknown；当前 UI 真实文案是中文/`API key missing/empty`，已覆盖 | 可补该英文模式 |
| N3 | low | 首轮 plain test 在并发负载下 10 个既有 5s timeout；extended 与最终重跑 714/714 | CI 对脆弱测试单独超时/串行 |
| N4 | low | ApprovalTerms 组件测试只渲染 note 文本/aria；任务交付/评审/合并 action 的 aria 仍由静态守卫 + 现有组件测试覆盖 | 可补 action 级 aria 快照 |

---

## 5. 结论

**PASS**：t248 的 F1（真实 Key 文案分类）、F2（Tasks 详情唯一 primary）、F3（设置聚焦模型）、F4（dismissed 删除）、F6（术语渲染 aria）均已修复；首用/错误/空态/960 无回退；未改 gate/权限/状态机；三命令最终 0/0/0，81/714。N1/N2/N3/N4 为非阻塞改进，不阻塞 PR #39 进入评审/合并流程。

*本次验证仅新增本报告，未修改生产代码。*
