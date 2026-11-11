# UX 审计文档索引（t189）

- **会议/任务**：t179 议程 → t180–t185 六路审计 → t186 去重短名单 → t187 最终报告 → t188 独立评审 → t189 文档入库
- **基线**：代码 `main@f3737d9`（t168/t175 已合入）；文档 `main@20f7a31`（t180 layout 已入库）
- **性质**：仅 `docs/team/`；**无生产代码改动**（不涉及 `src/`、`electron/`、`dist*`）；审计结论以设计/产品裁决为目标，不等于已实现
- **入库 PR**：`feature/t189-ux-audit-docs` → `main`（PR 与合并状态以 GitHub 为准）

---

## 1. 会议目标与范围

本轮会议要回答：**“指挥 AI 开发项目”的主流程，在交互设计、界面布局与可用性上哪里断了？**

范围覆盖：

- Shell/Welcome/Sidebar、Dock 10 个面板（chat/team/tasks/runs/mailbox/board/context/polls/watchdog/settings）；
- 任务/DAG、Run/调度、Review/VCS/Merge、Memory、Mail、Poll、Watchdog、Context、Settings；
- 主流程 7 步：打开工作区 → Router 讨论/规划 → DAG → 运行 → 监控 → 评审/合并 → 记忆沉淀；
- 8 个审计维度：信息层级、导航发现性、密度可读性、状态反馈、错误恢复、无障碍、性能、文案一致性。

**结论一句话**：功能深度已经足够，缺的是一条**可发现、可恢复、可完成**的工作流；保留 Dock，不做全量 IA 重写，先做 8 个 P0 切口。

---

## 2. 文档地图

| 文档 | 任务 | 内容 | 状态 |
|---|---|---|---|
| [`ux-audit-agenda.md`](ux-audit-agenda.md) | t179 | 屏幕/面板清单、7 步主流程、8 审计维、P0–P3 与证据卡模板、会议节奏 | 议程 |
| [`ux-audit-layout.md`](ux-audit-layout.md) | t180 | 界面层级图、25 行 keep/move/panel/modal、F01–F15、窄窗验算 | 审计 |
| [`ux-audit-workflow.md`](ux-audit-workflow.md) | t181 | 真实流程 Before/After、12 条摩擦 F1–F12、跨表面切换 | 审计 |
| [`ux-audit-accessibility.md`](ux-audit-accessibility.md) | t182 | 键盘/焦点/ARIA、Modal 叠层/inert、错误泄漏、对比度/字号等 15 项 | 审计（1 blocker） |
| [`ux-audit-feasibility.md`](ux-audit-feasibility.md) | t183 | 构建/运行测量、性能归因、布局硬约束、R1–R12 | 审计 |
| [`ux-audit-content.md`](ux-audit-content.md) | t184 | 文案/空态/首用/术语/设置密度、12 条内容改进 | 审计 |
| [`ux-audit-qa.md`](ux-audit-qa.md) | t185 | 0 任务/0 成员/长历史/大 diff/窄窗/200% zoom/Modal 等 12 边界用例 | QA 审计 |
| [`ux-audit-shortlist.md`](ux-audit-shortlist.md) | t186 | 六路审计 78 条去重 → 10 簇 → P0 8/P1 7/不做 5 类；**bb-97** | 短名单 |
| [`ux-audit-final.md`](ux-audit-final.md) | t187 | 最终报告：IA、逐屏、主流程 before/after、路线图、迁移、验收 | 最终报告 |
| [`ux-audit-review.md`](ux-audit-review.md) | t188 | 独立评审：覆盖度/一致性/现实性/遗漏/可执行性；**pass** | 评审 |

> 六路审计 = t180 layout、t181 workflow、t182 accessibility、t183 feasibility、t184 content、t185 QA；t179 是议程，t186/t187 是汇总，t188 是独立评审。

---

## 3. 裁决与结论

### 3.1 黑板裁决

- **bb-97**（t186）：78 条原始建议去重为 10 簇，**P0 8 / P1 7 / 不做/后置 5 类**；`ux-audit-shortlist.md` 为最终 shortlist。
- **bb-98**（Captain）：批准 P0 8 + P1 7；bb-97 作为最终 shortlist，不再投票。
- **t188 独立评审**：**verdict=pass**，无 blocker；3 条低优先观察（O1 Polls 小节、O2 px 推导、O3 P0-③ 拆分）不阻塞。

### 3.2 P0（8 条，本轮批准）

