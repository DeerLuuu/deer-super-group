# t432（G9）：Git 历史与工作区可拖拽分隔

- **任务**：t432 实现 G9（用户反馈：Git 工作区面板全显示时太矮，历史与工作区之间的分隔应可调整）
- **实现**：noor（GLM 席位）
- **分支**：`feature/t432-git-resizable-workspace`（worktree 开发，PR 流程，未改 main）
- **日期**：2026-11-13（Asia/Shanghai）

## 1. 变更内容

| 文件 | 变更 |
|---|---|
| `src/git/ui/gitWorkspaceSplit.ts`（新增） | 纯函数与常量：clamp（工作区 ≥160 / 历史 ≥180 → max=容器−216）、`workspaceHeightFromPointer`（拖拽映射：容器底 − 指针 Y）、`workspaceHeightAfterKey`（Arrow ±16 / Home / End）、`splitterUsable`（容器 <376 不可用）、localStorage 读写（key=`deer.git.workspaceHeight.<workspaceId>`，非法值回默认 300 并 clamp）、`workspaceHeightStyle`（`--git-workspace-h` CSS 变量） |
| `src/git/ui/GitGraphPanel.tsx` | 新增 `workspaceHeight` 状态 + `layoutRef` ResizeObserver（窗口/容器 resize 重新 clamp）；filter 与 workspace 之间插入 `<div class="git-st-splitter" role="separator">`：pointer 拖拽（pointer capture 实时更新）、双击恢复 300、键盘 ArrowUp/Down ±16 / Home 最小 / End 最大；aria-orientation=horizontal、aria-valuemin/max/now/valuetext（取整）、tabIndex=0、focus-visible |
| `src/git/ui/gitSourceTree.css` | `.git-st-layout` 行改为 `minmax(180px,1fr) 30px 6px var(--git-workspace-h,300px)`，areas 增加 `"nav splitter"`；`.git-st-splitter` 样式（row-resize、hover/focus 高亮线、focus-visible 轮廓）；≤719 三 tab 与 ≤560 短高两处容器查询均 `display:none` 隐藏分隔条 |
| `src/git/ui/gitWorkspaceSplit.test.ts`（新增，11 例） | clamp 上下限/默认/非法值、容器不可用、拖拽映射三向、键盘四键+边界、持久化往返/非法回退/容器变小重 clamp/localStorage 异常静默、CSS 变量样式 |
| `src/git/ui/gitSourceTree.test.ts`（+1 describe 3 例） | CSS 契约：行模板含 `var(--git-workspace-h, 300px)` 与 splitter 行、分隔条样式存在、≤719/≤560 隐藏规则 |
| `docs/team/t432/` | 三档截图 + `t432-verify.json`（CDP 断言报告） |

## 2. 交互契约

- **拖拽**：按住分隔条上下移动，工作区高度实时变化（= 容器底 − 指针 Y，clamp）；松开持久化。
- **键盘**：聚焦分隔条 → ArrowUp +16 / ArrowDown −16 / Home 160 / End 按容器最大；aria-valuenow 实时更新（valuetext「工作区高度 N 像素」）。
- **双击**：恢复默认 300（clamp 后持久化）。
- **持久化**：按 workspaceId 存 localStorage；非法值（NaN/负/字符串）回默认并 clamp；容器变小后读取旧值自动压到新上限。
- **响应式**：≤719（三 tab 模式）与 ≤560 短高（历史隐藏）分隔条隐藏，不参与布局。

## 3. 验证

- **单测**：`gitWorkspaceSplit.test.ts` 11 例 + `gitSourceTree.test.ts` 新 3 例全部通过。
- **浏览器实测（Edge headless + CDP，临时 harness 未入 PR）**：`docs/team/t432/t432-verify.json` 全 PASS——
  - 1440×900：分隔条可见、role/aria 完整、grid 4 行、Home→160、End→容器最大、ArrowDown −16、拖拽 +60、双击/持久化；
  - 960×700（?h=420 预设）：恢复存档 420，同套交互通过；
  - 480×640：分隔条 DOM 存在但 `display:none`（三 tab 模式）。
- **截图**：`docs/team/t432/wide-1440-default.png`（默认 300）、`mid-960-dragged.png`（预设 420）、`mobile-480-tabs.png`（≤719 隐藏）。截图为 mock `window.deer` 的真实 renderer（非 Electron 真机）。
- **三命令**：typecheck 0 / build 0（electron ⚡ Done）；test——t432 相关测试全绿（GitGraphPanel 9/9、gitWorkspaceSplit 11/11、gitSourceTree 6/6），全量套件 953 例中 933 过、20 失败均为**既有环境性失败**：`openai.test.ts`（需本地端点，main 上同样失败）+ git/gitWrite/readService.edge/watchdog 的 5s 计时类用例（全并行时机器过载）。对照证据：pristine main 全量同样失败 19 例（相同 4 个文件）；上述 4 个文件在 t432 worktree 单独运行 108/109→watchdog 重跑 23/23 全绿。与 t194/t206 记录的 watchdog timing flake 同源。

## 4. 边界与后续

- 分隔条实现过程中修正：aria-valuemax 取整（原始容器高度为小数，与 clamp 后整数不一致）。
- 修复期间发现并保持现状：`gitInitProbe` IPC 返回裸 probe（无 GitResult 包装），与其他 git 通道不同（harness 适配记录，不改生产契约）。
- 后续可选：`--git-workspace-h` 与 Dock 面板宽度联动提示；触屏拖拽（pointer events 已天然支持）。
