# AGENTS.md — DeerSuperGroup 开发与 AgentTeams 约定

本文件给在 DeerSuperGroup 仓库工作的编码 Agent / 团队队长使用。优先级高于个人习惯；与用户当前指令冲突时，以用户指令为准。

## 1. 模型路由基线

| 用途 | provider / model |
|---|---|
| 默认 DeepSeek | `deepseek-official/deepseek-flash` |
| GLM 5.3（4 个席位） | `mzai/glm-5.3` |

团队中 GLM 席位通常是 `lin / mika / noor / vale`；DeepSeek 席位通常是 `aria / ren / sol / kai`。实际以 `deers_team_status` 的 roster 为准，不要凭角色名硬编码。

## 2. GLM 到达限额时的处理（必须遵守）

GLM 路由触发 5 小时限额时，典型错误：

```json
429 {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 <timestamp> 重置。"}
```

处理顺序：

1. **不要连续重试同一 GLM 路由**，避免刷失败次数；记录 `code 1308` 与重置时间。
2. **立即把任务切到 DeepSeek 席位**：
   - 已失败 / 正在运行的任务：`deers_team_reassign_task` → `sol` / `ren` / `aria` / `kai` 中合适的人；
   - 尚未开始的 pending 任务：`deers_team_edit_plan` 的 `update_task` 改 assignee；
   - 不要新建重复任务，保留原 task id、依赖和契约。
3. **质量门禁保持独立**：
   - 实现者被换掉后，评审/集成优先换到另一名 DeepSeek 成员（例如 `sol` 实现 → `aria` 评审 → `kai` 集成）；
   - 不要让同一个人既实现又评审；
   - repair / review / integration 链不要绕过，除非用户明确要求。
4. **不要在 GLM 限额期间给 GLM 席位派新任务**，直到确认额度恢复。
5. **如果全部可用席位都不可用**：停止派发，向用户报告重置时间与阻塞任务；不要 busy-poll 或创建假任务。

## 3. 路由修改的验证

- 用 `deers_team_set_model` 修改成员路由后，**必须用 `deers_team_status` 复核实际 roster**。
- 本仓库曾出现 `set_model` 返回成功、但 status 仍显示 `mzai/glm-5.3` 的情况；此时不要假定切换成功，**直接把任务 reassign 给已确认的 DeepSeek 成员**。
- 不要直接编辑 `.deers-agent-team` 下的 `team.json` 或其他状态文件；只用 AgentTeams 工具。
- 不要为了绕限额而删除/重建团队或任务；保留历史、attempts 和评审证据。

## 4. 任务与质量门禁

- 使用现有 DAG；失败评审的自动 repair/review 链由系统生成，不重复创建。
- 权限/安全类修改必须过实现 → 评审 → 集成；不能因为换模型跳过评审。
- 每个实现/修复任务都要有可复现验证命令，默认：
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
- 完成报告要写：任务 id、模型路由、验证结果、遗留问题、是否需要下一轮。

## 5. DeerSuperGroup 应用层的模型降级

如果用户在应用内使用 `mzai/glm-5.3` 遇到 GLM 限额：

1. 设置 → 模型：切换到已配置的 DeepSeek provider/model；
2. 团队成员/对话成员的模型改为 DeepSeek profile；
3. 不要改变权限模式与 Full Throttle 语义：
   - 切换模型不影响 `read_only / workspace_write / full_access / auto_risk`；
   - Full Throttle 仍只是提示/预算模式，不改变权限；
4. 恢复 GLM 后，可按需把成员切回，不需要迁移数据。

## 6. 记录与恢复

- GLM 限额事件写在任务 output / 黑板 note / 最终交付文档中，包含：
  - provider/model；
  - `code 1308`；
  - 重置时间；
  - 被改派的任务与承接人。
- 额度恢复后，不要自动把已由 DeepSeek 完成的任务重新跑一遍；只有用户要求或任务明确需要 GLM 时才切回。
- 不在限额期间启动新的 GLM 评审/集成轮次。

## 7. 一句话

**GLM 限额不是重试问题，是路由问题：记录 reset、保留 DAG、把任务改派给已确认的 DeepSeek 席位、保持评审独立，不要新建重复任务，也不要直接改 team 状态文件。**

## 8. 分支并发开发（最多 3 个）

本项目使用 Git worktree 做并行开发；所有进行中的任务分支放在 `branches/` 目录，**最多 3 个 active worktree**。

### 任务开始

```bash
pnpm branch:start <task-id> <slug>
# 例：pnpm branch:start t68 execution-kernel
```

脚本会：

- 先 `fetch` 远端，并从最新 `origin/main` 起步（没有 remote 时用本地 `main`）；
- 检查 active worktree 是否已达 3 个；
- 创建 `feature/<task-id>-<slug>` 分支；
- 创建 `branches/<task-id>-<slug>/` worktree；
- 打印该任务应使用的目录。

Agent 必须在对应 worktree 中开发，不能在 `main` 工作树直接改任务代码。

### 开始新功能 / 提 PR 前同步主分支

每个功能开始前、以及每次提 PR 前，都必须同步最新主分支：

```bash
pnpm branch:sync <task-id>-<slug>
```

规则：

- `branch:start` 已自动从最新 `origin/main` 创建分支；
- 已经存在的分支在开发新功能或提 PR 前必须再执行一次 `branch:sync`；
- 同步产生冲突时，先在 worktree 内解决并提交，不得把冲突标记带进 PR；
- `branch:finish` 会拒绝尚未包含最新 `origin/main` 的分支。

### 任务完成：一个功能一个 PR

1. 在 worktree 中运行 `pnpm typecheck`、`pnpm build`、`pnpm test`；
2. 同步主分支并解决冲突；
3. 提交并推送分支；
4. 创建 PR，评审通过后合并到 `main`：
   ```bash
   pnpm branch:finish <task-id>-<slug>
   ```
   `branch:finish` 只 push + `gh pr create`，**不会自动合并**；
5. 合并后清理：
   ```bash
   pnpm branch:remove <task-id>-<slug>
   ```

### PR 最小功能原则（必须遵守）

- **一个功能 / 一个分支 / 一个 PR**；不要在一个 PR 里塞多个功能。
- 只改完成该功能必需的文件；不混入无关重构、格式化、依赖升级、顺手修复。
- 超出当前任务范围的改动拆成后续分支/PR，不放进当前 PR。
- PR 描述按 `.github/pull_request_template.md` 填写，必须包含：
  - 单一功能说明与 task id；
  - 已同步主分支；
  - 最小变更范围；
  - typecheck/build/test；
  - 风险与回滚方式；
  - UI 变更截图。
- 评审以“能否只通过这个最小功能独立验收”为准，不以改动大小论质量。

### 约束

- `main` 只接受 PR 合并；不直接 push 任务代码。
- 一个任务一个分支；一个 worktree 只给一个任务主体。
- 同时最多 3 个 active worktree；第 4 个会被脚本拒绝。
- PR 需要 Git remote；没有 remote 时 `branch:finish` 只打印手动 push/PR 指引。
- 历史 t61/t60 是分支流程启用前的 main-line 例外；新任务一律走 worktree/PR，不再直接改 `main`。
- `branches/` **整个目录被 gitignore**（worktree + README 都是本地文件）；不要手动把 worktree 内容提交到主仓库；跨团队规则以本文件为准。
