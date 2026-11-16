import { pathToFileURL } from "node:url";
import { ClientError } from "./errors.ts";

export async function ownerMcp(home: string) {
  if (process.env.AGENT_AUTOLOOP_RUN || process.env.AGENT_AUTOLOOP_CONTEXT)
    throw new ClientError("后台任务不能使用本人管理入口；请通过任务回执交接");
  process.env.AGENT_AUTOLOOP_HOME = home;
  const { mcp } = await import("../../../cli/mcp.ts");
  await mcp();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.argv[2];
  if (!home) throw new ClientError("需要本人管理入口的配置目录");
  ownerMcp(home).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
