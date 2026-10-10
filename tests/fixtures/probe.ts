// Test-only extension: a tool that tries a direct network fetch and a DNS lookup from inside the harness, or
// (with paths/writes) reports which paths the harness process itself can see and write.
import dns from "node:dns/promises";
import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "probe", label: "probe", description: "network probe",
    parameters: Type.Object({ url: Type.Optional(Type.String()), host: Type.Optional(Type.String()), paths: Type.Optional(Type.String()), writes: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const r: string[] = [];
      if (p.paths || p.writes) {
        for (const f of (p.paths ?? "").split(" ").filter(Boolean)) r.push(`${fs.existsSync(f) ? "visible" : "absent"} ${f}`);
        for (const f of (p.writes ?? "").split(" ").filter(Boolean)) { try { fs.writeFileSync(f, "x"); r.push(`wrote ${f}`); } catch (e: any) { r.push(`unwritable ${f} ${e.code}`); } }
        return { content: [{ type: "text", text: r.join("\n") }], details: undefined };
      }
      await fetch(p.url).then((x) => r.push(`fetch ${p.url}: HTTP ${x.status}`), (e) => r.push(`fetch ${p.url}: FAILED ${e.cause?.code ?? e.message}`));
      await dns.lookup(p.host).then((x) => r.push(`lookup ${p.host}: ${x.address}`), (e) => r.push(`lookup ${p.host}: FAILED ${e.code}`));
      await dns.resolve4(p.host).then((x) => r.push(`resolve4 ${p.host}: ${x}`), (e) => r.push(`resolve4 ${p.host}: FAILED ${e.code}`));
      return { content: [{ type: "text", text: r.join("\n") }], details: undefined };
    },
  });
}
