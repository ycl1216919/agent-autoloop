// Failure modes: Gemini accounts share credentials; a background executor gains the owner's MCP authority.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { hubClient } from "../protocol/client.ts";
import { resumeAfterLogin } from "../examples/recipes/personal-team/readiness.ts";

const folder = mkdtempSync(join(tmpdir(), "autoloop-clients-"));
after(() => rmSync(folder, { recursive: true, force: true }));
const launcher = join(import.meta.dirname, "../examples/recipes/personal-team/launch.ts");
const mcp = join(import.meta.dirname, "../examples/recipes/personal-team/owner-mcp.ts");
const gemini = join(folder, "gemini.mjs");
writeFileSync(
  gemini,
  `import {readFileSync} from 'node:fs';const account=readFileSync(process.env.GEMINI_CLI_HOME+'/.gemini/account','utf8');console.log(JSON.stringify({account,apiKey:process.env.GEMINI_API_KEY,auth:process.env.GOOGLE_GENAI_USE_GCA}));`,
);
const config = join(folder, "clients.json");
writeFileSync(
  config,
  JSON.stringify({
    hubHome: join(folder, "hub"),
    profilesRoot: folder,
    gemini: [process.execPath, gemini],
    codex: [process.execPath, gemini],
    claude: [process.execPath, gemini],
  }),
);
for (const account of ["gemini-personal", "gemini-business"]) {
  const directory = join(folder, account, ".gemini");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "account"), account);
}

test("personal and business Gemini executions load different credential stores without inherited API billing", () => {
  const outputs = ["gemini-personal", "gemini-business"].map((profile) => {
    const result = spawnSync(process.execPath, [launcher, config, profile, "worker", "--acp"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GEMINI_API_KEY: "unintended-key" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(outputs, [
    { account: "gemini-personal", auth: "true" },
    { account: "gemini-business", auth: "true" },
  ]);
});

test("the owner MCP entry refuses execution from a background task before reading owner credentials", () => {
  const result = spawnSync(process.execPath, [mcp, join(folder, "missing-owner-home")], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENT_AUTOLOOP_RUN: "12" },
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /后台任务不能使用本人管理入口/);
  assert.equal(result.stdout, "");
});

test("explicit Gemini API profiles select separate keys without exposing them in arguments or falling back to OAuth", () => {
  const executable = join(folder, "api-agent.mjs");
  writeFileSync(
    executable,
    `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';const settings=JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,'utf8'));console.log(JSON.stringify({home:process.env.GEMINI_CLI_HOME,auth:settings.security.auth.selectedType,key:createHash('sha256').update(process.env.GEMINI_API_KEY??'').digest('hex'),google:process.env.GOOGLE_GENAI_USE_GCA??null,keyInArgs:process.argv.some(arg=>arg.includes('fixture-key'))}));`,
  );
  const api = Object.fromEntries(
    ["gemini-personal", "gemini-business"].map((profile) => {
      const keyFile = join(folder, `${profile}.key`);
      writeFileSync(keyFile, `${profile}-fixture-key`);
      const home = join(folder, `${profile}-api`);
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "worker-settings.json"),
        JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } }, mcp: { excluded: ["autoloop"] } }),
      );
      return [profile, { keyFile, model: "gemini-3.8-flash" }];
    }),
  );
  const file = join(folder, "api-clients.json");
  writeFileSync(
    file,
    JSON.stringify({
      hubHome: join(folder, "hub"),
      profilesRoot: folder,
      gemini: [process.execPath, executable],
      geminiApi: api,
    }),
  );
  for (const profile of ["gemini-personal", "gemini-business"]) {
    const result = spawnSync(process.execPath, [launcher, file, profile, "worker", "--acp"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GEMINI_API_KEY: "inherited-wrong-key", GOOGLE_GENAI_USE_GCA: "true" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      home: join(folder, `${profile}-api`),
      auth: "gemini-api-key",
      key: createHash("sha256").update(`${profile}-fixture-key`).digest("hex"),
      google: null,
      keyInArgs: false,
    });
  }
});

