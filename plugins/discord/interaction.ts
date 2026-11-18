import type { Hub } from "../../protocol/client.ts";
import type { Card } from "../../host/channels.ts";
import { DiscordError, cardGuidance, holdCard, object, type DiscordConfig } from "./config.ts";
import { cardMessage, controlId } from "./card.ts";

export type DiscordApi = { request(method: string, path: string, body?: object): Promise<unknown> };
export type InteractionContext = {
  readonly config: DiscordConfig;
  readonly api: DiscordApi;
  readonly owner: Pick<Hub, "state" | "cancel" | "why" | "resolve">;
  readonly source: Pick<Hub, "event">;
  readonly channel: Pick<Hub, "answer">;
};

const clipped = (text: string) => text.slice(0, 1900);
export async function handleInteraction(context: InteractionContext, raw: unknown) {
  if (
    !object(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.token !== "string" ||
    raw.application_id !== context.config.applicationId
  )
    return;
  const member = object(raw.member) && object(raw.member.user) ? raw.member.user : undefined;
  const actor = member?.id;
  const callback = `/interactions/${raw.id}/${raw.token}/callback`;
  if (
    typeof actor !== "string" ||
    !context.config.users.includes(actor) ||
    raw.guild_id !== context.config.guildId ||
    typeof raw.channel_id !== "string" ||
    !context.config.channels.includes(raw.channel_id)
  ) {
    await context.api.request("POST", callback, {
      type: 4,
      data: { content: "这个用户或频道没有 AutoLoop 操作权限。", flags: 64, allowed_mentions: { parse: [] } },
    });
    return;
  }
  await context.api.request("POST", callback, { type: 5, data: { flags: 64 } });
  const respond = (content: string) =>
    context.api.request("PATCH", `/webhooks/${context.config.applicationId}/${raw.token}/messages/@original`, {
      content: clipped(content),
      allowed_mentions: { parse: [] },
    });
  try {
    if (!object(raw.data)) throw new DiscordError(400, "没有收到可识别的操作");
    switch (raw.type) {
      case 2: {
        if (raw.data.name !== "autoloop" || !Array.isArray(raw.data.options))
          throw new DiscordError(400, "没有这个 AutoLoop 命令");
        const command = raw.data.options[0];
        if (!object(command)) throw new DiscordError(400, "缺少子命令");
        const values: Record<string, unknown> = {};
        if (Array.isArray(command.options))
          for (const option of command.options)
            if (object(option) && typeof option.name === "string") values[option.name] = option.value;
        switch (command.name) {
          case "status": {
            const state = await context.owner.state();
            const totals = state.totals;
            const recent = state.runs
              .slice(0, 5)
              .map(
                (run: { id: number; state: string; summary?: string }) =>
                  `#${run.id} ${run.state} ${run.summary ?? ""}`,
              );
            await respond(
              [
                `AutoLoop：在跑 ${totals.running}；排队 ${totals.queued - totals.retrying}；等重派 ${totals.retrying}；待确认 ${totals.unknown}；待决定 ${totals.attention}`,
                ...recent,
              ].join("\n"),
            );
            return;
          }
          case "task": {
            const route =
              typeof values.route === "string" && Object.hasOwn(context.config.routes, values.route)
                ? context.config.routes[values.route]
                : undefined;
            if (!route || typeof values.text !== "string" || !values.text.trim())
              throw new DiscordError(400, "请选择已配置的任务入口并填写内容");
            const result = await context.source.event({
              id: `discord-${raw.id}`,
              type: route.type,
              subject: route.subject,
              detail: values.text,
              summary: "本人从 Discord 提交任务",
            });
            await respond(
              result.routed?.length
                ? `已交给任务中心，事件 #${result.event}。`
                : `事件 #${result.event} 已记录，但没有匹配规则；尚未执行。`,
            );
            return;
          }
          case "stop":
          case "why": {
            if (typeof values.run !== "number" || !Number.isSafeInteger(values.run) || values.run < 1)
              throw new DiscordError(400, "需要有效的轮次编号");
            const result =
              command.name === "stop" ? await context.owner.cancel(values.run) : await context.owner.why(values.run);
            await respond(
              command.name === "stop"
                ? `已记录停止请求 #${values.run}，执行程序退出后才算停止。`
                : JSON.stringify(result),
            );
            return;
          }
          default:
            throw new DiscordError(400, "没有这个 AutoLoop 子命令");
        }
      }
      case 3: {
        if (
          !object(raw.message) ||
          typeof raw.message.id !== "string" ||
          !object(raw.message.author) ||
          raw.message.author.id !== context.config.applicationId
        )
          throw new DiscordError(400, "这不是有效的 AutoLoop 原始卡片");
        const ref = `${raw.channel_id}/${raw.message.id}`;
        const customId = String(raw.data.custom_id ?? "");
        const control = /^autoloop-control:([1-9]\d*):(hold|resolve|cancel):[a-f0-9]{24}$/.exec(customId);
        if (control) {
          const cardId = Number(control[1]);
          const action = control[2];
          if (!Number.isSafeInteger(cardId) || customId !== controlId(context.config, { card: cardId, action, ref }))
            throw new DiscordError(403, "操作与原始卡片消息不匹配");
          const state = await context.owner.state();
          const card: Card | undefined = state.cards.find((item: Card) => item.id === cardId && item.state === "open");
          if (!card) {
            await respond("这张卡片已经处理，无需重复操作。");
            return;
          }
          switch (action) {
            case "hold":
              holdCard(context.config, cardId);
              if (context.config.cardGuidanceFile)
                await context.api.request(
                  "PATCH",
                  `/channels/${raw.channel_id}/messages/${raw.message.id}`,
                  cardMessage({ ...card, ref }, context.config),
                );
              await respond("已保留，卡片继续待处理；没有提交回答，也没有启动新的任务。");
              return;
            case "resolve":
            case "cancel": {
              const result = await context.owner.resolve(
                cardId,
                action === "cancel" ? `本人从 Discord 取消（${actor}）` : `本人从 Discord 标记已解决（${actor}）`,
              );
              await respond(
                result.changed
                  ? action === "cancel"
                    ? "已取消这张待处理卡片；没有启动新的任务。"
                    : "已标记解决并结案；没有启动新的任务。"
                  : "这张卡片已经处理，无需重复操作。",
              );
              return;
            }
            default:
              throw new DiscordError(400, "没有这个卡片操作");
          }
        }
        const match = /^autoloop:([1-9]\d*):([0-4])$/.exec(customId);
        if (!match) throw new DiscordError(400, "这不是有效的 AutoLoop 卡片操作");
        const allowed = cardGuidance(context.config)[Number(match[1])]?.answerChoices;
        if (allowed && !allowed.includes(Number(match[2])))
          throw new DiscordError(400, "这个旧选项已经停用，请使用卡片下方的保留、已解决或取消按钮");
        const result = await context.channel.answer(Number(match[1]), {
          choice: Number(match[2]),
          by: actor,
          ref,
        });
        await respond(
          result.changed ? "决定已记录，任务会继续；尚不表示执行完成。" : "这张卡片已经处理，无需重复回答。",
        );
        return;
      }
      default:
        throw new DiscordError(400, "暂不支持这类 Discord 操作");
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await respond(`未执行：${error.message}`);
  }
}
