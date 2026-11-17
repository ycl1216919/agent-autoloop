// Failure mode: a blocking card drops the goal, preserved evidence, consequences, or the action the owner must take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerText } from "../examples/recipes/code-review-loop/blocker.ts";

test("the visible blocker contains the task context and an actionable recovery path", () => {
  const context = {
    goal: "Complete the approved RCZ import/export smoke",
    phase: "Independent review",
    completed: ["Implementation preserved", "10 local checks recorded"],
    reason: "Native review receipt has an invalid findings shape",
    impact: "The current item is not approved; no publication takes place",
    action: "Choose continuation or pause; no manual JSON editing is required",
    resume: "Continue only the saved review; keep completed item b",
    evidence: ["checks-1.json", "native-review/original-response.json"],
  };
  const text = blockerText(context);
  for (const value of [
    context.goal,
    context.phase,
    ...context.completed,
    context.reason,
    context.impact,
    context.action,
    context.resume,
    ...context.evidence,
  ])
    assert.ok(text.includes(value), `The owner cannot see: ${value}`);
});
