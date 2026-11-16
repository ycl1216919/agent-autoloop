// Failure modes: branch work leaves the original repository, mixes owner edits, or delivers code changed after review.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { readMessage } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "autoloop-branch-"));
after(() => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
});
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
const reviewer = program(
  "reviewer",
  "console.log(JSON.stringify({type:'result',subtype:'success',num_turns:1,result:'reviewed',structured_output:{findings:[]}}));",
);
const context = join(root, "context.json");
writeFileSync(
  context,
  JSON.stringify({
    events: [{ id: "branch-1", subject: "discord:123", detail: "Implement an approved item" }],
    answers: [],
  }),
);

test("branch development works in the original repository and refuses to mix pre-existing edits", async () => {
  const { prepareBranch } = await import("../examples/recipes/personal-team/branch.ts");
  const workspace = join(root, "branch-source");
  mkdirSync(workspace);
  const command = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  command(["init", "--quiet", "-b", "main"]);
  writeFileSync(join(workspace, "base.txt"), "base");
  command(["add", "."]);
  command(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
  const directory = join(root, "branch-record");
  mkdirSync(directory);
  const project = { source: workspace, base: "main", prefix: "feat/" };
  writeFileSync(join(workspace, "owner.txt"), "owner edit");
  assert.throws(() => prepareBranch(project, directory), /未提交/);
  assert.equal(command(["branch", "--show-current"]), "main");
  assert.equal(readFileSync(join(workspace, "owner.txt"), "utf8"), "owner edit");
  command(["add", "owner.txt"]);
  command(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "owner"]);
  const prepared = prepareBranch(project, directory);
  assert.equal(prepared.workspace, workspace);
  assert.match(command(["branch", "--show-current"]), /^feat\/autoloop-/);
  assert.deepEqual(prepareBranch(project, directory), prepared);
});

test("the branch-mode entry executes in the original repository without making a workspace copy", () => {
  const source = join(root, "entry-source");
  mkdirSync(source);
  const command = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  command(["init", "--quiet", "-b", "main"]);
  writeFileSync(join(source, "README.md"), "original repository");
  command(["add", "."]);
  command(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
  const asking = program(
    "branch-entry-coder",
    `import {writeFileSync} from 'node:fs';writeFileSync('started.txt',process.cwd());console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Need decision\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({ask:[{title:'Choose',text:'Continue?',options:['Continue','Cancel']}]})+'\\n\`\`\`'}}));console.log(JSON.stringify({type:'turn.completed'}));`,
  );
  const file = join(root, "branch-entry.json");
  const tasks = join(root, "branch-entry-tasks");
  writeFileSync(
    file,
    JSON.stringify({
      name: "ReRace",
      source: source.replaceAll("\\", "/"),
      tasksDirectory: tasks,
      instructions: "Implement the authorized task",
      checks: [[process.execPath, "--version"]],
      coderProgram: asking,
      reviewerProgram: reviewer,
      branch: { base: "main", prefix: "feat/", repo: "fixture/project", remote: "origin" },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/personal-team/development.ts"), file],
    {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: join(root, "branch-entry-hub"), AGENT_AUTOLOOP_CONTEXT: context },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(source, "started.txt"), "utf8").toLowerCase(), source.toLowerCase());
  assert.match(command(["branch", "--show-current"]), /^feat\/autoloop-/);
  assert.equal(existsSync(join(tasks, readdirSync(tasks)[0], "workspace")), false);
  const continued = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/personal-team/development.ts"), file],
    {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: join(root, "branch-entry-hub"), AGENT_AUTOLOOP_CONTEXT: context },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(continued.status, 0, continued.stderr);
  const receipt = readMessage(continued.stdout).receipt;
  assert.ok(Array.isArray(receipt?.ask));
  assert.equal(receipt.ask[0].title, "Choose");
});

test("PR delivery rejects files changed after review before staging or committing", async () => {
  const { publish } = await import("../examples/recipes/personal-team/publish.ts");
  const { revision } = await import("../examples/recipes/code-review-loop/snapshot.ts");
  const workspace = join(root, "delivery-source");
  mkdirSync(workspace);
  const command = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  command(["init", "--quiet", "-b", "feat/test"]);
  writeFileSync(join(workspace, "base.txt"), "base");
  command(["add", "."]);
  command(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
  const base = command(["rev-parse", "HEAD"]);
  const directory = join(root, "delivery-state");
  mkdirSync(join(directory, "state"), { recursive: true });
  writeFileSync(
    join(directory, "state", "state.json"),
    JSON.stringify({ phase: "done", revision: revision(workspace) }),
  );
  writeFileSync(join(workspace, "base.txt"), "unreviewed change");
  assert.throws(
    () =>
      publish(
        { workspace, branch: "feat/test", base, baseBranch: "main" },
        { repo: "fixture/project", remote: "origin" },
        directory,
      ),
    /验收版本/,
  );
  assert.equal(command(["rev-parse", "HEAD"]), base);
  assert.equal(command(["diff", "--cached", "--name-only"]), "");
});
