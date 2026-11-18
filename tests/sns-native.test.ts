// Prevent stale or non-Gemini native results from advancing an SNS task, and verification probes from becoming content jobs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const entry = resolve("examples/recipes/sns-promotion/native-task.ts");
function setup(kind = "creative") {
  const root = mkdtempSync(join(tmpdir(), "autoloop-sns-native-"));
  mkdirSync(join(root, "packet"));
  writeFileSync(join(root, "packet", "brief.md"), "Battery promotion. The owner publishes manually.");
  const prepared = spawnSync(process.execPath, [entry, "prepare", root, kind, "discord:test"], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const request = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
  return { root, request };
}
function respond(root: string, request: { id: string; digest: string }, changes = {}) {
  writeFileSync(
    join(root, "response.json"),
    JSON.stringify({
      version: 1,
      id: request.id,
      digest: request.digest,
      reviewer: "gemini",
      model: "Gemini",
      status: "done",
      markdown: "Use the current verified battery prices and preserve the owner's manual publishing step.",
      ...changes,
    }),
  );
}

test("a matching native creative response produces the next SNS event and retains the actual content", () => {
  const { root, request } = setup();
  try {
    respond(root, request);
    const result = spawnSync(process.execPath, [entry, "poll", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.match(/```agent-autoloop\n([\s\S]+)\n```/)?.[1] ?? "null");
    assert.equal(receipt.events[0].type, "sns.creative.ready");
    assert.equal(receipt.events[0].subject, "discord:test");
    assert.equal(
      readFileSync(join(root, "creative.md"), "utf8").trim(),
      "Use the current verified battery prices and preserve the owner's manual publishing step.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale material or a response from another model cannot advance the native SNS task", () => {
  for (const invalid of ["material", "model", "request"]) {
    const { root, request } = setup();
    try {
      respond(
        root,
        request,
        invalid === "model" ? { model: "Codex" } : invalid === "request" ? { id: "0".repeat(32) } : {},
      );
      if (invalid === "material") writeFileSync(join(root, "packet", "brief.md"), "Changed campaign terms.");
      const result = spawnSync(process.execPath, [entry, "poll", root], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /sns\.creative\.ready/);
      assert.match(result.stdout, /"ask"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a real native verification receipt stays separate from production SNS events", () => {
  const { root, request } = setup("verification");
  try {
    respond(root, request);
    const result = spawnSync(process.execPath, [entry, "poll", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /sns\.creative\.ready/);
    assert.match(readFileSync(join(root, "creative.md"), "utf8"), /manual publishing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
