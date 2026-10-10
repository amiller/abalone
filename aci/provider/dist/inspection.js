export async function inspectAciProvider(provider, request, options = {}) {
    switch (request.action) {
        case "status":
            return { action: "status", status: provider.status() };
        case "attestation":
            return {
                action: "attestation",
                identity: await provider.connect(),
                releasePinned: Boolean(provider.config.trust.acceptedComposeHashes?.length),
            };
        case "receipts":
            return { action: "receipts", receipts: provider.receipts() };
        case "receipt":
            return { action: "receipt", audit: await provider.verifyReceipt(request.id) };
        case "session":
            return {
                action: "session",
                audit: await provider.verifySession(request.id, options),
            };
    }
}
export function formatAciInspection(result, options = {}) {
    switch (result.action) {
        case "status":
            return formatStatus(result.status);
        case "attestation":
            return formatAttestation(result.identity, result.releasePinned, options.providerLabel ?? "ACI provider");
        case "receipts":
            return formatReceipts(result.receipts);
        case "receipt":
            return formatReceipt(result.audit);
        case "session":
            return formatSession(result.audit);
    }
}
function isoTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}
function keySummary(keys) {
    return keys.length === 0
        ? "none"
        : keys.map((key) => `${String(key.key_id)} (${String(key.algo)})`).join(", ");
}
function formatStatus(status) {
    return [
        `Phase: ${status.phase}`,
        `Models: ${status.models.length}`,
        `Receipts retained: ${status.receipts.length}`,
        ...(status.error ? [`Error: ${status.error}`] : []),
    ].join("\n");
}
function formatAttestation(identity, releasePinned, providerLabel) {
    const keyset = identity.keyset;
    return [
        `${providerLabel} attestation`,
        `Origin: ${identity.origin}`,
        `API version: ${String(identity.report.api_version)}`,
        `Compose hash: ${identity.composeHash}`,
        `Release policy: ${releasePinned ? "reviewed release accepted" : "measurement verified, release not pinned"}`,
        "Report binding: verified",
        `Keyset digest: ${identity.workloadKeysetDigest}`,
        `TLS SPKI pins: ${identity.tlsSpkiPins.join(", ")}`,
        `Keyset not_after: ${isoTime(keyset.not_after * 1000)}`,
        `Encryption keys (${keyset.e2ee_public_keys.length}): ${keySummary(keyset.e2ee_public_keys)}`,
        `Receipt signing keys (${keyset.receipt_signing_keys.length}): ${keySummary(keyset.receipt_signing_keys)}`,
        `Verified at: ${isoTime(identity.verifiedAt)}`,
        `Expires at: ${isoTime(identity.expiresAt)}`,
    ].join("\n");
}
function formatReceipts(receipts) {
    if (receipts.length === 0)
        return "No ACI receipts have been recorded in this process.";
    return receipts
        .map((receipt) => `${receipt.receiptId} ${receipt.method} ${receipt.path} HTTP ${receipt.status} ${receipt.responseComplete ? "complete" : "streaming"}`)
        .join("\n");
}
function formatReceipt(audit) {
    const receipt = audit.receipt;
    return [
        `Receipt: ${audit.receiptId}`,
        `API version: ${String(receipt.api_version)}`,
        `Signing key: ${String(receipt.key_id)}`,
        `Model: ${String(receipt.model)}`,
        `Endpoint: ${String(receipt.endpoint)}`,
        `Served at: ${typeof receipt.served_at === "number" ? isoTime(receipt.served_at * 1000) : "invalid"}`,
        `Keyset digest: ${String(receipt.workload_keyset_digest)}`,
        `Status: ${audit.exchange.status}`,
        `Recorded at: ${isoTime(audit.exchange.recordedAt)}`,
        ...receiptEventLines(receipt),
        `Verdict: ${audit.transcript.verdict.line}`,
        ...audit.transcript.lines.map((line) => `${line.status.toUpperCase()} ${line.id}${line.detail ? `: ${line.detail}` : ""}`),
    ].join("\n");
}
function receiptEventLines(receipt) {
    if (!Array.isArray(receipt.event_log))
        return [];
    const interesting = new Set([
        "upstream.verified",
        "request.received",
        "request.forwarded",
        "response.received",
        "response.returned",
    ]);
    const lines = [];
    for (const value of receipt.event_log) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
        const event = value;
        const type = typeof event.type === "string" ? event.type : "";
        if (!interesting.has(type))
            continue;
        if (type === "upstream.verified") {
            const fields = ["result", "required", "provider", "model_id", "session_id"]
                .filter((field) => event[field] !== undefined)
                .map((field) => `${field}=${String(event[field])}`);
            lines.push(`${type} ${fields.join(" ")}`.trim());
        }
        else if (event.body_hash !== undefined) {
            lines.push(`${type} body_hash=${String(event.body_hash)}`);
        }
    }
    return lines;
}
function formatSession(audit) {
    const session = audit.session;
    return [
        `Session: ${audit.sessionId}`,
        `API version: ${session.api_version}`,
        `Upstream: ${String(session.upstream_name)}`,
        `Endpoint: ${String(session.endpoint ?? "none")}`,
        `Verifier: ${String(session.verifier_id)}`,
        `Established: ${isoTime(session.established_at * 1000)}`,
        `Expires: ${isoTime(session.expires_at * 1000)}`,
        ...audit.checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`),
    ].join("\n");
}
//# sourceMappingURL=inspection.js.map