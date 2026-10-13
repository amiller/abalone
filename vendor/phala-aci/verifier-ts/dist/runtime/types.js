import { AciError } from '../errors.js';
export class AciConnectionError extends AciError {
    code;
    constructor(code, message, options) {
        super(message);
        this.code = code;
        this.name = 'AciConnectionError';
        if (options && 'cause' in options)
            this.cause = options.cause;
    }
}
//# sourceMappingURL=types.js.map