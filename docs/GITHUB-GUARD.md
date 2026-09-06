# GITHUB-GUARD

本文件只描述 `xpi-mymodels` 的仓库级 GitHub 约束。

- 仓库级 Git / GitHub 通用流程见：`docs/GIT-WORKFLOW.md`
- 当前仓库阶段、ruleset、发布入口都在这里说明

## 当前阶段

- `xpi-mymodels` 采用**单主干开发 (Trunk-Based Development)**，**仅保留 `main` 分支**。
- 不再使用或新增临时分支；所有修改均直接在 `main` 分支经严格本地测试后提交并推送。
- 提交门禁：提交前必须保证 `pnpm typecheck`、`pnpm -w run lint`、`pnpm test` 全部通过。
- 允许直推 `origin main`（在本地全绿且同步远端最新后直接推送）。

## 本仓库约束

- 仅保留 `main` 主干分支，清理全部已合并的临时分支。
- 严禁任何强推（`git push --force`）、删除主干或绕过 git hooks 的操作。
- 不绕过 git hooks。
- 不把密钥 / Token 写入代码、日志、示例、文档。
- `.github/` 目录的变更必须先告知用户。

## 当前规则状态

- `guard-main` 只保留最小防线：`Block force pushes`、`Restrict deletions`。
- bypass 留空。
- 发布相关约束先按仓库现状执行，未配置 release-please。

## 切到阶段二的条件

当仓库满足以下条件时，再切换：

1. CI 已在 `main` 上稳定通过。
2. 用户显式要求进入更严格的协作流。
3. 再开启：
   - `Require a pull request before merging`
   - `Require status checks to pass`
4. 之后再把 `guard-main.json` 同步回仓库。

## 说明

- 这份文件只放仓库级判断，不重复写详细操作手册。
- 详细步骤统一看 `docs/GIT-WORKFLOW.md`。
