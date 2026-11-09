# 交互画布与提问弹窗 · 集成验收报告（t66）

- **任务**：t66 [integration] 集成验收：交互画布与提问弹窗（in scope：`src/`、`docs/team/`；out of scope：`dist/`、`dist-electron/`）
- **集成人**：max（QA / Release Reviewer，DeepSeek 替代 vale；模型路由 `deepseek-official/deepseek-flash`）
- **日期**：2026-11-10
- **输入**：
  - 设计：`docs/team/interactive-canvas-design.md`（t63，3049 行）
  - 实现：`docs/team/interactive-canvas-implementation.md`（t64 + t80 §17，405 行）
  - 评审：t65 首轮 **needs_revision**（11 项 findings）→ t80 repair-round-2（12/12）→ t81 review-round-2 **verdict=pass**（12/12）
  - PR：**#1** `feature/t64-interactive-canvas` → `main`，**已合并**（merge commit `8b0818c`，mergedAt 2026-11-09T20:28:14Z）
- **验证**：`pnpm typecheck` / `pnpm build` / `pnpm test`（最终 main `8b0818c` 实跑）+ 协议/持久化/安全/回归静态核对 + 实现文档 §15 的 29 项人工清单（无 GUI 环境，人工项留待用户冒烟）

---

## 1. 最终结论（6/6 通过）

| 验收点 | 结果 | 依据 |
|--------|------|------|
| t65 评审通过，t64 PR 已合并到 main | ✅ | t65 首轮 needs_revision（11 findings）→ t80 全修（12/12）→ **t81 review-round-2 verdict=pass（12/12）**；PR #1 状态 **MERGED**，merge commit `8b0818c`；集成轮将 PR squash 合并到 main（`7fb747a..8b0818c`），t64 worktree 分支 `feature/t64-interactive-canvas` 保留供追溯 |
| 交互画布与提问弹窗在最终代码中可用 | ✅ | 四类画布（mindmap/flowchart/roadmap/dependency）+ 缩放/平移/fit/节点详情/1 跳聚焦/折叠 + Mermaid/SVG 导出；问题四字段（single/multi/text/confirm）+ 队列/稍后/取消/超时/防重复；`src/canvas/`、`src/interactive/`、`src/ChatContent.tsx`、`src/App.tsx` 均在 main；20 文件/246 用例覆盖 |
| schema 校验、安全回退、回答回流与持久化通过 | ✅ | `src/shared/interactive.ts` 双 zod strict schema（4 kind/7 status/8 node kind/4 edge kind/6 tone，节点≤80/边≤240/分组≤12，问题≤6 字段/选项≤12）；7 个错误码整块回退；答案在主进程全量复核并格式化为 `[回答表单]` 用户消息回流；`chat_artifacts`/`chat_questions` 两表条件更新/过期/跨 workspace 隔离；`interactive.test` 36 + `kernel/interactive.test` 14 条 |
| 与 Dock/Chat/Markdown/Modal/Toast 无回归 | ✅ | PR 改动 34 文件，不含 `DockShell`/`panelRegistry`/`TaskStarMap`/`Markdown.tsx`/`SettingsView`；`Modal.tsx` 仅新增可选 `initialFocusRef`，`Toast.tsx` 仅新增 `info`，既有默认路径不变；20 文件/246 用例含 Markdown 2、deeplink 13、星图 5、service 7；build 392 modules 通过 |
| typecheck / build / test 全部通过 | ✅ | exit 0/0/0：typecheck 无错误；build 392 modules、js 1,072.61 kB（gzip 294.94 kB）、css 198.12 kB（gzip 21.98 kB）、electron main 924.4 kB；test 20 文件 246/246（main-only；含本地 `branches/t64-*`/`branches/t68-*` worktree 的最终全量跑 **61 文件 771/771** 亦通过，见 §4.1） |
| `docs/team/interactive-canvas-final.md` 输出实现、验证与后续项 | ✅ | 本文件 |

---

## 2. 交付与实现映射（最终 main）

