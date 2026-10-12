// SYNTHETIC FIXTURE ONLY: `node --import` this into bin/abalone.mjs to replace lib/near.mjs as imported by
// lib/coupon-near.mjs with synthetic-near.mjs. Production code and its testing flags are unchanged.
import { registerHooks } from "node:module";
const fixture = new URL("./synthetic-near.mjs", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "./near.mjs" && context.parentURL?.endsWith("/lib/coupon-near.mjs")
  ? { url: fixture, shortCircuit: true } : next(specifier, context) });
process.stderr.write("SYNTHETIC FIXTURE: NEAR attestation verdict and inference transport are test-only stand-ins; no provider request is made.\n");
