# P1-6 术语 / 记忆说明 / 模型配置路径 · 最终集成验收（t344）

- **任务**：t344 — 集成验收 P1-6，最终集成 t341 + t345 + t346 复验 + t343 评审
- **实现**：PR #51 / `feature/t341-content-terminology` @ `e87ce9d`（base main `f187af8`）
- **验证**：t346 复验 **PASS**（`docs/team/content-terminology-verification-2.md`）
- **评审**：t343 评审 **PASS**（`docs/team/content-terminology-review.md`）
- **PR**：[#51](https://github.com/DeerLuuu/deer-super-group/pull/51) — **MERGED（squash）**
- **合并提交**：`29b4c64`
- **实现文档**：`docs/team/content-terminology.md`
- **结论**：**PASS，已合并**；worktree 已清理，仅 main。

## 1. 结论

P1-6 已完成最终集成验收：

- **术语用户化**：运行历史 → 运行记录、运行中的 Run → 正在执行的任务、checks → 检查（技术字段 `title` 保留）、quorum → 投票门槛（字段不变）、blocker → 阻塞项；覆盖 App/RunPanel/RunHistory/SchedulerBar/Team/PollPanel/MergeQueue/CommandPalette/ReviewSection 的可见文案。
- **记忆说明**：黑板/备忘录/归档审核三 tab 的说明使用 `role="note"` + `aria-live`；黑板发布、备忘录新建/去黑板发布、归档去黑板查看 CTA 保持；空态有测试；无数据迁移。
- **模型配置路径**：Settings 四步路径（Provider → Key/BaseURL → 获取模型 → 选择默认模型）；`validateModelSetup` 校验 API Key 或环境变量、默认模型显式选择（不自动回退 `models[0]`）、provider/name/baseUrl/models；inline `role="alert"` + `aria-invalid` 阻止模型保存；Mock 豁免 Key；环境变量说明放在默认折叠的 `<details>`；schema 未变。
- **保存范围**：模型 section 保存校验模型；界面/Git/团队保存使用 `save({ validateModels: false })`，模型错误只阻止模型保存，不阻塞界面保存。
- **响应式/可访问性**：1440/960 截图四张；键盘/aria 保持；无 480 截图（N3 low）。
- 无权限/gate/数据层/schema/依赖变更。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| Run/checks/quorum/blocker 用户术语 | App/RunPanel/RunHistory/ReviewSection 等 | t346 §术语；t343 |
| 技术原文保留 | title 属性/字段名 | t346；t343 |
| 记忆三 tab 说明 | MemoryWorkbench role=note aria-live | MemoryWorkbench.test；t346 |
| 黑板/备忘录/归档 CTA/空态 | MemoryWorkbench | MemoryWorkbench.test 空态；t346 |
| 模型四步路径 | SettingsView | SettingsView.test；t346 |
| Key/env/默认模型校验 | `validateModelSetup` | SettingsView.test；t345/t346 |
| aria-invalid/role=alert | SettingsView inline | t345/t346 |
| Mock 豁免 Key / 高级变量折叠 | SettingsView | t346 §模型；t343 |
| 模型错误仅阻塞模型保存 | save({validateModels:false}) | SettingsView.test；t345/t346 |
| 1440/960/键盘/aria | 截图 + 既有控件 | t341 截图；t346 |
| 无 schema/权限/gate/数据层 | diff 仅 UI/tests/docs | PR diff；t346/t343 |

## 3. 独立复跑（合并后 main `29b4c64`）

工作目录：`S:\DeerSuperGroup`（仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；447 modules
                 # index 315.09 kB / gzip 93.90
                 # SettingsView 23.94 kB / gzip 6.88
                 # CSS index 130.68 kB / gzip 22.37
pnpm test -- --testTimeout=20000 --maxWorkers=2
                 # 120 files / 857 tests passed
```

> 默认 `pnpm test` 仍有既有 openai/watchdog/git 5s 并发 timeout；非本 PR 引入，CI 建议单独超时/串行。

## 4. 回归与范围

- **术语**：可见错误/确认/toast/空态/aria/评审阻断项无裸 Run/blocker；技术字段（checks/quorum 等）保留 title/内部名。
- **记忆**：三 tab 说明、发布/新建/归档 CTA、空态、键盘/aria 保持；无 schema/迁移。
- **模型**：四步路径、Key/env 校验、显式默认模型、Mock 豁免、高级环境变量折叠；模型错误不阻塞界面/Git 保存。
- **范围**：21 个文件；主范围 App/SettingsView/TeamDashboard/MemoryWorkbench/styles/shell/tests/docs；`CommandPalette`/`RunHistory`/`RunPanel`/`SchedulerBar`/`MergeQueuePanel`/`ReviewSection`/`KernelRuntimeUi.test`/`SettingsView.test` 为术语/校验必需改动（实现文档已标注 out-of-scope）。无 schema/权限/gate/数据层/IPC/依赖变更。
- **截图**：`docs/team/t341-memory-1440.png`、`t341-memory-960.png`、`t341-model-path-1440.png`、`t341-model-path-960.png`。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #51 | MERGED（squash） |
| merge commit | `29b4c64` |
| main | `29b4c64`（+ 本报告提交） |
| 实现 worktree | 已移除（清理时终止遗留 t341-ui Electron） |
| 实现 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 合并后三命令 | typecheck 0 / build 0 / test 120 files/857 |

## 6. 遗留（P1 发布前可补，不阻塞）

1. **MergeQueue `<dt>checks</dt>`/技术 title**：仍保留字段名（N1 low）。
2. **多 provider 全部要求 Key**：单 provider 5 分钟路径正常；多 provider 需逐个配置（N2 medium）。
3. **480 未测**：仅 1440/960 截图，480 模型/记忆布局未单独走查（N3 low）。
4. **env aria-invalid / Mock provider / addModel 自动默认**：仍有小边界（N4 low）。
5. **Run 内部技术名保留**：UI 术语已用户化，内部模型/字段仍用 Run（N5 low）。
6. **既有 5s 并发 flake**：非本 PR；建议 CI 串行/提高慢测 timeout（N6 info）。

**最终结论：P1-6 PASS，PR #51 已 squash 合并到 main `29b4c64`；术语、记忆三 tab 说明/CTA/空态、模型四步路径/校验/保存范围均集成验证，1440/960/键盘/aria 无回归；无 schema/权限/gate/数据层变更；遗留仅发布前可补的多 provider/480 深度项。**
