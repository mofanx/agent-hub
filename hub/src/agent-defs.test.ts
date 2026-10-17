import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_DEFS,
  buildAgentDefs,
  getAgentDef,
  parseArgs,
  spawnAgentProcess,
} from "./agent-defs.js";

test("parseArgs: 空值/空白回退 fallback", () => {
  assert.deepEqual(parseArgs(undefined, ["acp"]), ["acp"]);
  assert.deepEqual(parseArgs("   ", ["acp"]), ["acp"]);
});

test("parseArgs: 空白拆分，引号内保留空格", () => {
  assert.deepEqual(parseArgs('acp --foo "bar baz"', []), ["acp", "--foo", "bar baz"]);
  assert.deepEqual(parseArgs("acp --x='a b'  --y", []), ["acp", "--x=a b", "--y"]);
});

test("parseArgs: JSON 数组优先，非法 JSON 回退 shell 拆分", () => {
  assert.deepEqual(parseArgs('["acp", "--foo", "bar baz"]', []), ["acp", "--foo", "bar baz"]);
  assert.deepEqual(parseArgs('["a"]', ["fb"]), ["a"]);
  assert.deepEqual(parseArgs("[not json", []), ["[not", "json"]);
});

test("buildAgentDefs: deepseek 默认走固定版本 npm ACP profile", () => {
  const defs = buildAgentDefs({});
  assert.equal(defs.deepseek!.bin, "npx");
  assert.deepEqual(defs.deepseek!.args, [
    "-y",
    "@deepseek-ai/dsh@0.2.0-rc.2",
    "--profile",
    "acp",
  ]);
  assert.equal(defs.deepseek!.cwd, undefined);
});

test("buildAgentDefs: DSH_ACP_BIN 显式覆盖优先于 DSH_ROOT", () => {
  const defs = buildAgentDefs({
    DSH_ACP_BIN: "/opt/dsh/bin.js",
    DSH_ACP_ARGS: '--serve "a b"',
    DSH_ROOT: "/repo",
  });
  assert.equal(defs.deepseek!.bin, "/opt/dsh/bin.js");
  assert.deepEqual(defs.deepseek!.args, ["--serve", "a b"]);
  assert.equal(defs.deepseek!.cwd, "/repo");
});

test("buildAgentDefs: DSH_ROOT 源码开发模式走 tsx 直跑 apps/cli", () => {
  const defs = buildAgentDefs({ DSH_ROOT: "D:/dsh" });
  assert.equal(defs.deepseek!.bin, "node");
  assert.deepEqual(defs.deepseek!.args, [
    "--import",
    "tsx/esm",
    "apps/cli/src/bin.ts",
    "--profile",
    "acp",
  ]);
  assert.equal(defs.deepseek!.cwd, "D:/dsh");
});

test("buildAgentDefs: 既有 agent 默认 def 不回归", () => {
  const defs = buildAgentDefs({});
  assert.deepEqual(defs.devin, { bin: "devin", args: ["acp"] });
  assert.deepEqual(defs.claude, { bin: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] });
  assert.deepEqual(defs.codex, { bin: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] });
  assert.deepEqual(defs.opencode, { bin: "opencode", args: ["acp"] });
  assert.deepEqual(defs.openclaw, { bin: "openclaw", args: ["acp"] });
});

test("AGENT_DEFS/getAgentDef: 注册表含全部六个类型", () => {
  for (const key of ["devin", "claude", "codex", "opencode", "openclaw", "deepseek"]) {
    assert.ok(AGENT_DEFS[key], key);
    assert.equal(getAgentDef(key), AGENT_DEFS[key]);
  }
  assert.equal(getAgentDef("nonexistent"), undefined);
});

test("spawnAgentProcess: 转发 cwd 与 env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-defs-"));
  try {
    const proc = spawnAgentProcess({
      bin: process.execPath,
      args: [
        "-e",
        'process.stdout.write(process.cwd() + "|" + String(process.env.DSH_PROBE))',
      ],
      cwd: dir,
      env: { DSH_PROBE: "ok" },
    });
    let out = "";
    proc.stdout!.on("data", (c) => (out += String(c)));
    const [code] = await once(proc, "close");
    assert.equal(code, 0);
    const [cwd, probe] = out.split("|");
    assert.equal(fs.realpathSync(cwd!), fs.realpathSync(dir));
    assert.equal(probe, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAgentProcess: 未声明时剥离 ACP_BACKEND，声明时透传", async () => {
  process.env.ACP_BACKEND = "stale";
  try {
    const readEnv = async (env?: Record<string, string>) => {
      const proc = spawnAgentProcess({
        bin: process.execPath,
        args: ["-e", "process.stdout.write(String(process.env.ACP_BACKEND))"],
        ...(env ? { env } : {}),
      });
      let out = "";
      proc.stdout!.on("data", (c) => (out += String(c)));
      const [code] = await once(proc, "close");
      assert.equal(code, 0);
      return out;
    };
    assert.equal(await readEnv(), "undefined");
    assert.equal(await readEnv({ ACP_BACKEND: "kept" }), "kept");
  } finally {
    delete process.env.ACP_BACKEND;
  }
});
