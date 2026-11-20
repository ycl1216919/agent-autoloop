import { DiscordError, object } from "./config.ts";
import type { InteractionContext } from "./interaction.ts";
import type { TaskThreads } from "./threads.ts";

type MessageContext = Pick<InteractionContext, "config" | "source" | "channel" | "api"> & {
  readonly owner?: Pick<InteractionContext["owner"], "state">;
  readonly threads?: TaskThreads;
};
const snowflake = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

export async function handleMessage(context: MessageContext, raw: unknown) {
  const { config } = context;
  if (
    !config.inbox ||
    !object(raw) ||
    !snowflake(raw.id) ||
    raw.guild_id !== config.guildId ||
    typeof raw.channel_id !== "string" ||
    !object(raw.author) ||
    typeof raw.author.id !== "string" ||
    !config.users.includes(raw.author.id) ||
    raw.author.bot === true ||
    raw.webhook_id !== undefined ||
    ![0, 19].includes(Number(raw.type)) ||
    typeof raw.content !== "string" ||
    !raw.content.trim() ||
    raw.content.startsWith("/")
  )
    return;
  const threadSubject = context.threads?.subjectOf(raw.channel_id);
  const inMainChannel = config.channels.includes(raw.channel_id);
  if (!inMainChannel && !threadSubject) return;
  const content = raw.content.trim();
  if ([...content].length > 4000) throw new DiscordError(400, "一条任务最多 4000 字，请拆分发送");
  const reference = raw.message_reference;
  if (
    object(reference) &&
    snowflake(reference.message_id) &&
    (reference.channel_id === undefined || reference.channel_id === raw.channel_id) &&
    (reference.guild_id === undefined || reference.guild_id === config.guildId)
  ) {
    const original = object(raw.referenced_message)
      ? raw.referenced_message
      : await context.api.request("GET", `/channels/${raw.channel_id}/messages/${reference.message_id}`);
    if (
      object(original) &&
      original.id === reference.message_id &&
      object(original.author) &&
      original.author.id === config.applicationId
    ) {
      for (const row of Array.isArray(original.components) ? original.components : []) {
        if (!object(row) || !Array.isArray(row.components)) continue;
        for (const component of row.components) {
          if (!object(component) || typeof component.custom_id !== "string") continue;
          const match = /^autoloop:([1-9]\d*):[0-4]$/.exec(component.custom_id);
          if (!match) continue;
          await context.channel.answer(Number(match[1]), {
            text: content,
            by: raw.author.id,
            ref: `${raw.channel_id}/${reference.message_id}`,
          });
          return;
        }
      }
      return;
    }
  }
  if (threadSubject) {
    if (context.owner && context.threads) {
      const state = await context.owner.state();
      const openAsk = Array.isArray(state?.cards)
        ? state.cards.find(
            (card: unknown) =>
              object(card) && card.kind === "ask" && card.state === "open" && card.lane === threadSubject,
          )
        : undefined;
      if (openAsk && typeof openAsk.id === "number") {
        const ref = context.threads.refOfCard(openAsk.id);
        if (ref) {
          await context.channel.answer(openAsk.id, {
            text: content,
            by: raw.author.id,
            ref,
          });
          return;
        }
      }
    }
    await context.source.event({
      id: `discord-message-${raw.id}`,
      type: config.inbox.type,
      subject: threadSubject,
      summary: "本人在任务 Thread 补充消息",
      detail: content,
      link: `https://discord.com/channels/${config.guildId}/${raw.channel_id}/${raw.id}`,
    });
    return;
  }
  const subject = `discord:${raw.id}`;
  if (context.threads) {
    await context.threads.ensureFromMessage(context.api, raw.channel_id, raw.id, subject, content);
  }
  await context.source.event({
    id: `discord-message-${raw.id}`,
    type: config.inbox.type,
    subject,
    summary: "本人从 Discord 提交自然语言任务",
    detail: content,
    link: `https://discord.com/channels/${config.guildId}/${raw.channel_id}/${raw.id}`,
  });
}
