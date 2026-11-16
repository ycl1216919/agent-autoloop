import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "../code-review-loop/snapshot.ts";
import { object } from "../code-review-loop/config.ts";
import { ClientError } from "./errors.ts";

export type BranchProject = { readonly source: string; readonly base: string; readonly prefix: string };
export type Branch = {
  readonly workspace: string;
  readonly branch: string;
  readonly base: string;
  readonly baseBranch: string;
};

export function prepareBranch(project: BranchProject, directory: string): Branch {
  const workspace = realpathSync(project.source);
  if (resolve(git(workspace, ["rev-parse", "--show-toplevel"]).trim()) !== workspace)
    throw new ClientError("source 必须是原仓库根目录");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(project.base) || !/^(feat|fix|ci|docs|codex)\/$/.test(project.prefix))
    throw new ClientError("分支基线或前缀不符合可信项目配置");
  const file = join(directory, "branch.json");
  if (existsSync(file)) {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !object(saved) ||
      saved.workspace !== workspace ||
      saved.baseBranch !== project.base ||
      typeof saved.branch !== "string" ||
      !saved.branch.startsWith(project.prefix) ||
      typeof saved.base !== "string" ||
      !/^[a-f0-9]{40}$/.test(saved.base)
    )
      throw new ClientError("原仓库分支记录与项目配置不符，保留现场后核对");
    if (git(workspace, ["branch", "--show-current"]).trim() !== saved.branch)
      throw new ClientError("原仓库已切换到其他分支，不接管其他任务的现场");
    return { workspace, branch: saved.branch, base: saved.base, baseBranch: project.base };
  }
  if (git(workspace, ["status", "--porcelain"]).trim())
    throw new ClientError("原仓库有未提交改动，已保留；请由原任务提交或明确交接后继续");
  if (git(workspace, ["branch", "--show-current"]).trim() !== project.base)
    throw new ClientError(`原仓库正在其他分支工作，请先完成该事项并回到 ${project.base}`);
  const base = git(workspace, ["rev-parse", "HEAD"]).trim();
  const branch = `${project.prefix}autoloop-${basename(directory).slice(0, 16)}`;
  git(workspace, ["switch", "-c", branch]);
  const result = { workspace, branch, base, baseBranch: project.base };
  writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}
