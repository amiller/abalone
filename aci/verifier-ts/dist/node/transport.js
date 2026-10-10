import { Agent, ProxyAgent } from 'undici';
import { AciConnectionError } from '../runtime/types.js';
import { createPinnedServerIdentityCheck, requestUrl } from '../runtime/tls-pin.js';
const nodeFetch = globalThis.fetch;
export function createPinnedTransport(options) {
    let observedSpkiSha256;
    const tls = {
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        checkServerIdentity: createPinnedServerIdentityCheck(options.hostname, options.spkiPins, (value) => {
            observedSpkiSha256 = value;
        }),
    };
    const dispatcher = options.proxy
        ? new ProxyAgent({ uri: options.proxy, allowH2: false, requestTls: tls })
        : new Agent({ allowH2: false, connect: tls });
    let closed = false;
    return {
        fetch(input, init) {
            if (closed) {
                return Promise.reject(new AciConnectionError('closed', 'ACI transport is closed'));
            }
            const target = requestUrl(input);
            if (target.origin !== options.origin) {
                return Promise.reject(new AciConnectionError('origin_mismatch', `ACI transport for ${options.origin} cannot request ${target.origin}`));
            }
            return nodeFetch(input, { ...init, dispatcher })
                .catch((error) => {
                const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
                throw new AciConnectionError('channel_binding', `ACI pinned request failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: error });
            });
        },
        observedSpkiSha256() {
            return observedSpkiSha256;
        },
        async close() {
            if (closed)
                return;
            closed = true;
            await dispatcher.close();
        },
    };
}
//# sourceMappingURL=transport.js.map