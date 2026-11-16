import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export class LoopError extends Error {
  readonly reason: string;
  readonly action: string;
  constructor(reason: string, action = reason) {
    super(reason);
    this.reason = reason;
    this.action = action;
  }
}

export type Team = {
  readonly name: string;
  readonly workspace: string;
  readonly taskFile: string;
  readonly stateDirectory: string;
  readonly checks: readonly (readonly string[])[];
  readonly maxAttempts: number;
  readonly coderProgram?: string;
  readonly reviewerProgram?: string;
  readonly start: "implement" | "review";
  readonly reviewBase?: string;
};

export type Phase = "implement" | "check" | "review" | "done" | "nothing" | "cancelled";
export type Checkpoint = {
  task: string;
  base: string;
  phase: Phase;
  attempt: number;
  revision?: string;
  error?: string;
};
export type Finding = { readonly title: string; readonly text: string };

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const words = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text);

export function readTeam(file: string): Team {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!object(raw) || !text(raw.name) || !text(raw.workspace) || !text(raw.taskFile) || !text(raw.stateDirectory)) {
    throw new LoopError("配置需要 name、workspace、taskFile 和 stateDirectory");
  }
  const { name, workspace, taskFile, stateDirectory } = raw;
  if (![workspace, taskFile, stateDirectory].every(isAbsolute))
    throw new LoopError("配置中的目录和任务文件需要绝对路径");
  if (!Array.isArray(raw.checks) || !raw.checks.length || !raw.checks.every(words)) {
    throw new LoopError("checks 需要至少一条命令，每条命令是独立参数的数组");
  }
  const maxAttempts = raw.maxAttempts ?? 3;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new LoopError("maxAttempts 需要是 1 到 5 的整数");
  }
  for (const field of ["coderProgram", "reviewerProgram"]) {
    if (raw[field] !== undefined && (!text(raw[field]) || !isAbsolute(raw[field]))) {
      throw new LoopError(`${field} 需要是程序的绝对路径`);
    }
  }
  const start = raw.start ?? "implement";
  if (start !== "implement" && start !== "review") throw new LoopError("start 只能是 implement 或 review");
  if (raw.reviewBase !== undefined && (typeof raw.reviewBase !== "string" || !/^[a-f0-9]{40}$/.test(raw.reviewBase))) {
    throw new LoopError("reviewBase 需要是可信审查基线的完整提交号");
  }
  const known = [
    "name",
    "workspace",
    "taskFile",
    "stateDirectory",
    "checks",
    "maxAttempts",
    "coderProgram",
    "reviewerProgram",
    "start",
    "reviewBase",
  ];
  if (Object.keys(raw).some((field) => !known.includes(field))) throw new LoopError("配置有不认识的字段");
  const canonical = realpathSync(workspace);
  const inside = (file: string) => {
    const part = relative(canonical, resolve(file));
    return (
      part === "" ||
      (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    );
  };
  if (inside(stateDirectory) || inside(taskFile)) throw new LoopError("任务文件和状态目录必须放在代码工作目录之外");
  return {
    name,
    workspace: canonical,
    taskFile: realpathSync(taskFile),
    stateDirectory: resolve(stateDirectory),
    checks: raw.checks,
    maxAttempts,
    start,
    ...(text(raw.reviewBase) ? { reviewBase: raw.reviewBase } : {}),
    ...(text(raw.coderProgram) ? { coderProgram: raw.coderProgram } : {}),
    ...(text(raw.reviewerProgram) ? { reviewerProgram: raw.reviewerProgram } : {}),
  };
}

export function readCheckpoint(file: string): Checkpoint {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!object(value) || !text(value.task) || !text(value.base) || !Number.isInteger(value.attempt)) {
    throw new LoopError("任务状态无法读取，保留现场后检查状态文件");
  }
  const { phase, attempt } = value;
  if (
    (phase !== "implement" &&
      phase !== "check" &&
      phase !== "review" &&
      phase !== "done" &&
      phase !== "nothing" &&
      phase !== "cancelled") ||
    typeof attempt !== "number" ||
    attempt < 1
  ) {
    throw new LoopError("任务阶段或执行次数无效");
  }
  if (value.revision !== undefined && !text(value.revision)) throw new LoopError("任务版本记录无效");
  return {
    task: value.task,
    base: value.base,
    phase,
    attempt,
    ...(text(value.revision) ? { revision: value.revision } : {}),
  };
}

export function saveCheckpoint(file: string, state: Checkpoint) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function readFindings(message: string): readonly Finding[] {
  const value: unknown = JSON.parse(message);
  if (!object(value) || !Array.isArray(value.findings)) throw new LoopError("审查没有提供有效的 findings 结果");
  return value.findings.map((finding: unknown) => {
    if (!object(finding) || !text(finding.title) || !text(finding.text))
      throw new LoopError("审查意见缺少 title 或 text");
    return { title: finding.title, text: finding.text };
  });
}
