import { type SessionRecord } from "@phala/aci-verifier";
export interface AciSessionCheck {
    name: "content-address" | "api-version" | "validity-window" | "evidence";
    ok: boolean;
    detail: string;
}
export interface AciSessionAudit {
    sessionId: string;
    session: SessionRecord;
    verified: boolean;
    checks: readonly AciSessionCheck[];
}
export declare function isAciSessionId(value: string): boolean;
export declare function auditAciSession(sessionId: string, value: unknown): Promise<AciSessionAudit>;
//# sourceMappingURL=session.d.ts.map