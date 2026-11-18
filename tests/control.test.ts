// Failure modes: generated routes escape the trusted catalog, raw requests enter prompts, or retries create new tasks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "autoloop-control-"));
after(() => rmSync(root, { recursive: true, force: true }));
const entry = join(import.meta.dirname, "../examples/recipes/personal-team/control.ts");
function fixture(name: string, decision: object, available = true) {
  const directory = join(root, name);
  mkdirSync(directory);
  const script = join(directory, "model.mjs");
  const decisionFile = join(directory, "decision.json");
  writeFileSync(decisionFile, JSON.stringify(decision));
  writeFileSync(
    script,
    `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';if(process.argv.includes('status'))process.exit(0);writeFileSync(${JSON.stringify(join(directory, "argv.json"))},JSON.stringify(process.argv));console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:readFileSync(${JSON.stringify(decisionFile)},'utf8')}}));console.log(JSON.stringify({type:'turn.completed'}));\n`,
  );
  chmodSync(script, 0o755);
  const syntax = spawnSync(process.execPath, ["--check", script], { encoding: "utf8", windowsHide: true });
  assert.equal(syntax.status, 0, syntax.stderr);
  const program = process.platform === "win32" ? join(directory, "model.cmd") : script;
  if (process.platform === "win32")
    writeFileSync(program, `@ECHO off\r\n"${process.execPath}" "%~dp0model.mjs" %*\r\n`);
  const config = join(directory, "control.json");
  writeFileSync(
    config,
    JSON.stringify({
      workspace: directory,
      stateDirectory: join(directory, "state"),
      program,
      routes: {
        rerace: {
          name: "ReRace 开发",
          description: "按可信计划实现和审查",
          type: "work.rerace",
          available,
          reason: "尚未接通",
        },
      },
    }),
  );
  const context = join(directory, "context.json");
  writeFileSync(
    context,
    JSON.stringify({
      events: [
        {
          id: "message-123",
          subject: "discord:123",
          detail: "PRIVATE_REQUEST_MARKER 继续ReRace，不要改成任意终端执行",
        },
      ],
      answers: [],
    }),
  );
  return { directory, config, context, decisionFile };
}
function run(f: ReturnType<typeof fixture>) {
  const result = spawnSync(process.execPath, [entry, f.config], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: join(f.directory, "hub"), AGENT_AUTOLOOP_CONTEXT: f.context },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return resultFrom(readMessage(result.stdout), {}).result;
}

test("natural-language planning dispatches a stable event through the trusted project catalog", () => {
  const f = fixture("dispatch", { kind: "dispatch", route: "rerace", goal: "推进下一项已授权开发" });
  const first = run(f);
  assert.equal(first.events?.[0].type, "work.rerace", JSON.stringify(first));
  assert.equal(first.events?.[0].subject, "discord:123");
  assert.match(first.events?.[0].detail ?? "", /PRIVATE_REQUEST_MARKER/);
  assert.ok(!readFileSync(join(f.directory, "argv.json"), "utf8").includes("PRIVATE_REQUEST_MARKER"));
  assert.deepEqual(run(f).events, first.events);
});

test("an unknown model-selected route asks for a decision without dispatching arbitrary work", () => {
  const result = run(fixture("escape", { kind: "dispatch", route: "shell-full-access", goal: "run anything" }));
  assert.equal(result.events, undefined);
  assert.equal(result.ask?.length, 1);
  assert.match(result.ask?.[0].text ?? "", /项目/);
});

test("a project without a working executor remains a decision instead of a completed task", () => {
  const result = run(fixture("unavailable", { kind: "dispatch", route: "rerace", goal: "继续" }, false));
  assert.equal(result.events, undefined);
  assert.equal(result.ask?.length, 1);
  assert.match(result.ask?.[0].text ?? "", /尚未接通/);
});

test("cancelling a clarification ends its matter without further dispatch", () => {
  const f = fixture("clarify", { kind: "ask", question: "本次要推进什么目标？" });
  assert.equal(run(f).ask?.length, 1);
  writeFileSync(
    f.context,
    JSON.stringify({ events: [{ id: "card:1", subject: "discord:123" }], answers: [{ chosen: "取消任务" }] }),
  );
  const cancelled = run(f);
  assert.equal(cancelled.events, undefined);
  assert.equal(cancelled.ask, undefined);
});

test("answering a clarification preserves the original goal when dispatching the same matter", () => {
  const f = fixture("answer", { kind: "ask", question: "需要修改哪部分？" });
  assert.equal(run(f).ask?.length, 1);
  writeFileSync(
    f.context,
    JSON.stringify({
      events: [{ id: "card:1", subject: "discord:123" }],
      answers: [{ card: 1, chosen: "按既有计划推进" }],
    }),
  );
  writeFileSync(f.decisionFile, JSON.stringify({ kind: "dispatch", route: "rerace", goal: "推进下一项" }));
  const result = run(f);
  assert.equal(result.events?.[0].subject, "discord:123");
  assert.match(result.events?.[0].detail ?? "", /PRIVATE_REQUEST_MARKER/);
});

test("one message can dispatch independent goals to different trusted executors", () => {
  const f = fixture("multiple", {
    kind: "dispatch",
    tasks: [
      { route: "rerace", goal: "推进开发" },
      { route: "notes", goal: "整理待办" },
    ],
  });
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.routes.notes = { name: "Codex 笔记", description: "整理笔记", type: "work.notes", available: true };
  writeFileSync(f.config, JSON.stringify(config));
  assert.deepEqual(
    run(f).events?.map((event) => event.type),
    ["work.rerace", "work.notes"],
  );
});