| 区域 | 文件 / 证据 | 交付要点 |
|------|-------------|----------|
| 协议/schema | `src/shared/interactive.ts`（1287 行）：`CanvasSchema`/`QuestionSchema` strictObject；`CANVAS_LIMITS`/`QUESTION_LIMITS`；`E_JSON/E_SCHEMA/E_PROTOCOL/E_VERSION/E_TOO_LARGE/E_LIMIT/E_UNCLOSED`；`sanitizeText`；`parseChatContent`/`scanInteractiveSegments`；`compressInteractiveForModel`；`stripInteractiveForStreaming`；`INTERACTIVE_PROMPT_V1` | fence 只解析助手消息；其他语言 fence/行内代码不拦截；坏块整块回退且保留前后文本；流式不裸露 JSON |
| 存储 | `src/kernel/store.ts:181–219`（两表 + 索引）、`:996–1180`（9 方法） | `chat_artifacts`/`chat_questions` `CREATE TABLE IF NOT EXISTS`；`UNIQUE(message_id, block_index)`；`answerChatQuestion` 条件 UPDATE；`expireChatQuestions` 逐条条件更新；所有查询带 workspace |
| 服务 | `src/kernel/service.ts:489`（sendChat ingest）、`:609`（ingest）、`:720`（answer）、`:813`（cancel）、`:967`（context 交互段） | 幂等 ingest、`changed:false` 不重复发消息、`E_BUSY/E_EXPIRED/E_CLOSED/E_WORKSPACE_MISMATCH`、审计事件不含答案值 |
| IPC | `src/shared/ipc.ts`、`electron/preload.ts`、`electron/main.ts` | 5 通道：`chat:artifacts:list`、`chat:artifact:get`、`chat:questions:list`、`chat:question:answer`、`chat:question:cancel`；主进程复核答案 |
| 布局 | `src/canvas/layout.ts`（1024 行） | 四类图确定性布局；bounds/fitView；`placeDetailPosition`(:990)/`nodeScreenAnchor`(:957)；折叠可见集；80 节点性能 smoke |
| 画布 UI | `src/canvas/CanvasArtifact.tsx`、`CanvasCard.tsx`、`CanvasFallback.tsx`、`interaction.ts` | 视口/节点/边/分组/泳道；缩放 0.3–2.2、平移、fit、±/0/方向键；单击 250ms 详情、双击 1 跳聚焦；详情按实测尺寸翻转/夹取 (:548)、开焦点 (:274)/回焦 (:358)；浮层滚轮隔离 (:246)；`role="application"` (:566)、`aria-live` (:874)；导出菜单 `role=group` |
| 导出 | `src/canvas/export.ts` | Mermaid id 重映射/标签清洗/白名单行校验；SVG 纯函数 + `escapeXml` + 无脚本/外链；4096 限制；折叠可见集导出 |
| 对话接入 | `src/ChatContent.tsx`、`src/ChatBubble`（`App.tsx`） | 文本段仍走 Markdown `skipHtml`；canvas/question 块组件化；用户/系统消息纯文本；失败块回退卡片；流式剥离 |
| 提问 UI | `src/interactive/QuestionModal.tsx`、`QuestionCard.tsx`、`QuestionFallback.tsx`、`questionFlow.ts` | 四字段 + fieldset/legend/aria-labelledby/组级 aria-invalid（`:197–285`）；`initialFocusRef`；错误 role=alert；取消二次确认 4s；可选 timeoutSec；`answerAlreadySent`/`shouldAutoOpenQuestion`/composer 焦点排除 |
| App 流程 | `src/App.tsx:165–205`（状态/派生）、`:511–584`（自动打开 DEC-10）、`:1017`（取消）、`:1050`（回答）、`:1771`（Modal）、`:588–622`（审批优先收起） | 队列/稍后/草稿/防重复/workspace 重置；`changed:true` 才 `sendChat`；失败 toast 带重发去重；风险审批优先 |
| 安全 | `src/shared/interactive.ts` strict schema + `src/canvas/export.ts` + `ChatContent` | 无 `dangerouslySetInnerHTML/innerHTML/eval/new Function/document.write/window.open`（grep 0）；React 转义；模型不能提供颜色/坐标/样式；选项不经过 Markdown |
| 样式/可达性 | `src/styles.css` t64 分区（+1092 行） | `--canvas-*` 复用现有 token；`data-width` compact/regular/wide；窄窗 960/1100/1440 与 chat 面板 420/520/760；focus-visible；reduced-motion；无裸 hex |
| 测试 | 9 个新测试文件（实为 10 个，含 t80 `questionFlow.test.ts`）；总计 246 | 协议 36、布局 22、导出 17、交互 9、持久化/服务 14、Canvas SSR 14、QuestionModal 5、QuestionCard 4、questionFlow 19、ChatContent 5；既有 101 条基线保持 |

