import { setTimeout as delay } from "node:timers/promises";
import { DiscordError, object } from "./config.ts";

type Gateway = {
  readonly url: string;
  readonly token: string;
  readonly receive: (event: unknown) => Promise<void>;
  readonly receiveMessage?: (event: unknown) => Promise<void>;
  readonly intents?: number;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
};

export async function connectGateway(options: Gateway) {
  let session: string | undefined;
  let resumeUrl: string | undefined;
  let sequence: number | null = null;
  while (!options.signal.aborted) {
    const socket = new WebSocket(`${resumeUrl ?? options.url}?v=10&encoding=json`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = true;
    const send = (op: number, d: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d }));
    };
    const beat = () => {
      acknowledged = false;
      send(1, sequence);
    };
    const code = await new Promise<number>((resolve) => {
      const stop = () => {
        socket.close(1000);
        resolve(1000);
      };
      options.signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener("message", (message) => {
        if (options.signal.aborted) return;
        let event: unknown;
        try {
          event = JSON.parse(String(message.data));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          socket.close(4000);
          return;
        }
        if (!object(event)) return;
        if (typeof event.s === "number") sequence = event.s;
        switch (event.op) {
          case 10: {
            if (!object(event.d) || typeof event.d.heartbeat_interval !== "number" || event.d.heartbeat_interval <= 0) {
              socket.close(4000);
              break;
            }
            const interval = event.d.heartbeat_interval;
            const tick = () => {
              if (!acknowledged) {
                socket.close(4000);
                return;
              }
              beat();
              timer = setTimeout(tick, interval);
            };
            timer = setTimeout(tick, Math.random() * interval);
            if (session) send(6, { token: options.token, session_id: session, seq: sequence });
            else
              send(2, {
                token: options.token,
                intents: options.intents ?? 0,
                properties: { os: process.platform, browser: "agent-autoloop", device: "agent-autoloop" },
              });
            break;
          }
          case 11:
            acknowledged = true;
            break;
          case 1:
            beat();
            break;
          case 7:
            socket.close(4000);
            break;
          case 9:
            if (event.d !== true) {
              session = undefined;
              resumeUrl = undefined;
              sequence = null;
            }
            socket.close(4000);
            break;
          case 0:
            if (
              event.t === "READY" &&
              object(event.d) &&
              typeof event.d.session_id === "string" &&
              typeof event.d.resume_gateway_url === "string"
            ) {
              session = event.d.session_id;
              resumeUrl = event.d.resume_gateway_url;
              options.log("Discord 已连接");
            }
            if (event.t === "INTERACTION_CREATE")
              void options.receive(event.d).catch(() => options.log("Discord 操作处理失败；任务状态仍以中台记录为准"));
            if (event.t === "MESSAGE_CREATE" && options.receiveMessage)
              void options
                .receiveMessage(event.d)
                .catch(() => options.log("Discord 消息处理失败；请查看任务状态后重试"));
            break;
        }
      });
      socket.addEventListener(
        "error",
        () => {
          socket.close();
          resolve(1006);
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          if (timer) clearTimeout(timer);
          options.signal.removeEventListener("abort", stop);
          resolve(event.code);
        },
        { once: true },
      );
      if (options.signal.aborted) stop();
    });
    if (timer) clearTimeout(timer);
    if ([4004, 4010, 4011, 4013, 4014].includes(code)) throw new DiscordError(code);
    if ([1000, 1001, 4007, 4009].includes(code)) {
      session = undefined;
      resumeUrl = undefined;
      sequence = null;
    }
    if (options.signal.aborted) return;
    await delay(1000 + Math.random() * 4000, undefined, { signal: options.signal });
  }
}
