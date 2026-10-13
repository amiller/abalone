import { type AciFetch, type AciReceiptAudit, type RecordedAciExchange, type VerifiedAciIdentity } from "@phala/aci-verifier/runtime";
import type { AciProviderConfig } from "./config.ts";
import { type AciModel } from "./models.ts";
import { type AciSessionAudit } from "./session.ts";
export type AciProviderPhase = "idle" | "connecting" | "verified" | "blocked" | "closed";
export interface AciProviderStatus {
    phase: AciProviderPhase;
    error?: string;
    identity?: VerifiedAciIdentity;
    models: readonly AciModel[];
    receipts: readonly RecordedAciExchange[];
}
export declare class AciProviderError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class AciProvider {
    readonly fetch: AciFetch;
    readonly config: AciProviderConfig;
    private connection?;
    private connecting?;
    private phase;
    private error?;
    private catalog;
    constructor(config: AciProviderConfig);
    connect(): Promise<VerifiedAciIdentity>;
    discoverModels(options?: {
        signal?: AbortSignal;
    }): Promise<readonly AciModel[]>;
    models(): readonly AciModel[];
    receipts(): readonly RecordedAciExchange[];
    verifyReceipt(receiptId?: string): Promise<AciReceiptAudit>;
    verifySession(sessionId: string, options?: {
        signal?: AbortSignal;
    }): Promise<AciSessionAudit>;
    status(): AciProviderStatus;
    close(): Promise<void>;
    private secureFetch;
}
export declare function createAciProvider(config: AciProviderConfig): AciProvider;
/** @internal Response-stream boundary used by provider adapters and contract tests. */
export declare function auditResponse(response: Response, verify: () => Promise<unknown>): Promise<Response>;
//# sourceMappingURL=provider.d.ts.map