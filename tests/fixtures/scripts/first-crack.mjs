// The private reader for an outside model (policy.json mediator in the session tests). It answers from the material
// abalone gave it (and says when a file was missing), drafts a pour without the file's date, and checks the open answer.
// As a selected private model, it says whether abalone added the mentioned file to its request.
const text = (m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
export default (msgs) => {
  const users = msgs.filter((m) => m.role === "user").map(text), last = users.at(-1);
  if (last.includes("<<<OPEN ANSWER")) return { text: "The open answer agrees with the file: the form is due by 15 November 2026 [L19]." };
  if (last.includes("pour-planning")) return { text: JSON.stringify({ needed: !users[0].includes("NOT NEEDED"), help: "What happens when a fixed-term tenancy ends without a signed renewal.", policy: "free_text",
    payload: users[0].includes("NOTHING PERMITTED") ? "" : "Under a typical residential tenancy in England, if the tenant neither signs a renewal nor leaves when a fixed term ends, what happens next?",
    reveals: "The jurisdiction, and that the user is a tenant facing a renewal deadline." }) };
  if (users[0].includes("<<<CONVERSATION")) return { text: users[0].includes("L19: To accept, sign and return the enclosed renewal form by 15 November 2026.")
    ? "The file says to return the signed form by 15 November 2026 [L19]; otherwise the tenancy ends on 31 January 2027 [L21]." : "I was not given the file." };
  // "what's in this folder": answer from abalone's folder listing, which is all this model can see of the folder.
  if (last.startsWith("what's in this folder")) { const m = users[0].match(/\[folder [^\n]*listed by abalone on this computer\]\n([\s\S]*)$/); return { text: m ? `Files here, from abalone's listing:\n${m[1]}` : "I was not given a listing." }; }
  const read = /\[file tenancy-renewal\.txt, \d+ lines, read by abalone[\s\S]*\nL19: To accept, sign and return/.test(last);
  return { text: `private model turn, file read by abalone: ${read ? "yes" : "no"}` };
};
