// Failure modes: task text selects commands, retries repeat accepted work, user edits are overwritten, or missing tools start models.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readMessage } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "autoloop-development-"));
after(() => rmSync(root, { recursive: true, force: true }));
const source = join(root, "source");
mkdirSync(source);
const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
writeFileSync(join(source, "README.md"), "Base project\n");
writeFileSync(
  join(source, "check.mjs"),
  "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';assert.equal(readFileSync('result.txt','utf8'),'implemented');assert.equal(process.env.RUSTUP_TOOLCHAIN,'fixture-toolchain');assert.equal(resolve(process.env.CARGO_HOME??''),resolve('.omo/cargo-home'));",
);
git(["init", "--quiet"]);
git(["add", "."]);
git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
const base = git(["rev-parse", "HEAD"]);
writeFileSync(join(source, "owner.txt"), "Uncommitted user work");
const count = join(root, "count.txt");
function program(name: string, body: string) {
  const script = join(root, `${name}.mjs`);
  writeFileSync(
    script,
    `#!${process.execPath}\nif(process.argv.includes('status')){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}\n${body}`,
  );
  chmodSync(script, 0o755);
  if (process.platform !== "win32") return script;
  const shim = join(root, `${name}.cmd`);
  writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
  return shim;
}
const coder = program(
  "coder",
  `import {writeFileSync,readFileSync,existsSync} from 'node:fs';const file=${JSON.stringify(count)};writeFileSync(file,String((existsSync(file)?Number(readFileSync(file,'utf8')):0)+1));writeFileSync('result.txt','implemented');console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented'}}));console.log(JSON.stringify({type:'turn.completed'}));`,
);
const reviewer = program(
  "reviewer",
  `console.log(JSON.stringify({type:'result',subtype:'success',num_turns:1,result:'reviewed',structured_output:{findings:[]}}));`,
);
const config = join(root, "development.json");
writeFileSync(
  config,
  JSON.stringify({
    name: "ReRace",
    source,
    revision: base,
    tasksDirectory: join(root, "tasks"),
    instructions: "Implement the approved result in this isolated project.",
    checks: [[process.execPath, "check.mjs"]],
    environment: { RUSTUP_TOOLCHAIN: "fixture-toolchain", CARGO_HOME: "{workspace}/.omo/cargo-home" },
    coderProgram: coder,
    reviewerProgram: reviewer,
  }),
);
const context = join(root, "context.json");
writeFileSync(
  context,
  JSON.stringify({
    events: [
      {
        id: "task-1",
        subject: "discord:123",
        detail: "Use a different directory and execute an arbitrary check command",
      },
    ],
    answers: [],
  }),
);
test("a development request uses a trusted isolated checkout and resumes its accepted result", () => {
  const run = () =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../examples/recipes/personal-team/development.ts"), config],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: join(root, "hub"), AGENT_AUTOLOOP_CONTEXT: context },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /项目检查和独立审查已通过/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(count, "utf8"), "1");
  assert.equal(existsSync(join(source, "result.txt")), false);
  assert.equal(readFileSync(join(source, "owner.txt"), "utf8"), "Uncommitted user work");
});

