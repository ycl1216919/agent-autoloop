import { execFileSync } from "node:child_process";
import { object } from "../code-review-loop/config.ts";
import { ClientError } from "./errors.ts";

export function github(account: string | undefined, workspace: string) {
  const requested =
    account ?? execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(requested)) throw new ClientError("GitHub 账号必须来自可信项目配置");
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token", "--hostname", "github.com", "--user", requested], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new ClientError(`GitHub 账号 ${requested} 尚未在本机 CLI 登录，不切换或借用其他账号`);
  }
  const env = { ...process.env, GH_TOKEN: token, GH_HOST: "github.com", GIT_TERMINAL_PROMPT: "0" };
  const command = (args: string[]) =>
    execFileSync("gh", args, { cwd: workspace, env, encoding: "utf8", windowsHide: true }).trim();
  const user: unknown = JSON.parse(command(["api", "user", "--jq", "{login,id}"]));
  if (!object(user) || user.login !== requested || typeof user.id !== "number")
    throw new ClientError("GitHub 实际身份与项目指定账号不符，停止交付");
  const identity = [
    "-c",
    `user.name=${requested}`,
    "-c",
    `user.email=${user.id}+${requested}@users.noreply.github.com`,
  ];
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...identity, ...args],
      { cwd: workspace, env, encoding: "utf8", windowsHide: true },
    ).trim();
  return { command, git };
}