---

## 3. 评审、修复与合并流转

| 阶段 | 结果 |
|------|------|
| t64（ray，实现） | P0 全部实现；worktree `branches/t64-interactive-canvas`；PR #1 打开（未直改 main）；初始 worktree 验证 19 文件/206 用例 |
| t65（ivy，评审 1） | **needs_revision**：11 项 findings（F1 详情浮窗裁剪 high、F2 详情焦点 medium、F3 dim focus、F4 表单 ARIA、F5 重发去重、F6 autofocus composer、F7 折叠导出、F8 缩放锚点、F9 裸色、F10 浮层滚轮、F11 假 menu）；PR 流程/worktree 未改 main 通过 |
| t80（ray，repair 2） | F1–F11 全修；新增 `questionFlow` 19 条与既有测试补充（+40）；worktree 20 文件/246 全绿；commit `55812c8` 推送至 PR |
| t81（noor，评审 2） | **verdict=pass**，12/12 acceptance；复核 F1–F11 均已落地；PR #1 open/mergeable、worktree clean、未改 main |
| t66（max，集成） | 复核最终 main + PR 合并 + 三命令 + 安全/回归静态核对；新增本报告；PR #1 **squash 合并**为 `8b0818c`（main `7fb747a..8b0818c`） |

> **合并说明**：t81 通过后 PR #1 仍为 OPEN；集成轮在确认 `mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`、head `d86756c` 包含 t80 修复后执行 `gh pr merge 1 --squash`，GitHub 返回 **MERGED**、mergeCommit `8b0818c`；本地 main fast-forward 到该 commit。GitHub 无 required review/CI（`reviewDecision` 为空、`statusCheckRollup=[]`），因此团队评审 t81 是唯一质量门禁，已在本报告留证。

---

## 4. 最终验证（main `8b0818c` 实跑）

### 4.1 三条命令

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无错误（main 合并后） |
| `pnpm build` | ✅ | 0 | vite **392 modules**；`dist/assets/index-CNAUXv7D.css 198.12 kB (gzip 21.98)`、`index-qRb9Mlr9.js 1,072.61 kB (gzip 294.94)`；`dist-electron/main.cjs 924.4kb`、`preload.cjs 3.5kb`；chunk >500 kB 警告（t64 前既有 + zod 增量，非阻断） |
| `pnpm test` | ✅ | 0 | 最终全量（main 合并后，本机含 `branches/t64-*`/`branches/t68-*` worktree）：**61 文件 / 771 用例全部通过**；main-only 复跑 `pnpm exec vitest run --dir src`：**20 文件 / 246 用例全部通过**（此前 t68 代码未同步时的全量样本为 51 文件/626，同样通过） |

**测试环境说明（不属 t64 代码问题）**：
1. `pnpm test` 默认扫描整个工作区，包含本地 `branches/t64-interactive-canvas`（重复 t64 测试，均通过）与 `branches/t68-execution-kernel`（并发任务，含内核测试）。最终全量 **61/771 全绿**（04:31:24）；此前 t68 worktree 处于一次并发合并中（`store.ts` 短暂出现 `<<<<<<<`），该时段的全量跑会被外部 worktree 污染；冲突随后已由 t68 负责人解决。main 本身 `src/` 无冲突标记，main-only 20/246 全绿。
2. 建议后续在 vitest 配置中 `exclude: ['branches/**']`（或把 worktree 移出项目根），避免全量测试扫描本地 worktree；本任务未改 `vite.config.ts`（t66 inScope 为 `src/`、`docs/team/`）。
3. `branches/t64-interactive-canvas` 未删除；PR 已合并，建议 Captain/后续按 AGENTS §8 `pnpm branch:remove t64-interactive-canvas` 清理（不在本轮代码范围）。

