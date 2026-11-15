# G12 后台任务与多 tab 命令控制台 · 最终集成验收（t451）

- **任务**：t451 — 最终集成 G12（t447 设计 → t448 实现 → t449 验证 → t487 修复 → t488 review）
- **PR**：[#69](https://github.com/DeerLuuu/deer-super-group/pull/69) — **MERGED（squash）**
- **合并提交**：`e18fa62`
- **实现文档**：`docs/team/background-console.md`
- **证据**：`docs/team/t448-evidence.json`、`docs/team/t448-{chat-popover,console}-*.png`
- **验证**：`docs/team/background-console-verification.md`（t449 PASS）
- **复审**：`docs/team/background-console-review-2.md`（t488 pass）
- **结论**：**PASS，已合并**；t448 worktree/branch 已清理；当前仅主工作区 + 其他任务 t360。

## 1. 进程/安全/IPC/UI 可追溯

### 主进程 ConsoleManager

- 非 PTY：Windows `cmd` / Unix `/bin/sh`，`spawn` stdin/stdout/stderr。
- cwd：相对路径 resolve + `realpath`，必须位于 workspace root 内；越界拒绝；`cwds` 来自 workspace root。
- env allowlist：PATH/PATHEXT/SystemRoot/TEMP/TMP/HOME/USERPROFILE/LANG/LC_ALL/TERM 等；显式排除 SSH_AUTH_SOCK/GPG_AGENT_INFO/TOKEN/KEY/SECRET/PASSWORD/BASH_ENV/ENV/PROMPT_COMMAND；`CI=1 TERM=dumb NO_COLOR=1 FORCE_COLOR=0`。
- 输出：`StringDecoder` + 2MB ring，50ms/16KB 批流，redact；输出/状态事件带 `workspaceId`。
- stdin；SIGTERM → 3s 后 force，Windows taskkill；exitCode/status；per-workspace 6 active/20 history、global 12 active/32 sessions；`before-quit` `quitGuard` 单次 `closeAll`；deadline 后再次 `terminate(force)` 等 exit/100ms 宽限。
- 安全：`sudo`/提权拒绝；危险命令（rm -rf、mkfs、dd、shutdown 等）60s 一次性 `confirmToken`，重放拒绝；危险检测非穷举（风险接受，见 §5）。

### IPC / UI

- 新增 `console:list/start/stop/input/clear/snapshot/cwds` + `console:event`；shared zod strict；main/preload 全链路；`workspaceId` 参数覆盖 input 防跨 workspace；无 Agent tool。
- Chat 头部「后台任务」badge + 浮窗；点击打开 console Dock tab；ConsolePanel 多 tab/新建/停止/重启/清屏/复制/stdin/关闭确认/危险 alertdialog/错误/tablist/log/aria；480 tab 横滚 + 输入 sticky 底部，960/1440 布局。
- ConsoleStore meta 与 output 分离，Chat 只订阅 meta（计数），避免高频输出重渲染 Chat。
- 修复 F1：output/status/cleared 均带 workspaceId；Store 首行校验、未知 session output/cleared 忽略、refresh/loadSnapshot/start workspaceVersion+workspaceId 双守卫；真实 A→B 事件测试。

## 2. 独立复跑（PR HEAD `679815b`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；463 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 164 files / 1079 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 三档/性能/退出清理/无 heavy deps

- 真实 Electron + 隔离 userData：Chat badge/浮窗 sessions=2；console 3 tabs；ping/dev server 演示流式；`consoleStop` 清理 demo。
- 截图（内容区 1440 实际 1424×881，480/960 CDP emulation 已披露）：
  - `docs/team/t448-chat-popover-1440.png`
  - `docs/team/t448-console-1440.png`
  - `docs/team/t448-console-960.png`
  - `docs/team/t448-console-480.png`
- 三档 `scrollWidth`：1440 内容 1424、960、480 均无横向溢出；480 tab 横滚、输入 sticky 可见。
- 性能：50ms/16KB 批流、2MB ring、meta/output 分离；`background-console-verification` 记录真实进程/limits/taskkill/exit。
- 退出清理：`before-quit` quitGuard 单次 `service.close`；hung child closeAll taskkill + 100ms 宽限 finalize；单次关闭源码断言。
- 无 heavy deps：PR diff 无 `package.json`/lockfile；无 schema/权限/新 dependency。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #69 | MERGED（squash） |
| merge commit | `e18fa62` |
| main | `e18fa62` + 本报告提交 |
| t448 worktree | 已移除 |
| t448 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t360 |

## 5. 遗留（非阻塞）

1. 非 PTY：无 TTY/ANSI 全保真；PowerShell `Remove-Item/Stop-Computer` 等危险检测可能绕过，风险接受，后续 PowerShell 模式/白名单。
2. 会话仅内存，应用重启清空。
3. 无沙箱；危险检测非穷举。
4. 关闭 panel 不杀后台任务（设计如此；任务仍可在 badge 恢复）。
5. 480/960 截图为 CDP emulation，1440 内容区 1424×881；2MB 输出 FPS/输入延迟基准列为后续专项。
6. 既有并行测试时序 timeout（CI 串行）。

**最终结论：G12 PASS，PR #69 已 squash 合并 `e18fa62`；ConsoleManager、安全边界、IPC、Chat 浮窗/多 tab、三档/a11y、退出清理、无 heavy deps 均集成验收；遗留仅为非 PTY/危险检测/性能深度项。**
