// STUB_SCRIPT for tests/regress: the reported turn's recorded model replies, in order. A recorded error is thrown again, as is a call past the recording.
import fs from "node:fs";
const fx = JSON.parse(fs.readFileSync(process.env.REGRESS_FIXTURE, "utf8"));
const replies = fx.turns.at(-1).steps.filter((s) => "model" in s);
const text = (m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
export default (msgs) => {
  // REGRESS_ECHO: the follow-up turn of a next_sees check answers with what the model was sent since its last reply.
  if (process.env.REGRESS_ECHO) return { text: msgs.slice(msgs.findLastIndex((m) => m.role === "assistant") + 1).map(text).join("\n") };
  const n = msgs.filter((m) => m.role === "assistant").length;
  if (n >= replies.length) throw new Error(`replay exhausted: model call ${n + 1}, but the fixture recorded ${replies.length}`);
  if (replies[n].error) throw new Error(replies[n].error);
  return { text: replies[n].model, thinking: replies[n].thinking };
};
