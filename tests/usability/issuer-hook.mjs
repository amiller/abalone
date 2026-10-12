// SYNTHETIC FIXTURE ONLY: `node --import` this into bin/abalone.mjs so the `credit inspect/redeem` CLI reaches the
// loopback synthetic issuer of tests/lib/credit-fixture.mjs. Only lib/credit.mjs's import of coupon-attested.mjs is
// replaced, by issuer-shim.mjs; every other module and check is the production code.
import { registerHooks } from "node:module";
const shim = new URL("./issuer-shim.mjs", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "./coupon-attested.mjs" && context.parentURL?.endsWith("/lib/credit.mjs")
  ? { url: shim, shortCircuit: true } : next(specifier, context) });
process.stderr.write("SYNTHETIC FIXTURE: issuer identity verdict is a test-only stand-in; the issuer is a loopback fixture.\n");
