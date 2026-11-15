# F1 界面字号三档 · 最终集成验收（t367）

- **任务**：t367 — 最终集成 F1（t364 实现 → t365 PASS → t491 修复 → t492 review）
- **PR**：[#70](https://github.com/DeerLuuu/deer-super-group/pull/70) — **MERGED（squash）**
- **合并提交**：`7c3991c`
- **实现文档**：`docs/team/font-scale.md`
- **证据**：`docs/team/t364-font-scale-walkthrough.json`、`t364-font-settings-walkthrough.json`、`t364-font-panels-walkthrough.json`、`t364-font-save-refresh.json`、`t364-font-contrast.json`、`t364-font-chat-{code-thinking,translation}.json`、t364 截图集
- **验证**：`docs/team/font-scale-verification.md`（t365 PASS）
- **复审**：`docs/team/font-scale-review-2.md`（t492 pass）
- **结论**：**PASS，已合并**；t364 worktree/branch 已清理，`git worktree list` 仅主工作区。

## 1. 三档/持久化/3×3 可追溯

### 三档与持久化

- Settings → 界面新增原生 radio（fieldset/radiogroup + aria-label）：小 / 标准 / 大。
- `LayoutSettings.fontScale`：`small 0.92` / `standard 1` / `large 1.15`；默认 standard；非法 clamp 回 standard；dirty/fingerprint/save payload/保存后立即生效/刷新 JSON 保持。
- CSS `--font-scale` 驱动正文/控件/代码/思考/翻译；标准档 body 13px、Chat 正文 14px、code 14px、label small 11px。
- 修复 t491：Chat/Markdown（`.chat-bubble/.chat-content/.markdown-body` 及 p/li/ul/ol/blockquote/标题/table）、reasoning/live/translation pre、Chat label/status、Task/Mailbox 主正文均纳入变量；SettingsView/types 的 13/14 常量改动回退，CSS 为唯一字号来源。
- 实测：small 11.96/11.04/10.12、standard 13/12/11、large 14.95/13.8/12.65；真实 Chat reasoning pre 14/23.1、译文 pre 14/23.1/label 11/16.5（Bing zh-Hans）。

### 3×3 证据

- `t364-font-scale-walkthrough.json`：Settings 9/9；Chat/Task/Mailbox 27/27。
- 9 张三档 Settings 1440/960/480 + 27 张 Chat/Task/Mailbox 三档×三宽截图。
- `t364-font-save-refresh.json`：large 1.15/body14.95 → 保存 small 0.92/11.96/radio checked → reload 仍 0.92/small。
- `t364-font-contrast.json`：16.02/14.64；muted 6.45/5.90；行高记录。
- 480 Settings modal 432/24 边距；三档×三宽 `scrollWidth===innerWidth`，无根级横向。

## 2. 独立复跑（PR HEAD `d2ab177`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；465 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 169 files / 1110 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无新依赖/权限变更

- PR diff 无 `package.json`/lockfile；无新依赖。
- 无 schema/权限/IPC/数据层变更；仅 UI/设置/CSS/文档与测试。
- 原生 radio + radiogroup aria；ArrowRight 键盘切换 focus 截图；颜色 token/reduced-motion 未改。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #70 | MERGED（squash） |
| merge commit | `7c3991c` |
| main | `7c3991c` + 本报告提交 |
| t364 worktree | 已移除 |
| t364 branch | 已删除（local/remote） |
| 当前 worktree | 仅主工作区 |

## 5. 遗留（非阻塞）

1. `FONT_SCALE_OPTIONS.codePx` 旧值（11/12/14）与 CSS 实际（12.88/14/16.1）不一致；当前 Settings 隐藏 px 文本，无用户可见错误（N1 medium）。
2. Settings 隐藏 px 预览（N2 low）。
3. Chat 正文 14 vs body 13 的设计差异（N3 low）。
4. Task/Mailbox 微标签保留 small（N4 low）。
5. Mailbox 480 内部 878 既有布局（N5 low）。
6. 既有并行测试时序 timeout（N6 info）。

**最终结论：F1 PASS，PR #70 已 squash 合并 `7c3991c`；三档缩放/持久化/3×3 布局、Settings radio/a11y、保存即时/刷新保持、无新依赖/权限变更均集成验收；遗留仅证据深度/旧常量文案项。**