### 4.2 静态与安全核对

- `rg "dangerouslySetInnerHTML|innerHTML|eval\(|new Function|document\.write|window\.open" src` → **0 命中**（t64 新代码；`Markdown.tsx` 未改，保持 `skipHtml`）。
- `package.json` / `pnpm-lock.yaml` **无改动**：无新依赖，zod 4.6.7 既有；协议/布局/导出均为自研纯函数，无第三方图/表单库。
- zod `strictObject` 拒绝 `style/html/url/color/x/y` 等未知字段；节点/边/分组 id/端点/分组引用校验；答案服务端复核拒绝额外 key/非法选项/超长。
- SSR 测试断言恶意 label/选项只以转义文本出现；导出 Mermaid 白名单行校验、SVG `escapeXml` 无 script/foreignObject/外链。
- t64 CSS 分区无裸 hex/rgb（t81 F9 机读 0 处）；状态色只经 `--status-*` token。
- PR 改动不含 Dock/Markdown/星图/设置文件；`Modal.tsx`/`Toast.tsx` 改动为可选新增，默认行为不变（git diff 核对）。

### 4.3 t65 findings 修复复核（main）

| Finding | 复核证据 |
|---------|----------|
| F1 详情浮窗裁剪 | `layout.ts:990 placeDetailPosition` 按实测尺寸翻转/夹取；`CanvasArtifact.tsx:548` 使用；`layout.test.ts` 4 条含底部节点 |
| F2 详情焦点 | `CanvasArtifact.tsx:274` 聚焦首动作、`:358` 关闭回焦、非模态不圈禁；详情 SSR/手工项 22 |
| F3 dim 聚焦 | `styles.css:3974 .canvas-node.dimmed:focus-visible` 恢复 opacity + 焦点环；样式断言 |
| F4 表单 ARIA | `QuestionModal.tsx:197–285` fieldset/legend、`aria-labelledby`、组级 `aria-invalid`、文本 aria-label；测试 2 条 |
| F5 重发去重 | `questionFlow.answerAlreadySent` + App `resendAnswer`；`questionFlow.test.ts` 6 条 |
| F6 自动打开排除 composer | `questionFlow.shouldAutoOpenQuestion`/`isComposerFocusWithin`；13 条矩阵 |
| F7 折叠导出 | `visibleCanvasArtifact` + `onVisibleLayoutChange`；`export.test.ts` 4 条 |
| F8 缩放锚点 | `nodeScreenAnchor`/`selectedZoomAnchor`；`layout.test.ts` 锚点用例 |
| F9 裸色 | t64 CSS 机读 0 处 hex/rgb；token 断言 |
| F10 浮层滚轮 | `isCanvasOverlayWheelTarget` 先 return；`interaction.test.ts` 2 条 |
| F11 导出菜单 | `CanvasExportMenu` `role="group"`、Esc 回焦；`CanvasArtifact.test.tsx` 2 条 |

### 4.4 首轮/复审评审证据

- t65（ivy）：**needs_revision**，7 条 acceptance 中 4 passed，11 findings（F1 high；其余 medium/low），PR open/mergeable、worktree clean。
- t80（ray）：12/12 acceptance passed；F1–F11 全修；worktree 20 文件/246 全绿。
- t81（noor）：**verdict=pass**，12/12 acceptance；F1–F11 逐项复核；PR 保持 open、未改 main。
- 因 t65 首轮未通过，t66 以 **t81 复审 pass + t80 修复证据**作为“评审通过”的最终门禁；本报告 §4.3 在 main 上再次核对修复点。

---

## 5. 验收链路核对

