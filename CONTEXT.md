# CONTEXT.md — xpi-mymodels 术语表 (Glossary)

本文件定义本仓库的统一语言 (Ubiquitous Language)。代码、文档、issue、commit 中使用下列术语,禁止漂移为同义词。

| 术语 | 定义 | 备注 |
| :--- | :--- | :--- |
| 阶段一 | 单人快速迭代优先的仓库阶段。默认允许在本仓内按仓库约束工作。 | 以 `docs/GITHUB-GUARD.md` 为准 |
| 阶段二 | 更严格的协作阶段。默认分支 + PR + 人工合并。 | 以后切换时再启用 |
| 直推 | 直接 push 到主分支。 | 仅在仓库阶段与规则明确允许时才可能出现 |
| PR | Pull Request，合并请求。 | 远端协作入口 |
| ruleset | GitHub 仓库规则集。 | 由用户在 GitHub UI 管理 |
| 远端同步 | 先 fetch，再决定是否 rebase / push / 停止。 | 避免覆盖与分叉 |

## 避免用词 (Banned Synonyms)

- <!-- 记录易混淆/禁用的同义词 -->