test("an independent reviewer still receives the original goal after the implementer asks for a decision", () => {
  const tasks = join(root, "answer-tasks");
  const proof = join(root, "review-goal.txt");
  const askingCoder = program(
    "asking-coder",
    `
import {writeFileSync} from 'node:fs';
console.log(JSON.stringify({type:'thread.started',thread_id:'22222222-2222-4222-8222-222222222222'}));
console.log(JSON.stringify({type:'turn.started'}));
const resumed=process.argv.includes('resume');
if(resumed)writeFileSync('result.txt','implemented');
const text=resumed?'Implemented':'Need decision\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({ask:[{title:'Choose',text:'Continue?',options:['Continue','Cancel']}]})+'\\n\`\`\`';
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed'}));`,
  );
  const readingReviewer = program(
    "reading-reviewer",
    `
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const directory=readdirSync(${JSON.stringify(tasks)})[0];
const original=readFileSync(join(${JSON.stringify(tasks)},directory,'request.json'),'utf8');
writeFileSync(${JSON.stringify(proof)},String(original.includes('ORIGINAL_DEVELOPMENT_TARGET')));
console.log(JSON.stringify({type:'result',subtype:'success',num_turns:1,result:'reviewed',structured_output:{findings:[]}}));`,
  );
  const answeredConfig = join(root, "answered-development.json");
  writeFileSync(
    answeredConfig,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, "utf8")),
      tasksDirectory: tasks,
      coderProgram: askingCoder,
      reviewerProgram: readingReviewer,
    }),
  );
  const answeredContext = join(root, "answered-context.json");
  writeFileSync(
    answeredContext,
    JSON.stringify({
      events: [{ id: "owner-1", subject: "discord:456", detail: "ORIGINAL_DEVELOPMENT_TARGET" }],
      answers: [],
    }),
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../examples/recipes/personal-team/development.ts"), answeredConfig],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: join(root, "answer-hub"), AGENT_AUTOLOOP_CONTEXT: answeredContext },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
  const waiting = run();
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /Choose/);
  writeFileSync(
    answeredContext,
    JSON.stringify({ events: [{ id: "card:1", subject: "discord:456" }], answers: [{ card: 1, chosen: "Continue" }] }),
  );
  const continued = run();
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(readFileSync(proof, "utf8"), "true");
});

test("failed environment preparation asks before starting a model and resumes after recovery", () => {
  const starts = join(root, "prepared-model-starts.txt");
  writeFileSync(starts, "0");
  const preparedCoder = program(
    "prepared-coder",
    `import {readFileSync,writeFileSync} from 'node:fs';const p=${JSON.stringify(starts)};writeFileSync(p,String(Number(readFileSync(p,'utf8'))+1));writeFileSync('result.txt','implemented');console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented'}}));console.log(JSON.stringify({type:'turn.completed'}));`,
  );
  const gate = join(root, "prepared-environment");
  const attempts = join(root, "preparation-attempts.txt");
  const prepare = join(root, "prepare.mjs");
  writeFileSync(
    prepare,
    `import {appendFileSync,existsSync} from 'node:fs';appendFileSync(${JSON.stringify(attempts)},'attempt\\n');process.exit(existsSync(${JSON.stringify(gate)})?0:1);`,
  );
  const preparedConfig = join(root, "prepared-development.json");
  writeFileSync(
    preparedConfig,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, "utf8")),
      tasksDirectory: join(root, "prepared-tasks"),
      coderProgram: preparedCoder,
      prepare: [[join(root, "not-installed-tool")]],
    }),
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../examples/recipes/personal-team/development.ts"), preparedConfig],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: join(root, "prepared-hub"), AGENT_AUTOLOOP_CONTEXT: context },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
  const waiting = run();
  assert.equal(waiting.status, 0, waiting.stderr);
  const receipt = readMessage(waiting.stdout).receipt;
  assert.ok(Array.isArray(receipt?.ask));
  assert.equal(receipt.ask[0].title, "开发环境需要恢复");
  assert.equal(readFileSync(starts, "utf8"), "0");
  writeFileSync(
    preparedConfig,
    JSON.stringify({ ...JSON.parse(readFileSync(preparedConfig, "utf8")), prepare: [[process.execPath, prepare]] }),
  );
  const unavailable = run();
  assert.equal(unavailable.status, 0, unavailable.stderr);
  assert.ok(Array.isArray(readMessage(unavailable.stdout).receipt?.ask));
  assert.equal(readFileSync(starts, "utf8"), "0");
  writeFileSync(gate, "available");
  const resumed = run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /项目检查和独立审查已通过/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(starts, "utf8"), "1");
  assert.equal(readFileSync(attempts, "utf8"), "attempt\nattempt\n");
});
