# G17：默认 1440 下 Git 面板可调分隔线（t608）

## 问题

- 默认 1440 窗口、Dock 双栏时，Git 面板主组约 666px。
- `gitSourceTree.css` / `gitWorkingDiff.css` 的容器断点为 `max-width: 719px`。
- 666px 命中该断点，进入三 tab 移动布局，`.git-st-splitter` 被 `display:none`，历史/工作区分隔线不可拖。
- 之前 G9 的 N1 已记录该问题：需要关闭 Team/最大化或更宽窗口才能拖拽。

## 修复

- 两个容器断点从 `719px` 调整为 `600px`。
- 666px（默认 1440 Dock Git 面板）不再进入三 tab 模式：
  - 历史、6px 分隔条、工作区同时可见；
  - 分隔条鼠标/键盘可拖，高度继续走 `--git-workspace-h` 与 G9 持久化；
  - 双击恢复 300 的既有行为不变。
- `<600px` 仍进入三 tab 移动布局；`≤560px` 短高策略保持隐藏历史/分隔条。
- 工作区 diff（`gitWorkingDiff.css`）同步使用 600px 断点，避免 Git 主区与 diff 区断点不一致。

## 验证

- 新增测试 `默认 1440 Dock 宽度约 666px 不进入三 tab 模式`：
  - 解析所有 `@container git-panel (max-width: Npx)`，取最小断点；
  - 断言 `minWidth <= 600` 且 `666 > minWidth`。
- 既有 G9 测试更新为 600px 契约：
  - 分隔条 CSS 契约；
  - ≤600 三 tab、≤560 短高隐藏。
- 命令：
  - `pnpm typecheck` — 0
  - `pnpm build` — 0（477 modules）
  - `pnpm test -- --maxWorkers=1 --testTimeout=20000 --no-file-parallelism` — 186 文件 / 1254 用例

## 回滚

- 将两处 `max-width: 600px` 改回 `719px`，并同步测试即可。
- 不涉及数据/schema/权限/依赖。

## 已知边界

- 600–719px 区间使用桌面双区布局（导航 180px + 历史/工作区），比移动三 tab 更紧凑；如后续发现 <640px 过挤，可再单独优化导航宽度，而不是重新隐藏分隔条。
