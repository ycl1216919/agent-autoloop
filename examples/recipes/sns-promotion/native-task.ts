import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeError, packetDigest, readRequest, readResponse } from "./native-contract.ts";

const [mode, root, kind, subject, ...extra] = process.argv.slice(2);
if (!root || extra.length)
  throw new NativeError("用法：native-task.ts prepare <目录> <creative|verification> <事项>，或poll <目录>");
const receipt = (summary: string, value: object = {}) =>
  `${summary}\n\n\`\`\`agent-autoloop\n${JSON.stringify(value)}\n\`\`\``;
switch (mode) {
  case "prepare": {
    if ((kind !== "creative" && kind !== "verification") || !subject || !/^[a-zA-Z0-9#._:/@-]{1,100}$/.test(subject))
      throw new NativeError("原生任务类型或事项无效");
    const files = readdirSync(join(root, "packet"), { withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => file.name)
      .sort();
    if (!files.length) throw new NativeError("先准备原生任务的资料文件");
    const digest = packetDigest(root, files);
    const id = createHash("sha256")
      .update(JSON.stringify([kind, subject, digest]))
      .digest("hex")
      .slice(0, 32);
    if (existsSync(join(root, "response.json"))) {
      const previous: unknown = JSON.parse(readFileSync(join(root, "response.json"), "utf8"));
      if (typeof previous === "object" && previous !== null && "id" in previous && previous.id !== id)
        renameSync(join(root, "response.json"), join(root, `response-before-${id}.json`));
    }
    writeFileSync(
      join(root, "request.json.tmp"),
      JSON.stringify({ version: 1, id, digest, kind, subject, files }, null, 2),
    );
    renameSync(join(root, "request.json.tmp"), join(root, "request.json"));
    console.log(JSON.stringify({ id, digest, kind, subject }));
    break;
  }
  case "poll": {
    if (kind || subject) throw new NativeError("poll只接受资料目录");
    if (!existsSync(join(root, "request.json"))) {
      console.log("没事可做：尚无Gemini原生完成回执。");
      break;
    }
    try {
      const request = readRequest(root);
      if (existsSync(join(root, "dispatch-error.json"))) {
        const failure: unknown = JSON.parse(readFileSync(join(root, "dispatch-error.json"), "utf8"));
        if (typeof failure === "object" && failure !== null && "id" in failure && failure.id === request.id)
          throw new NativeError("Gemini原生派发失败；保留资料，核对原生入口后继续，不自动重复派发");
      }
      if (!existsSync(join(root, "response.json"))) {
        console.log("没事可做：尚无Gemini原生完成回执。");
        break;
      }
      const consumedFile = join(root, "consumed.json");
      if (existsSync(consumedFile)) {
        try {
          const prev: unknown = JSON.parse(readFileSync(consumedFile, "utf8"));
          if (
            typeof prev === "object" &&
            prev !== null &&
            "id" in prev &&
            "digest" in prev &&
            prev.id === request.id &&
            prev.digest === request.digest
          ) {
            console.log("没事可做：当前Gemini原生回执已处理过。");
            break;
          }
        } catch {
          // Corrupted consumed marker falls back to normal verification.
        }
      }
      const response = readResponse(root, request);
      writeFileSync(join(root, "creative.md"), response.markdown + "\n");
      writeFileSync(
        `${consumedFile}.tmp`,
        JSON.stringify({ id: request.id, digest: request.digest, consumedAt: new Date().toISOString() }, null, 2) +
          "\n",
      );
      renameSync(`${consumedFile}.tmp`, consumedFile);
      switch (request.kind) {
        case "verification":
          console.log(receipt(`Gemini原生连接验收通过：${response.model}`));
          break;
        case "creative":
          console.log(
            receipt(`Gemini素材与创意已完成：${response.model}`, {
              events: [
                {
                  id: `sns-native:${request.id}`,
                  type: "sns.creative.ready",
                  subject: request.subject,
                  summary: "Gemini原生素材分析与创意已完成",
                  detail: JSON.stringify({ id: request.id, digest: request.digest, model: response.model }),
                },
              ],
            }),
          );
          break;
        default: {
          const unreachable: never = request.kind;
          throw new NativeError(String(unreachable));
        }
      }
    } catch (error) {
      if (!(error instanceof NativeError) && !(error instanceof SyntaxError)) throw error;
      console.log(
        receipt("待你处理：Gemini原生回执需要核对", {
          ask: [
            {
              key: "sns-native-receipt",
              title: "SNS原生回执未通过核对",
              text: error.message,
              options: ["已处理，继续", "本次停止"],
              about: "只核对当前SNS资料和Gemini回执，不重做已完成内容。",
            },
          ],
        }),
      );
    }
    break;
  }
  default:
    throw new NativeError("原生任务只支持prepare或poll");
}
