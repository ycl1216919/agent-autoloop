import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export function git(workspace: string, args: readonly string[]) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function revision(workspace: string) {
  const hash = createHash("sha256").update(git(workspace, ["rev-parse", "HEAD"]));
  hash.update(git(workspace, ["diff", "HEAD", "--binary", "--no-ext-diff"]));
  for (const file of git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort()) {
    const absolute = join(workspace, file);
    const contents = lstatSync(absolute).isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute))
      : readFileSync(absolute);
    hash.update(JSON.stringify([file, contents.length])).update(contents);
  }
  return hash.digest("hex");
}
