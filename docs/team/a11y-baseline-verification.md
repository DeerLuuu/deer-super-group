# P1-4 无障碍基线 · 独立验证报告（t293）

- **任务**：t293 [verification] 独立验证 t292
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #44 `feature/t292-a11y-baseline`，HEAD `32fda22`（OPEN/MERGEABLE；worktree `branches/t292-a11y-baseline`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 App/Settings/Toast/styles/a11yBaseline.test + 1440/960/480 截图与 docs 测量。

---

## 1. 结论：**PASS（通过，无 blocker）**

- **尺寸**：1440/960/480 三档 `document.scrollWidth == innerWidth`；480 main/Dock 418、Chat 377、Team 379、Tasks 394；`effectivePanelMinWidth(560,true,418)=418`、正常 560 保持；首用卡 480 单列；无页面横向溢出。
- **Shell/焦点**：skip link→`main#main-content`（tabIndex=-1）+ aside/main label；全局 `:focus-visible`；Sidebar/Tasks resizer `role=separator` + aria-valuemin/max/now + tabIndex + Arrow/Home；侧栏新建/刷新/面板图标 aria-label；Modal/CommandPalette 既有 trap/return 未改且既有测试绿。
- **Chat**：composer aria-label/describedby；对话/轨迹 tabs 完整 id/controls/tabIndex/aria-selected/方向键/tabpanel/aria-labelledby。
- **语义**：Settings `aria-current=page`；Toast focus 暂停；live/alert 既有保持。
- **对比/动效**：正文 #e6edf3 16.02、muted #8b98a9 6.45/5.90；legend 改 var(--muted)；全局 prefers-reduced-motion（0.001ms）实测 1e-06s。
- **范围**：无权限/gate/数据层/schema 变更；无新依赖；仅 App/Settings/Toast/styles/test/docs。
- **三命令**：typecheck/build 0；plain 9 个既有 5s timeout；extended 20s/2 workers 99 文件/784 全绿。

残留 N1/N2 为 resizer 窄窗键盘/测试面，不阻塞基线通过。

---

## 2. 命令（worktree HEAD `32fda22`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 434 modules；css 260.45 kB (gzip 32.01)；js 1,298.12 kB (gzip 359.06)；electron main 1.5MB/preload 12.0kB |
| `pnpm test`（plain） | 1（既有 flake） | 9 个既有 5s timeout（openai/chatTerminal/watchdog×2/git/planDraft/service/layout/memberRec），775/784；a11yBaseline 5 全绿 |
| `pnpm exec vitest run --testTimeout=20000 --maxWorkers=2` | **0** | 99 文件/784 用例全绿 |

---

## 3. 逐项

### 3.1 1440/960/480 无裁切/核心控件（PASS，N4 low）

- docs CDP 实测：1440 scrollWidth 1440/main 1378/Dock 1378/Chat 704；960 960/898/898/872；480 480/418/418/377；首用卡 1358/882/402。
- `effectivePanelMinWidth`：single + dock 418 → 418；dock ≥560 → 560；非 single → 声明值；narrowWindow.test 28 通过。
- 480 截图（480×700）：侧栏收起、首用卡四项单列、「创建团队成员」CTA 可达、Chat tabs/composer 可见，无横向滚动。
- **N4 low**：480 截图只覆盖 Chat/首用卡；Team/Tasks 480 只有 docs 测量（379/394），无独立截图；建议补。

### 3.2 skip/focus/Tab/aria（PASS，N1/N2）