### 5.1 合法/非法 canvas
- `parseChatContent` 只解析助手消息；合法 `deer-canvas` → `CanvasSchema` → 四类布局 → CanvasCard；非法 JSON/schema/版本/超限/未闭合 → `CanvasFallback` 错误码 + 转义原始 JSON，正文前后文本保留（`interactive.test.ts` 36 条、`ChatContent.test.tsx` 5 条）。
- 缩放/平移/fit/±/0/方向键/空白清理/拖拽阈值在 `CanvasArtifact.tsx` + `layout.test.ts`；节点详情按实测尺寸翻转/夹取、焦点进入/回焦、Esc 逐级、Enter/Ctrl+Enter 等价；1 跳聚焦与 dim 恢复全亮有实现与样式断言。
- 折叠（分组/分支/泳道）只改本地可见集，不改 JSON；折叠后导出按可见集（F7）。

### 5.2 提问四字段与生命周期
- `QuestionSchema` 四字段；`QuestionModal` 原生控件 + fieldset/legend/aria-invalid + 错误 role=alert + 必填/min-max/maxLength + 取消二次确认 + 可选 timeoutSec + `initialFocusRef` + 隐私提示；`QuestionCard` 四状态。
- 回答：主进程 `answerChatQuestion` 校验 → 条件 UPDATE `status='pending'` → `formatQuestionAnswer` → `sendChat` 生成 `[回答表单]` 用户消息；`changed:false` 不重复发；`E_BUSY/E_EXPIRED/E_CLOSED/E_WORKSPACE_MISMATCH/E_INVALID_ANSWER` 覆盖；取消/过期/跨 workspace/审计不含答案值（`kernel/interactive.test.ts` 14 条）。
- 刷新/切对话：画布以 `message.content` 为事实源；问题来自 `chat_questions`（表 IF NOT EXISTS）；跨 workspace 隔离；工作区切换清空本地队列/草稿（`App.tsx:701`）。

### 5.3 与 Dock/Chat/Markdown/Modal/Toast
- PR 未改 DockShell/panelRegistry/TaskStarMap/SettingsView/Markdown.tsx；Dock 无新增面板（画布为对话内联卡片，P1 才做 Dock 面板）。
- `ChatContent` 文本段仍走 `<Markdown skipHtml>`；用户/系统消息纯文本，不解析 deer-*。
- `Modal` 仅新增可选 `initialFocusRef`，既有 5 个弹窗默认路径不变；`Toast` 新增 `info`（role=status），既有 success/error 行为不变。
- 20 文件/246 用例中 Markdown 2、deeplink 13、星图 5、service 7、模型 10 全过；build 392 modules。

### 5.4 安全
- 模型输出不可信：strict schema 白名单 + React 转义 + 无危险 API；节点/边/分组/选项枚举；文本清洗控制符/双向字符。
- 答案：主进程全量复核，拒绝额外 key/非法选项/超长/过期/跨 workspace；条件更新防重放；审计只记 id/计数/错误码。
- 导出：Mermaid id 重映射 + 标签清洗 + 白名单行校验；SVG 纯函数 + `escapeXml` + 无脚本/外链；文件名去路径字符。
- 资源上限：64KiB/块、80 节点/240 边/12 分组、6 块/消息、16KB 答案、标签 120 字符、布局线性遍历。

---

## 6. 集成发现与后续项

**阻断缺陷：无。** 未修改生产代码（仅新增本报告）；PR 合并系发布动作。

