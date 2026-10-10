import type { AciReceiptAudit, RecordedAciExchange, VerifiedAciIdentity } from "@phala/aci-verifier/runtime";
import type { AciProvider, AciProviderStatus } from "./provider.ts";
import type { AciSessionAudit } from "./session.ts";
export type AciInspectionRequest = {
    action: "status";
} | {
    action: "attestation";
} | {
    action: "receipts";
} | {
    action: "receipt";
    id?: string;
} | {
    action: "session";
    id: string;
};
export type AciInspectionResult = {
    action: "status";
    status: AciProviderStatus;
} | {
    action: "attestation";
    identity: VerifiedAciIdentity;
    releasePinned: boolean;
} | {
    action: "receipts";
    receipts: readonly RecordedAciExchange[];
} | {
    action: "receipt";
    audit: AciReceiptAudit;
} | {
    action: "session";
    audit: AciSessionAudit;
};
export interface InspectAciProviderOptions {
    signal?: AbortSignal;
}
export interface FormatAciInspectionOptions {
    providerLabel?: string;
}
export declare function inspectAciProvider(provider: AciProvider, request: AciInspectionRequest, options?: InspectAciProviderOptions): Promise<AciInspectionResult>;
export declare function formatAciInspection(result: AciInspectionResult, options?: FormatAciInspectionOptions): string;
//# sourceMappingURL=inspection.d.ts.map