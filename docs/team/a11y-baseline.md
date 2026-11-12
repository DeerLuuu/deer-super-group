# 无障碍基线（P1-4 / t292）

## 范围

本轮建立可独立验收的 a11y 基线，不改变权限/gate/数据层：

- Shell：skip link、main/aside landmark、focus-visible、resizer 键盘。
- Chat：composer 可访问名称/说明；对话/轨迹 WAI-ARIA tabs（id/aria-controls/tabpanel/roving/方向键）。
- Team/Tasks：复用既有 aria-label/状态/空态；480 CSS 下不横向裁切。
- Settings：子导航 `aria-current="page"`。
- Toast：键盘 focus 暂停自动消失。
- 对比/动效：正文/次要文字 ≥4.5:1；全局 `prefers-reduced-motion`。
- 文档/截图：1440、960、480。

## 200% 缩放（960 窗口 = 480 CSS）

用真实 Electron + CDP 在 1440/960/480 三档 reload 后测量：

| 视口 | document.scrollWidth | main | Dock | Chat panel | 首用卡 |
|---|---|---|---|---|---|
| 1440 | 1440 | 1378 | 1378 | 704 | 1358 |
| 960 | 960 | 898 | 898 | 872 | 882 |
| 480 | 480 | 418 | 418 | 377 | 402 |

- 三档 `scrollWidth == innerWidth`，无页面横向溢出；480 下首用清单单列、Chat composer 可达。
- Team/Tasks 480 实测 `.team-layout`/`.tasks-layout` 宽 379/394，scrollWidth 相等，无横向裁切。
- 截图：`docs/team/t292-a11y-1440.png`、`-960.png`、`-480.png`。

## Shell / 焦点

- `.app` 第一个可聚焦元素是 `<a class="skip-link" href="#main-content">跳到主内容</a>`；focus 时 `top:12px` + 3px outline（已实测）。
- `<main id="main-content" aria-label="主内容" tabIndex={-1}>`；`<aside aria-label="侧栏">`。
- 全局 `:focus-visible { outline:2px solid var(--accent); outline-offset:2px }`；自定义组件保留原 focus 样式。
- Sidebar/Tasks resizer：`role=separator` + `aria-valuemin/max/now` + `tabIndex=0` + Arrow/Home；鼠标拖动/双击保留。
- PrimaryRail/Workflow/NeedsMe 原有 aria/键盘（Arrow/Home/End、listbox option）保留；侧栏折叠图标按钮补 `aria-label`。
- Modal/CommandPalette 既有 focus trap/return 未改。

## Chat

- composer：`aria-label="给 Router 发消息"` + `aria-describedby="chat-composer-help"`（Ctrl+Enter/清空/压缩说明）。
- 对话/轨迹 tabs：`role=tablist`、tab 有 id/aria-controls/tabIndex、ArrowLeft/Right 切换并 focus；内容 `role=tabpanel` + aria-labelledby。
- 终态错误 `role=alert`/状态 `role=status` 沿用。

## 对比 / 动效

- Tokens：正文 `#e6edf3` on `#0d1117` 16.02:1；次要 `#8b98a9` on `#0d1117` 6.45:1、on `#151b24` 5.90:1。
- 星图「归属」图例从 `#6e7681` 改为 `var(--muted)`，不再低于 4.5:1。
- 全局 `@media (prefers-reduced-motion: reduce)` 将 animation/transition 压到 0.001ms，并保留既有 star/dock/review 规则；实测 `transitionDuration=1e-06s`。
- skip link 不使用位移动画，focus 直接显示。

## 测试

- `src/a11yBaseline.test.ts`：skip link/main/aside、composer label、Chat tabs/tabpanel、resizer aria/键盘、focus-visible、reduced-motion、Settings aria-current、Toast focus 暂停、对比度 token、480 单列。
- 全量 typecheck/build/test 与截图命令见 PR。
- 未引入新依赖；未改 kernel/权限/gate/数据层。

## 已知边界

- 200% 缩放通过 Electron `960` 窗口 CSS 480 验证；未使用真实系统缩放设置。
- 屏幕阅读器人工走查（NVDA/VoiceOver）仍建议发布前执行。
- 审计中的 Settings 保存错误内联、全局快捷键穿透、Modal 背景 inert 等属于后续 A11Y P1/P2，不在本基线 PR 扩大范围。
- 既有 5s 全量测试并发 flake 与本 PR 无关。

## 回滚

- 删除 `.skip-link`/`#main-content`/composer label/Chat tabs/ARIA/resizer CSS 即可回退到原交互；无数据迁移。
