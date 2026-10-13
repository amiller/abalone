import { connectAci, } from "@phala/aci-verifier/runtime";
import { discoverAciModels } from "./models.js";
import { auditAciSession, isAciSessionId } from "./session.js";
export class AciProviderError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AciProviderError";
    }
}
export class AciProvider {
    fetch;
    config;
    connection;
    connecting;
    phase = "idle";
    error;
    catalog = [];
    constructor(config) {
        this.config = config;
        this.fetch = (input, init) => this.secureFetch(input, init);
    }
    async connect() {
        if (this.phase === "closed")
            throw new AciProviderError("ACI provider is closed");
        if (this.connection)
            return this.connection.identity;
        if (!this.connecting) {
            this.phase = "connecting";
            const pending = connectAci({
                baseURL: this.config.baseURL,
                policy: this.config.trust.acceptedComposeHashes
                    ? { acceptedComposeHashes: this.config.trust.acceptedComposeHashes }
                    : {},
                serving: this.config.trust.acceptedSessionIds
                    ? { acceptedSessionIds: this.config.trust.acceptedSessionIds }
                    : {},
                receiptHistorySize: this.config.receipts.historySize,
            })
                .then((connection) => {
                if (this.phase === "closed") {
                    return connection.close().then(() => {
                        throw new AciProviderError("ACI provider closed during connection setup");
                    });
                }
                this.connection = connection;
                this.phase = "verified";
                this.error = undefined;
                return connection;
            })
                .catch((error) => {
                if (this.phase !== "closed") {
                    this.phase = "blocked";
                    this.error = error instanceof Error ? error.message : String(error);
                }
                throw new AciProviderError(`ACI connection verification failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            })
                .finally(() => {
                if (this.connecting === pending)
                    this.connecting = undefined;
            });
            this.connecting = pending;
        }
        return (await this.connecting).identity;
    }
    async discoverModels(options = {}) {
        await this.connect();
        const models = await discoverAciModels({
            config: this.config,
            fetch: this.fetch,
            ...options,
        });
        this.catalog = models;
        return models;
    }
    models() {
        return this.catalog;
    }
    receipts() {
        return this.connection?.receipts() ?? [];
    }
    async verifyReceipt(receiptId) {
        await this.connect();
        const audit = await this.connection?.verifyReceipt(receiptId);
        if (!audit)
            throw new AciProviderError("ACI connection is unavailable");
        if (!audit.transcript.verdict.verified) {
            throw new AciProviderError(`ACI receipt verification failed: ${audit.transcript.verdict.line}`);
        }
        return audit;
    }
    async verifySession(sessionId, options = {}) {
        if (!isAciSessionId(sessionId)) {
            throw new AciProviderError("ACI session id must be a 64-character lowercase hex digest");
        }
        await this.connect();
        const url = new URL(this.config.baseURL);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/aci/sessions/${sessionId}`;
        url.search = "";
        const response = await this.fetch(url, {
            headers: { Accept: "application/json" },
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) {
            throw new AciProviderError(`ACI session fetch returned HTTP ${response.status} ${response.statusText}`);
        }
        const value = await response.json().catch((error) => {
            throw new AciProviderError("ACI session endpoint returned invalid JSON", { cause: error });
        });
        const audit = await auditAciSession(sessionId, value).catch((error) => {
            throw new AciProviderError("ACI session endpoint returned an invalid session document", {
                cause: error,
            });
        });
        if (!audit.verified) {
            const failed = audit.checks.filter((check) => !check.ok).map((check) => check.name);
            throw new AciProviderError(`ACI session verification failed: ${failed.join(", ")}`);
        }
        return audit;
    }
    status() {
        return {
            phase: this.phase,
            ...(this.error ? { error: this.error } : {}),
            ...(this.connection ? { identity: this.connection.identity } : {}),
            models: this.catalog,
            receipts: this.receipts(),
        };
    }
    async close() {
        if (this.phase === "closed")
            return;
        this.phase = "closed";
        try {
            await this.connecting;
        }
        catch {
            // Connection setup already recorded the useful failure.
        }
        const connection = this.connection;
        this.connection = undefined;
        await connection?.close();
    }
    async secureFetch(input, init) {
        await this.connect();
        const connection = this.connection;
        if (!connection)
            throw new AciProviderError("ACI inference blocked: no verified connection");
        const response = await connection.fetch(input, init);
        const receiptId = response.headers.get("x-receipt-id");
        if (!receiptId)
            return response;
        return auditResponse(response, () => this.verifyReceipt(receiptId));
    }
}
export function createAciProvider(config) {
    return new AciProvider(config);
}
/** @internal Response-stream boundary used by provider adapters and contract tests. */
export async function auditResponse(response, verify) {
    if (!response.body) {
        await verify();
        return response;
    }
    const reader = response.body.getReader();
    let verification;
    const verifyOnce = () => {
        verification ??= Promise.resolve()
            .then(verify)
            .then(() => undefined);
        return verification;
    };
    const body = new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (!done) {
                controller.enqueue(value);
                return;
            }
            await verifyOnce();
            controller.close();
        },
        async cancel(reason) {
            const [cancelled, verified] = await Promise.allSettled([reader.cancel(reason), verifyOnce()]);
            if (verified.status === "rejected")
                throw verified.reason;
            if (cancelled.status === "rejected")
                throw cancelled.reason;
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
    });
}
//# sourceMappingURL=provider.js.map