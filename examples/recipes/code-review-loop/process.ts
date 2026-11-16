import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine } from "../../../host/command.ts";
import { adapterFor, type Reading, type Turn } from "../../../worker/agents.ts";
import { readMessage } from "../../../worker/contract.ts";
import { LoopError, object } from "./config.ts";
import { quotaWait } from "./quota.ts";

const findingsSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          text: { type: "string" },
        },
        required: ["title", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export async function runAgent(use: "codex" | "claude", turn: Turn): Promise<Reading> {
  const adapter = await adapterFor(use);
  const read = (stdout: string, code: number | null, stderr: string): Reading => {
    const result = adapter.read(stdout, code, stderr);
    switch (use) {
      case "codex":
        return result;
      case "claude": {
        if (result.error || !result.finished) return result;
        let structured: unknown;
        for (const line of stdout.split("\n")) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
          if (object(event) && event.type === "result") structured = event.structured_output;
        }
        return object(structured)
          ? { ...result, text: JSON.stringify(structured) }
          : { ...result, error: "审查未提供有效的结构化结果" };
      }
      default: {
        const unreachable: never = use;
        throw new LoopError(`不认识的执行工具：${unreachable}`);
      }
    }
  };
  mkdirSync(turn.folder, { recursive: true });
  const stdoutFile = join(turn.folder, "stdout.log");
  const stderrFile = join(turn.folder, "stderr.log");
  const sessionFile = join(turn.folder, "session.txt");
  const previous = existsSync(stdoutFile)
    ? read(readFileSync(stdoutFile, "utf8"), null, existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "")
    : {};
  const previousMessage = previous.text ? readMessage(previous.text) : undefined;
  if (previousMessage)
    switch (previousMessage.outcome) {
      case "done":
      case "nothing":
        if (
          previous.finished &&
          previous.text &&
          !previous.error &&
          !previousMessage.problem &&
          !previousMessage.receipt?.ask &&
          !previousMessage.summary?.startsWith("待你处理")
        )
          return previous;
        break;
      case "failed":
        break;
      default: {
        const unreachable: never = previousMessage.outcome;
        throw new LoopError(`不认识的执行结果：${unreachable}`);
      }
    }
  const problem = adapter.check?.(turn.program);
  const names = { codex: "Codex", claude: "Claude Code" } as const;
  if (problem) throw new LoopError(problem, `${names[use]} 的后台入口尚未接通，请在同一运行环境核实登录和可用状态。`);
  if (previous.session) writeFileSync(sessionFile, previous.session);
  const resume = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() : turn.resume;
  writeFileSync(stdoutFile, "");
  writeFileSync(stderrFile, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE_CODE_")));
  const argv = adapter.command({ ...turn, resume });
  switch (use) {
    case "codex":
      break;
    case "claude":
      argv.push("--json-schema", JSON.stringify(findingsSchema));
      break;
    default: {
      const unreachable: never = use;
      throw new LoopError(`不认识的执行工具：${unreachable}`);
    }
  }
  const child = spawn(...commandLine(argv), {
    cwd: turn.cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    appendFileSync(stdoutFile, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    appendFileSync(stderrFile, chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = read(stdout, code, stderr);
  if (result.session) writeFileSync(sessionFile, result.session);
  if (code !== 0 || result.error || !result.text?.trim()) {
    const waiting = use === "claude" ? quotaWait(stdout, Date.now()) : undefined;
    if (waiting) throw waiting;
    throw new LoopError(
      result.error ?? `${use} 没有完成并留下结果`,
      `${names[use]} 未能完成：${(result.error ?? "没有留下结果").split("\n")[0].slice(0, 180)}`,
    );
  }
  return result;
}

export function runChecks(commands: readonly (readonly string[])[], workspace: string) {
  return commands.map((argv) => {
    const result = spawnSync(...commandLine([...argv]), {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status === null)
      throw new LoopError(`项目检查无法运行：${result.error?.message ?? result.signal}`);
    return {
      command: [...argv],
      code: result.status,
      stdout: result.stdout.slice(-16000),
      stderr: result.stderr.slice(-16000),
    };
  });
}
