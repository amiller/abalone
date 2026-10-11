import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("incognito agent settings, debug and crash output stay in tmpfs on disk-backed runtime paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "incognito-agent-memory-"));
  const state = path.join(directory, "state"), work = path.join(directory, "work"), run = path.join(directory, "runtime");
  for (const p of [state, work, run]) fs.mkdirSync(p, { mode: 0o700 });
  const module = new URL("../lib/sandbox.mjs", import.meta.url).href;
  const script = `import fs from "node:fs"; import path from "node:path"; import {spawnSync} from "node:child_process";
    import {piArgv} from ${JSON.stringify(module)};
    const run = ${JSON.stringify(run)}, work = ${JSON.stringify(work)}, agent = path.join(run, "agent");
    fs.mkdirSync(agent); const initial = path.join(agent, "settings.json");
    fs.writeFileSync(initial, JSON.stringify({quietStartup:"header"}));
    const fd = fs.openSync(initial, "r");
    const payload = 'const fs=require("node:fs"),path=require("node:path"),dir=' + JSON.stringify(agent) + ';' +
      'if(fs.statfsSync(dir).type!==0x01021994) process.exit(9);' +
      'if(JSON.parse(fs.readFileSync(path.join(dir,"settings.json"))).quietStartup!=="header") process.exit(10);' +
      'fs.writeFileSync(path.join(dir,"debug.log"),"private-marker");' +
      'fs.writeFileSync(path.join(dir,"crash.log"),"private-marker");' +
      'fs.writeFileSync(path.join(dir,"settings.json"),"changed-in-memory");process.exit(7);';
    const result=spawnSync("bwrap", [...piArgv(run,[],work,{incognito:true,settingsFd:3}),"--",process.execPath,"-e",payload],
      {stdio:["ignore","pipe","pipe",fd],timeout:5000}); fs.closeSync(fd);
    if(result.status!==7) {console.error("memory mount refusal");process.exit(11);}
    if(fs.existsSync(path.join(agent,"debug.log"))||fs.existsSync(path.join(agent,"crash.log"))) process.exit(12);
    if(JSON.parse(fs.readFileSync(initial)).quietStartup!=="header") process.exit(13);
    console.log("crash output remained in memory");`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, ABALONE_DIR: state }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "crash output remained in memory");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
