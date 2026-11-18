import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export class NativeError extends Error {}
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export type NativeRequest = {
  readonly version: 1;
  readonly id: string;
  readonly digest: string;
  readonly kind: "creative" | "verification";
  readonly subject: string;
  readonly files: readonly string[];
};
export function packetDigest(root: string, files: readonly string[]): string {
  const prefix = realpathSync(root) + sep;
  const hashes = files.map((file) => {
    if (!file || /[\\/]/.test(file) || file === "." || file === "..")
      throw new NativeError("原生资料只能使用packet目录中的普通文件");
    const path = join(root, "packet", file);
    if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(prefix))
      throw new NativeError("原生资料不能越出本事项目录或使用符号链接");
    return [file, createHash("sha256").update(readFileSync(path)).digest("hex")];
  });
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}
export function readRequest(root: string): NativeRequest {
  const value: unknown = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.id) ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    !text(value.digest) ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    (value.kind !== "creative" && value.kind !== "verification") ||
    !text(value.subject) ||
    !/^[a-zA-Z0-9#._:/@-]{1,100}$/.test(value.subject) ||
    !Array.isArray(value.files) ||
    !value.files.length
  )
    throw new NativeError("原生SNS请求格式不完整");
  const files = value.files.map((file: unknown) => {
    if (!text(file)) throw new NativeError("原生资料文件名无效");
    return file;
  });
  if (packetDigest(root, files) !== value.digest) throw new NativeError("原生资料已变化，需要重新准备对应版本");
  return { version: 1, id: value.id, digest: value.digest, kind: value.kind, subject: value.subject, files };
}
export function readResponse(
  root: string,
  request: NativeRequest,
): { readonly model: string; readonly markdown: string } {
  const value: unknown = JSON.parse(readFileSync(join(root, "response.json"), "utf8"));
  if (
    !object(value) ||
    value.version !== 1 ||
    value.id !== request.id ||
    value.digest !== request.digest ||
    value.reviewer !== "gemini" ||
    !text(value.model) ||
    !/^gemini(?:$|\s|[-_\d])/i.test(value.model) ||
    value.status !== "done" ||
    !text(value.markdown)
  )
    throw new NativeError("Gemini原生回执未完成、身份不符或不是当前版本");
  return { model: value.model, markdown: value.markdown };
}
