// Failure modes: per-round memos get lost or overwritten across rounds on the same matter, leak across lanes or rules,
// or are accepted on failed runs; /v1/state omits rule resume/parallel or run lane/resume/memo so dashboards cannot tell
// whether a run resumed a session or what memo it left; worker receipt parsing rejects memo; why omits memo or resume.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { formatWhy } from "../cli/why.ts";
import { stateOf, viewStatements } from "../host/state.ts";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, initialize, type Fact } from "../kernel/evolve.ts";
import { cardView, unrouted } from "../kernel/query.ts";
import { parseRules } from "../protocol/rules.ts";
import { checkSchema } from "../protocol/schema.ts";
import { parseResult } from "../protocol/validate.ts";
import { invariants } from "../sim/invariants.ts";
import { promptFor, readMessage, resultFrom } from "../worker/contract.ts";

const env = { secret: "memo-test", publicUrl: "https://hub.test" };
const given = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const rules = parseRules(
  JSON.stringify({
    ...given,
    rules: given.rules
      .filter((rule: { when: { source?: string } }) => rule.when.source)
      .map((rule: { name: string }) => (rule.name === "意见" ? { ...rule, resume: true } : rule)),
  }),
  0,
  "UTC",
);

function hub() {
  const db = new DatabaseSync(":memory:");
  initialize(db);
  for (const statement of viewStatements) db.exec(statement);
  let view = empty(db);
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  let claims = 0;
  return {
    act,
    log,
    now: () => now,
    view: () => view,
    message: (subject = "#1", type = "feedback.new") => act("ingest", "app", { id: `e${++events}`, type, subject }),
    claim: () => act("claimNext", "w1", `c${++claims}`),
    state: () =>
      stateOf(now, undefined, rules, {
        all: <T>(sql: string, params: any[] = []) => db.prepare(sql).all(...params) as T[],
        view: (card) => cardView(card, env),
        unrouted: () => unrouted(view),
      }),
    check: () => invariants(view, log),
  };
}

test("per-round memos accumulate with run numbers per lane, isolate across lanes, and reject failed runs", () => {
  const it = hub();

  // Round 1 on #1 leaves memo about A, B, C
  it.message("#1");
  const j1 = it.claim();
  assert.deepEqual(j1.context.memos, []);
  const r1 = {
    outcome: "done",
    summary: "梳理了 A、B、C 三项任务",
    memo: "A: 完成调研；B: 待写测试；C: 等外部账号。",
    session: "S1",
  };
  assert.deepEqual(checkSchema("result", r1), []);
  assert.deepEqual(parseResult(r1), r1);
  it.act("finish", j1.run, j1.token, r1);

  // Round 2 on #2 (different lane) must not see #1's memo
  it.message("#2");
  const j2 = it.claim();
  assert.deepEqual(j2.context.memos, []);
  it.act("finish", j2.run, j2.token, { outcome: "done", summary: "处理 #2", memo: "#2 的独立备忘", session: "S2" });

  // Round 3 on #1 sees Round 1's memo and adds Round 3's memo without overwriting Round 1
  it.message("#1");
  const j3 = it.claim();
  assert.equal(j3.session, "S1");
  assert.equal(j3.context.memos.length, 1);
  assert.equal(j3.context.memos[0].run, j1.run);
  assert.equal(j3.context.memos[0].summary, "梳理了 A、B、C 三项任务");
  assert.equal(j3.context.memos[0].memo, "A: 完成调研；B: 待写测试；C: 等外部账号。");
  assert.ok(j3.context.memos[0].at);
  assert.deepEqual(checkSchema("job", JSON.parse(JSON.stringify(j3))), []);
  it.act("finish", j3.run, j3.token, {
    outcome: "done",
    summary: "完成 A 和 B",
    memo: "A、B 已合入分支 feat/ab；C 仍未动。",
    session: "S1",
  });

  // Round 4 on #1 fails with a memo -> rejected, not persisted
  it.message("#1");
  const j4 = it.claim();
  assert.equal(j4.context.memos.length, 2);
  assert.deepEqual(
    j4.context.memos.map((m: { run: number }) => m.run),
    [j1.run, j3.run],
  );
  const failed = it.act("finish", j4.run, j4.token, {
    outcome: "failed",
    error: "网络断了",
    memo: "不该存的失败备忘",
  });
  assert.ok(failed.rejected.some((item: { what?: string }) => item.what === "memo"));
  assert.equal(it.view().get("runs", j4.run)!.memo ?? null, null);

  // /v1/state exposes rule resume/parallel and run lane/resume/memo
  const state = it.state();
  const opinion = state.lines.find((line) => line.name === "意见")!;
  assert.equal(opinion.resume, true);
  assert.equal(opinion.parallel, 3);
  const run3 = state.runs.find((run) => run.id === j3.run)!;
  assert.equal(run3.lane, "#1");
  assert.equal(run3.resume, "S1");
  assert.equal(run3.memo, "A、B 已合入分支 feat/ab；C 仍未动。");

  // why timeline includes resume and memo
  const why3 = formatWhy(j3.run, it.log);
  assert.match(why3, /续接会话/);
  assert.match(why3, /备忘：A、B 已合入分支 feat\/ab；C 仍未动。/);

  it.check();
});

test("worker receipt contract parses memo and rejects oversized memo", () => {
  const said = [
    "完成接口校验",
    "",
    "```agent-autoloop",
    JSON.stringify({ memo: "已修改 src/auth.ts，待补集成测试。" }),
    "```",
  ].join("\n");
  const parsed = readMessage(said);
  assert.equal(parsed.problem, undefined);
  const { result, problem } = resultFrom(parsed, {});
  assert.equal(problem, undefined);
  assert.equal(result.memo, "已修改 src/auth.ts，待补集成测试。");

  const tooLong = { outcome: "done", memo: "x".repeat(4001) };
  assert.throws(() => parseResult(tooLong), /memo/);
  assert.ok(checkSchema("result", tooLong).length);

  const prompt = promptFor(
    {
      run: 1,
      token: "t",
      attempt: 1,
      rule: { name: "意见", cwd: "/tmp" },
      agent: { id: "claude", name: "Claude", use: "claude", access: "edit" },
      session: null,
      askFirst: [],
      context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [], memos: [] },
    },
    "/tmp/context.json",
  );
  assert.match(prompt, /memos/);
  assert.match(prompt, /"memo"/);
});
