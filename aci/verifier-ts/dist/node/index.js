import { connectAciWithTransport } from '../runtime/connection.js';
import { createPinnedTransport } from './transport.js';
export function connectAci(options) {
    return connectAciWithTransport(options, createPinnedTransport);
}
export * from '../runtime/types.js';
//# sourceMappingURL=index.js.map