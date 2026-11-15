# G16 主进程 EPIPE/未捕获异常防护 · 最终集成验收（t471）

- **任务**：t471 — 最终集成 G16（t468 实现 → t483 harness → t484 复验 → t470 review）
- **PR**：[#66](https://github.com/DeerLuuu/deer-super-group/pull/66) — **MERGED（squash）**
- **合并提交**：`f2f729f`
- **实现文档**：`docs/team/main-process-epipe-guard.md`
- **证据**：`docs/team/t483-epipe-harness.json`、`docs/team/t483-main-process.log`、`docs/team/t483-epipe-alive-1440.png`
- **复验**：`docs/team/main-process-epipe-guard-verification-2.md`（t484 PASS）
- **复审**：`docs/team/main-process-epipe-guard-review.md`（t470 pass）
- **结论**：**PASS，已合并**；t468 worktree/branch 已清理，`git worktree list` 仅主工作区。

## 1. EPIPE/普通异常处理可追溯

`electron/processGuards.ts`：

- stdout/stderr `error`：`EPIPE` / `EIO` / `ERR_STREAM_DESTROYED`（含 message 匹配）记录 `stream:stdout:pipe` / `stream:stderr:pipe` 后忽略；其他 stream error 记录。
- `uncaughtException`：管道错误记录 `uncaughtException:pipe` 后继续运行；其他错误记录 stack 后 `process.exit(1)`（fail-fast，不静默）。
- `unhandledRejection`：管道错误记录 `unhandledRejection:pipe` 后继续；其他错误记录。
- 日志 `userData/main-process.log`，仅 `appendFileSync`，不调用 console（避免同一 broken pipe 递归）；日志失败静默。
- `electron/main.ts` 在 module scope、任何 window/service 工作前安装 `installProcessGuards({logPath})`。

## 2. 真实 Electron harness（t483）

隔离 userData + 真实 `main.cjs`：

| 项 | 结果 |
|---|---|
| alive | true |
| windows | 1 |
| appReady | true |
| dialog.showErrorBox | 0 |
| IPC `listWorkspaces` | ok=true / count=0 |
| 日志 pipe 行 | 4 条：stdout EPIPE、stderr EIO、uncaught EPIPE、unhandledRejection EPIPE |
| 普通 rejection | 记录，不退出 |
| 关闭 | `win.close()` 正常，harness 退出 0 |

- 截图：`docs/team/t483-epipe-alive-1440.png`（1424×861）。
- 日志副本：`docs/team/t483-main-process.log`。
- 源码断言：`processGuardsWiring.test.ts` 确认 install 在 createWindow 前；无 console。

## 3. 独立复跑（PR HEAD `4e9367c`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；459 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 159 files / 1052 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 4. 启动/断管无回归

- 真实启动正常创建窗口；注入 stdout/stderr 管道错误、uncaught EPIPE、unhandledRejection EPIPE 后仍 alive/windows=1/appReady。
- 错误后 IPC 仍可服务（listWorkspaces ok）；无错误弹框；win.close 正常；普通 rejection 被记录而不退出。
- 无 schema/权限/新 IPC/依赖变更；processGuards 是 Electron main-only 防护，不触碰业务 service/Renderer。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #66 | MERGED（squash） |
| merge commit | `f2f729f` |
| main | `f2f729f` + 本报告提交 |
| t468 worktree | 已移除 |
| t468 branch | 已删除（local/remote） |
| 当前 worktree | 仅主工作区 |

## 6. 遗留（非阻塞）

1. uncaught 注入为合成 `emit`（N1 low）。
2. dialog 仅 stub `showErrorBox` 断言 0（N2 low）。
3. 未使用真实断开 OS pipe（N3 low）。
4. harness JSON 未记录 exitCode（N4 low）。
5. 既有并行测试时序 timeout（N5 info；CI 串行）。

**最终结论：G16 PASS，PR #66 已 squash 合并 `f2f729f`；EPIPE 写/未捕获不崩溃不弹框、普通异常记录并 exit1、真实启动/断管/IPC 无回归；无 schema/权限/新 IPC/依赖；遗留仅 harness 深度/环境项。**
