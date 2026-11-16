// Failure modes: review findings never reach the implementer; a review outage repeats completed implementation;
// an approval is accepted after files or check results change; quota exhaustion requires a manual restart.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "autoloop-code-review-"));
after(() => rmSync(root, { recursive: true, force: true }));
const entry = join(import.meta.dirname, "../examples/recipes/code-review-loop/run.ts");

function program(folder: string, name: string, source: string) {
  const script = join(folder, `${name}.mjs`);
  const authentication = `if(['login status','auth status'].includes(process.argv.slice(2).join(' '))){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}`;
  writeFileSync(script, `#!${process.execPath}\n${authentication}\n${source}`);
  if (process.platform !== "win32") {
    chmodSync(script, 0o755);
    return script;
  }
  const shim = join(folder, `${name}.cmd`);
  writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0\\${name}.mjs" %*\r\n`);
  return shim;
}

function fixture(name: string, agents: { coder: string; reviewer: string }) {
  const folder = join(root, name);
  const workspace = join(folder, "workspace");
  mkdirSync(workspace, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(join(workspace, "sum.mjs"), "export const sum = (a, b) => 0;\n");
  writeFileSync(
    join(workspace, "check.mjs"),
    "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2, 3), 5);\n",
  );
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const task = join(folder, "task.md");
  writeFileSync(task, "Implement addition for positive and negative numbers.\n");
  const config = join(folder, "team.json");
  writeFileSync(
    config,
    JSON.stringify({
      name,
      workspace,
      taskFile: task,
      stateDirectory: join(folder, "state"),
      checks: [[process.execPath, "check.mjs"]],
      maxAttempts: 3,
      coderProgram: program(folder, "coder", agents.coder),
      reviewerProgram: program(folder, "reviewer", agents.reviewer),
    }),
  );
  return { folder, workspace, config };
}

const coderResult = `
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implementation ready.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`;
const approval = `console.log(JSON.stringify({type:'result',subtype:'success',session_id:'review',num_turns:1,result:'Review complete.',structured_output:process.argv.includes('--json-schema')?{findings:[]}:undefined}));`;
const run = (config: string, env: NodeJS.ProcessEnv = {}) => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_")),
  );
  const result = spawnSync(process.execPath, [entry, config], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...inherited, ...env, AGENT_AUTOLOOP_HOME: join(dirname(config), "hub") },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const state = (folder: string) => JSON.parse(readFileSync(join(folder, "state", "state.json"), "utf8"));

test("an implementation with nothing to do does not consume checks or review quota", () => {
  const f = fixture("nothing", {
    coder: coderResult.replace("Implementation ready.", "没事可做：原任务已经完成。"),
    reviewer: approval,
  });
  assert.equal(readMessage(run(f.config)).outcome, "nothing");
  assert.equal(state(f.folder).phase, "nothing");
  assert.equal(existsSync(join(f.folder, "state", "checks-1.json")), false);
  assert.equal(existsSync(join(f.folder, "state", "review-1")), false);
  run(f.config);
  assert.equal(existsSync(join(f.folder, "state", "review-1")), false);
});

test("a rejected Claude quota schedules review at the reported reset without asking the owner", () => {
  const f = fixture("quota-reset", {
    coder: `import {writeFileSync} from 'node:fs';writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n');${coderResult}`,
    reviewer: `console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:4102444800}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'Usage limit reached'}));process.exit(1);`,
  });
  const receipt = resultFrom(readMessage(run(f.config)), {}).result;
  assert.deepEqual(
    receipt.later?.map(({ key, at }) => ({ key, at })),
    [{ key: "code-review-loop-quota", at: "2100-01-01T00:01:00.000Z" }],
  );
  assert.equal(receipt.ask, undefined);
  assert.equal(state(f.folder).phase, "review");
});

