import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { object } from "../code-review-loop/config.ts";
import { ClientError } from "./errors.ts";

type Route = {
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly available: boolean;
  readonly reason?: string;
};
type Control = {
  readonly workspace: string;
  readonly stateDirectory: string;
  readonly program?: string;
  readonly routes: Readonly<Record<string, Route>>;
};
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function readControl(file: string): Control {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !object(raw) ||
    !text(raw.workspace) ||
    !isAbsolute(raw.workspace) ||
    !text(raw.stateDirectory) ||
    !isAbsolute(raw.stateDirectory) ||
    !object(raw.routes)
  )
    throw new ClientError("总控配置需要可信的绝对目录和项目清单");
  if (raw.program !== undefined && (!text(raw.program) || !isAbsolute(raw.program)))
    throw new ClientError("总控程序需要绝对路径");
  const routes: Record<string, Route> = {};
  for (const [name, route] of Object.entries(raw.routes)) {
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
      !object(route) ||
      !text(route.name) ||
      !text(route.description) ||
      !text(route.type) ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(route.type) ||
      typeof route.available !== "boolean"
    )
      throw new ClientError("项目清单需要固定名称、事件类型、说明和可用状态");
    routes[name] = {
      name: route.name,
      description: route.description,
      type: route.type,
      available: route.available,
      ...(text(route.reason) ? { reason: route.reason } : {}),
    };
  }
  if (!Object.keys(routes).length) throw new ClientError("总控至少需要一个项目入口");
  return {
    workspace: raw.workspace,
    stateDirectory: raw.stateDirectory,
    routes,
    ...(text(raw.program) ? { program: raw.program } : {}),
  };
}
