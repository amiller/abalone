// The optional client uses the same focused integration as ordinary Pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providers } from "../../lib/config.mjs";
import { registerChutes } from "../../verifiers/chutes/pi-extension.ts";

export default async function (pi: ExtensionAPI) {
  const cfg = providers().admitted.find((p: any) => p.id === "chutes");
  await registerChutes(pi, { policy: cfg.policy, code: cfg.axes.code });
}