| ID | 切口 | 核心验收 |
|---|---|---|
| P0-1 | 窄窗 Dock/Team 自适应 | ≤960 默认 single + 侧栏折叠 + Team `within`；960/900/760 无裁切，主按钮可点 |
| P0-2 | 可见一级导航 rail | 常驻图标+短标签；10s 内找到对话/任务/团队/记忆；关闭面板可恢复 |
| P0-3 | WorkflowRail + NeedsMe | 阶段条常驻；每阶段 1 个主 CTA；失败/阻塞/评审/合并/告警/预算单一条目 |
| P0-4 | Chat→Plan + 可编辑 DAG | 目标 100% 带入；创建前可编辑任务/依赖/owner/验收/契约；无隐藏副作用 |
| P0-5 | 任务交付流水线 | 概览/运行/评审/Git/历史 tab + sticky CTA；Review/Merge/冲突首屏可见；三个“批准”分域 |
| P0-6 | 信任与恢复 | 错误脱敏（secret blocker 先行）；Settings dirty/保存失败 inline；Modal 栈/顶层 Esc/inert；快捷键不穿透 |
| P0-7 | 首用就绪 + 帮助/错误/空态 | 无 Key 新用户 60s 内知道下一步；Top 10 错误有恢复；Run/Context/Review/VCS/星图空态有 CTA |
| P0-8 | 流式/刷新/长历史性能 | R1 流式隔离、R2 面板渲染隔离、R3 刷新降噪；长历史可加载更早；无 API 回归 |

### 3.3 P1（7 条，同轮/下一轮）

| ID | 切口 |
|---|---|
| P1-1 | Settings 全高 Modal 守卫 + MergeQueue Dock 面板；dirty/save/focus |
| P1-2 | 历史分页 + 翻译失败重试 + 关键失败持久反馈 + 冲突处理 |
| P1-3 | Runs/Context/Polls/Watchdog 辅助面板 route/badge/溢出/恢复；旧 settings key 清理 |
| P1-4 | 无障碍基线：composer label、tabs、resizer、Review 焦点、skip link、Toast、对比度 |
| P1-5 | 任务/团队去重 + 执行契约 chip + 成员单一 owner |
| P1-6 | 内容/术语/空态/记忆命名/设置密度/评审摘要 |
| P1-7 | trace/星图/diff/字号/懒加载（R4）/体积预算（真机基线后） |

### 3.4 明确不做/后置（5 类）

1. **重依赖/替代渲染**：Monaco、自研 canvas、第三方虚拟列表、React Compiler、微前端。
2. **容器重写**：全量 Dock/App 重写、替换为传统多页路由。
3. **大字号档位**：先做 200% 验收，不先做应用内三档字号/完整 rem 化。
4. **邮箱长尾**：线程/未读/回执。
5. **过度优化**：星图 >150 全量渲染优化、聊天虚拟列表、trace 虚拟化（先分页/过滤/基线）。

> 其余后置项（插件/MCP/Skills 实功能、大 diff 全文搜索、多用户/权限扩展、owner/依赖数据层重构）见 `ux-audit-final.md` §5.3，不进入本轮 P0。

### 3.5 常驻最小集 S1–S7

工作区身份 + 模型/Key/Mock 就绪；一级入口；当前阶段 + 唯一 CTA；NeedsMe；当前任务/来源；关键 inline 错误；Chat composer/契约。长解释、历史、低频配置一律进二级面板/帮助/设置高级，不常驻主界面。

---

## 4. 下一步建议

1. **P0-6 secret sanitize 立即独立立项**（A11Y-06 blocker：错误横幅/复制详情可能泄漏 provider 原文）。
2. 其余按 `ux-audit-final.md` §5.4：
   - 安全先行（P0-6）；
   - 布局/入口：P0-1 → P0-2 → P0-3；
   - 主流程：P0-4 → P0-5；
   - 首用/信任：P0-7 与 P0-6 后半同批；
   - 性能：P0-8 R1–R3 并行，R4 进 P1-7。
3. 首批实现拆分（P0 ①–④，**本报告不实现**）：
   - P0-① Shell/入口/布局：P0-1 + P0-2 + P0-3；
   - P0-② 规划/DAG：P0-4；
   - P0-③ 交付/评审：P0-5 + P1-1 MergeQueue 面板；
   - P0-④ 信任/首用/性能：P0-6 + P0-7 + P0-8 R1–R3。
4. 每个 P0/P1 独立任务、独立评审、独立 PR；不把审计建议当一次大改。

---

## 5. 入库验证

- `git diff --check`：无 whitespace/冲突标记。
- 文档检查：10 份 `ux-audit-*.md`（含 t180 layout）均存在；文件名/任务号/裁决引用一致。
- 范围检查：`git diff --name-only` 仅 `docs/team/ux-audit-*.md`；无 `src/`、`electron/`、`dist*` 改动。
- 本索引只做导航与摘要，不替代 `ux-audit-final.md` 的完整论证；冲突以最终报告 + bb-98 裁决为准。

---

*文档版本：t189；基线 main f3737d9 / 文档 20f7a31；六路审计 + 短名单 + 最终报告 + 独立评审均已入库。*
