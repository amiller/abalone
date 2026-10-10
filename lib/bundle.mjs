// abalone-task-bundle/1 (notes/contracts/receipt-v1.md, task-v1.md "The bundle"): offline verification of a collected
// task directory. Three claims kept apart: integrity, admitted execution, task outcome. Every check runs; each failure
// is listed. Two attested signers:
//   completion.sig  the worker peer's runner, App Attest assertion over abalone-task-completion/1|h(completion);
//   guest/          the task VM's boot clientData (task compose_hash, receipt_pub), bound by a runner assertion, and the
//                   runner's receipts for that VM (task-start … exit) under receipt_pub.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { peerIdFromString } from "@libp2p/peer-id";
import { verifyAssertion, verifyAttestation } from "./appattest.mjs";
import { verifyMacRunner } from "./vendor/macrunner.mjs";
import { V, h, check as shape, completionData } from "./contracts/task-v1.mjs";
import { verify as ed25519 } from "./gift.mjs";

export const TASK_BOOT_DOMAIN = "mac-compose-task-boot/1"; // must differ from guest-callable /attest (mac-compose-assert/1)
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const must = (ok, what) => { if (!ok) throw new Error(what); };
const short = (x) => `${String(x).slice(0, 12)}…`;
const p256 = (hex) => crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(hex, "hex").subarray(1, 33).toString("base64url"), y: Buffer.from(hex, "hex").subarray(33).toString("base64url") }, format: "jwk" });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

