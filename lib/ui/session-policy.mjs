// Configured boundaries and recorded verification, not network surveillance.
const clean = (value) => String(value ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
const shell = ["     __..--..__", "  .-'  o o o  `-.", " /   .-~~~~-.    \\", " `--.________.--'"];

export function sessionPolicy({ model, checked = false, checkText, descriptor, incognito = false, ownedHost = false, art = false }) {
  const provider = String(model ?? "").split("/")[0];
  const protectedProvider = ["nearai", "chutes", "gift"].includes(provider);
  const isolated = descriptor?.local_boundary === "bubblewrap";
  const ordinary = descriptor?.local_boundary === "trusted-owned-host" || ownedHost;
  const history = descriptor?.retention?.kind === "encrypted-trace" ? "encrypted trace saved by choice"
    : incognito ? "conversation not saved; managed state temporary"
    : "conversation saved for resume";
  return [...(art ? shell : []),
    { label: "Inference", text: `${clean(model)} · ${checkText ? clean(checkText) : checked ? "checked for this model" : "not checked yet"}` },
    { label: "Connection", text: protectedProvider ? "configured: encrypted requests to provider TEE" : "see provider evidence; protected request path unknown" },
    { label: "Tools", text: isolated ? "sandboxed filesystem; shell network blocked" : ordinary ? "your account's files and network; no tool sandbox" : "local boundary unknown" },
    { label: "Retention", text: history },
    { label: "Files", text: "workspace edits and terminal output can remain" },
  ];
}
