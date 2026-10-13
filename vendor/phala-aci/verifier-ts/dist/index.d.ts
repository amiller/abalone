/**
 * @phala/aci-verifier — a TypeScript ACI verifier for the browser and node.
 *
 * {@link verifyService} is the one call: fetch a service's attestation report
 * with a fresh nonce and get a full §9.1 transcript, including the hardware
 * quote (id-1, verified with @phala/dcap-qvl against Intel PCS) and the
 * compose measurement (id-4). Also exposes the individual checks: report
 * binding (§9.1 checks 2–3), receipts and body hashes (§9.3), and sessions
 * (§8, §9.3). Every check other than the quote uses Web Crypto (Ed25519 and
 * SHA-256). E2EE v2 field encryption is specified by §6 but is not constructed
 * by this verifier package.
 */
export { sha256, sha256Hex, sha256Prefixed, verifyEd25519, toHex, fromHex, toBase64, fromBase64, jcsBytes, } from './crypto.js';
export { computeKeysetDigest, attestationStatement, computeReportData } from './digest.js';
export { computeSessionId, checkSessionApiVersion, checkSessionEvidence } from './session.js';
export { verifyReceipt, findEvent, hashBody, checkRequestBodyHash, checkResponseBodyHash, } from './receipt.js';
export { verifyReportBinding, verifyComposeMeasurement, verifyQuote } from './report.js';
export type { ReportBindingOptions } from './report.js';
export { verifyService, reportTranscript, receiptTranscript, receiptTranscriptFromDigests, computeVerdict, } from './transcript.js';
export type { ReceiptBodyDigests, UpstreamAuditInput } from './transcript.js';
export type { CheckStatus, TranscriptLine, Verdict, ReportTranscript, ReceiptTranscript, TranscriptOptions, VerifyServiceOptions, } from './transcript.js';
export { AciError, AciFormatError } from './errors.js';
export type { KeysetKey, TlsKeyPin, WorkloadKeyset, SourceProvenance, Attestation, AttestationReport, ReceiptEnvelope, ReceiptEvent, ReceiptPayload, SessionEvidence, SessionRecord, Check, ReceiptVerification, ReportVerification, } from './types.js';
//# sourceMappingURL=index.d.ts.map