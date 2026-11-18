import { setTimeout } from "node:timers/promises";
import { DiscordError, object } from "./config.ts";

export class DiscordRest {
  readonly token: string;
  readonly signal: AbortSignal;
  constructor(token: string, signal: AbortSignal) {
    this.token = token;
    this.signal = signal;
  }
  async request(method: string, path: string, body?: object): Promise<unknown> {
    for (;;) {
      const response = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
      });
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new DiscordError(response.status);
      }
      if (
        response.status === 429 &&
        object(data) &&
        typeof data.retry_after === "number" &&
        Number.isFinite(data.retry_after) &&
        data.retry_after > 0
      ) {
        await setTimeout(Math.ceil(data.retry_after * 1000), undefined, { signal: this.signal });
        continue;
      }
      if (!response.ok) throw new DiscordError(response.status);
      return data;
    }
  }
}
