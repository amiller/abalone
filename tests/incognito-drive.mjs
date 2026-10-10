// One strict-incognito turn over Pi's RPC mode: node tests/incognito-drive.mjs <provider/model> <message> [abalone args...]
// With ABALONE_PASSPHRASE_FD=3 (for --with-trace), fd 3 is passed through. Prints the events as JSON lines on stdout; the launcher's close summary goes to stderr.
import { runPrompt } from "../lib/rpc.mjs";
const [model, message, ...rest] = process.argv.slice(2);
const { events, stderr } = await runPrompt({ args: ["--incognito", "--model", model, ...rest], message, fds: process.env.ABALONE_PASSPHRASE_FD ? ["inherit"] : [], onUi: (ev) => { throw new Error(`unexpected ${ev.method} dialog: ${ev.title}`); } });
for (const e of events) console.log(JSON.stringify(e));
process.stderr.write(stderr);
