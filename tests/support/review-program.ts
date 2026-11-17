import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function program(folder: string, name: string, source: string) {
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
