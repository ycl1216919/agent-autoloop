# 个人任务入口与分支开发

这是内核外的接单配方。`launch.ts` 在本人交互入口接入管理 MCP，在后台执行时排除管理 MCP；个人与副业 Gemini 登录和凭据分开。

客户端可信配置中的 `claudeModel` 和 `claudeEffort` 可固定 Claude 模型与推理强度，例如 `claude-opus-5-5`、`medium`。登录和账号状态查询不带模型参数。模型可用性仍需同一后台入口真实验收，配置成功不代表账号额度可用。

`development.ts` 从可信开发配置接收项目路径、检查命令与分支约定。新项目建议设置：

```json
{
  "name": "项目",
  "source": "/absolute/project",
  "tasksDirectory": "/absolute/autoloop-tasks",
  "instructions": "先读项目 AGENTS.md 和进度，完成一个可验收的小项。",
  "checks": [["npm", "test"]],
  "branch": {
    "base": "main",
    "prefix": "feat/",
    "repo": "owner/project",
    "account": "github-login",
    "remote": "origin"
  }
}
```

事件文字仅是业务资料，不能设置目录、程序、权限、命令、基线或交付目标。本人在项目配置中按仓库约定选择 `feat/`、`fix/`、`ci/`、`docs/` 或 `codex/` 前缀。

`branch.account` 固定该项目的 GitHub 登录账号。交付通过官方 `gh` 的该账号凭据，仅在本次子进程环境中使用，并核对实际身份和仓库写权限；不切换全局登录，不把凭据写入文件或命令参数。提交作者按该账号使用 GitHub noreply 地址。账号缺失时停止交付。

分支模式直接在原仓库工作，不创建 clone 或 worktree。新事项要求工作区干净并位于指定基线分支；已有未提交工作或其他任务分支会保留并交卡片，不 stash、丢弃、混入提交或切走其他任务。续办只接受本事项记录的分支。旧副本不会自动覆盖原仓库，需要明确核对交接。

流程为：Codex 实现 → 项目检查 → Claude 独立审查 → 必须修的问题返工 → 提交功能分支并推送 → 创建或读回 PR。审查结果绑定工作区版本；版本变化就停止交付。提交准备与 PR 结果写入本事项资料，交付中断后接续交付，避免重跑实现。项目自己的 hooks、CI、审批、合并和发版要求继续生效；本配方不自动合并或发布。

不填写 `branch` 的旧配置仍按指定 `revision` 创建独立验收副本，保留旧调用方兼容；个人团队的新开发配置使用分支模式。`code-review-loop` 也仍可用于已有工作区的单独审查。

本地验证使用临时 Git 仓库和测试程序，不访问真实 GitHub、通道或模型账号。真实部署另行核实已安装 CLI 版本、登录、选中模型及仓库状态。
