# 无障碍基线最终集成验收（t295）

- **任务**：t295 — 集成验收 P1-4：无障碍基线（200% 缩放/焦点/键盘/语义/对比/动效）
- **实现链**：t292 实现 → t293 独立验证 → t296 repair-round-2 → t298 repair-round-3 → t299 review pass
- **PR**：[#44](https://github.com/DeerLuuu/deer-super-group/pull/44) — **MERGED（squash）**
- **合并提交**：`ba81f4a`（2026-11-12）
- **实现文档**：`docs/team/a11y-baseline.md`
- **验证/评审**：`a11y-baseline-verification.md`、`a11y-baseline-review-3.md`
- **结论**：**PASS，可交付**；PR 已合并，t292 worktree/branch 已清理。

## 1. 结论

P1-4 无障碍基线已完成最终集成验收：

- **缩放基线**：按 Captain t297 裁决，采用 **真实 Electron 480 CSS 视口**作为 200% 等效基线（非 OS/DPR2 真机），不虚报；1440/960/480 均 `scrollWidth == innerWidth`。
- **480 布局**：main/Dock 418、Chat 377、Team 379、Tasks 394；首用卡单列；Tasks 详情单列 + `minmax(240px,1fr)` + 纵向滚动，任务行/负责人/优先级/Run/操作/概览/运行/评审/Git/历史/描述/验收可达（detail clientHeight 238）；Team 滚动后成员/星图可见。
- **焦点/键盘**：skip link→`main#main-content` + aside label；全局 `:focus-visible`；Sidebar/Tasks resizer `role=separator` + `aria-valuemin/max/now` + Arrow/Home + clamp（960/900/760/480 max 394/334/194/180；Tasks 52% clamp；480 不渲染）；折叠隐藏 resizer；图标按钮 aria-label；Modal/CommandPalette 既有 trap 未改。
- **语义/tabs**：Chat composer `aria-label`/`aria-describedby`；对话/轨迹完整 tablist/tab/tabpanel + roving + Arrow/Home/End；Settings `aria-current`；Toast focus 暂停；live/alert 保持。
- **对比/动效**：正文 16.02、muted 6.45/5.90（WCAG AA）；legend 用 `var(--muted)`；全局 `prefers-reduced-motion`（实测 1e-06s）。
- **范围**：无新依赖/权限/gate/数据层/任务状态机变更；无 CSS 布局重写（仅基线/480 必要规则）；1440/960/480 矩阵保持。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 1440/960/480 无横向 | App/styles；480 单列 | 三档截图/metrics；480 main418/Chat377/Team379/Tasks394 |
| Tasks 480 详情可达 | `styles.css` minmax/overflow；t298 | 480 detail 截图（clientHeight 238）；t299 |
| 200% 基线 | Captain t297 接受 480 CSS 视口 | docs 明确非 OS/DPR2；t298/t299 |
| skip link/main/aside | `SkipLink.tsx`；App `#main-content` | SkipLink 测试；真实首 Tab 走查 |
| 全局 focus-visible | `styles.css` | a11yBaseline 测试；视觉走查 |
| Sidebar/Tasks resizer | `SeparatorControl.tsx`；`taskListWidth.ts` | SeparatorControl 3；t296/t298（30 次快速 Arrow 停 394/280） |
| 侧栏图标 aria-label | App buttons | a11yBaseline；t293 |
| Chat composer label/describedby | App Chat | chatViewIsolation 2；t293 |
| Chat tabs 完整 ARIA | App Chat tabs | chatViewIsolation（Home/End）；t293 |
| Settings aria-current | SettingsView | a11yBaseline；t293 |
| Toast focus pause | `Toast.tsx` | Toast 1；t296 |
| 对比 token | `styles.css` | a11yBaseline 5（读 token）；16.02/6.45/5.90 |
| reduced-motion | `styles.css` | a11yBaseline；实测 1e-06s |
| rail/Workflow/NeedsMe/Modal 无回归 | diff 未改相关逻辑 | primaryRail 10、Workflow 3、Modal 2；102/790 |
| 无新依赖/权限/gate/数据层 | diff 无相关文件 | t299 review；102/790 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `ba81f4a`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；437 modules
                 # js 1,299.00 kB / gzip 359.44
                 # css 260.65 kB / gzip 32.05
                 # electron main 1.5 MB / preload 12.0 KB
pnpm test        # --testTimeout=20000 --maxWorkers=2
                 # 102 files / 790 tests 全绿
```

> 说明：默认 5s 高并发下 openai/chat terminal/watchdog/git 偶发既有 5s timeout；PR worktree 与合并后 main 使用 20s/2 workers 均 102/790 全绿。该 flake 与 a11y 无因果关系，保留为 P1 测试稳定性项。

## 4. 1440/960/480 与证据

1. **1440**：`t292-a11y-1440.png` — 桌面布局、焦点可见、对比/字号基线。
2. **960**：`t292-a11y-960.png` + `t292-a11y-resizer-960.png` — 侧栏/Tasks resizer 键盘与 aria；无横向。
3. **480**：`t292-a11y-480.png`（Chat/首用卡）、`t292-a11y-480-team.png`/`-team-scrolled.png`（成员/星图）、`t292-a11y-480-tasks.png`/`-tasks-detail.png`（单列详情）。
4. **480 Tasks detail**：minmax(240,1fr)+overflow-y+detail min-height240；真实 Electron detail clientHeight 238/top447，tabs + 描述/验收/Run 可达，scrollWidth 480。
5. **resizer**：Sidebar max 按当前宽度 clamp（960/900/760/480→394/334/194/180）；Tasks 实测 layout+52% clamp；480 不渲染；折叠隐藏。
6. **键盘/焦点**：skip link 真实首 Tab 走查；SeparatorControl Arrow/Home DOM；Toast focus pause；Chat tabs Home/End；快速连按用 ref 串行，30 次仍停 394/280。
7. **对比/动效**：正文 16.02、muted 6.45/5.90；legend 改 muted；reduced-motion 0.001ms（1e-06s）。
8. **回归**：rail/Workflow/NeedsMe/Modal/CommandPalette 未改；1440/960/480 无横向；权限/gate/数据层/依赖未改。

## 5. 范围/兼容性检查

- PR #44 合并 23 文件：`src/App.tsx`、`SettingsView.tsx`、`Toast.tsx/test`、`src/a11yBaseline.test.ts`、`src/shell/{SkipLink,SeparatorControl,taskListWidth}*`、`src/shell/chat/chatViewIsolation.test.tsx`、`styles.css`、docs/截图。
- **无** `src/kernel/`、data store/事件、git/memory/review/watchdog/electron、权限/gate/任务状态机改动；无新依赖；无 CSS 布局重写（仅基线/480 必要规则）。
- 200% 按 Captain t297 接受的真实 Electron 480 CSS 视口基线记录，不把 CSS 模拟写成 OS/DPR2 实测。
- 合并前 PR #44 OPEN/MERGEABLE/CLEAN，head `c1e3141`（含 t293/t299 报告）；合并后 main `ba81f4a`；t292 worktree 已移除，branch 已删除。
- 清理时 t292 worktree 被遗留 `t298-ui` Electron 冒烟进程占用；终止该测试进程后由目录删除完成，无生产影响。
- 当前 main 有 4 个与 t295 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t295 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **a11yBaseline 偏源码/SkipLink 仅 href**：部分断言为静态源/DOM 合同，不是完整读屏/浏览器审计（N1/t299）。
2. **OS/DPR2 未实测**：200% 以 480 CSS 视口为基线；真实 OS scale/DPR2 需真机复核（Captain 已接受当前基线，N2）。
3. **快速连按为纯函数测试**：30 次 Arrow 用 ref 串行纯函数验证，未在真实 Electron 逐帧测量（N3）。
4. **480 覆盖有限**：已覆盖 Chat/首用卡/Team/Tasks detail；Review/Git/Poll/Watchdog 窄屏仍需后续抽查（N4）。
5. **对比测试读 CSS token**：token 变化会自动反映，但视觉对比仍需真机/axe 工具（N5）。
6. **既有 5s flake**：openai/chat terminal/watchdog/git 默认 5s 偶发；建议统一提高慢测 timeout 或拆分 fake clock（N6）。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #44 | MERGED（squash） |
| 实现 head / 文档 head | `d9737b3` / `c1e3141` |
| merge commit | `ba81f4a` |
| main | `ba81f4a`（+ 本报告提交） |
| t292 worktree | 已移除（清理时终止遗留 `t298-ui` Electron 进程） |
| t292 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 102 files/790（20s/2 workers） |

**最终结论：PASS；1440/960/480 无横向、skip/focus/keyboard/ARIA、对比/reduced-motion 与 Tasks 480 详情均已完成集成；rail/Workflow/NeedsMe/Modal 无回归、无新依赖/权限/gate/数据层变更。残余为 P1 真机/读屏审计项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