// Regular files of a ustar archive: {path: Buffer}.
export function untar(buf) {
  const files = {};
  for (let i = 0; i + 512 <= buf.length && buf[i];) {
    const hd = buf.subarray(i, i + 512), str = (a, b) => hd.subarray(a, b).toString().replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8), name = [str(345, 500), str(0, 100)].filter(Boolean).join("/");
    if ([0, 48].includes(hd[156])) files[name.replace(/^\.\//, "")] = buf.subarray(i + 512, i + 512 + size);
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// A runner receipt chain (runner README "Receipt") under one boot's receipt key: the bodies, in order.
export function runnerChain(lines, receiptPub, compose) {
  let prev = "0".repeat(64);
  return lines.map((l, i) => {
    const e = JSON.parse(l);
    must(crypto.verify("sha256", Buffer.from(e.body), { key: p256(receiptPub), dsaEncoding: "der" }, Buffer.from(e.sig, "hex")), `runner receipt ${i + 1}: signature does not verify under the task VM's receipt key (altered, or signed by another key)`);
    const b = JSON.parse(e.body);
    must(b.domain === "mac-compose-receipt/1" && b.seq === i + 1 && b.prev === prev && b.compose_hash === compose, `runner receipt ${i + 1}: chain broken or another compose`);
    prev = sha(e.body);
    return b;
  });
}

// The runner's App Attest assertion over a task VM's boot clientData (runner notes/abalone-node-interface.md): the
// asserted bytes are the clientData itself, domain mac-compose-task-boot/1, which the guest-callable /attest cannot
// produce (it wraps data in mac-compose-assert/1). The key is the peer VM's enrollment, so the peer compose must be
// admitted too. Historical: certificates checked at that enrollment's time.
export function taskBoot(a, clientData, admit) {
  must(a.type === "macrunner", `guest/attest.json is ${a.type}, not runner evidence`);
  const enrollBytes = Buffer.from(a.bootClientData, "base64"), enroll = JSON.parse(enrollBytes), policy = { appId: admit.task.appId, cdhashes: admit.macrunner.cdhashes, category: admit.task.category };
  const v = verifyAttestation(Buffer.from(a.attestation, "base64"), a.keyId, enrollBytes, policy, new Date(enroll.enrolled_at * 1000));
  must(["mac-compose-boot/1", "mac-compose-enroll/1"].includes(enroll.domain) && enroll.attested === true, `runner enrollment domain ${enroll.domain}`);
  must(admit.macrunner.composeHashes.includes(enroll.compose_hash), `the enrolled peer compose ${short(enroll.compose_hash)} is not admitted by your policy`);
  const asserted = Buffer.from(a.assertClientData, "base64"), s = verifyAssertion(Buffer.from(a.assertion, "base64"), asserted, v.publicKey, policy);
  must(s.cdhash === v.cdhash, "assertion CDHash differs from the enrollment's");
  const domain = JSON.parse(asserted).domain;
  must(domain === TASK_BOOT_DOMAIN, `the runner's assertion is over a ${domain} record, not ${TASK_BOOT_DOMAIN}: a peer-requested /attest assertion cannot vouch for a task boot`);
  must(asserted.equals(clientData), "the runner's assertion is over a different task boot");
  return { cdhash: v.cdhash, enrolled_at: enroll.enrolled_at, peer_compose: enroll.compose_hash };
}

// Settlement consistency, all from signed or chained records: the task-settle figures against the authorization's cap,
// the usage, the offer's tariff, the charge events in the worker's chain and (if present) the runner's measured seconds.
export function settlement(c, auth, offer, events, runnerExit) {
  const s = c.settlement, u = c.usage, charges = events.filter((e) => e.kind === "charge").map((e) => e.data);
  must(s, "completion has no settlement (bundle predates receipt-v1 settlement)");
  must(s.entry === `task:${c.task_id}:settle` && /^[0-9a-f]{64}$/.test(s.entry_sha256), "the completion cites no task-settle entry for this task");
  must(s.reserved === auth.cap && u.reserved === auth.cap, `reserved ${s.reserved} µ$ is not the authorization's cap ${auth.cap} µ$`);
  must(s.charged + s.released === s.reserved && s.charged <= auth.cap, `charged ${s.charged} + released ${s.released} ≠ reserved ${s.reserved} µ$, or over the cap`);
  must(u.charged === s.charged && u.released === s.released && u.settled === true, "usage and settlement disagree");
  must(u.execution.charge + u.inference.charge + u.storage.charge === s.charged, `execution ${u.execution.charge} + inference ${u.inference.charge} µ$ ≠ charged ${s.charged} µ$`);
  must(charges.reduce((a, x) => a + x.amount, 0) === s.charged && charges.map((x) => x.idem).join() === s.debits.join(), "the charge events in events.jsonl do not add up to the settlement's debits");
  must(u.sponsored === offer.tariff.sponsored && u.execution.per_second === offer.tariff.execution_per_second && u.tariff_version === offer.tariff.version, "usage is not priced by the offer's tariff");
  must(u.execution.charge <= Math.ceil(u.execution.per_second * u.execution.seconds), `execution charge ${u.execution.charge} µ$ exceeds ${u.execution.seconds} s × ${u.execution.per_second} µ$/s`);
  if (runnerExit) must(u.execution.seconds <= runnerExit.wall_seconds + 1, `billed ${u.execution.seconds} s of execution, but the runner measured ${runnerExit.wall_seconds} s`);
  return `settlement adds up: reserved ${s.reserved} = charged ${s.charged} + released ${s.released} µ$; ${charges.length} charge events match its debits; priced by the offer's tariff ${u.tariff_version}${runnerExit ? "; billed seconds within the runner's measurement" : ""}`;
}

// admit: providers.json peers.admit. expect: the authorization object the client issued. seen: [{task_id, record}]
// the client already accepted.
export function verifyBundle(dir, { admit, expect, seen = [] }) {
  const r = { label: "", integrity: [], execution: [], outcome: [], failures: [], unknowns: [], freshness: [], assumptions: [] };
  const check = (claim, fn) => { try { const m = fn(); if (m) r[claim].push(m); } catch (e) { r.failures.push(`${claim}: ${e.message}`); } };
  const has = (p) => fs.existsSync(path.join(dir, p)), raw = (p) => fs.readFileSync(path.join(dir, p)), json = (p) => JSON.parse(raw(p));
  const index = json("bundle.json");
  must(index.v === "abalone-task-bundle/1", `not an abalone-task-bundle/1 (v ${index.v})`);
  if (has("FIXTURE")) { r.label = "fixture"; r.unknowns.push(`FIXTURE: ${raw("FIXTURE").toString().trim()}`); }
  const completion = json("completion.json"), { authorization: auth, request } = json("authorization.json"), offer = json("offer.json");

  check("integrity", () => {
    const listed = Object.keys(index.files), present = walk(dir).map((f) => path.relative(dir, f)).filter((p) => !["bundle.json", "FIXTURE"].includes(p));
    for (const p of listed) must(has(p) && sha(raw(p)) === index.files[p], `${p} differs from bundle.json's hash (altered or missing)`);
    for (const p of present) must(listed.includes(p), `${p} is not listed in bundle.json`);
    shape("completion", { ...completion, settlement: completion.settlement ?? {} }); // a missing settlement is its own failure below shape("authorization", auth); shape("offer", offer);
    must(completion.task_id === index.task_id, "bundle.json names another task");
    return `bundle.json lists ${listed.length} files, all present and matching`;
  });

  // The completion signature: the worker peer's runner (attested) or the peer's libp2p key (bare host signature).
  const sig = json("completion.sig");
  check("integrity", () => {
    if (sig.type === "macrunner") return must(JSON.parse(Buffer.from(sig.assertClientData, "base64")).data === completionData(completion), "completion.sig is an assertion over a different completion"), "completion.sig names this completion; its App Attest signature is checked under claim 2";
    must(sig.type === "peer-ed25519" && sig.data === completionData(completion), "completion.sig is not over this completion");
    must(sig.peer === completion.worker.peer && peerIdFromString(sig.peer).publicKey.verify(Buffer.from(sig.data), Buffer.from(sig.sig, "hex")), "completion.sig does not verify under the worker's PeerId key");
    return `the completion is signed by worker ${short(sig.peer)}'s PeerId key`;
  });
  check("execution", () => {
    must(sig.type === "macrunner", `the completion is signed by the worker's PeerId key only (${sig.type}): a bare host signature, not attested execution`);
    const enroll = JSON.parse(Buffer.from(sig.bootClientData, "base64"));
    const v = verifyMacRunner(sig, { cdhashes: admit.macrunner.cdhashes, composeHashes: admit.macrunner.composeHashes, expectData: completionData(completion), now: new Date(enroll.enrolled_at * 1000) });
    must(v.compose_hash === completion.peer_evidence.compose_hash, "the signing runner's peer compose is not the one the completion names");
    return `the worker peer's completion is asserted by Apple App Attest (as of ${new Date(enroll.enrolled_at * 1000).toISOString()}) from runner CDHash ${short(v.cdhash)} running peer image ${short(v.compose_hash)}, both admitted by your policy`;
  });

  check("integrity", () => {
    must(h(auth) === completion.auth_hash && auth.task_id === completion.task_id, `the completion is for authorization ${short(completion.auth_hash)}, not the bundled one (${short(h(auth))})`);
    must(auth.inputs_root === completion.inputs_root && auth.offer_id === completion.offer_id && offer.offer_id === auth.offer_id, "the completion, authorization and offer disagree on inputs or offer");
    must(auth.worker === completion.worker.peer, `the authorization names worker ${short(auth.worker)}, but ${short(completion.worker.peer)} completed it`);
    if (expect) must(h(expect) === h(auth), `the bundled authorization (task ${auth.task_id}) is not the one you issued (task ${expect.task_id})`);
    else r.unknowns.push("no --expect: the authorization was not compared with your own copy");
    must(ed25519(auth.device, [V, "commission", auth.task_id, request.ts, request.idem, request.body_hash].join("\n"), request.sig), "the commission request's device signature does not verify");
    r.unknowns.push("the device signed a commission body by hash; that body also holds the input files, which the bundle omits, so its link to this authorization rests on the worker");
    return `task ${auth.task_id}: authorization ${short(h(auth))} (device ${short(auth.device)}, cap ${auth.cap} µ$), ${auth.inputs.length} inputs committed by sha256 (root ${short(auth.inputs_root)})`;
  });

  check("integrity", () => {
    const evs = raw("events.jsonl").toString().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let prev = "0".repeat(64);
    for (const [i, e] of evs.entries()) { shape("event", e); must(e.seq === i + 1 && e.prev === prev, `event ${i + 1}: chain broken: an event is missing, reordered or inserted`); prev = e.hash; }
    must(evs.length === completion.events.count && prev === completion.events.head, "events.jsonl is not the chain the completion commits to");
    const outs = walk(path.join(dir, "outputs")).map((f) => path.relative(path.join(dir, "outputs"), f));
    for (const o of completion.outputs) must(has(`outputs/${o.path}`) && sha(raw(`outputs/${o.path}`)) === o.sha256, `output ${o.path} has been altered (its sha256 is not the completion's)`);
    for (const p of outs) must(completion.outputs.some((o) => o.path === p), `output ${p} is not in the completion`);
    return `${evs.length} worker events in one chain (head ${short(prev)}); ${completion.outputs.length} output files match the completion; status ${completion.status}${completion.reason ? ` (${completion.reason})` : ""}`;
  });

  // The task VM, from the runner's own record.
  let guestBoot, runnerExit;
  if (!has("guest/clientData.bin")) r.failures.push("execution: no guest/ record: the task did not run in a runner task VM (local executor), so nothing attests where it ran");
  else {
    guestBoot = JSON.parse(raw("guest/clientData.bin"));
    const taskCompose = JSON.parse(raw("guest/app-compose.json")), taskService = () => { const v = Object.values(JSON.parse(taskCompose.docker_compose_file).services); must(v.length === 1, "the task compose does not have exactly one service"); return v[0]; };
    const compose = sha(raw("guest/app-compose.json")), events = [];
    check("integrity", () => {
      must(guestBoot.domain === TASK_BOOT_DOMAIN, `guest/clientData.bin has domain ${guestBoot.domain}, not ${TASK_BOOT_DOMAIN}`);
      must(guestBoot.compose_hash === compose && compose === completion.guest.compose_hash, "the task VM's compose, boot record and the completion disagree");
      const lines = raw("guest/receipts.jsonl").toString().split("\n").filter(Boolean);
      events.push(...runnerChain(lines, guestBoot.receipt_pub, compose));
      must(lines.length === completion.guest.receipts.count && sha(lines.at(-1) ?? "") === completion.guest.receipts.head, "guest/receipts.jsonl is not the chain the completion commits to");
      const [start] = events, exit = events.at(-1);
      runnerExit = exit;
      must(start?.event === "task-start" && exit?.event === "exit", "the runner's chain does not run from task-start to exit");
      const labels = taskService().labels;
      must(labels["abalone.task_id"] === auth.task_id && labels["abalone.auth_hash"] === h(auth) && labels["abalone.inputs_root"] === auth.inputs_root, "the task VM's compose labels name another task, authorization or inputs");
      if (has("guest/out.tar")) {
        const tar = raw("guest/out.tar"), files = Object.fromEntries(Object.entries(untar(tar)).map(([p, d]) => [p.replace(/^out\//, ""), d]));
        must(sha(tar) === exit.out_sha256, "guest/out.tar is not the output the runner hashed at exit");
        for (const o of completion.outputs) must(files[o.path] && sha(files[o.path]) === o.sha256, `output ${o.path} is not what the task VM left in /out`);
      } else r.unknowns.push(`no guest/out.tar: the outputs are not linked to the runner's exit hash ${short(exit.out_sha256)}`);
      return `the runner recorded the task VM from task-start (inputs tar ${short(start.inputs_sha256)}) to exit (code ${exit.exit_code}, ${exit.wall_seconds} s) in ${events.length} signed receipts; its compose labels bind this task, authorization and inputs`;
    });
    check("execution", () => {
      must(guestBoot.attested === true, "the task VM's runner was not attested (dev): nothing ties its receipt key to a measured binary");
      const { cdhash, enrolled_at, peer_compose } = taskBoot(json("guest/attest.json"), raw("guest/clientData.bin"), admit), image = taskService().image, eg = taskCompose.egress;
      must(admit.task.images.includes(image.split("@").pop()) && image === offer.runtime.image, `task image ${image} is not admitted by your policy or not the offered one`);
      must(taskCompose.kms_enabled === false && !eg.allow.length && !(eg.tcp ?? []).length && eg.max_requests === 0 && eg.max_tokens === 0, "the task compose is not the no-network, no-KMS template");
      return `Apple App Attest (as of ${new Date(enrolled_at * 1000).toISOString()}) → runner CDHash ${short(cdhash)} (admitted), asserting for peer image ${short(peer_compose)} (admitted) → task VM boot (no network, no KMS), image ${image} (admitted), receipt key ${short(guestBoot.receipt_pub)}`;
    });
  }

  // Replay: a second, different execution (another task VM receipt key, or event chain) under an accepted task_id.
  const record = guestBoot?.receipt_pub ?? completion.events.head;
  r.record = { task_id: auth.task_id, record };
  check("integrity", () => {
    must(seen.filter((s) => s.task_id === auth.task_id).every((s) => s.record === record), `task ${auth.task_id} already has an accepted execution with a different record: this authorization was replayed`);
    if (!seen.length) r.unknowns.push("no --seen record: one bundle cannot show it is the only execution of its authorization");
  });
  check("integrity", () => settlement(completion, auth, offer, raw("events.jsonl").toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)), runnerExit));
  check("outcome", () => {
    const u = completion.usage, st = completion.settlement, label = u.sponsored ? "Sponsored (development tariff): not paid execution" : "Paid (gift credit)";
    const exec = `execution ${u.execution.seconds} s × ${u.execution.per_second} µ$/s = ${u.execution.charge} µ$${runnerExit ? ` (runner measured ${runnerExit.wall_seconds} s)` : ""}; inference ${u.inference.calls} calls = ${u.inference.charge} µ$`;
    if (!st) return `${label}: ${exec}; charged ${u.charged} µ$ by the worker's usage report, with no settlement record`;
    r.unknowns.push(`settlement entry ${st.entry} is cited by its line hash ${short(st.entry_sha256)}; whether the worker's ledger holds that line is checked online (tools/reconcile-tasks.mjs), not here`);
    return `${label}: reserved ${st.reserved} µ$; ${exec}; charged ${st.charged} µ$, released ${st.released} µ$, settled by ${st.entry}`;
  });
  check("outcome", () => {
    const touched = has("outputs/patch.diff") ? [...raw("outputs/patch.diff").toString().matchAll(/^\+\+\+ b\/(.*)$/gm)].map((m) => m[1]) : [];
    const tests = touched.filter((p) => /(^|\/)(tests?|spec)(\/|\.|_)|\.(test|spec)\./.test(p));
    const patch = `The patch changes ${touched.length} file(s)${tests.length ? `, INCLUDING TEST FILES: ${tests.join(", ")}` : ", none of them test files"}`;
    if (!auth.task.check && !has("outputs/test.log")) return `no test was requested (the authorization names no check), so none ran. ${patch}`;
    must(has("outputs/test.log"), `the authorization asked for \`${auth.task.check}\`, but there is no outputs/test.log: no test result was recorded`);
    const log = raw("outputs/test.log").toString(), cmd = log.match(/^\$ (.*)$/m)?.[1], exit = log.match(/\nexit (\S+)\n?$/)?.[1];
    return `the task ran \`${cmd}\`, which exited ${exit}${auth.task.check ? ` (the authorization asked for \`${auth.task.check}\`)` : ""}. ${patch}. This is evidence the tests ran and how they exited, not that the change is correct or the tests adequate`;
  });

  r.assumptions.push("Apple App Attest and the Mac's SIP and Secure Boot hold", "the runner, as measured by its CDHash, isolates the task VM and alone holds its receipt key", "the admitted peer image built /in from exactly the authorized inputs and reports usage honestly", "the Mac's owner can read the task's data: this is not confidentiality", "events neither the runner nor the peer observed are not covered");
  r.freshness.push("admission is judged by your current policy; whether it differed at run time is not recorded", "revocation: unknown (no revocation feed is consulted)");
  if (sig.type === "macrunner") check("freshness", () => {
    try { verifyMacRunner(sig, { cdhashes: admit.macrunner.cdhashes, composeHashes: admit.macrunner.composeHashes, expectData: completionData(completion) }); return "the completion's Apple evidence would still pass today"; }
    catch (e) { return `checked today instead of at enrollment: ${e.message.replace(/^✗ refused: /, "")} (expected for an old run; the historical check is what counts)`; }
  });
  r.ok = !r.failures.length;
  return r;
}

export function describe(r) {
  const sec = (t, xs) => [t, ...xs.map((s) => `  - ${s}`)];
  const ok = (c) => !r.failures.some((f) => f.startsWith(c));
  return [
    `abalone verify: ${r.ok ? "VERIFIED" : "REJECTED"}${r.label ? ` [${r.label.toUpperCase()}]` : ""}`,
    ...sec(`1. Integrity (signatures and content): ${ok("integrity") ? "holds" : "FAILS"}`, r.integrity),
    ...sec(`2. An admitted execution produced this record: ${ok("execution") && r.execution.length ? "established" : "NOT established"}`, [...r.execution, ...r.assumptions.map((a) => `assumes: ${a}`)]),
    ...sec(`3. Task outcome (evidence, not a proof of correctness): ${ok("outcome") ? "recorded" : "not recorded"}`, r.outcome),
    ...sec("Failures", r.failures.length ? r.failures : ["none"]), ...sec("Unknowns", r.unknowns),
    ...sec("Freshness (separate from historical verification)", r.freshness),
    `Replay record (append to your --seen file once you accept this bundle): ${r.record.task_id} ${r.record.record}`,
  ].join("\n");
}
