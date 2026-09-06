# Git 工作流与安全生产规范

> 本文件是当前项目的 Git / GitHub 流程单一事实来源。
> 如果它与其他文档冲突，以本文件为准。

## 1. 目标

让 Agent 在当前项目中安全地处理：
- 本地分支与工作区
- 远端同步
- 提交、推送、开 PR
- 发布与 Release PR
- ignore / secret / 覆盖风险

## 2. 默认原则

- 本项目采用**单主干开发 (Trunk-Based Development)**，**仅保留 `main` 分支**。
- 不再采用或新增任何特性/修复等临时分支（禁止新建 `feat/*`、`fix/*` 等）。
- 所有提交必须小粒度、可回滚、经过全套质量门禁验证。
- 任何会覆盖、丢失、重写历史的操作都要先停下并说明风险。
- 先看状态，再动 Git。

## 3. 每次 Git 动作前的固定顺序

只要任务碰到 Git / GitHub / 远端仓库 / release，先按顺序做：

1. `git branch --show-current`（确保在 `main` 分支）
2. `git status --short`
3. `git diff --stat`
4. `git remote get-url origin`；仅成功时执行 `git fetch origin`
5. 检查本地 `main` 与 `origin/main` 状态；有落后时优先 `git pull --rebase origin main`

然后再决定：
- 运行本地验证门禁（`typecheck`、`lint`、`test`）
- 进行小粒度本地提交
- 推送 `origin main`
- 发布 Release / Tag
- 暂停并说明风险

## 4. 分支规则 (单主干规范)

- **仅保留 `main`**：本项目已全面切换为单主干开发，不再创建、切换或维护除 `main` 之外的任何分支。
- **直接在 `main` 迭代**：所有功能新增、缺陷修复、文档更新均在本地 `main` 分支完成，严禁新建分支。
- **门禁先行**：在 `main` 提交前必须保证 `pnpm typecheck`、`pnpm -w run lint`、`pnpm test` 全部通过。
- **直推规范**：本地提交完成后，执行 `git pull --rebase origin main`，测试全绿后直接推送至 `origin main`。
## 5. 暂存与提交

- 优先使用 `git add <specific-file>`。
- 不默认使用 `git add .` 或 `git add -A`。
- 新脚手架首次提交必须显式暂存生成文件与 `pnpm-lock.yaml`。
- 提交前运行 `git check-ignore -v node_modules dist`、`git diff --cached --check` 与 `git diff --cached --stat`。
- Git identity 缺失时保留 staged 状态并报告；禁止修改 global identity。
- 提交信息用 Conventional Commits：`<type>(<scope>): <subject>`。
- 禁止空泛提交名：`update`、`wip`、`fix bug`。
- 提交前先展示 `git status` 和 `git diff` 摘要给用户。

## 6. 远端同步

- 存在 `origin` 时先 `git fetch origin`；无远端时跳过。
- 如果本地落后，优先 `git pull --rebase`。
- 如果有未提交改动，先停，不直接拉取覆盖。
- 如果分叉或冲突，先说明，不猜测，不 force。

## 7. PR 与发布

- 分支推送后再开 PR。
- PR 标题尽量沿用 Conventional Commits 风格。
- PR 描述至少说明：目的、改了什么、怎么验证。
- 发布优先走项目约定的发布流程。
- 如果项目约定 `release-please`，Release PR 由人类手动合并。
- Agent 不代做最终 merge。

## 8. 安全红线

绝对禁止，除非用户明确要求并确认后再执行：
- `git push --force`
- `git push -f`
- `git push --force-with-lease`
- `git reset --hard`
- `git checkout .`
- `git restore .`
- `git clean -fd`
- `git commit --amend`（尤其是已 push 后）
- `gh pr merge`
- `--no-verify`
- 修改 GitHub ruleset / branch protection / 仓库 settings

## 9. 密钥与 ignore

- `.env`、`.env.*`、`*.pem`、`*.key`、`secrets/`、`node_modules/`、`dist/`、`.next/`、`coverage/`、`__pycache__/` 必须被忽略。
- 如果发现该忽略却已被跟踪的文件，先停，再处理。
- 不要把 Token、密钥、完整用户数据写进代码、日志、示例或文档。

## 10. 项目阶段

- 具体项目阶段、ruleset、release 细则，放在该项目的 `docs/GITHUB-GUARD.md`。
- 这份文件只定义通用工作流，不定义某个项目的阶段编号或发布状态。

## 11. 用户最常见动作

### 11.1 本地改完后
1. 看 `git status`
2. 看 `git diff`
3. 精确 `git add`
4. 约定式提交
5. 再决定 push 还是继续改

### 11.2 需要同步远端
1. `git fetch origin`
2. 检查是否有本地未提交改动
3. 如果只是落后，`git pull --rebase`
4. 如果冲突，先停

### 11.3 需要发布
1. 看项目发布流程
2. 先开 Release PR 或按项目约定处理
3. 人类手动合并

## 12. 说明

- 具体项目级阶段、ruleset、release 细则，放在该项目的 `docs/GITHUB-GUARD.md`。
- 旧的 Git 说明文档只保留短指针，不再重复写完整规则。
