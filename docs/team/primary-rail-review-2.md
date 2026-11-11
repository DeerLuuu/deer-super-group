# P0-2 一级入口 rail · 复审 round 2（t221）

- **对象**：PR #35 `feature/t216-primary-rail`，HEAD `e3fcc1e`（OPEN/MERGEABLE）；t220 修复
- **评审人**：aria（独立复审，未修改生产代码）
- **基线**：main `6b2331e`；t218 findings（F1 抢焦、F2 折叠 label、F3 960 footer、F4 测试）
- **结论**：**PASS（无 blocker）**；t220 代码/测试修复成立，保留 2 条 low 证据/口径观察。

## 1. 命令

在 `branches/t216-primary-rail` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（413 modules；js1,237.45 kB/gzip340.13；css247.63/gzip29.95；main1.5MB/preload11.7）
- `pnpm test`：最终 0（**64 文件/650 用例**；primaryRail 10）
  - 首次全量并行受环境负载影响，openai/watchdog 两个既有 5s timeout 失败；未改代码，单独/第二次全量 650/650。与 t216/t217 记录的既有 flake 一致。

worktree clean；PR #35 OPEN/MERGEABLE；无越界。

## 2. 逐项复核

### F1（high）抢焦 → 已修

`usePrimaryRailFocus`（`src/shell/PrimaryRail.tsx`）：
- generation/token（ref 自增）、timer registry；request 取消旧 timer/递归 timer；
- `pointerdown`/`keydown`（含 ⌘K/Ctrl K、Alt）capture invalidate；`activePanelKey` 变化 invalidate；
- 聚焦前校验 activePanelKey、inert、layout rect、visibility/display；chat composer 优先；
- 卸载 clearTimers；成功停止重试。
- t220 测试 4 例：立即切 Tasks 后 >2.5s 不抢焦、⌘K/Alt 不补焦、pointerdown/active 变化取消、成功停止。
- `App.tsx` 删除旧 120/450/1200/2500 + 递归逻辑，改用 hook；无旧 `railFocusRequest`。

### F2（medium）折叠 label → 已修

- `PrimaryRail` 每项加 `aria-label={entry.label}`；折叠只 `display:none` 视觉文本，读屏有显式名称。
- SSR/TestRenderer 断言五项 aria-label；t220 测试 10 例。
- 残余：`display:none` 文本不在无障碍树，但 aria-label 已覆盖名称，不影响操作。

### F3（low）footer → 处理

- t220 960×700 手动展开 Sidebar 截图 `t216-rail-960-footer.png` + metrics：footer top654/bottom700/height46、visible、sidebar scrollHeight=clientHeight=700；短视口 rail 179px。
- 默认 960 仍自动折叠为 55px 图标栏（产品既定），手动展开后 footer 可见；未要求默认 960 图标+短标签。

### F4（low）测试 → 补充

- primaryRail.test 5→10：ArrowLeft/Right/Space、aria-label、pointerdown/active 变化、⌘K/Alt 取消、>2.5s、成功停止。
- 无 App DOM e2e；t220 的真实 Electron 截图覆盖 footer/rail，焦点 hook 以 Harness 单测覆盖。

### 无回归

- 五入口/active/aria-current、折叠 249→55、关闭重开、深链/960 single/Dock/⌘K/Alt/Settings 保留；active 仍从现有 `activePanelKey`/route tab 派生，无第二 panel state。
- 全量 64/650 覆盖 deeplink、narrowWindow、Dock、权限/审批/执行/评审/watchdog；无 shared/kernel/electron 改动。

## 3. 非阻塞观察

- **N1（low）**：t220 的焦点表单/表格仍沿用 t216 的 CDP 证据，没有新增“rail→立即切 Tasks / ⌘K / Alt”真实 Electron 截图；该行为目前由 10 个 Harness 单测覆盖。建议发布前补一次真实 Electron 键盘序列冒烟。
- **N2（low）**：默认 960 仍为 55px 图标栏，顶部 Dock tabs 仍是带文字的主要入口；rail 在默认窄窗不独立提供图标识别。这是既定折叠形态，不是 blocker。
- **N3（low）**：首次全量测试的 2 个 5s timeout 是既有环境 flake（openai/watchdog），未见与 rail 改动相关的新失败。

## 4. 判定

t218 F1/F2/F3/F4 的代码与测试问题已处理；三命令最终全绿、无越界、无状态/深链/权限回归。**PASS**，PR #35 可进入集成/合并；N1/N2 作为发布前冒烟/产品形态确认，不阻塞 P0-2。