for (const scenario of [
  { name: "authentication", mode: "worker", args: ["auth", "status"], expected: { loggedIn: true } },
  { name: "client prompt", mode: "client", args: ["hello"], expected: { response: "hello", tools: ["autoloop"] } },
  { name: "worker end-of-options", mode: "worker", args: ["--", "hello"], expected: { response: "hello", tools: [] } },
])
  test(`Claude preserves ${scenario.name} and its MCP permissions`, () => {
    const executable = join(folder, `claude-${scenario.name.replaceAll(" ", "-")}.mjs`);
    writeFileSync(
      executable,
      `const args=process.argv.slice(2);const positional=[];const configs=[];let strict=false;
for(let i=0;i<args.length;i++){if(args[i]==='--'){positional.push(...args.slice(i+1));break;}if(args[i]==='--strict-mcp-config'){strict=true;continue;}if(args[i]==='--mcp-config'){while(i+1<args.length&&!args[i+1].startsWith('-')){try{configs.push(JSON.parse(args[++i]));}catch{console.error('Invalid MCP config input');process.exit(1);}}continue;}positional.push(args[i]);}
const servers=strict?{}:{inherited_owner:{}};for(const config of configs)Object.assign(servers,config.mcpServers);console.log(JSON.stringify(positional[0]==='auth'?{loggedIn:true}:{response:positional.join(' '),tools:Object.keys(servers)}));`,
    );
    const file = join(folder, `claude-${scenario.name.replaceAll(" ", "-")}.json`);
    writeFileSync(
      file,
      JSON.stringify({ hubHome: join(folder, "hub"), profilesRoot: folder, claude: [process.execPath, executable] }),
    );
    const result = spawnSync(process.execPath, [launcher, file, "claude", scenario.mode, ...scenario.args], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), scenario.expected);
  });

test("restored CLI login resumes only the saved technical-blocker card without model polling", async () => {
  const ready = join(folder, "claude-ready");
  const auth = join(folder, "claude-status.mjs");
  writeFileSync(
    auth,
    `import {existsSync} from 'node:fs';const loggedIn=existsSync(${JSON.stringify(ready)});console.log(JSON.stringify({loggedIn}));process.exit(loggedIn?0:1);`,
  );
  const cards = [
    { id: 17, title: "PR90 需要继续处理", kind: "ask", state: "open" },
    { id: 99, title: "需要业务决定", kind: "ask", state: "open" },
  ];
  const server = createServer((request, response) => {
    if (request.url === "/v1/state") return response.end(JSON.stringify({ cards }));
    const id = Number(/^\/v1\/cards\/(\d+)\/answer$/.exec(request.url ?? "")?.[1]);
    const card = cards.find((item) => item.id === id);
    if (card) card.state = "decided";
    response.end(JSON.stringify({ changed: !!card }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = {
    command: [process.execPath, auth],
    owner: hubClient(`http://127.0.0.1:${address.port}`, "owner"),
    card: 17,
    title: "PR90 需要继续处理",
  };
  try {
    assert.equal(await resumeAfterLogin(options), "waiting");
    assert.equal(cards[0].state, "open");
    writeFileSync(ready, "logged in");
    assert.equal(await resumeAfterLogin(options), "resumed");
    assert.deepEqual(
      cards.map((card) => card.state),
      ["decided", "open"],
    );
    assert.equal(await resumeAfterLogin(options), "nothing");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Claude uses the configured model and effort while retaining worker MCP isolation", () => {
  const executable = join(folder, "resolved-model.mjs");
  writeFileSync(
    executable,
    `const args=process.argv.slice(2);let model='old-default',effort='high';for(let i=0;i<args.length;i++){if(args[i]==='--model')model=args[++i];else if(args[i]==='--effort')effort=args[++i];}const at=args.indexOf('--mcp-config');console.log(JSON.stringify({model,effort,tools:Object.keys(JSON.parse(args[at+1]).mcpServers)}));`,
  );
  const file = join(folder, "pinned-model.json");
  writeFileSync(
    file,
    JSON.stringify({
      hubHome: join(folder, "hub"),
      profilesRoot: folder,
      claude: [process.execPath, executable],
      claudeModel: "claude-opus-5-5",
      claudeEffort: "medium",
    }),
  );
  const result = spawnSync(process.execPath, [launcher, file, "claude", "worker", "hello"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { model: "claude-opus-5-5", effort: "medium", tools: [] });
});
