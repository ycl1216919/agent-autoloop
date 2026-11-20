import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { object } from "./config.ts";
import type { DiscordApi } from "./interaction.ts";

const snowflake = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const clip = (text: string, limit: number) => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
};

export class TaskThreads {
  readonly file?: string;
  private readonly bySubject = new Map<string, string>();
  private readonly byThread = new Map<string, string>();
  private readonly cardRefs = new Map<number, string>();

  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (object(raw)) {
          const threads = object(raw.threads) ? raw.threads : raw;
          for (const [subject, threadId] of Object.entries(threads)) {
            if (typeof threadId === "string" && snowflake(threadId)) {
              this.bySubject.set(subject, threadId);
              this.byThread.set(threadId, subject);
            }
          }
          if (object(raw.cards)) {
            for (const [cardId, ref] of Object.entries(raw.cards)) {
              if (/^[1-9]\d*$/.test(cardId) && typeof ref === "string" && /^\d+\/\d+$/.test(ref)) {
                this.cardRefs.set(Number(cardId), ref);
              }
            }
          }
        }
      } catch {
        // Corrupted or empty thread map starts fresh instead of crashing the channel.
      }
    }
  }

  threadOf(subject: string): string | undefined {
    return this.bySubject.get(subject);
  }

  subjectOf(threadId: string): string | undefined {
    return this.byThread.get(threadId);
  }

  refOfCard(cardId: number): string | undefined {
    return this.cardRefs.get(cardId);
  }

  recordCard(cardId: number, ref: string) {
    if (this.cardRefs.get(cardId) === ref) return;
    this.cardRefs.set(cardId, ref);
    this.save();
  }

  bind(subject: string, threadId: string) {
    const previous = this.bySubject.get(subject);
    if (previous === threadId) return;
    if (previous) this.byThread.delete(previous);
    this.bySubject.set(subject, threadId);
    this.byThread.set(threadId, subject);
    this.save();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const data = {
      threads: Object.fromEntries(this.bySubject.entries()),
      cards: Object.fromEntries([...this.cardRefs.entries()].slice(-500)),
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async ensureFromMessage(
    api: DiscordApi,
    parentChannelId: string,
    messageId: string,
    subject: string,
    title: string,
  ): Promise<string | undefined> {
    const existing = this.bySubject.get(subject);
    if (existing) return existing;
    try {
      const name = clip(title, 90) || subject;
      const created = await api.request("POST", `/channels/${parentChannelId}/messages/${messageId}/threads`, {
        name,
        auto_archive_duration: 1440,
      });
      if (object(created) && snowflake(created.id)) {
        this.bind(subject, created.id);
        return created.id;
      }
    } catch {
      // Creating a thread is best-effort; never drop the task event if Discord rejects thread creation.
    }
    return undefined;
  }
}

type StateLine = { name?: string; resume?: boolean };
type StateAgent = { id?: string; name?: string };
type StateRun = {
  id: number;
  rule?: string;
  lane?: string;
  agent?: string;
  state: string;
  attempts?: number;
  summary?: string;
  memo?: string;
  error?: string;
  resume?: string | null;
  events?: { subject?: string }[];
};
type StateSnapshot = {
  lines?: StateLine[];
  agents?: StateAgent[];
  runs?: StateRun[];
};

const TERMINAL = new Set(["done", "nothing", "cancelled"]);

function subjectOfRun(run: StateRun): string {
  if (typeof run.lane === "string" && run.lane) return run.lane;
  const first = run.events?.find((event) => typeof event?.subject === "string" && event.subject);
  return first?.subject ?? "";
}

function formatSessionMode(resume: string | null | undefined, ruleResume: boolean | undefined) {
  if (resume) return `续接上次会话（${resume}）`;
  if (ruleResume === true) return "新会话（后续可续接）";
  if (ruleResume === false) return "新会话（不续接上轮）";
  return "新会话";
}

function formatClaimed(run: StateRun, agentLabel: string, ruleResume: boolean | undefined) {
  const retry = run.attempts && run.attempts > 0 ? `（第 ${run.attempts + 1} 次尝试）` : "";
  const rule = run.rule ? ` · ${run.rule}` : "";
  return [
    `▶ 轮次 #${run.id} 开始${rule}${retry}`,
    `执行者：${agentLabel}`,
    `会话：${formatSessionMode(run.resume, ruleResume)}`,
  ]
    .join("\n")
    .slice(0, 1900);
}

function formatFinished(run: StateRun, agentLabel: string) {
  const icon = run.state === "done" ? "✅" : run.state === "nothing" ? "⏭️" : "🛑";
  const label = run.state === "done" ? "已完成" : run.state === "nothing" ? "无需处理" : "已停止";
  const rule = run.rule ? ` · ${run.rule}` : "";
  const lines = [`${icon} 轮次 #${run.id} ${label}${rule} · ${agentLabel}`];
  if (run.summary) lines.push(`结论：${run.summary}`);
  if (run.error) lines.push(`原因：${run.error}`);
  if (run.memo) lines.push(`交接备忘（轮次 #${run.id}）：\n${run.memo}`);
  return lines.join("\n").slice(0, 1900);
}

export async function syncRunUpdates(
  state: StateSnapshot,
  seen: Map<number, string>,
  threads: TaskThreads,
  api: DiscordApi,
) {
  const linesByName = new Map((state.lines ?? []).map((line) => [line.name ?? "", line]));
  const agentsById = new Map((state.agents ?? []).map((agent) => [agent.id ?? "", agent]));
  const runs = [...(state.runs ?? [])].sort((a, b) => a.id - b.id);
  for (const run of runs) {
    const subject = subjectOfRun(run);
    const threadId = subject ? threads.threadOf(subject) : undefined;
    if (!threadId) continue;
    const tag = run.state === "claimed" ? `claimed:${run.attempts ?? 0}` : run.state;
    const prev = seen.get(run.id);
    if (prev === tag) continue;
    const agent = agentsById.get(run.agent ?? "");
    const agentLabel =
      agent?.name && agent.name !== run.agent ? `${agent.name}（${run.agent}）` : (run.agent ?? "未知");
    if (run.state === "claimed") {
      const ruleResume = linesByName.get(run.rule ?? "")?.resume;
      await api.request("POST", `/channels/${threadId}/messages`, {
        content: formatClaimed(run, agentLabel, ruleResume),
        allowed_mentions: { parse: [] },
      });
      seen.set(run.id, tag);
    } else if (TERMINAL.has(run.state) && !TERMINAL.has(prev ?? "")) {
      await api.request("POST", `/channels/${threadId}/messages`, {
        content: formatFinished(run, agentLabel),
        allowed_mentions: { parse: [] },
      });
      seen.set(run.id, tag);
    }
  }
}

export function seedSeenRuns(state: StateSnapshot, seen: Map<number, string>) {
  for (const run of state.runs ?? []) {
    const tag = run.state === "claimed" ? `claimed:${run.attempts ?? 0}` : run.state;
    seen.set(run.id, tag);
  }
}
