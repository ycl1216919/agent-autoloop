// Prevent unrelated business files entering an SNS inventory and missing media being reported as an empty success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "autoloop-sns-"));
  const media = join(directory, "media");
  mkdirSync(join(media, "old"), { recursive: true });
  writeFileSync(join(media, "hero.PNG"), "image");
  writeFileSync(join(media, "old", "clip.mp4"), "video");
  writeFileSync(join(media, "credentials.json"), "private");
  writeFileSync(join(directory, "receipt.pdf"), "unrelated");
  const config = join(directory, "assets.json");
  writeFileSync(config, JSON.stringify({ roots: [media] }));
  return { directory, media, config, output: join(directory, "inventory.json") };
}

const script = resolve("examples/recipes/sns-promotion/index-assets.ts");

test("SNS inventory includes media only from the configured roots", () => {
  const setup = fixture();
  try {
    const result = spawnSync(process.execPath, [script, setup.config, setup.output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(readFileSync(setup.output, "utf8"));
    assert.deepEqual(inventory.assets.map((asset: { path: string }) => asset.path).sort(), [
      "hero.PNG",
      "old/clip.mp4",
    ]);
    assert.equal(inventory.assets[0].root, setup.media);
    assert.equal(inventory.assets[0].bytes, 5);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test("rescanning unchanged SNS media keeps the same event identity", () => {
  const setup = fixture();
  try {
    const runs = Array.from({ length: 2 }, () =>
      spawnSync(process.execPath, [script, setup.config, setup.output], { encoding: "utf8" }),
    );
    const receipts = runs.map((result) => {
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.match(/```agent-autoloop\n([\s\S]+)\n```/)?.[1] ?? "null");
    });
    assert.match(receipts[0].events[0].id, /^assets:[a-f0-9]{64}$/);
    assert.equal(receipts[0].events[0].id, receipts[1].events[0].id);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test("an unavailable SNS source fails without replacing the previous inventory or emitting ready", () => {
  const setup = fixture();
  try {
    writeFileSync(setup.config, JSON.stringify({ roots: [join(setup.directory, "not-mounted")] }));
    writeFileSync(setup.output, "previous inventory");
    const result = spawnSync(process.execPath, [script, setup.config, setup.output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(readFileSync(setup.output, "utf8"), "previous inventory");
    assert.doesNotMatch(result.stdout, /sns\.assets\.ready/);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});
