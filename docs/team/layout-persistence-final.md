# G14 窗口与布局持久化 · 最终集成验收（t461）

- **任务**：t461 — 最终集成 G14（t458 实现 → t479 e2e → t480 复验 → t481 修复 → t482 review）
- **PR**：[#65](https://github.com/DeerLuuu/deer-super-group/pull/65) — **MERGED（squash）**
- **合并提交**：`d56d20a`
- **实现文档**：`docs/team/layout-persistence.md`
- **证据**：`docs/team/layout-persistence-evidence.md`、`docs/team/layout-persistence-e2e.json`
- **复验**：`docs/team/layout-persistence-verification-2.md`（t480 PASS）
- **复审**：`docs/team/layout-persistence-review-2.md`（t482 pass）
- **结论**：**PASS，已合并**；t458 worktree/branch 已清理，`git worktree list` 仅主工作区。

## 1. 窗口/工作区/split 可追溯

### 窗口

- `electron/windowState.ts`：`userData/window-state.json` 保存 x/y/width/height/maximized；move/resize/maximize/unmaximize/minimize 去抖 400ms，close 同步保存；maximized 保存 `getNormalBounds`，restore 先 bounds 再 maximize。
- 多屏/拔屏/非法/过小/无显示器回退 1440x920 居中；诊断 warn（首次缺失静默）。e2e 实际 offscreen 保存 99999/1200x800 → `[window-state] offscreen; using default window bounds`，恢复 1000,276,1440x920。
- 真实重启 bounds：120,80,1200x800 保存 → 重启同值；最大化保存/重启 true（t458 证据）。

### last workspace

- boot 优先读取存在的 saved workspace；不存在回首个并清理 stale；open/switch 成功写。
- e2e：切 ws-b → 重启 title `t458-ws-b · 任务`，`lastWorkspaceId` 保持 ws-b；随后隔离 DB 删除 ws-b（3→2）→ 重启回「按钮工厂」，lastWorkspaceId=ws-A，stale 清理。
- screenshot：`t458-e2e-deleted-workspace-1440.png`。

### 四类 split（真实重启）

| split | 操作 | 重启后 |
|---|---|---|
| Sidebar | 298 + collapsed 1 | 298 / collapsed 1；展开 aria 298 |
| Task list | 291 + collapsed 1 | 291 / collapsed 1；展开 aria 291 |
| Git workspaceHeight | 332 | 同 workspace 重开 separator aria 332 |
| Dock | sash 581/555；关闭版本图 tab activePanel=tasks、views=[tasks,team] | 重启一致；重开 Git activePanel=gitGraph |

- Task list 额外修复 preferred/displayed：窄布局拖动只改 displayed、不写 storage；回宽恢复 preferred；宽布局 clamp 后写。e2e：窄 760 下 displayed 323、preferred/stored 291；回 1440 displayed 291。

## 2. 独立复跑（合并前 PR HEAD `7222d5e`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；459 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 156 files / 1037 tests passed
```

> 默认并行有既有 29 项时序 timeout；串行全绿（与 t480/t482 一致）。

## 3. 重启证据/三档/无回归

- e2e 隔离 userData 真实 Electron；BrowserWindow outer 1440x900（content 1424x861）。
- 截图：
  - `docs/team/t458-e2e-before-1440.png`
  - `docs/team/t458-e2e-restored-1440.png`
  - `docs/team/t458-e2e-git-1440.png`
  - `docs/team/t458-e2e-git-960.png`
  - `docs/team/t458-e2e-git-480.png`（480 为 CDP emulation，已披露）
  - `docs/team/t458-e2e-deleted-workspace-1440.png`
- 无新依赖；无 schema/权限/gate 变更；窗口/工作区/布局键只在既有 localStorage/userData 范围内持久化；无旧格式迁移。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #65 | MERGED（squash） |
| merge commit | `d56d20a` |
| main | `d56d20a` + 本报告提交 |
| t458 worktree | 已移除 |
| t458 branch | 已删除（local/remote） |
| 当前 worktree | 仅主工作区 |

## 5. 遗留（非阻塞）

1. 原生 workspace picker 在 e2e 中为 stub（UI 点击/service 真实），N1 low。
2. 多屏/拔屏仅单测覆盖；480 为 CDP emulation，N2 medium。
3. stale 删除 workspace 已真实 e2e；更复杂的多屏热插拔仍单测，N3 low。
4. 既有并行测试时序 timeout，CI 建议串行/提高慢测 timeout，N4 info。

**最终结论：G14 PASS，PR #65 已 squash 合并 `d56d20a`；窗口 bounds/maximized、last workspace、Sidebar/Task/Git/Dock 四类 split、重启/删除 workspace/stale、三档证据均集成验收；无新依赖/schema/权限/gate；遗留仅环境/单测深度项。**
