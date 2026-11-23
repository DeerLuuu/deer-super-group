# 自研 Dock v2 parity（t600 / DW1-5 重挂）

- **任务**：t600（v2 parity；默认仍 dockview，不切默认）
- **分支**：`feature/t600-v2-parity`，基线 main `1d84756`（t599 回滚后）
- **范围**：`src/shell/dock/` v2 渲染器/拖放/落点/sash/CSS、测试/脚本/文档；不改 kernel/memory/review/watchdog/electron、schema/IPC/权限/gate
- **结论**：**交互/几何/默认 tab 集 parity 通过**（五向、单侧落点、双轴 sash、内容撑满、持久化、默认 tabs）；**默认仍 dockview，本 PR 不切换默认**；是否切换由 Captain/用户确认。

## 1. 实现

### 1.1 面板内容撑满

`dockLayout.css`：

```css
.docktree-panel > *,
.docktree-panel > .panel {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
```

- 只约束尺寸，不改变各 panel 自身 `display/overflow`/业务布局；
- 修复 team `.team-progress` 26px、`.team-members` 2px 以及 board/tasks 正文塌缩；
- 覆盖 chat/tasks/board/team 的真实 DOM 比例（t576 JSON）。

### 1.2 单一落点（移除四层 edge overlay）

- 新增纯函数 `src/shell/dock/dropPosition.ts`：
  - 距四边 ≤25% 取最近一侧；对角线比较归一化距离；四边都不近返回 center。
  - `computeDropPosition(clientX, clientY, rect)` 单测覆盖四向、对角线、center、越界、空 rect。
- 删除 `DockDropZone.tsx` 四层 overlay；`DockGroup` 在自身 body `onDragOver` 计算位置，只渲染一个 `.docktree-drop-position.active.<position>`（center 为中央提示）。
- `dragstart` 不显示源组提示；目标组 `dragenter/dragover` 才显示；`dragleave/dragend/onDrop` 清除。
- `onDrop` 直接用同一 `computeDropPosition`，不依赖 `data-dropzone` DOM 命中。

### 1.3 sash 双轴 / 键盘 / 双击

- `DockSash` 支持水平/垂直轴 resize（pointer capture + 4px 阈值 + Arrow/Home/End）；
- 新增 `onDoubleClick` → `DockShellV2 dispatch({type:"reset"})` + toast；t576 JSON 断言 0.58/0.42 恢复；
- 松手后 v2 store 400ms debounce 更新；t576 JSON `[0.58,0.42] → [0.645029,0.354971]`。

### 1.4 保持

- tab 状态 keepalive、关闭/激活/深链/快捷键、错误边界沿用 t548/t560 v2 代码；
- 默认仍 `DockShellLegacy`（dockview）；v2 仍由 `deer.dock.engine=v2` / `VITE_DOCK_ENGINE` opt-in；旧引擎不删除。

## 2. 五向 parity（真实 Electron/CDP）

`docs/team/t600-parity-walkthrough.json`：

| 方向 | groups | 轴/目标 | 结果 |
|---|---|---|---|
| left | 2→3 | horizontal，chat 在 team 左 | PASS |
| right | 2→3 | horizontal，chat 在 team 右 | PASS |
| above | 2→3 | vertical，chat 在 team 上 | PASS |
| below | 2→3 | vertical，chat 在 team 下 | PASS |
| center | 2→2 | 无新组，team panels `[团队,对话]` | PASS |

- drop 后 v2 store `root` 结构/尺寸更新；双轴 vertical sash 拖动 60px 后 group 高度改变、store sizes 改变；键盘 ArrowRight + 双击恢复 PASS。
- 单侧落点：hover 时 active 提示 0；dragover 左/右/center 分别只有对应一个 position；dragend 后 0（t576 JSON）。
- 面板宽度：chat/tasks/board/team 1440/960/480 全部 `childWidth/bodyWidth ≥0.95`（most 1.0；board 480 0.964）；CDP 记录于 t576 JSON。

## 3. 三档 side-by-side

| 尺寸 | v2 | dockview 默认 |
|---|---|---|
| 1440×1000 | `t600-v2-1440.png` | `t600-dockview-1440.png` |
| 960×900 | `t600-v2-960.png` | `t600-dockview-960.png` |
| 480×900 | `t600-v2-480.png` | `t600-dockview-480.png` |

几何 JSON：v2 1440/960/480 = 2/1/1 组；dockview = 2/1/1；`scrollWidth` 均等于视口。dockview 默认 DOM 检查 `dockview=true, docktree=0`；v2 opt-in 检查 `docktree=1, dockview=0`。

## 4. 测试矩阵

- `dropPosition.test.ts`：四向/对角线/center/越界/空 rect。
- `layoutOps`/`layoutModel` 既有 split axis、resize、持久化测试。
- `docktreeInteraction.test.tsx`：键盘/双击 sash、active group、close、lazy keepalive。
- CDP：`scripts/t600-parity-check.mjs`（五向、双轴 sash、键盘/重置、三档、默认 dockview/opt-in）；`scripts/t576-layout-check.mjs`（panel 宽度、单侧落点、sash）。

## 5. 默认 tab 集（t604 已关闭）

- t600 报告中的差异（v2 默认主组含 settings，6 tabs）已在 t604 对齐：v2 默认主组改为 `chat/tasks/mailbox/board`，wide/medium/narrow 仅额外 team 右组，single 不再默认 team/settings；settings 仍可经启动器/命令打开。
- 对齐后 v2/dockview 在 1440/960/480 的 tabs=5/4/4，组数=2/1/1，默认 tab 集一致；严格 fixture 断言见 `defaultTabParity.test.ts`。
- 默认仍 dockview；是否切换默认由 Captain/用户确认，本 PR 不切换。

## 6. 验证

```text
pnpm typecheck  # 0
pnpm build      # 477 modules；vendor-dockview 保留（默认引擎不删）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                # 185 files / 1251 tests passed
```
