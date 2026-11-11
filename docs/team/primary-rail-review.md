# P0-2 一级入口 rail · 独立评审（t218）

- **对象**：PR #35 `feature/t216-primary-rail`，HEAD `05f23fe`（OPEN/MERGEABLE）；t216 实现 + t217 验证
- **评审人**：aria（独立评审，未修改生产代码）
- **基线**：main `6b2331e`（P0-1 已合入后）
- **结论**：**needs_revision（不通过）**；5 入口/active/aria/键盘主路径成立，但焦点的 2.5s 重试会抢回已离开的面板，直接破坏 Dock/▦/⌘K/Alt 交互。

## 1. 命令

在 `branches/t216-primary-rail` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（413 modules；js1,236.12 kB/gzip339.74；css247.63/gzip29.95；main1.5MB/preload11.7）
- `pnpm test`：0（**64 文件/645 用例**；primaryRail 5）

worktree clean；PR #35 OPEN/MERGEABLE；4 张真实截图 + metrics 存在；无数据层/kernel/git/memory/review 改动。

## 2. 通过项

- 五入口 chat/tasks/team/board/mailbox 图标+短标签；展开 249px/折叠 55px；`aria-current="page"`、`is-active`、`aria-label="一级入口"`。
- active 从现有 `activePanelKey`/route tab 派生，无第二套 panel 状态；runs/context/polls/watchdog/settings 回退/为空。
- 鼠标点击、Enter/Space、Arrow/Home/End 主路径；关闭面板经 `openPanel` 重开（Team reopened 截图）。
- 折叠复用 `sidebarCollapsed`/Ctrl+B；Dock tabs/split、▦、⌘K、Alt、深链、960 single、Settings 均保留；1440/960 截图无重叠/横向裁切。
- 全量 64/645 覆盖 deeplink、narrowWindow、Dock、权限/审批/执行/评审；无越界。

## 3. Blocking finding

### F1（high）焦点 2.5s 重试会在用户切走后抢回旧面板

`src/App.tsx` 的 `focusPanelWhenReady`：

- `openPrimaryPanel` 设置 `railFocusRequest` 后，effect 立即聚焦，并排 120/450/1200/2500ms 四次补焦；
- `focusPanelWhenReady` 在面板未就绪时还会 **递归 20×80ms** 补焦，且这些递归 timer 没有纳入 effect cleanup；
- 没有在用户 `pointerdown`/`keydown`、`activePanelKey` 变化、新 rail 请求时取消/失效旧请求；`panel.closest("[inert]")` 只看 inert，不判断该面板是否仍激活/可见；`always` 面板即使切走仍在 DOM。

因此：点 rail 打开 Team → 2.5s 内点 Dock Tasks / 另一个 rail / ▦ 菜单 / Alt+1 / 打开其它面板，旧 timer 可能把焦点拉回 Team；点击较慢/键盘用户会被反复夺焦。这与验收“Dock/▦/⌘K/Alt 无冲突”和“键盘/焦点”直接冲突；t217 已把 N1 定为 medium，但本评审认为它影响 P0-2 主交互，属于 blocker。

**Required fix**：

1. 用 request generation/token；新请求/activePanelKey 变化/pointerdown/keydown 时取消旧 timer 并 invalidate 旧 generation。
2. 递归 timer 纳入可清理集合；面板未挂载时停止/只在当前 active panel 上聚焦。
3. 聚焦前校验 `activePanelKey`/`data-panel` 是否为当前面板、面板可见且未被 inert；不要对 hidden/inactive 面板 `focus()`。
4. 补 App 级测试：rail 打开 Team → 立即切 Tasks/Dock → 等待 >2.5s，焦点仍在 Tasks；rail → ⌘K/Alt 不抢焦点。

## 4. 非阻塞 findings

- **F2（medium）折叠 rail 的可访问名称依赖 title**：`styles.css` 的 `.sidebar.collapsed .primary-rail-label { display:none }` 会把文本移出无障碍树；`PrimaryRail.tsx` collapsed 只设置 `title={entry.label}`，没有显式 `aria-label`。浏览器通常仍用 title 作 fallback，但不稳健；t216 文档“label 仍在无障碍树中”表述不准确。建议给按钮加 `aria-label={entry.label}`（或视觉隐藏而非 display:none），补读屏断言。
- **F3（low）真实截图 960×700 未显示 Sidebar footer 的 Key/Mock/成员状态**：t216 文档声称“矮窗口优先保留 Key/成员状态”，但 `t216-rail-960-board.png` 底部未见 footer；rail 新增垂直空间后是否被 `overflow` 裁切需真机复核。建议在 960×700 补 footer 可见性断言/截图。
- **F4（low）测试边界**：ArrowLeft/ArrowRight/Space、关闭面板后 active 保留（N4）、Date.now 同毫秒 nonce（N5）没有直接测试；t217 N3–N5 已记录，不阻塞。
- **F5（info）**：rail 在 960 折叠为纯图标，顶部 Dock tabs 仍有文字；发现性靠 tabs/title，不是 rail 单独解决；这是既定 P0-2 形态，不是 blocker。

## 5. 判定

五入口、active/aria、折叠、重开、Dock/深链/窄窗状态未发现回归；但 F1 的焦点抢回是 P0-2 的交互缺陷，且正好落在验收“焦点/Dock/⌘K/Alt 无冲突”上。**needs_revision**，先修 F1 并补 App 级焦点取消测试；F2/F3 同批修，PR #35 暂不合并。