| 编号 | 严重度 | 观察 | 处理/建议 |
|------|--------|------|-----------|
| IF-01 | 低（测试环境） | `pnpm test` 扫描本地 `branches/` 下 worktree，重复执行 t64/t68 测试；t68 并发冲突标记会让全量跑失败，main-only 不受影响 | 建议 vitest `exclude: ['branches/**']` 或把 worktree 移出项目根；本轮未改 `vite.config.ts`（out of scope） |
| IF-02 | 低（包体） | js 1,072.61 kB > 500 kB 警告；zod 全量进 renderer，gzip 较 t64 前 +约 48KB（实现文档偏差 #2） | 后续动态 import/拆包或轻量校验器；当前为已知取舍 |
| IF-03 | 低（验证） | 无 RTL/Playwright；画布 DOM 交互、窄窗、reduced-motion 依赖实现文档 §15 的 29 项人工清单 | 引入测试库后补组件/e2e；本轮人工项交用户冒烟 |
| IF-04 | P1 | Dock「画布」面板、PNG 导出、工具调用 `render_canvas`/`ask_user`、节点 refs 跳转、草稿持久化按设计 P1 | 见实现文档 §14 |
| IF-05 | 信息 | GitHub PR 无 required review/CI（`reviewDecision` 空、checks 空），团队 t81 评审是唯一门禁；PR 模板要求 UI 截图，本轮无 GUI 未提供 | 已在 §3 记录；后续真实 UI 冒烟补截图 |
| IF-06 | 低（产品） | 导出菜单点击外部不自动收起；问题草稿仅内存（刷新丢失）；`document.hasFocus` 自动打开在特殊焦点场景可能不弹 | 均为设计 P0 边界，记 P1/人工项 |
| IF-07 | 信息 | 本地 `branches/t64-interactive-canvas` 未删除（PR 已合并） | 建议 Captain/后续 `pnpm branch:remove t64-interactive-canvas`；清理前保留追溯 |

---

## 7. 限制与人工冒烟

- 无 Electron GUI/Playwright：画布拖拽/缩放、问题弹窗键盘、窄窗、reduced-motion、剪贴板/下载、真实模型协议遵从性需人工验证；自动化以 246 条单测 + SSR + 纯函数覆盖。
- 人工冒烟按 `interactive-canvas-implementation.md` §15 的 29 项执行（含 t80 追加 9 项）；关键 10 项：
  1. Mock 输入四种图 → 画布出现、无 JSON 裸露；坏 JSON/schema/版本/81 节点/未闭合 → 回退卡片。
  2. 滚轮缩放/拖拽平移/fit/±/0/方向键；单击 250ms 详情、双击聚焦、Esc 逐级、Enter/Ctrl+Enter。
  3. 分组/分支/泳道折叠；折叠后导出不含隐藏节点。
  4. 四字段表单校验、必填/min-max/maxLength/confirm、错误内联 + 焦点首错。
  5. 提交回答 → `[回答表单]` 用户消息 → Router 继续；刷新后卡片已回答；重复提交不重复发。
  6. 两问题队列/稍后/自动打开排除 composer；timeoutSec 倒计时与过期；取消二次确认。
  7. 风险审批弹窗出现时问题弹窗收起，审批后卡片仍在。
  8. 960/1100/1440 与 chat 面板 420/520/760 无横向溢出；200% + reduced-motion。
  9. 导出 Mermaid/SVG 可打开、无脚本、标签正确；剪贴板失败 textarea 兜底。
  10. 刷新/切对话/切工作区恢复且不串档；危险 HTML 夹具不执行；`rg` 危险 API 0 命中。

---

## 8. 文件清单与变更记录

- **t64 PR #1（已合并）**：34 文件，+11,045/−19；包含 `src/shared/interactive.ts`、`src/canvas/*`、`src/interactive/*`、`src/ChatContent.tsx`、`src/kernel/{store,service,model}.ts`、`src/shared/{types,ipc}.ts`、`electron/{main,preload}.ts`、`src/App.tsx`、`src/styles.css`、`src/Modal.tsx`、`src/Toast.tsx`、9 个测试文件、实现文档；无 `dist/`、`dist-electron/` 手工修改。
- **t66 新增**：`docs/team/interactive-canvas-final.md`（本报告）；未修改 `src/`、`electron/`、`vite.config.ts`。
- **git**：main `7fb747a` → `8b0818c`（PR #1 squash merge）；`feature/t64-interactive-canvas` 保留；本地 `branches/t64-interactive-canvas` 未删除。
- **变更记录**：t64 实现（19/206）→ t65 needs_revision（11）→ t80 修复（20/246）→ t81 pass（12/12）→ t66 集成/合并（20/246 main-only；最终全量 61/771）→ 本报告。

---

*本报告为 t66 集成验收交付。后续请按 §6/§7 处理测试环境 exclude、包体与人工冒烟；无阻断项。*
