import type { Card } from "../../host/channels.ts";
import { createHmac } from "node:crypto";
import { cardGuidance, type DiscordConfig } from "./config.ts";

export function controlId(
  config: DiscordConfig,
  control: { readonly card: number; readonly action: string; readonly ref: string },
) {
  const signature = createHmac("sha256", config.ownerKey)
    .update(JSON.stringify([config.applicationId, config.guildId, control.card, control.action, control.ref]))
    .digest("hex")
    .slice(0, 24);
  return `autoloop-control:${control.card}:${control.action}:${signature}`;
}

export function cardMessage(card: Card, config?: DiscordConfig) {
  const guidance = config ? cardGuidance(config)[card.id] : undefined;
  const choices = card.options
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => !guidance?.answerChoices || guidance.answerChoices.includes(index));
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  const outcome =
    card.state === "decided"
      ? `决定已记录：${chosen ?? ""}；等待执行`
      : card.state === "done"
        ? `已执行：${card.result ?? ""}`
        : card.state === "closed"
          ? `已结案：${card.result ?? ""}`
          : "";
  const runTag =
    typeof (card as { run?: number | null }).run === "number"
      ? `（轮次 #${(card as { run?: number | null }).run}）`
      : "";
  return {
    content: [
      `卡片 #${card.id}${runTag} · ${guidance?.title ?? card.title}`,
      card.rule ? `规则：${card.rule}` : "",
      guidance?.task ? `任务：${guidance.task}` : card.text,
      guidance?.cause ? `卡住原因：${guidance.cause}` : "",
      guidance?.next ? `需要你做：${guidance.next}` : "",
      guidance?.held && card.state === "open" ? "状态：已保留，等待你处理（尚未提交继续执行的回答）。" : "",
      outcome,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 1900),
    allowed_mentions: { parse: [] },
    components:
      card.state === "open" && card.kind === "ask"
        ? [
            ...(choices.length
              ? [
                  {
                    type: 1,
                    components: choices.map(({ label, index }) => ({
                      type: 2,
                      style: index === card.recommend ? 1 : 2,
                      custom_id: `autoloop:${card.id}:${index}`,
                      label: label.slice(0, 80),
                    })),
                  },
                ]
              : []),
            ...(config && card.ref
              ? [
                  {
                    type: 1,
                    components: [
                      ["hold", "保留"],
                      ["resolve", "已解决"],
                      ["cancel", "取消"],
                    ].map(([action, label]) => ({
                      type: 2,
                      style: action === "cancel" ? 4 : 2,
                      custom_id: controlId(config, { card: card.id, action, ref: card.ref ?? "" }),
                      label,
                    })),
                  },
                ]
              : []),
          ]
        : [],
  };
}
