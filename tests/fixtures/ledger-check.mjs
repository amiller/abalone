// Reconcile a node ledger: node ledger-check.mjs <ledger.jsonl> [status-json]. Prints "reconciled" (and
// "status matches" when the core's live status is given) or throws naming the broken invariant.
import fs from "node:fs";
const [file, statusJson] = process.argv.slice(2);
const E = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const prices = new Map((await (await fetch("https://cloud-api.near.ai/v1/models")).json()).data.map((m) => [m.id, m.pricing]));
const must = (ok, what) => { if (!ok) throw new Error(`ledger: ${what}`); };
const funded = E.filter((e) => e.type === "fund").reduce((s, e) => s + e.amount, 0);
const grants = new Map(E.filter((e) => e.type === "claim").map((e) => [e.account, e]));
// A lost claim (optimistic window, then the chain gave the code to another peer) commits only what this peer served.
const lost = new Map(E.filter((e) => e.type === "lost").map((e) => [e.account, e]));
const commit = (g) => lost.has(g.account) ? lost.get(g.account).served : g.amount;
const spent = new Map(), idems = new Set(), byNode = {};
// With a chain, every debit must fall inside a window that was checkpointed before it (window entries precede it).
const covered = new Map();
for (const d of E.filter((e) => e.type === "debit" || e.type === "window")) {
  if (d.type === "window") { covered.set(d.account, d.covered); continue; }
  must(grants.has(d.account), `debit on unknown account ${d.account}`);
  must(!idems.has(`${d.account}:${d.idem}`), `two debits for one idempotency key ${d.idem}`);
  idems.add(`${d.account}:${d.idem}`);
  const p = prices.get(d.model);
  must(d.usage ? d.charge === Math.ceil(d.usage.prompt_tokens * p.input + d.usage.completion_tokens * p.output) : d.charge === d.hold, `charge ${d.charge} for ${d.idem} does not match usage × price`);
  must(d.charge <= d.hold, `charge above its hold for ${d.idem}`);
  spent.set(d.account, (spent.get(d.account) ?? 0) + d.charge);
  if (covered.has(d.account) && !d.writeoff) must(spent.get(d.account) <= covered.get(d.account), `account ${d.account.slice(0, 8)} spent past its checkpointed window`);
  must(d.slice === grants.get(d.account).slice, `debit ${d.idem} is on a slice its gift does not have`);
  byNode[d.slice.slice(0, 12)] = (byNode[d.slice.slice(0, 12)] ?? 0) + d.charge;
}
for (const [a, s] of spent) must(s <= grants.get(a).amount, `account ${a.slice(0, 8)} spent ${s} > ${grants.get(a).amount}`);
must([...grants.values()].reduce((s, g) => s + commit(g), 0) <= funded, "claims exceed the reserve");
// Optimistic windows are checked on their own: a lost account was served only inside its optimistic window.
const optimistic = new Map(E.filter((e) => e.type === "window" && e.optimistic).map((e) => [e.account, e.covered]));
for (const [a, l] of lost) {
  must(optimistic.has(a), `lost claim ${a.slice(0, 8)} had no optimistic window`);
  must((spent.get(a) ?? 0) === l.served && l.served <= optimistic.get(a), `lost claim ${a.slice(0, 8)} served ${spent.get(a) ?? 0} (recorded ${l.served}) past its optimistic window ${optimistic.get(a)}`);
}
if (lost.size) console.log(`optimistic losses: ${lost.size} claim(s), ${[...lost.values()].reduce((s, l) => s + l.served, 0)} µ$ served at the peer's risk`);
console.log(`funded ${funded} µ$, granted ${[...grants.values()].reduce((s, g) => s + g.amount, 0)} µ$ over ${grants.size} gifts, ${idems.size} debits = ${[...spent.values()].reduce((a, b) => a + b, 0)} µ$; by slice ${JSON.stringify(byNode)}`);
console.log("reconciled");
if (statusJson) {
  const st = JSON.parse(statusJson);
  for (const g of st.gifts) {
    const a = [...grants.keys()].find((k) => k.startsWith(g.account));
    must(g.spent === (spent.get(a) ?? 0) && g.held === 0 && g.remaining === g.amount - g.spent, `live status for ${g.account} differs from the ledger`);
  }
  console.log("status matches");
}
