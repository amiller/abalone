// abalone-task/1 (notes/contracts/task-v1.md): canonical JSON, hashes, the signed request message, and shape checks.
import crypto from "node:crypto";

export const V = "abalone-task/1";
export const canonical = (x) => Array.isArray(x) ? `[${x.map(canonical).join(",")}]`
  : x && typeof x === "object" ? `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`
  : JSON.stringify(x);
export const h = (x) => crypto.createHash("sha256").update(canonical(x)).digest("hex");
export const requestMsg = (op, task_id, ts, idem, body) => [V, op, task_id, ts, idem, h(body)].join("\n");
export const completionData = (completion) => `abalone-task-completion/1|${h(completion)}`;
export const offerId = ({ offer_id, ...o }) => h(o);
export const OPS = ["commission", "watch", "instruct", "take", "release", "bash", "stop", "status", "collect", "list"];
export const TERMINAL = ["completed", "failed", "cancelled", "budget_exhausted", "timed_out", "worker_lost"];
export const STATES = ["booting", "running", ...TERMINAL];

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const T = {
  str: (v) => typeof v === "string", int: (v) => Number.isSafeInteger(v) && v >= 0, bool: (v) => typeof v === "boolean",
  hex64: (v) => HEX(64).test(v), id: (v) => HEX(32).test(v), arr: Array.isArray, obj: (v) => v && typeof v === "object" && !Array.isArray(v),
};
const SHAPES = {
  offer: { v: (x) => x === V, type: (x) => x === "offer", offer_id: T.hex64, worker: T.obj, evidence: T.obj, runtime: T.obj, resources: T.arr, network: T.obj, inference: T.obj, accepts: T.arr, persistence: T.obj, tariff: T.obj, expiry: T.int },
  authorization: { v: (x) => x === V, type: (x) => x === "authorization", task_id: T.id, account: T.hex64, device: T.hex64, worker: T.str, offer_id: T.hex64, tariff_version: T.str, task: T.obj, inputs: T.arr, inputs_root: T.hex64, model: T.str, capabilities: T.obj, cap: T.int, expires: T.int, ts: T.int },
  handle: { task_id: T.id, worker: T.str, auth_hash: T.hex64, state: (x) => STATES.includes(x), control: (x) => ["agent", "human"].includes(x), seq: T.int, created: T.int, updated: T.int },
  event: { seq: T.int, ts: T.int, kind: T.str, prev: T.hex64, hash: T.hex64 },
  usage: { tariff_version: T.str, cap: T.int, reserved: T.int, sponsored: T.bool, execution: T.obj, inference: T.obj, storage: T.obj, charged: T.int, released: T.int, settled: T.bool, ledger: T.arr },
  completion: { v: (x) => x === V, type: (x) => x === "completion", task_id: T.id, auth_hash: T.hex64, offer_id: T.hex64, inputs_root: T.hex64, worker: T.obj, peer_evidence: T.obj, status: (x) => TERMINAL.includes(x), events: T.obj, outputs: T.arr, usage: T.obj, settlement: T.obj, retention: T.obj },
};
// check("authorization", x) throws naming the first bad field; returns x.
export function check(kind, x) {
  if (!T.obj(x)) throw new Error(`${kind}: not an object`);
  for (const [k, ok] of Object.entries(SHAPES[kind])) if (!ok(x[k])) throw new Error(`${kind}.${k}: invalid (${JSON.stringify(x[k])?.slice(0, 80)})`);
  if (kind === "offer" && offerId(x) !== x.offer_id) throw new Error("offer.offer_id: not the hash of the offer");
  if (kind === "authorization" && h(x.inputs) !== x.inputs_root) throw new Error("authorization.inputs_root: not h(inputs)");
  if (kind === "event" && h({ seq: x.seq, ts: x.ts, kind: x.kind, data: x.data, prev: x.prev }) !== x.hash) throw new Error(`event ${x.seq}: hash mismatch`);
  return x;
}