test("resuming review rechecks external evidence before accepting a cached code revision", () => {
  const f = fixture("changed-check-evidence", {
    coder: `import {writeFileSync} from 'node:fs';writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n');${coderResult}`,
    reviewer: `import {existsSync} from 'node:fs';if(!existsSync('../ready')){console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'Unavailable'}));process.exit(1);}${approval}`,
  });
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.checks.push([
    process.execPath,
    "-e",
    "import {existsSync} from 'node:fs';if(existsSync('../changed'))process.exit(1)",
  ]);
  writeFileSync(f.config, JSON.stringify(config));
  run(f.config);
  writeFileSync(join(f.folder, "changed"), "external evidence changed");
  writeFileSync(join(f.folder, "ready"), "review available");
  run(f.config);
  assert.equal(state(f.folder).phase, "review");
});

test("review findings automatically return to implementation and only the corrected code completes", () => {
  const f = fixture("repair", {
    coder: `import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(${JSON.stringify(join(root, "repair", "state", "input.json"))},'utf8'));
const hasFeedback=Array.isArray(input.feedback?.findings)&&input.feedback.findings.length>0;
writeFileSync('sum.mjs',hasFeedback?'export const sum=(a,b)=>a+b;\\n':'export const sum=(a,b)=>Math.abs(a+b);\\n');
${coderResult}`,
    reviewer: `const {sum}=await import(new URL('file:///'+process.cwd().replaceAll('\\\\','/')+'/sum.mjs'));
const findings=sum(-2,-3)===-5?[]:[{title:'Negative additions have the wrong sign',text:'Return the signed sum.'}];
console.log(JSON.stringify({type:'result',subtype:'success',session_id:'review',num_turns:1,result:'Review complete.',structured_output:process.argv.includes('--json-schema')?{findings}:undefined}));`,
  });
  run(f.config);
  const result = state(f.folder);
  assert.equal(result.phase, "done", result.error);
  assert.equal(result.attempt, 2);
  const verified = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import {sum} from './sum.mjs'; if(sum(-2,-3)!==-5)process.exit(1)"],
    {
      cwd: f.workspace,
      encoding: "utf8",
    },
  );
  assert.equal(verified.status, 0, verified.stderr);
});

