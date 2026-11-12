# P1-4 无障碍基线 · 复审 round 3（t299）

- **对象**：PR #44 `feature/t292-a11y-baseline`，HEAD `d9737b3`（OPEN/MERGEABLE）；t298 修复
- **评审人**：aria（独立复审，未修改生产代码）
- **基线**：main `ea40513`；t297 findings（F1 480 Tasks 详情、F2 200% 口径）
- **结论**：**PASS（无 blocker）**；480 Tasks 详情已可见，resizer/焦点/对比/动效证据成立。

## 1. 命令

在 `branches/t292-a11y-baseline` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（437 modules；css260.65 kB/gzip32.05；js1,299.00 kB/gzip359.44；main1.5MB/preload12.0）
- `pnpm test -- --testTimeout=20000 --maxWorkers=2`：**102 文件/790 用例全绿**
- plain 并发仍有既有 openai/watchdog/git 5s flake；按 t293/t296/t298 口径 extended 全绿，未改代码。

worktree clean；PR #44 OPEN/MERGEABLE；无权限/gate/数据层/依赖变更。

## 2. t297 修复确认

### F1 480 Tasks 详情 — 已修

- `.tasks-layout` 在 ≤640 容器改为 `auto / minmax(120px,180px) list / minmax(240px,1fr) detail`，`overflow-y:auto`；`.task-detail-panel min-height:240px`。
- `t292-a11y-480-tasks-detail.png` 现在显示任务详情：任务行、负责人/优先级/Run、操作、概览/运行/评审/Git/历史 tab、描述/验收文本可达；`480` 宽无横向。
- `t292-a11y-480-team-scrolled.png` 显示滚动后的 Team/星图；`t292-a11y-resizer-960.png` 证明 resizer focus；首用卡单列/可折叠。
- 证据：真实 Electron 480 CSS，detail clientHeight238/top447，scrollWidth480。

### F2 200% 口径 — 已按 Captain 接受范围记录

- 文档写明：验收按 **真实 Electron 480 CSS 视口基线**，不宣称 OS 200%/DPR2；Captain t297 接受该范围；系统 DPR2/读屏为 P1 发布前走查。没有虚报 OS 200% 通过。
- 480/960/1440 的布局/无横向/详情可达有实际截图；在已接受基线下成立。

### F3–F6 — 已处理

- **F3 480 Team**：`t292-a11y-480-team-scrolled.png` 显示滚动后团队/星图，members/star-map 可达。
- **F4/F5**：SkipLink/Separator/Toast/Chat tabs 增加 DOM/组件交互测试；对比测试读 `styles.css` token；真实 skip focus 首 Tab 已走查。
- **F6 快速连按**：`stepSidebarWidth` 用 ref 串行、`stepListWidth` 用 `listWidthRef`/`layoutWidthRef`；30 次快速 Arrow 停在 394/280，不越界。
- **Resizer**：Sidebar `sidebarMaxWidth(viewportWidth)` 394/334/194/180、折叠隐藏；Tasks `layoutRef`+52% clamp、≤640 不渲染；`aria-valuenow/max` 动态；SeparatorControl Arrow/Home。
- **Chat tabs** Home/End；**Toast** focus pause；**对比** 16.02/6.45/5.90；**reduced-motion** 1e-06s；**skip/main/aside/composer** 语义保留。

### 无回归

- 1440/960/480 无横向；480 main418/Dock418/Chat377/Team383/Tasks398；Tasks 详情在单列下方可滚动。
- Modal/CommandPalette 既有 trap 未改；无权限/gate/数据层/依赖变化。
- 102/790 全绿；PR 仅 App/Settings/Toast/styles/shell a11y tests/docs/screenshots。

## 3. 非阻塞观察

- **N1（low）**：`a11yBaseline.test` 仍以源码字符串断言为主；SkipLink 组件测试只断言 href，真实 skip 聚焦/焦点顺序由人工走查证明。建议后续补 App 级 skip focus 断言。
- **N2（low）**：200% 的 OS/DPR2 未实测，已按 Captain 接受的 CSS 480 基线记录；发布前仍建议真实系统缩放/读屏人工走查。
- **N3（low）**：`SeparatorControl` 快速连按测试是纯函数/组件层（30 次），没有 App 实例 test；但 ref 串行代码覆盖了目标行为。
- **N4（info）**：480 Team 首屏仍只显示进度头，成员/星图需滚动；截图已补 scrolled 证据，可接受。
- **N5（info）**：plain 全量 5s flake 是既有环境问题，extended 全绿。

## 4. 判定

t297 的 F1 480 Tasks 详情已通过布局/截图修复；F2–F6 全部有改动/证据；resizer 键盘/aria、Chat tabs、SkipLink/Toast、对比/reduced-motion 成立；三命令 typecheck/build 0、extended 102/790 全绿；无权限/gate/数据层/依赖/越界。**PASS**，PR #44 可进入集成/合并流程；N1–N5 为 low/info 发布前项。
