import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

type Asset = {
  readonly root: string;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
};

class InventoryError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "InventoryError";
  }
}

const extensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".gif",
  ".svg",
  ".mp4",
  ".mov",
  ".m4v",
  ".mp3",
  ".wav",
]);
const [configFile, outputFile, ...extra] = process.argv.slice(2);
if (!configFile || !outputFile || extra.length) {
  throw new InventoryError("用法：node index-assets.ts <素材目录配置.json> <盘点结果.json>");
}
const config: unknown = JSON.parse(readFileSync(configFile, "utf8"));
if (
  typeof config !== "object" ||
  config === null ||
  !("roots" in config) ||
  !Array.isArray(config.roots) ||
  !config.roots.length
) {
  throw new InventoryError("配置必须包含非空的 roots 数组，只填写本次允许读取的素材目录");
}
const roots: string[] = [];
for (const root of config.roots) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new InventoryError("每个素材目录必须是当前接单电脑上的绝对路径");
  }
  const directory = resolve(root);
  if (!lstatSync(directory).isDirectory()) {
    throw new InventoryError(`素材来源不是普通目录：${directory}`);
  }
  if (!roots.includes(directory)) roots.push(directory);
}
const assets: Asset[] = [];
function walk(root: string, directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(root, file);
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      const metadata = statSync(file);
      assets.push({
        root,
        path: relative(root, file).split("\\").join("/"),
        bytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      });
    }
  }
}
for (const root of roots.sort()) walk(root, root);
const id = createHash("sha256").update(JSON.stringify({ roots, assets })).digest("hex");
writeFileSync(
  outputFile,
  JSON.stringify({ id, collectedAt: new Date().toISOString(), coverage: "metadata-only", roots, assets }, null, 2) +
    "\n",
  { mode: 0o600 },
);
process.stdout.write(
  `素材目录盘点完成；只核对了文件元数据，尚未检查内容或发布历史。\n\n\`\`\`agent-autoloop\n${JSON.stringify({
    events: [{ id: `assets:${id}`, type: "sns.assets.ready", subject: "assets", summary: "素材目录元数据已更新" }],
  })}\n\`\`\`\n`,
);
