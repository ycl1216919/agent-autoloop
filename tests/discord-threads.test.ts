// Failure modes: tasks submitted in Discord do not open a Thread, typing directly in a task Thread creates a brand-new
// task or fails to answer the open card, cards land in the main channel instead of the task Thread, or claimed/finished
// run updates omit which Agent claimed the job, its resume mode, or its per-round memo.
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";
import { discordConfig } from "../plugins/discord/config.ts";
import { handleMessage } from "../plugins/discord/message.ts";
import { handleInteraction } from "../plugins/discord/interaction.ts";
import { TaskThreads, syncRunUpdates } from "../plugins/discord/threads.ts";

const home = setup("discord-threads");
const file = join(home, "rules.json");
writeFileSync(
  file,
  JSON.stringify({
    sources: { discord: { name: "Discord" } },
    agents: {
      control: {
        name: "Codex 总控",
        worker: "pc",
        use: "command",
        command: [process.execPath, "-e", "process.exit(0)"],
        access: "read",
      },
    },
    channels: { discord: { name: "Discord", answerers: ["42"] } },
    rules: [
      {
        name: "总控",
        when: { source: "discord", types: ["control.request"] },
        to: "control",
        cwd: home,
        prompt: "Use only trusted routes.",
        parallel: 2,
        resume: true,
      },
    ],
  }),
);
process.env.AGENT_AUTOLOOP_RULES = file;
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sourceKey = hub.addKey("source", "discord");
const channelKey = hub.addKey("channel", "discord");
const ownerKey = hub.addKey("owner", "owner");
const config = discordConfig({
  applicationId: "11",
  guildId: "22",
  channelId: "33",
  users: ["42"],
  tokenFile: "unused",
  hubUrl: url,
  sourceKey,
  ownerKey,
  routes: { old: { type: "old.task", subject: "old" } },
  inbox: { type: "control.request" },
});

