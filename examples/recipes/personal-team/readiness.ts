import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commandLine } from "../../../host/command.ts";
import { hubClient, type Hub } from "../../../protocol/client.ts";
import { ClientError } from "./errors.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type Recovery = {
  readonly command: readonly string[];
  readonly owner: Pick<Hub, "state" | "answer">;
  readonly card: number;
  readonly title: string;
};
export async function resumeAfterLogin(recovery: Recovery): Promise<"waiting" | "resumed" | "nothing"> {
  const result = spawnSync(...commandLine([...recovery.command, "auth", "status"]), {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return "waiting";
  let auth: unknown;
  try {
    auth = JSON.parse(result.stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return "waiting";
  }
  if (!object(auth) || auth.loggedIn !== true) return "waiting";
  const state: unknown = await recovery.owner.state();
  if (!object(state) || !Array.isArray(state.cards)) throw new ClientError("中台状态无法核对");
  const card = state.cards.find(
    (item: unknown) =>
      object(item) &&
      item.id === recovery.card &&
      item.title === recovery.title &&
      item.kind === "ask" &&
      item.state === "open",
  );
  if (!card) return "nothing";
  await recovery.owner.answer(recovery.card, { choice: 0 });
  return "resumed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new ClientError("需要客户端配置文件");
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !object(config) ||
    typeof config.hubHome !== "string" ||
    !Array.isArray(config.claude) ||
    !config.claude.every((value): value is string => typeof value === "string") ||
    !object(config.recovery) ||
    typeof config.recovery.card !== "number" ||
    typeof config.recovery.title !== "string"
  )
    throw new ClientError("连接恢复配置无效");
  process.env.AGENT_AUTOLOOP_HOME = config.hubHome;
  const { readConfig } = await import("../../../host/config.ts");
  const current = readConfig();
  if (!current.owner) throw new ClientError("缺少恢复指定卡片所需的本人身份");
  resumeAfterLogin({
    command: config.claude,
    owner: hubClient(current.url, current.owner),
    card: config.recovery.card,
    title: config.recovery.title,
  })
    .then((result) =>
      console.log(
        result === "resumed"
          ? "Claude 后台登录已接通，已唤醒原有 PR90 审查。"
          : "没事可做：连接尚未恢复，或原有等待卡片已经处理。",
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
