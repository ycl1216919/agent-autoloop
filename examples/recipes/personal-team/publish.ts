import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { object } from "../code-review-loop/config.ts";
import { git, revision } from "../code-review-loop/snapshot.ts";
import type { Branch } from "./branch.ts";
import { ClientError } from "./errors.ts";
import { github } from "./github.ts";

export type Delivery = { readonly repo: string; readonly remote: string; readonly account?: string };

export function publish(branch: Branch, delivery: Delivery, directory: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(delivery.repo) || !/^[A-Za-z0-9_.-]+$/.test(delivery.remote))
    throw new ClientError("PR 仓库与 remote 必须来自可信项目配置");
  const { workspace } = branch;
  if (git(workspace, ["branch", "--show-current"]).trim() !== branch.branch)
    throw new ClientError("分支已改变，停止提交与推送");
  const file = join(directory, "delivery.json");
  const checkpoint: unknown = JSON.parse(readFileSync(join(directory, "state", "state.json"), "utf8"));
  if (!object(checkpoint) || checkpoint.phase !== "done" || typeof checkpoint.revision !== "string")
    throw new ClientError("没有当前小项的检查与独立审查通过记录");
  let record: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  if (
    record === undefined &&
    (git(workspace, ["rev-parse", "HEAD"]).trim() !== branch.base || revision(workspace) !== checkpoint.revision)
  )
    throw new ClientError("代码已偏离验收版本，停止提交");
  const client = github(delivery.account, workspace);
  if (client.command(["api", `repos/${delivery.repo}`, "--jq", ".permissions.push"]) !== "true")
    throw new ClientError("项目指定 GitHub 账号没有目标仓库写权限，保留现场");
  if (record === undefined) {
    git(workspace, ["add", "--all"]);
    record = { tree: git(workspace, ["write-tree"]).trim(), base: branch.base, branch: branch.branch };
    writeFileSync(file, JSON.stringify(record, null, 2));
  }
  if (
    !object(record) ||
    typeof record.tree !== "string" ||
    record.base !== branch.base ||
    record.branch !== branch.branch
  )
    throw new ClientError("交付记录与本事项不符");
  if (git(workspace, ["rev-parse", "HEAD"]).trim() === branch.base) {
    if (git(workspace, ["write-tree"]).trim() !== record.tree || revision(workspace) !== checkpoint.revision)
      throw new ClientError("暂存内容已改变，需要重新验收");
    client.git(["commit", "-m", `feat: complete ${branch.branch.split("/").at(-1)}`]);
  }
  const head = git(workspace, ["rev-parse", "HEAD"]).trim();
  if (
    git(workspace, ["rev-parse", "HEAD^{tree}"]).trim() !== record.tree ||
    git(workspace, ["rev-parse", "HEAD^"]).trim() !== branch.base ||
    git(workspace, ["status", "--porcelain"]).trim()
  )
    throw new ClientError("提交或工作区偏离已审查内容，保留提交但不推送");
  const gh = client.command;
  const remote = git(workspace, ["remote", "get-url", delivery.remote]).trim();
  const expected = `github.com/${delivery.repo}`.toLowerCase();
  if (
    ![expected, `${expected}.git`].some(
      (value) =>
        remote
          .replace("git@github.com:", "github.com/")
          .replace(/^https:\/\//, "")
          .toLowerCase() === value,
    )
  )
    throw new ClientError("remote 不对应可信 GitHub 仓库，停止推送");
  client.git(["push", "--set-upstream", delivery.remote, `HEAD:refs/heads/${branch.branch}`]);
  const existing: unknown = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      delivery.repo,
      "--head",
      branch.branch,
      "--base",
      branch.baseBranch,
      "--state",
      "all",
      "--json",
      "url,headRefOid",
    ]),
  );
  if (!Array.isArray(existing)) throw new ClientError("无法核对已有 PR");
  const same = existing.find((pr: unknown) => object(pr) && pr.headRefOid === head);
  const body = join(directory, "pr-body.md");
  const implementation = join(directory, "state", `implement-${checkpoint.attempt}`, "stdout.log");
  let summary = "按项目计划完成本轮小项。";
  if (existsSync(implementation)) {
    for (const line of readFileSync(implementation, "utf8").split("\n")) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (
        object(event) &&
        event.type === "item.completed" &&
        object(event.item) &&
        event.item.type === "agent_message" &&
        !["analysis", "reasoning"].includes(String(event.item.channel)) &&
        typeof event.item.text === "string"
      )
        summary = event.item.text.slice(0, 12000);
    }
  }
  const title = summary.split("\n")[0].replace(/[#*`]/g, "").trim().slice(0, 120) || "完成本轮开发事项";
  writeFileSync(
    body,
    `${summary}\n\n验证：配置的项目检查与 Claude 独立审查通过。审查 findings 为空。\n\n提交：${head}\n\nCI 与仓库合并要求仍需在 PR 上核对；不自动合并或发布。\n`,
  );
  const url =
    object(same) && typeof same.url === "string"
      ? same.url
      : gh([
          "pr",
          "create",
          "--draft",
          "--repo",
          delivery.repo,
          "--base",
          branch.baseBranch,
          "--head",
          branch.branch,
          "--title",
          title,
          "--body-file",
          body,
        ]);
  writeFileSync(file, JSON.stringify({ ...record, commit: head, pr: url }, null, 2));
  return `PR：${url}\n提交：${head}；等待仓库 CI 和合并条件，不自动合并。`;
}
