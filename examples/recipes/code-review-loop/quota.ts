import { LoopError, object } from "./config.ts";

export class QuotaWait extends LoopError {
  readonly at: string;
  constructor(at: string) {
    super("Claude 额度尚未恢复");
    this.at = at;
  }
}

export function quotaWait(stdout: string, now: number): QuotaWait | undefined {
  let latest: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (object(value) && value.type === "rate_limit_event" && object(value.rate_limit_info))
      latest = value.rate_limit_info;
  }
  if (!latest || latest.status !== "rejected" || latest.errorCode === "credits_required") return;
  if (typeof latest.resetsAt !== "number" || !Number.isFinite(latest.resetsAt)) return;
  const milliseconds = latest.resetsAt * 1000 + 60_000;
  if (milliseconds <= now || milliseconds > 8.64e15) return;
  return new QuotaWait(new Date(milliseconds).toISOString());
}
