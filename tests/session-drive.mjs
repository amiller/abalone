// Drive one interactive-session turn over Pi's RPC mode. Answers each dialog in order from CHOICES (a JSON list of
// select values, or {"editor": "<file>"} for the editor), then prints the events as JSON lines on stdout.
// usage: CHOICES='["continue privately"]' node tests/session-drive.mjs <provider/model, or - for the default> <message> [abalone args, such as --continue]
import fs from "node:fs";
import { runPrompt } from "../lib/rpc.mjs";

const [model, message, ...rest] = process.argv.slice(2), choices = JSON.parse(process.env.CHOICES ?? "[]");
const { events } = await runPrompt({ args: [...(model === "-" ? [] : ["--model", model]), ...rest], message, onUi: (ev) => {
  const c = choices.shift();
  if (c === undefined) throw new Error(`unexpected ${ev.method} dialog: ${ev.title}`);
  if (ev.method === "editor") return { value: fs.readFileSync(c.editor, "utf8") };
  if (!ev.options.includes(c)) throw new Error(`"${c}" is not an option of ${JSON.stringify(ev.options)}`);
  return { value: c };
} });
if (choices.length) throw new Error(`unused choices: ${JSON.stringify(choices)}`);
for (const e of events) console.log(JSON.stringify(e));
