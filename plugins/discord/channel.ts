import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { hubClient } from "../../protocol/client.ts";
import { DiscordError, cardGuidance, discordConfig, object } from "./config.ts";
import { DiscordRest } from "./rest.ts";
import { connectGateway } from "./gateway.ts";
import { handleInteraction } from "./interaction.ts";
import { cardMessage } from "./card.ts";
import { handleMessage } from "./message.ts";

export default async function discord(context: ChannelContext) {
  const config = discordConfig(context.options);
  const token = parseEnv(readFileSync(config.tokenFile, "utf8"))[config.tokenVariable];
  if (!token) throw new DiscordError(401);
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const api = new DiscordRest(token, signal);
  const identity = await api.request("GET", "/users/@me");
  const app = await api.request("GET", "/oauth2/applications/@me");
  if (
    !object(identity) ||
    identity.id !== config.applicationId ||
    !object(app) ||
    app.id !== config.applicationId ||
    app.interactions_endpoint_url
  )
    throw new DiscordError(409);
  if (config.inbox && (typeof app.flags !== "number" || !(app.flags & ((1 << 18) | (1 << 19)))))
    throw new DiscordError(4014, "请在 Discord 应用设置中开启 Message Content Intent，再启用自然语言入口");
  const options = [
    { type: 1, name: "status", description: "查看任务中心状态" },
    {
      type: 1,
      name: "task",
      description: "提交任务到固定入口",
      options: [
        {
          type: 3,
          name: "route",
          description: "任务入口",
          required: true,
          choices: Object.keys(config.routes).map((name) => ({ name, value: name })),
        },
        { type: 3, name: "text", description: "任务内容", required: true, max_length: 4000 },
      ],
    },
    ...["stop", "why"].map((name) => ({
      type: 1,
      name,
      description: name === "stop" ? "停止一轮任务" : "查看一轮任务的依据",
      options: [{ type: 4, name: "run", description: "轮次编号", required: true, min_value: 1 }],
    })),
  ];
  await api.request("POST", `/applications/${config.applicationId}/guilds/${config.guildId}/commands`, {
    name: "autoloop",
    description: "管理 AutoLoop 任务中心",
    type: 1,
    options,
  });
  const endpoint = await api.request("GET", "/gateway/bot");
  if (
    !object(endpoint) ||
    typeof endpoint.url !== "string" ||
    !/^wss:\/\/(?:[a-z0-9-]+\.)*discord\.gg\/?$/.test(endpoint.url)
  )
    throw new DiscordError(502);
  const interactionContext = {
    config,
    api,
    owner: hubClient(config.hubUrl, config.ownerKey),
    source: hubClient(config.hubUrl, config.sourceKey),
    channel: context.hub,
  };
  const guidance = cardGuidance(config);
  if (Object.values(guidance).some((item) => item.ref)) {
    const state = await interactionContext.owner.state();
    const cards: Card[] = state.cards;
    for (const card of cards) {
      const ref = guidance[card.id]?.ref;
      if (!ref || !config.channels.includes(ref.split("/")[0])) continue;
      await api.request(
        "PATCH",
        `/channels/${ref.split("/")[0]}/messages/${ref.split("/")[1]}`,
        cardMessage({ ...card, ref }, config),
      );
    }
  }
  async function deliver() {
    while (!signal.aborted) {
      const { card } = await context.hub.nextCard(10);
      if (!card) continue;
      try {
        const body = cardMessage(card, config);
        let ref = card.ref;
        if (ref) {
          if (!/^\d+\/\d+$/.test(ref)) throw new DiscordError(409);
          await api.request("PATCH", `/channels/${ref.split("/")[0]}/messages/${ref.split("/")[1]}`, body);
        } else {
          const nonce = createHash("sha256").update(`${config.hubUrl}:${card.id}`).digest("hex").slice(0, 25);
          const sent = await api.request("POST", `/channels/${config.channelId}/messages`, {
            ...body,
            nonce,
            enforce_nonce: true,
          });
          if (!object(sent) || typeof sent.id !== "string") throw new DiscordError(502);
          ref = `${config.channelId}/${sent.id}`;
          if (card.kind === "ask" && card.state === "open")
            await api.request(
              "PATCH",
              `/channels/${config.channelId}/messages/${sent.id}`,
              cardMessage({ ...card, ref }, config),
            );
        }
        await context.hub.delivered(card.id, card.version, ref);
      } catch (error) {
        if (signal.aborted) return;
        await context.hub.failed(
          card.id,
          card.version,
          error instanceof DiscordError ? error.message : "Discord 卡片未送达",
        );
      }
    }
  }
  try {
    await Promise.all([
      deliver(),
      connectGateway({
        url: endpoint.url,
        token,
        receive: (event) => handleInteraction(interactionContext, event),
        ...(config.inbox
          ? {
              intents: (1 << 9) | (1 << 15),
              receiveMessage: (event: unknown) => handleMessage(interactionContext, event),
            }
          : {}),
        log: context.log,
        signal,
      }),
    ]);
  } finally {
    stop.abort();
  }
}
