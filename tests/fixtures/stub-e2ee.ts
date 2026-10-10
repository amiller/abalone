// Test-only: the stub model under a provider marked "tools": "in-content" (as NEAR is), for lib/intools.mjs.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "./stub-provider.ts";

export default (pi: ExtensionAPI) => register(pi, "stub-e2ee");
