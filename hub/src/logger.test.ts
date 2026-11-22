import test from "node:test";
import assert from "node:assert/strict";
import { createStderrForwarder } from "./logger.js";

function collect() {
  const out: string[] = [];
  return { out, write: (s: string) => out.push(s) };
}

test("stderr forwarder drops tracing INFO lines", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write);
  fwd.push("2026-11-22T03:22:42.575Z  INFO chisel_agent::skills_loading: skills discovery: cwd=/tmp\n");
  fwd.push("2026-11-22T03:22:42.576Z  WARN chisel_agent::x: something bad\n");
  assert.deepEqual(out, ["2026-11-22T03:22:42.576Z  WARN chisel_agent::x: something bad\n"]);
});

test("stderr forwarder drops ANSI-colored INFO", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write);
  fwd.push("\x1b[32m2026-11-22T03:22:42.575Z  INFO chisel_agent::x: hi\x1b[0m\n");
  assert.equal(out.length, 0);
});

test("stderr forwarder handles lines split across chunks", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write);
  fwd.push("2026-11-22T03:22:42.575Z  INFO chisel_agent::x: par");
  fwd.push("tial line\n2026-11-22T03:22:42.576Z ERROR real: boom\n");
  assert.deepEqual(out, ["2026-11-22T03:22:42.576Z ERROR real: boom\n"]);
});

test("stderr forwarder keeps non-tracing lines", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write);
  fwd.push("plain startup line\n");
  fwd.push("2026-11-22T03:22:42.575Z DEBUG chisel_agent::x: dbg\n");
  fwd.push("2026-11-22T03:22:42.575Z TRACE chisel_agent::x: trc\n");
  assert.deepEqual(out, ["plain startup line\n"]);
});

test("stderr forwarder all=true keeps INFO", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write, true);
  fwd.push("2026-11-22T03:22:42.575Z  INFO chisel_agent::x: hi\n");
  assert.equal(out.length, 1);
});

test("stderr forwarder keeps multibyte chars split across Buffers", () => {
  const { out, write } = collect();
  const fwd = createStderrForwarder(write);
  const buf = Buffer.from("中文日志\n", "utf8");
  fwd.push(buf.subarray(0, 4));
  fwd.push(buf.subarray(4));
  assert.deepEqual(out, ["中文日志\n"]);
});

test("stderr forwarder end() emits unterminated WARN and drops unterminated INFO", () => {
  const a = collect();
  const fwdA = createStderrForwarder(a.write);
  fwdA.push("2026-11-22T03:22:42.576Z  WARN tail: no newline");
  fwdA.end();
  assert.deepEqual(a.out, ["2026-11-22T03:22:42.576Z  WARN tail: no newline\n"]);
  const b = collect();
  const fwdB = createStderrForwarder(b.write);
  fwdB.push("2026-11-22T03:22:42.577Z  INFO tail: dropped");
  fwdB.end();
  assert.deepEqual(b.out, []);
});