test("main channel message opens a task Thread, broadcasts claimed & done+memo, and accepts direct replies in Thread", async () => {
  const threadsFile = join(home, "discord-threads.json");
  const threads = new TaskThreads(threadsFile);
  const calls: { method: string; path: string; body?: any }[] = [];
  const api = {
    request: async (method: string, path: string, body?: object) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/channels/33/messages/500/threads") {
        return { id: "9001" };
      }
      return { id: "9999" };
    },
  };
  const owner = hubClient(url, ownerKey);
  const source = hubClient(url, sourceKey);
  const channel = hubClient(url, channelKey);
  const ctx = { config, source, channel, owner, api, threads };

  // 1. User sends a new task in main channel 33 -> opens thread 9001 for subject discord:500
  await handleMessage(ctx, {
    id: "500",
    type: 0,
    guild_id: "22",
    channel_id: "33",
    author: { id: "42", bot: false },
    content: "排查登录接口超时问题",
  });
  assert.equal(threads.threadOf("discord:500"), "9001");
  assert.equal(threads.subjectOf("9001"), "discord:500");

  // Reloading from disk preserves mapping
  const reloaded = new TaskThreads(threadsFile);
  assert.equal(reloaded.threadOf("discord:500"), "9001");

  // 2. Round 1 claimed -> syncRunUpdates broadcasts claimed info into thread 9001
  const seen = new Map<number, string>();
  const job1 = hub.claimNext("pc", "c1");
  assert.ok(job1);
  await syncRunUpdates(await owner.state(), seen, threads, api);
  const claimedPost = calls.find(
    (c) => c.method === "POST" && c.path === "/channels/9001/messages" && String(c.body?.content).includes("开始"),
  );
  assert.ok(claimedPost);
  assert.match(claimedPost.body.content, /Codex 总控/);
  assert.match(claimedPost.body.content, /后续可续接/);
  assert.match(claimedPost.body.content, /新会话/);

  // 3. Round 1 finishes with summary, memo, and an ask card -> broadcasts finish + memo to thread 9001
  hub.finish(job1.run, job1.token, {
    outcome: "done",
    summary: "定位到连接池耗尽，需确认是否重启",
    memo: "已在 logs/auth.log 找到超时点；未改动数据库配置。",
    session: "S-500",
    ask: [{ title: "是否重启服务", text: "预计中断 5 秒", options: ["立即重启", "稍后再说"] }],
  });
  await syncRunUpdates(await owner.state(), seen, threads, api);
  const donePosts = calls.filter(
    (c) => c.method === "POST" && c.path === "/channels/9001/messages" && String(c.body?.content).includes("完成"),
  );
  assert.equal(donePosts.length, 1);
  assert.match(donePosts[0].body.content, /定位到连接池耗尽/);
  assert.match(donePosts[0].body.content, /已在 logs\/auth\.log 找到超时点/);

  // Repeated sync does not duplicate
  await syncRunUpdates(await owner.state(), seen, threads, api);
  assert.equal(
    calls.filter(
      (c) => c.method === "POST" && c.path === "/channels/9001/messages" && String(c.body?.content).includes("完成"),
    ).length,
    1,
  );

  // 4. Card is delivered into thread 9001; user types directly in thread 9001 without Reply/@ -> answers the card!
  const card = hub.nextCard("discord");
  assert.ok(card);
  hub.delivered("discord", card.id, card.version, "9001/7777");
  threads.recordCard(card.id, "9001/7777");
  await handleMessage(ctx, {
    id: "501",
    type: 0,
    guild_id: "22",
    channel_id: "9001",
    author: { id: "42", bot: false },
    content: "立即重启，顺便把连接池调大到 50",
  });
  const job2 = hub.claimNext("pc", "c2");
  assert.ok(job2);
  assert.equal(job2.context.answers[0]?.card, card.id);
  assert.equal(job2.context.answers[0]?.chosen, "立即重启，顺便把连接池调大到 50");
  assert.equal(job2.context.memos?.[0]?.memo, "已在 logs/auth.log 找到超时点；未改动数据库配置。");

  // Round 2 claimed -> broadcasts resumed session info into thread 9001
  await syncRunUpdates(await owner.state(), seen, threads, api);
  const claimed2 = calls.find(
    (c) =>
      c.method === "POST" &&
      c.path === "/channels/9001/messages" &&
      String(c.body?.content).includes(`#${job2.run}`) &&
      String(c.body?.content).includes("续接上次会话"),
  );
  assert.ok(claimed2);
  hub.finish(job2.run, job2.token, { outcome: "done", summary: "已重启并调大连接池" });

  // 5. No open card now; user types directly in thread 9001 -> continues same subject discord:500
  await handleMessage(ctx, {
    id: "502",
    type: 0,
    guild_id: "22",
    channel_id: "9001",
    author: { id: "42", bot: false },
    content: "再帮我顺手看一下缓存命中率",
  });
  const job3 = hub.claimNext("pc", "c3");
  assert.ok(job3);
  assert.equal(job3.context.events[0]?.subject, "discord:500");
  assert.equal(job3.context.events[0]?.detail, "再帮我顺手看一下缓存命中率");
  hub.finish(job3.run, job3.token, { outcome: "nothing", summary: "缓存正常" });

  // 6. Button click inside thread 9001 is authorized
  const clickResponses: unknown[] = [];
  await handleInteraction(
    {
      ...ctx,
      api: {
        request: async (_m, _p, body) => {
          clickResponses.push(body);
          return {};
        },
      },
    },
    {
      id: "800",
      application_id: "11",
      token: "tok",
      type: 3,
      guild_id: "22",
      channel_id: "9001",
      member: { user: { id: "42" } },
      data: { custom_id: `autoloop:${card.id}:0` },
      message: { id: "7777", author: { id: "11" } },
    },
  );
  assert.ok(!clickResponses.some((r: any) => String(r?.data?.content ?? "").includes("没有 AutoLoop 操作权限")));
});
