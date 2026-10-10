// Consent state and gift terms (charter G7). Gift terms carry an explicit `noPromotion`; redemption records it as a
// restriction and never grants consent. Consent comes only from grantConsent, called from a recipient's own command.
// Any surface that would show a commercial offer asks mayOffer first. Essential balance, service and security
// notices are not offers and do not go through here.
import fs from "node:fs";
import path from "node:path";
import { STATE, readJson } from "../config.mjs";

export const SURFACES = ["terminal", "browser", "notifications", "email"];
export const OFFER_KINDS = ["campaign", "trace-sale", "rebate", "marketing"];
const FILE = () => path.join(STATE, "consent.json");

export const load = () => fs.existsSync(FILE()) ? readJson(FILE()) : { consents: [], restrictions: [] };
const save = (s) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 }); };

function scoped(x, what) {
  if (!Array.isArray(x.scope) || !x.scope.length || x.scope.some((s) => !SURFACES.includes(s))) throw new Error(`${what}: scope must be a non-empty subset of ${SURFACES.join(", ")}`);
  if (typeof x.until !== "string" || Number.isNaN(Date.parse(x.until))) throw new Error(`${what}: until must be an ISO-8601 time`);
  return { scope: [...x.scope], until: new Date(x.until).toISOString() };
}

// terms.noPromotion is required: false, or { scope: [surface...], until: ISO-8601 }.
export function parseTerms(terms) {
  if (!terms || !("noPromotion" in terms)) throw new Error("gift terms: noPromotion must be stated (false or {scope, until})");
  return { noPromotion: terms.noPromotion === false ? false : scoped(terms.noPromotion, "gift terms noPromotion") };
}

// Called by gift redemption. Records the restriction; consents are untouched.
export function applyGift(giftId, terms) {
  const { noPromotion } = parseTerms(terms);
  const s = load();
  if (noPromotion) s.restrictions.push({ gift: giftId, noPromotion, recorded: new Date().toISOString() });
  save(s);
  return s;
}

// Only from an explicit recipient action (a command they ran), never from redemption, use, or an issuer.
export function grantConsent(kind, scope) {
  if (!OFFER_KINDS.includes(kind)) throw new Error(`consent: unknown kind ${kind}`);
  const s = load();
  s.consents.push({ kind, ...scoped(scope, `consent ${kind}`), granted: new Date().toISOString() });
  save(s);
}

// The enforcement point. solicited = the recipient opened the marketplace themselves; a no-promotion gift does not block that.
export function mayOffer({ kind, surface, solicited }, now = Date.now()) {
  if (!OFFER_KINDS.includes(kind)) throw new Error(`offer: unknown kind ${kind}`);
  if (!SURFACES.includes(surface)) throw new Error(`offer: unknown surface ${surface}`);
  if (solicited === true) return true;
  const live = (x) => x.scope.includes(surface) && Date.parse(x.until) > now;
  const s = load();
  if (s.restrictions.some((r) => live(r.noPromotion))) return false;
  return s.consents.some((c) => c.kind === kind && live(c));
}
