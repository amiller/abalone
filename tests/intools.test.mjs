// The in-content tool call parser (lib/intools.mjs): which <tool_call> bodies become requests, and which stay as written
// (reported "not executed"). The <arg_NAME> spelling is the one Qwen3.8-27B wrote in the preview.7 live edit task (tests/regress/0007).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requests, respond } from "../lib/intools.mjs";

const call = (body) => requests(`<tool_call>${body}</tool_call>`)[0];
const parsed = (body) => JSON.parse(call(body));
const kept = (body) => assert.equal(call(body), body.trim(), `parsed: ${body}`);

test("the taught arg_key/arg_value shape parses, multi-line values included", () => {
  assert.deepEqual(parsed("list\n<arg_key>path</arg_key>\n<arg_value>.</arg_value>\n"), { op: "list", path: "." });
  assert.deepEqual(parsed("read<arg_key>path</arg_key><arg_value>a.txt</arg_value><arg_key>from</arg_key><arg_value>3</arg_value>"), { op: "read", path: "a.txt", from: 3 });
  assert.deepEqual(parsed("write\n<arg_key>path</arg_key>\n<arg_value>n.txt</arg_value>\n<arg_key>content</arg_key>\n<arg_value>first line\nsecond line</arg_value>\n"), { op: "write", path: "n.txt", content: "first line\nsecond line" });
  assert.deepEqual(parsed("list"), { op: "list" });
  assert.deepEqual(parsed("browser<arg_key>action</arg_key><arg_value>open</arg_value>"), { op: "browser", action: "open" }, "an unknown op still parses, to be refused by name");
});

test("<arg_NAME> parses when NAME is an argument of that op, alone or mixed with arg_key pairs", () => {
  assert.deepEqual(parsed("write\n<arg_key>path</arg_key>\n<arg_value>rota.txt</arg_value>\n<arg_content>a\nb\n</arg_content>\n"), { op: "write", path: "rota.txt", content: "a\nb\n" });
  assert.deepEqual(parsed("write<arg_path>x.md</arg_path><arg_content></arg_content>"), { op: "write", path: "x.md", content: "" });
  assert.deepEqual(parsed("read<arg_path>a.txt</arg_path><arg_lines>5</arg_lines>"), { op: "read", path: "a.txt", lines: 5 });
  assert.deepEqual(parsed("goto<arg_url>https://example.org/</arg_url>"), { op: "goto", url: "https://example.org/" });
  assert.deepEqual(parsed("write<arg_path>x</arg_path><arg_content><arg_key>path</arg_key><arg_value>y</arg_value></arg_content>"), { op: "write", path: "x", content: "<arg_key>path</arg_key><arg_value>y</arg_value>" },
    "tags inside a value are its text, not arguments");
});

test("malformed or ambiguous calls stay as written", () => {
  kept("read\n<arg_path>a.txt</arg_path>\n<arg_content>x</arg_content>"); // content is not an argument of read
  kept("browser<arg_url>https://example.org/</arg_url>"); // no declared arguments for an unknown op
  kept("write<arg_path>a</arg_path><arg_Content>x</arg_Content>");
  kept("write<arg_path>a</arg_path><arg_content>x</arg_path>");
  kept("write<arg_path>a</arg_path><arg_content>x"); // unclosed
  kept("write<arg_path>a</arg_path><arg_content><arg_content>x</arg_content></arg_content>"); // nested
  kept("write<arg_content>x</arg_content><arg_path>evil</arg_path>y</arg_content>"); // a value ends at its first closing tag; the rest must parse
  kept("write<arg_key>content</arg_key><arg_value>x</arg_value>y</arg_value><arg_key>path</arg_key><arg_value>a</arg_value>");
  kept("write<arg_key>path</arg_key><arg_value>a</arg_value><arg_path>b</arg_path><arg_content>x</arg_content>"); // repeated name
  kept("list<arg_key>path</arg_key><arg_value>a</arg_value><arg_key>path</arg_key><arg_value>b</arg_value>");
  kept("list<arg_key>path</arg_key>"); // a key with no value
  kept("list<arg_value>.</arg_value>");
  kept("list<arg_path>.</arg_path> trailing words");
  kept("constructor<arg_x>1</arg_x>"); // an Object.prototype name is not an op with declared arguments
  kept("OUSE: use_tool\n<arg_key>arguments</arg_key>\n<arg_value>{\"command\": \"ls\"}</arg_value>"); // regress 0002
  assert.deepEqual(requests("<tool_call>write<arg_path>a</arg_path><arg_content>x"), ["<tool_call>write<arg_path>a</arg_path><arg_content>x"]);
});

test("the recorded preview.7 write runs; a refused one is not executed", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-intools-"));
  const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "regress/0007/fixture.json"), "utf8"));
  const reqs = requests(fx.turns[0].steps[2].model);
  const r = await respond(cwd, reqs, () => { throw new Error("no browser"); });
  assert.deepEqual(r.bad, []);
  assert.match(r.results[0].output, /^wrote \d+ bytes to rota\.txt$/);
  assert.match(fs.readFileSync(path.join(cwd, "rota.txt"), "utf8"), /^Thursday: Joan Castellanos\nFriday: Priya Raman$/m);
  const refused = await respond(cwd, requests("<tool_call>write<arg_path>b.txt</arg_path><arg_content>x</arg_content><arg_path>c.txt</arg_path></tool_call>"), () => {});
  assert.match(refused.line, /^not executed: abalone couldn't read this tool request/);
  assert.match((await respond(cwd, requests("<tool_call>constructor<arg_x>1</arg_x></tool_call>"), () => {})).line, /^not executed: /);
  assert.deepEqual(fs.readdirSync(cwd), ["rota.txt"]);
  fs.rmSync(cwd, { recursive: true });
});
