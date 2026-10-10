import type { PinnedTransportFactory } from './transport.js';
import { type AciConnection, type ConnectAciOptions } from './types.js';
export declare function connectAciWithTransport(options: ConnectAciOptions, createPinnedTransport: PinnedTransportFactory): Promise<AciConnection>;
interface PreparedRequest {
    request: Request;
    bodyDigest: string;
    pinnedSessions: string[];
    authorization?: string;
}
/** @internal Exported for transport-policy conformance tests. */
export declare function prepareRequest(input: RequestInfo | URL, init: RequestInit | undefined, options: ConnectAciOptions): Promise<PreparedRequest>;
/** @internal Exported for transport-policy conformance tests. */
export declare function constrainJsonBody(body: Uint8Array, options: ConnectAciOptions): {
    body: Uint8Array;
    pinnedSessions: string[];
};
export {};
//# sourceMappingURL=connection.d.ts.map