- skip link 是 `.app` 首个可聚焦元素，href `#main-content`；main `tabIndex=-1`，focus 后跳过导航；aside/main 均有 aria-label。
- 全局 `:focus-visible` 2px accent；skip-link focus 3px outline。
- Sidebar/Tasks resizer：`role=separator`、aria-label、aria-valuemin/max/now、tabIndex=0、ArrowLeft/Right、Home 复位；鼠标拖动/双击保留。
- 侧栏新建/刷新/面板图标按钮补 aria-label；PrimaryRail/Workflow/NeedsMe 既有 aria/键盘未改。
- **N1 medium**：`stepSidebarWidth` 以 `effectiveSidebarWidth` 为基准、max 固定 480，未按 `sidebarMaxWidth(viewportWidth)` clamp；960 narrow（实际 max 394）时 ArrowRight 设置 preferred/display 410，但 effective 仍 394，键盘看似无效；aria-valuemax 仍 480，屏幕阅读器范围与真实 max 不一致。Tasks 列表 resizer 同样固定 520，960/480 下 +16 可能超过布局宽。建议 keyboard clamp 到当前窗口 max，并补回归。
- **N2 medium**：a11yBaseline.test 只读源码字符串，未真实 mount/触发 skip link、resizer Arrow、Chat tabs 方向键、Toast focus 暂停；这些依赖人工/既有测试。Modal/CommandPalette 旧测试仍绿。

### 3.3 表单/Tabs/live/alert/主要键盘（PASS，N3 low）

- composer label/description；Chat tabs 2 个 tab id/controls/tabIndex/aria-selected + ArrowLeft/Right 切换并 focus + panel role/labeledby；**N3 low**：未实现 Home/End（WAI tab 可选，但 TaskWorkspaceTabs 已支持，Chat 两 tab 可加）。
- Settings 子导航 aria-current；Toast 在 focus 时 pause、blur resume；既有 live/alert 保持。
- 主要 CTA/关闭/搜索/rail/Workflow/NeedsMe 未改；既有 CommandPalette/Modal/task tabs 测试绿。

### 3.4 对比/reduced-motion（PASS，N5 low）

- Token 对比：正文 16.02:1；muted 6.45/5.90；legend 原 #6e7681 改 var(--muted)。
- 全局 `prefers-reduced-motion`：animation/transition 0.001ms、iteration 1、scroll auto；实测 transitionDuration 1e-06s。
- **N5 low**：对比测试用硬编码色值而非从 CSS 变量计算；当前 token 与测试一致。

### 3.5 范围/依赖/UI（PASS，N6/N7 low）

- PR 只改 App/Settings/Toast/styles/test/docs；无 electron/kernel/git/memory/review/watchdog、权限/gate/数据层/schema；无 package.json/新依赖。
- 无 CSS 布局重写；三档截图；Modal/CommandPalette focus trap 未改。
- **N6 low**：plain 高并发 9 个既有 5s timeout；extended 784 全绿。
- **N7 low**：200% 以 960 Electron 窗口 CSS 480 模拟，未改真实系统缩放；文档已声明边界。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | medium | resizer 键盘在 960/480 未 clamp 到当前窗口 max；Arrow 可能无效、aria-valuemax 480 与真实 394 不符；Tasks list max 520 可能超布局 | keyboard 按 sidebarMaxWidth/Tasks 实际宽 clamp；补 Arrow 回归 |
| N2 | medium | a11yBaseline.test 仅源码静态断言；未真实 mount skip/resizer/Chat tabs/Toast focus | 补组件级键盘/焦点测试 |
| N3 | low | Chat tabs 无 Home/End；两 tab 可选 | 可补 |
| N4 | low | 480 截图只覆盖 Chat/首用卡，Team/Tasks 仅 docs 测量 | 补 Team/Tasks 480 截图 |
| N5 | low | 对比测试硬编码色值 | 可从 CSS 变量解析 |
| N6 | low | plain test 9 个既有 5s flake；extended 全绿 | CI 单独超时/串行 |
| N7 | low | 200% 用 480 CSS 模拟，非真实系统缩放 | 发布前 NVDA/VoiceOver/真实缩放抽查 |

---

## 5. 结论

**PASS**：三档无页面横向溢出、effectivePanelMinWidth 降级、skip link/main/aside、focus-visible、resizer ARIA+键位、Chat composer/tabs、Settings aria-current、Toast focus pause、对比与 reduced-motion、无新依赖/权限/gate/数据层均成立；typecheck/build 0，extended 99/784 全绿。N1/N2 为窄窗键盘 clamp 与真实组件 a11y 测试补强，不阻塞 PR #44 进入评审/合并。

*本次验证仅新增本报告，未修改生产代码。*
