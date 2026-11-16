import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { commandLine } from "../../../host/command.ts";
import { ClientError } from "./errors.ts";

type Profile = "codex" | "claude" | "gemini-personal" | "gemini-business";
type Mode = "worker" | "client" | "login";
type Launch = {
  readonly file: string;
  readonly profile: Profile;
  readonly mode: Mode;
  readonly args: readonly string[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const words = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);

export async function launch(request: Launch): Promise<number> {
  if (request.mode !== "worker" && (process.env.AGENT_AUTOLOOP_RUN || process.env.AGENT_AUTOLOOP_CONTEXT))
    throw new ClientError("后台任务不能启动本人管理或交互登录入口");
  const config: unknown = JSON.parse(readFileSync(request.file, "utf8"));
  if (
    !object(config) ||
    typeof config.hubHome !== "string" ||
    !isAbsolute(config.hubHome) ||
    typeof config.profilesRoot !== "string" ||
    !isAbsolute(config.profilesRoot)
  )
    throw new ClientError("客户端配置缺少绝对路径 hubHome 或 profilesRoot");
  const bridge = join(import.meta.dirname, "owner-mcp.ts");
  const server = { command: process.execPath, args: [bridge, config.hubHome] };
  const env = { ...process.env };
  let argv: string[];
  switch (request.profile) {
    case "codex": {
      if (!words(config.codex)) throw new ClientError("缺少 Codex 程序");
      const options =
        request.mode === "client"
          ? [
              "-c",
              `mcp_servers.autoloop.command=${JSON.stringify(server.command)}`,
              "-c",
              `mcp_servers.autoloop.args=${JSON.stringify(server.args)}`,
            ]
          : ["-c", "mcp_servers.autoloop.enabled=false"];
      argv = [...config.codex, ...options, ...(request.mode === "login" ? ["login"] : request.args)];
      break;
    }
    case "claude": {
      if (!words(config.claude)) throw new ClientError("缺少 Claude Code 程序");
      for (const key of ["claudeModel", "claudeEffort"])
        if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim()))
          throw new ClientError(`${key} 需要非空字符串`);
      const selection = [
        ...(typeof config.claudeModel === "string" ? ["--model", config.claudeModel] : []),
        ...(typeof config.claudeEffort === "string" ? ["--effort", config.claudeEffort] : []),
      ];
      const options =
        request.mode === "login"
          ? ["auth", "login", "--claudeai"]
          : request.args[0] === "auth"
            ? [...request.args]
            : [
                ...selection,
                "--mcp-config",
                JSON.stringify({ mcpServers: request.mode === "client" ? { autoloop: server } : {} }),
                "--strict-mcp-config",
                ...request.args,
              ];
      argv = [...config.claude, ...options];
      break;
    }
    case "gemini-personal":
    case "gemini-business": {
      if (!words(config.gemini)) throw new ClientError("缺少 Gemini CLI 程序");
      if (config.geminiApi !== undefined && !object(config.geminiApi))
        throw new ClientError("geminiApi 需要按账号配置");
      const api = object(config.geminiApi) ? config.geminiApi[request.profile] : undefined;
      if (
        api !== undefined &&
        (!object(api) ||
          typeof api.keyFile !== "string" ||
          !isAbsolute(api.keyFile) ||
          typeof api.model !== "string" ||
          !api.model.trim())
      )
        throw new ClientError("Gemini API 需要该账号的绝对 keyFile 和明确 model");
      const directory = join(config.profilesRoot, `${request.profile}${api === undefined ? "" : "-api"}`);
      env.GEMINI_CLI_HOME = directory;
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(
        directory,
        `${request.mode === "client" ? "client" : "worker"}-settings.json`,
      );
      for (const key of [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
      ])
        delete env[key];
      if (object(api) && typeof api.keyFile === "string" && typeof api.model === "string") {
        const key = readFileSync(api.keyFile, "utf8").trim();
        if (!key) throw new ClientError("该 Gemini 账号尚未配置 API key");
        const settings: unknown = JSON.parse(readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
        if (
          !object(settings) ||
          !object(settings.security) ||
          !object(settings.security.auth) ||
          settings.security.auth.selectedType !== "gemini-api-key"
        )
          throw new ClientError("API 账号的设置必须明确使用 gemini-api-key，不能回退到 Google 登录");
        if (
          request.mode === "worker" &&
          (!object(settings.mcp) ||
            !Array.isArray(settings.mcp.excluded) ||
            !settings.mcp.excluded.includes("autoloop"))
        )
          throw new ClientError("Gemini 后台 API 设置必须排除本人 autoloop MCP");
        env.GEMINI_API_KEY = key;
        delete env.GOOGLE_GENAI_USE_GCA;
        argv = [...config.gemini, "--model", api.model, ...request.args];
      } else {
        env.GOOGLE_GENAI_USE_GCA = "true";
        argv = [...config.gemini, ...request.args];
      }
      break;
    }
    default: {
      const unreachable: never = request.profile;
      throw new ClientError(`不认识的账号：${unreachable}`);
    }
  }
  const child = spawn(...commandLine(argv), { env, stdio: "inherit", windowsHide: request.mode === "worker" });
  const stop = () => child.kill();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, profile, mode, ...args] = process.argv.slice(2);
  if (
    !file ||
    !["codex", "claude", "gemini-personal", "gemini-business"].includes(profile) ||
    !["worker", "client", "login"].includes(mode)
  )
    throw new ClientError(
      "用法：node launch.ts <clients.json> <codex|claude|gemini-personal|gemini-business> <worker|client|login> [参数]",
    );
  if (
    (profile === "codex" || profile === "claude" || profile === "gemini-personal" || profile === "gemini-business") &&
    (mode === "worker" || mode === "client" || mode === "login")
  )
    launch({ file, profile, mode, args })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
}
