// Failure modes: a native text finding is discarded as an approval, or malformed findings silently pass review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFindings } from "../examples/recipes/code-review-loop/config.ts";

test("legacy native text findings remain required fixes with their complete evidence", () => {
  const text =
    "examples/link_smoke.rs does not exercise the required import/export path. Debug and release validation are still required.";
  const findings = readFindings(JSON.stringify({ findings: [text] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].text, text);
  assert.ok(findings[0].title.includes("examples/link_smoke.rs"));
});

test("empty native text or malformed finding objects cannot become approval", () => {
  for (const finding of ["   ", { title: "Missing details" }, null])
    assert.throws(() => readFindings(JSON.stringify({ findings: [finding] })));
  assert.deepEqual(readFindings('{"findings":[]}'), []);
});
