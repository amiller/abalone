/**
 * The verification transcript engine plus the one-call {@link verifyService}
 * entry point. DOM-free, so any web or node project imports it directly. Check
 * ids, titles, and section cites are the shared ACI transcript vocabulary (the
 * `aci` CLI prints the same lines); a check that cannot run is reported as
 * `skip` with the reason, never as a pass.
 */
import type { AttestationReport, ReceiptEnvelope, WorkloadKeyset, ReportVerification } from './types.js';
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'info';
export interface TranscriptLine {
    /** Shared check id, e.g. `id-2` or `receipt-1`. */
    id: string;
    /** Spec section cite, e.g. `9.1(2)`. */
    section: string;
    title: string;
    status: CheckStatus;
    detail?: string;
    /** Short clause for the verdict line; set on `skip` lines. */
    reason?: string;
}
export interface Verdict {
    /** True when no check failed and the hardware root (id-1) passed. */
    verified: boolean;
    /** One-line summary, e.g. `VERIFIED (4 pass, 2 skipped: …)`. */
    line: string;
}
export interface ReportTranscript {
    lines: TranscriptLine[];
    verdict: Verdict;
    verification: ReportVerification;
    /** RTMR3-bound sha256(app_compose), present only when id-4 measured successfully. */
    composeHash?: string;
}
export interface TranscriptOptions {
    /** Fixed clock (Unix seconds) for deterministic runs; defaults to local. */
    now?: number;
    /** PCCS base URL for quote collateral; defaults to the Phala PCCS. */
    pccsUrl?: string;
    /**
     * Live run against the service (`verifyService` sets this). Online, a
     * provenance claim no measurement backs fails id-4 (§9.1(4)) and an
     * unbound channel fails id-6 (§1.1); offline (auditing a stored report)
     * both stay honest skips.
     */
    online?: boolean;
    /**
     * How this client's channel is bound to the attested keyset (§9.1(6)):
     * the TLS leaf SPKI the caller's own stack observed. A browser cannot
     * observe TLS, so its channel is unbound — use the `aci` CLI or the
     * `aci serve` proxy for a pinned channel.
     */
    channel?: {
        observedSpkiSha256: string;
        host?: string;
    };
    /**
     * Appraise the RTMR3 `os-image-hash` against this release's production
     * allowlist (§1.3). This does not reconstruct MRTD/RTMR0-2. Use it only
     * after a dstack verifier binds the same evidence to the OS-image hash.
     */
    requireProductionOs?: boolean;
    /**
     * Reviewed RTMR3-bound compose hashes accepted by this verifier (§1.3).
     * An empty or omitted list verifies and reports the measurement without
     * claiming that the release was reviewed.
     */
    acceptedComposeHashes?: readonly string[];
}
/** Verdict wording shared with the CLI: skips are counted and explained, never
 *  passed off, and VERIFIED requires the hardware root (id-1) to have passed. */
export declare function computeVerdict(lines: TranscriptLine[]): Verdict;
export interface VerifyServiceOptions extends TranscriptOptions {
    /** Nonce to send; a fresh 32-byte random hex value by default. */
    nonce?: string;
    /** Fetch implementation; the global `fetch` by default. */
    fetchImpl?: typeof fetch;
}
/**
 * Fetch a service's attestation report with a fresh nonce and run the §9.1
 * transcript — one call for any web or node project. Verifies the quote (id-1,
 * via @phala/dcap-qvl and Intel PCS), the binding chain (id-2/id-3),
 * and the compose measurement (id-4) when the service publishes `app_compose`.
 * Custody (id-5) and the TLS pin (id-6) stay out of a plain browser's reach.
 */
export declare function verifyService(baseUrl: string, options?: VerifyServiceOptions): Promise<ReportTranscript>;
/**
 * Run the §9.1 checks against a fetched report and render the transcript.
 * `nonce` must be the value this client sent with the request.
 */
export declare function reportTranscript(report: AttestationReport, nonce: string | null, options?: TranscriptOptions): Promise<ReportTranscript>;
/** @internal Re-appraise id-6 after a runtime transport observes the TLS peer. */
export declare function bindReportTranscriptChannel(transcript: ReportTranscript, channel: NonNullable<TranscriptOptions['channel']>): ReportTranscript;
export interface ReceiptTranscript {
    lines: TranscriptLine[];
    verdict: Verdict;
}
/** Precomputed ACI wire-body digests for streaming clients (§9.3(3)-(4)). */
export interface ReceiptBodyDigests {
    request?: string;
    response?: string;
}
/** Aggregator inputs for the §9.3(5)-(6) checks. */
export interface UpstreamAuditInput {
    /** The session record the receipt cites, as served (§9.2). */
    session?: unknown;
    /** Session ids the client pinned with `provider.aci_session_ids` (§5.3). */
    pinnedSessions?: string[];
    /**
     * Whether the client requires verified serving. §9.3(5) rejects
     * `required: false` only for such a client; default true.
     */
    requiresVerified?: boolean;
    /**
     * The report's `service_capabilities.serving` (§4.1); default
     * `"aggregator"` (Appendix B). Only a `direct` service may omit
     * `upstream.verified` (§7.5).
     */
    serving?: string;
}
/**
 * Run the §9.3 checks against a receipt document and the keyset the report
 * verification established. Byte inputs are optional: absent bytes make receipt-3/receipt-4
 * skips, not passes. `upstream` supplies the aggregator inputs for §9.3(5)-(6);
 * without it those checks are skips with their reason, never silent passes.
 */
export declare function receiptTranscript(envelope: ReceiptEnvelope, keyset: WorkloadKeyset, establishedDigest: string, requestBytes?: Uint8Array | string, responseBytes?: Uint8Array | string, upstream?: UpstreamAuditInput): Promise<ReceiptTranscript>;
/**
 * Run the same §9.3 transcript from wire digests captured incrementally by a
 * streaming transport. This avoids buffering an entire SSE response while
 * preserving the exact body-hash checks.
 */
export declare function receiptTranscriptFromDigests(envelope: ReceiptEnvelope, keyset: WorkloadKeyset, establishedDigest: string, digests: ReceiptBodyDigests, upstream?: UpstreamAuditInput): Promise<ReceiptTranscript>;
//# sourceMappingURL=transcript.d.ts.map