test("a reviewer outage preserves completed implementation and resumes at review", () => {
  const f = fixture("review-outage", {
    coder: `import {readFileSync,writeFileSync} from 'node:fs';
const previous=readFileSync('sum.mjs','utf8');
writeFileSync('sum.mjs',previous.includes('a+b')?'export const sum=()=>{throw Error("implementation repeated")};\\n':'export const sum=(a,b)=>a+b;\\n');
${coderResult}`,
    reviewer: `import {existsSync} from 'node:fs';
if(!existsSync('../review-restored')){console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'Review temporarily unavailable'}));process.exit(1);}
${approval}`,
  });
  const blocked = run(f.config);
  assert.match(blocked, /agent-autoloop/);
  assert.match(blocked, /Review temporarily unavailable/);
  assert.equal(state(f.folder).phase, "review");
  writeFileSync(join(f.folder, "review-restored"), "ready");
  run(f.config);
  assert.equal(state(f.folder).phase, "done", state(f.folder).error);
  const checked = spawnSync(process.execPath, ["check.mjs"], { cwd: f.workspace, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("a reviewer changing the reviewed files cannot produce an accepted result", () => {
  const f = fixture("stale-review", {
    coder: `import {writeFileSync} from 'node:fs'; writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n'); ${coderResult}`,
    reviewer: `import {writeFileSync} from 'node:fs'; writeFileSync('sum.mjs','export const sum=()=>0;\\n'); ${approval}`,
  });
  run(f.config);
  assert.equal(state(f.folder).phase, "review", state(f.folder).error);
});

test("failed project checks return to implementation and stop at the configured attempt limit", () => {
  const f = fixture("failed-checks", {
    coder: `import {writeFileSync} from 'node:fs'; writeFileSync('sum.mjs','export const sum=()=>1;\\n'); ${coderResult}`,
    reviewer: approval,
  });
  run(f.config);
  const result = state(f.folder);
  assert.notEqual(result.phase, "done");
  assert.equal(result.attempt, 3);
});

test("an implementer asking for a decision resumes after the decision instead of replaying its old question", () => {
  const f = fixture("decision", {
    coder: `import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(${JSON.stringify(join(root, "decision", "state", "input.json"))},'utf8'));
const answered=input.ownerContext?.answers?.some(answer=>answer.chosen==='继续');
if(!answered||!process.argv.includes('resume')||!process.argv.includes('11111111-1111-4111-8111-111111111111')){
 const fence=String.fromCharCode(96).repeat(3);
 const question='待你处理：需要确认任务。\\n\\n'+fence+'agent-autoloop\\n'+JSON.stringify({ask:[{title:'继续吗',text:'确认后继续',options:['继续','停止'],key:'decision'}]})+'\\n'+fence;
 console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:question}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{}}));
}else{writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n');${coderResult}}
`,
    reviewer: approval,
  });
  run(f.config);
  assert.equal(state(f.folder).phase, "implement");
  const answerFile = join(f.folder, "answer.json");
  writeFileSync(answerFile, JSON.stringify({ answers: [{ chosen: "继续" }] }));
  run(f.config, { AGENT_AUTOLOOP_CONTEXT: answerFile });
  assert.equal(state(f.folder).phase, "done", state(f.folder).error);
});

test("an owner cancellation remains cancelled after the review tool recovers", () => {
  const f = fixture("cancelled", {
    coder: `import {writeFileSync} from 'node:fs';writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n');${coderResult}`,
    reviewer: `import {existsSync} from 'node:fs';if(!existsSync('../ready')){console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'Unavailable'}));process.exit(1);}${approval}`,
  });
  run(f.config);
  assert.equal(state(f.folder).phase, "review");
  const context = join(f.folder, "answer.json");
  writeFileSync(context, JSON.stringify({ answers: [{ chosen: "停止这个任务" }] }));
  run(f.config, { AGENT_AUTOLOOP_CONTEXT: context });
  writeFileSync(join(f.folder, "ready"), "ready");
  run(f.config);
  assert.equal(state(f.folder).phase, "cancelled");
});

test("review entry examines existing work before invoking implementation for its findings", () => {
  const f = fixture("review-first", {
    coder: `import {writeFileSync} from 'node:fs';writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\\n');${coderResult}`,
    reviewer: `import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';const {sum}=await import(pathToFileURL(resolve('sum.mjs')).href);const findings=sum(2,3)===5?[]:[{title:'Addition is incorrect',text:'Return a+b.'}];console.log(JSON.stringify({type:'result',subtype:'success',session_id:'review',num_turns:1,result:'Review complete.',structured_output:process.argv.includes('--json-schema')?{findings}:undefined}));`,
  });
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.start = "review";
  config.checks = [[process.execPath, "-e", "process.exit(0)"]];
  writeFileSync(f.config, JSON.stringify(config));
  run(f.config);
  assert.equal(state(f.folder).phase, "done", state(f.folder).error);
  assert.equal(state(f.folder).attempt, 2);
  const checked = spawnSync(process.execPath, ["check.mjs"], { cwd: f.workspace, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

for (const response of [
  { name: "business failure", message: "FAILED: The requested implementation could not be completed." },
  { name: "malformed decision receipt", message: '待你处理：需要回答。\n\n```agent-autoloop\n{"ask":' },
]) {
  test(`an implementation reporting ${response.name} cannot advance to acceptance`, () => {
    const f = fixture(`invalid-${response.name.replaceAll(" ", "-")}`, {
      coder: coderResult.replace("text:'Implementation ready.'", `text:${JSON.stringify(response.message)}`),
      reviewer: approval,
    });
    const config = JSON.parse(readFileSync(f.config, "utf8"));
    config.checks = [[process.execPath, "-e", "process.exit(0)"]];
    writeFileSync(f.config, JSON.stringify(config));
    run(f.config);
    assert.equal(state(f.folder).phase, "implement");
  });
}
