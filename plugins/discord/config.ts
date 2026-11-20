export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export class DiscordError extends Error {
  readonly status: number;
  constructor(status: number, reason = `Discord 请求未完成（${status}）`) {
    super(reason);
    this.status = status;
  }
}
const id = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export type DiscordConfig = {
  readonly applicationId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly users: readonly string[];
  readonly tokenFile: string;
  readonly tokenVariable: string;
  readonly hubUrl: string;
  readonly sourceKey: string;
  readonly ownerKey: string;
  readonly routes: Readonly<Record<string, { readonly type: string; readonly subject: string }>>;
  readonly inbox?: { readonly type: string };
  readonly cardGuidanceFile?: string;
  readonly threadsFile?: string;
};
export function discordConfig(raw: Record<string, unknown>): DiscordConfig {
  if (raw.cardGuidanceFile !== undefined && !text(raw.cardGuidanceFile))
    throw new DiscordError(400, "Discord cardGuidanceFile 需要是本机文件路径");
  if (raw.threadsFile !== undefined && !text(raw.threadsFile))
    throw new DiscordError(400, "Discord threadsFile 需要是本机文件路径");
  if (
    raw.inbox !== undefined &&
    (!object(raw.inbox) || typeof raw.inbox.type !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(raw.inbox.type))
  )
    throw new DiscordError(400, "Discord inbox 需要固定事件类型");
  if (![raw.applicationId, raw.guildId, raw.channelId].every(id))
    throw new DiscordError(400, "Discord 需要 applicationId、guildId、channelId");
  if (!Array.isArray(raw.users) || !raw.users.length || !raw.users.every(id))
    throw new DiscordError(400, "Discord 必须指定允许操作的用户 ID");
  if (![raw.tokenFile, raw.hubUrl, raw.sourceKey, raw.ownerKey].every(text))
    throw new DiscordError(400, "Discord 缺少私有凭据文件或中台连接身份");
  if (!object(raw.routes) || !Object.keys(raw.routes).length || Object.keys(raw.routes).length > 25)
    throw new DiscordError(400, "Discord routes 需要是 1 至 25 项的对象");
  const routes: Record<string, { type: string; subject: string }> = {};
  for (const [name, route] of Object.entries(raw.routes)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !object(route) || !text(route.type) || !text(route.subject))
      throw new DiscordError(400, "Discord 任务入口需要固定名称、事件类型和事项");
    routes[name] = { type: route.type, subject: route.subject };
  }
  const channels = raw.channels ?? [raw.channelId];
  if (!Array.isArray(channels) || !channels.length || !channels.every(id))
    throw new DiscordError(400, "Discord channels 必须是允许交互的频道 ID");
  if (
    !id(raw.applicationId) ||
    !id(raw.guildId) ||
    !id(raw.channelId) ||
    !text(raw.tokenFile) ||
    !text(raw.hubUrl) ||
    !text(raw.sourceKey) ||
    !text(raw.ownerKey)
  )
    throw new DiscordError(400, "Discord 配置无效");
  return {
    applicationId: raw.applicationId,
    guildId: raw.guildId,
    channelId: raw.channelId,
    channels,
    users: raw.users,
    tokenFile: raw.tokenFile,
    tokenVariable: text(raw.tokenVariable) ? raw.tokenVariable : "DISCORD_BOT_TOKEN",
    hubUrl: raw.hubUrl,
    sourceKey: raw.sourceKey,
    ownerKey: raw.ownerKey,
    routes,
    ...(text(raw.cardGuidanceFile) ? { cardGuidanceFile: raw.cardGuidanceFile } : {}),
    ...(text(raw.threadsFile) ? { threadsFile: raw.threadsFile } : {}),
    ...(object(raw.inbox) && typeof raw.inbox.type === "string" ? { inbox: { type: raw.inbox.type } } : {}),
  };
}
import { readFileSync, writeFileSync } from "node:fs";

export type CardGuidance = {
  readonly title?: string;
  readonly task?: string;
  readonly cause?: string;
  readonly next?: string;
  readonly answerChoices?: readonly number[];
  readonly ref?: string;
  readonly held?: boolean;
};

export function cardGuidance(config: DiscordConfig): Readonly<Record<string, CardGuidance>> {
  if (!config.cardGuidanceFile) return {};
  const raw: unknown = JSON.parse(readFileSync(config.cardGuidanceFile, "utf8"));
  if (!object(raw)) throw new DiscordError(400, "卡片说明文件需要按卡片编号保存");
  const result: Record<string, CardGuidance> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(key) || !object(value)) throw new DiscordError(400, "卡片说明编号无效");
    if (
      value.answerChoices !== undefined &&
      (!Array.isArray(value.answerChoices) ||
        !value.answerChoices.every(
          (choice: unknown) => typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < 5,
        ))
    )
      throw new DiscordError(400, "卡片说明的回答编号无效");
    if (value.ref !== undefined && (typeof value.ref !== "string" || !/^\d+\/\d+$/.test(value.ref)))
      throw new DiscordError(400, "卡片说明的原消息地址无效");
    result[key] = {
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.task === "string" ? { task: value.task } : {}),
      ...(typeof value.cause === "string" ? { cause: value.cause } : {}),
      ...(typeof value.next === "string" ? { next: value.next } : {}),
      ...(Array.isArray(value.answerChoices) ? { answerChoices: value.answerChoices } : {}),
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
      ...(typeof value.held === "boolean" ? { held: value.held } : {}),
    };
  }
  return result;
}

export function holdCard(config: DiscordConfig, card: number) {
  if (!config.cardGuidanceFile) return;
  const raw: unknown = JSON.parse(readFileSync(config.cardGuidanceFile, "utf8"));
  if (!object(raw)) throw new DiscordError(400, "卡片说明文件需要按卡片编号保存");
  const previous = raw[String(card)];
  raw[String(card)] = { ...(object(previous) ? previous : {}), held: true };
  writeFileSync(config.cardGuidanceFile, JSON.stringify(raw, null, 2) + "\n");
}
