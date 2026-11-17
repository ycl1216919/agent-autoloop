export type BlockerContext = {
  readonly goal: string;
  readonly phase: string;
  readonly completed: readonly string[];
  readonly reason: string;
  readonly impact: string;
  readonly action: string;
  readonly resume: string;
  readonly evidence: readonly string[];
};

export const reviewStageLabels = {
  implement: "实现",
  check: "项目检查",
  review: "代码审查",
  done: "验收完成",
  nothing: "无需执行",
  cancelled: "已停止",
} as const;

export function blockerText(context: BlockerContext): string {
  const short = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit)}…` : value);
  return [
    `任务目标：${short(context.goal, 180)}`,
    `当前阶段：${short(context.phase, 40)}`,
    `需要你做什么：${short(context.action, 220)}`,
    `已完成并保留：${
      context.completed.length
        ? context.completed
            .slice(0, 3)
            .map((item) => short(item, 80))
            .join("；")
        : "尚无可确认的完成记录"
    }`,
    `当前阻塞：${short(context.reason, 400)}`,
    `影响：${short(context.impact, 140)}`,
    `选择继续后：${short(context.resume, 160)}`,
    ...(context.evidence.length
      ? [
          `证据：\n${context.evidence
            .slice(0, 2)
            .map((item) => short(item, 140))
            .join("\n")}`,
        ]
      : []),
  ].join("\n\n");
}
