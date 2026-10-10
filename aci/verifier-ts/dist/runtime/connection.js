import { createHash, randomBytes } from 'node:crypto';
import { bindReportTranscriptChannel, computeVerdict, receiptTranscriptFromDigests, reportTranscript, } from '../transcript.js';
import { AciConnectionError, } from './types.js';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECEIPT_HISTORY_SIZE = 32;
export async function connectAciWithTransport(options, createPinnedTransport) {
    const connection = new RuntimeAciConnection(options, createPinnedTransport);
    await connection.refresh();
    return connection;
}
class RuntimeAciConnection {
    baseURL;
    fetch;
    origin;
    hostname;
    attestationURL;
    options;
    createPinnedTransport;
    currentIdentity;
    transport;
    refreshing;
    exchanges = [];
    rotationRequired = false;
    closed = false;
    constructor(options, createPinnedTransport) {
        validateOptions(options);
        const target = normalizeBaseURL(options.baseURL);
        this.baseURL = target.baseURL;
        this.origin = target.origin;
        this.hostname = target.hostname;
        this.attestationURL = target.attestationURL;
        this.options = options;
        this.createPinnedTransport = createPinnedTransport;
        this.fetch = (input, init) => this.secureFetch(input, init);
    }
    get identity() {
        if (!this.currentIdentity) {
            throw new AciConnectionError('closed', 'ACI identity is unavailable');
        }
        return this.currentIdentity;
    }
    receipts() {
        return this.exchanges
            .slice()
            .reverse()
            .map(publicExchange);
    }
    async verifyReceipt(receiptId) {
        const exchange = receiptId
            ? [...this.exchanges].reverse().find((entry) => entry.receiptId === receiptId)
            : this.exchanges.at(-1);
        if (!exchange) {
            throw new AciConnectionError('receipt_not_found', receiptId
                ? `no recorded ACI exchange cites receipt ${receiptId}`
                : 'no recorded ACI receipt is available');
        }
        const id = exchange.receiptId;
        await exchange.completion;
        await this.ensureFreshIdentity();
        const identity = exchange.identity;
        const receipt = await this.fetchJsonArtifact(`receipts/${encodeURIComponent(id)}`, exchange.authorization);
        const sessionId = citedSessionId(receipt);
        let session;
        if (sessionId) {
            try {
                session = await this.fetchJsonArtifact(`sessions/${encodeURIComponent(sessionId)}`);
            }
            catch (error) {
                if (!(error instanceof AciConnectionError) || error.code !== 'receipt_fetch')
                    throw error;
            }
        }
        const serving = identity.report.service_capabilities?.serving;
        const transcript = await receiptTranscriptFromDigests(receipt, identity.keyset, identity.workloadKeysetDigest, {
            request: exchange.requestDigest,
            ...(exchange.responseDigest ? { response: exchange.responseDigest } : {}),
        }, {
            ...(session === undefined ? {} : { session }),
            ...(exchange.pinnedSessions.length ? { pinnedSessions: exchange.pinnedSessions } : {}),
            requiresVerified: true,
            ...(typeof serving === 'string' ? { serving } : {}),
        });
        if (exchange.responseError) {
            const responseLine = transcript.lines.find((line) => line.id === 'receipt-4');
            if (responseLine) {
                responseLine.status = 'fail';
                responseLine.detail = `response stream could not be hashed completely: ${exchange.responseError}`;
                delete responseLine.reason;
                transcript.verdict = computeVerdict(transcript.lines);
            }
        }
        return {
            receiptId: id,
            receipt,
            transcript,
            exchange: publicExchange(exchange),
        };
    }
    refresh() {
        if (this.closed) {
            return Promise.reject(new AciConnectionError('closed', 'ACI connection is closed'));
        }
        if (this.refreshing)
            return this.refreshing;
        const refresh = this.refreshOnce().finally(() => {
            if (this.refreshing === refresh)
                this.refreshing = undefined;
        });
        this.refreshing = refresh;
        return refresh;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.refreshing) {
            try {
                await this.refreshing;
            }
            catch {
                // The refresh owns its candidate transport and closes it on failure.
            }
        }
        const transport = this.transport;
        this.transport = undefined;
        if (transport)
            await transport.close();
    }
    async refreshOnce() {
        const identity = await establishIdentity(this.attestationURL, this.origin, this.hostname, this.options);
        const candidate = this.createPinnedTransport({
            origin: this.origin,
            hostname: this.hostname,
            spkiPins: identity.tlsSpkiPins,
            ...(this.options.proxy === undefined ? {} : { proxy: this.options.proxy }),
            ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        });
        try {
            await probePinnedChannel(candidate, this.attestationURL, this.options);
            if (this.closed)
                throw new AciConnectionError('closed', 'ACI connection closed during refresh');
        }
        catch (error) {
            await candidate.close();
            if (error instanceof AciConnectionError)
                throw error;
            throw new AciConnectionError('channel_binding', 'failed to establish the pinned ACI channel', {
                cause: error,
            });
        }
        const observedSpkiSha256 = candidate.observedSpkiSha256();
        if (!observedSpkiSha256) {
            await candidate.close();
            throw new AciConnectionError('channel_binding', 'pinned ACI channel probe did not observe a TLS peer SPKI');
        }
        const transcript = bindReportTranscriptChannel(identity.transcript, {
            observedSpkiSha256,
            host: identity.hostname,
        });
        const channelCheck = transcript.lines.find((line) => line.id === 'id-6');
        if (channelCheck?.status !== 'pass') {
            await candidate.close();
            throw new AciConnectionError('channel_binding', `pinned ACI channel did not satisfy id-6: ${channelCheck?.detail ?? 'check did not run'}`);
        }
        const boundIdentity = { ...identity, transcript };
        const previous = this.transport;
        this.transport = candidate;
        this.currentIdentity = boundIdentity;
        this.rotationRequired = false;
        if (previous)
            await previous.close();
    }
    async secureFetch(input, init) {
        if (this.closed || !this.transport) {
            throw new AciConnectionError('closed', 'ACI connection is closed');
        }
        await this.ensureFreshIdentity();
        const transport = this.transport;
        if (!transport)
            throw new AciConnectionError('closed', 'ACI connection is closed');
        const identity = this.identity;
        const prepared = await prepareRequest(input, init, this.options);
        const response = await transport.fetch(prepared.request);
        const observedDigest = response.headers.get('x-aci-keyset-digest');
        if (observedDigest && observedDigest !== identity.workloadKeysetDigest) {
            this.rotationRequired = true;
        }
        const receiptId = response.headers.get('x-receipt-id');
        if (prepared.request.method === 'POST' &&
            response.ok &&
            !receiptId) {
            try {
                await response.body?.cancel();
            }
            catch {
                // The missing receipt is the security failure; cancellation is cleanup.
            }
            throw new AciConnectionError('receipt_missing', 'successful ACI POST response carries no X-Receipt-Id');
        }
        if (prepared.request.method === 'POST' && receiptId) {
            this.recordExchange(receiptId, prepared, response, identity);
        }
        return response;
    }
    async ensureFreshIdentity() {
        if (!this.rotationRequired && Date.now() < this.identity.expiresAt)
            return;
        try {
            await this.refresh();
        }
        catch (error) {
            throw new AciConnectionError('identity_expired', 'ACI workload identity changed or expired and re-verification failed', { cause: error });
        }
    }
    recordExchange(receiptId, prepared, response, identity) {
        const entry = {
            receiptId,
            method: prepared.request.method,
            path: new URL(prepared.request.url).pathname,
            status: response.status,
            recordedAt: Date.now(),
            responseComplete: false,
            requestDigest: prepared.bodyDigest,
            ...(prepared.authorization === undefined ? {} : { authorization: prepared.authorization }),
            completion: Promise.resolve(),
            identity,
            pinnedSessions: prepared.pinnedSessions,
        };
        entry.completion = digestResponse(response.clone()).then((digest) => {
            entry.responseDigest = digest;
            entry.responseComplete = true;
        }, (error) => {
            entry.responseError = error instanceof Error ? error.message : String(error);
            entry.responseComplete = true;
        });
        this.exchanges.push(entry);
        const cap = this.options.receiptHistorySize ?? DEFAULT_RECEIPT_HISTORY_SIZE;
        if (this.exchanges.length > cap)
            this.exchanges.splice(0, this.exchanges.length - cap);
    }
    async fetchJsonArtifact(path, authorization) {
        const root = new URL(this.attestationURL);
        root.pathname = root.pathname.replace(/attestation$/, path);
        const response = await this.secureFetch(root, {
            headers: {
                Accept: 'application/json',
                ...(authorization ? { Authorization: authorization } : {}),
            },
        });
        if (!response.ok) {
            throw new AciConnectionError('receipt_fetch', `ACI artifact fetch returned HTTP ${response.status}`);
        }
        const value = await response.json().catch((error) => {
            throw new AciConnectionError('receipt_fetch', 'ACI artifact endpoint returned invalid JSON', {
                cause: error,
            });
        });
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new AciConnectionError('receipt_verification', 'ACI artifact is not a JSON object');
        }
        return value;
    }
}
/** @internal Exported for transport-policy conformance tests. */
export async function prepareRequest(input, init, options) {
    const original = new Request(input, init);
    const authorization = original.headers.get('authorization')?.trim() || undefined;
    if (original.method !== 'POST') {
        return {
            request: original,
            bodyDigest: await digestRequest(original),
            pinnedSessions: [],
            ...(authorization ? { authorization } : {}),
        };
    }
    const bytes = new Uint8Array(await original.clone().arrayBuffer());
    const constrained = constrainJsonBody(bytes, options);
    const headers = new Headers(original.headers);
    headers.delete('content-length');
    const request = constrained.body === bytes
        ? original
        : new Request(original, { body: Buffer.from(constrained.body), headers });
    return {
        request,
        bodyDigest: digestBytes(constrained.body),
        pinnedSessions: constrained.pinnedSessions,
        ...(authorization ? { authorization } : {}),
    };
}
/** @internal Exported for transport-policy conformance tests. */
export function constrainJsonBody(body, options) {
    const fixed = [...(options.serving?.acceptedSessionIds ?? [])];
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(body));
    }
    catch (error) {
        throw new AciConnectionError('invalid_serving_constraints', 'POST body is not JSON, so provider.aci_verified cannot be set (§5.3)', { cause: error });
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AciConnectionError('invalid_serving_constraints', 'POST body is not a JSON object, so provider.aci_verified cannot be set (§5.3)');
    }
    const root = value;
    const providerValue = root.provider;
    if (providerValue !== undefined &&
        (providerValue === null || typeof providerValue !== 'object' || Array.isArray(providerValue))) {
        throw new AciConnectionError('invalid_serving_constraints', 'provider must be a JSON object when ACI serving constraints are enabled');
    }
    const provider = providerValue !== null && typeof providerValue === 'object' && !Array.isArray(providerValue)
        ? { ...providerValue }
        : {};
    const supplied = parseSessionIds(provider.aci_session_ids);
    const pinnedSessions = fixed.length === 0
        ? supplied
        : supplied.length === 0
            ? fixed
            : supplied.filter((id) => fixed.includes(id));
    if (fixed.length > 0 && supplied.length > 0 && pinnedSessions.length === 0) {
        throw new AciConnectionError('invalid_serving_constraints', 'request session ids do not intersect the connection acceptedSessionIds policy');
    }
    if (pinnedSessions.length > 0)
        provider.aci_session_ids = pinnedSessions;
    provider.aci_verified = true;
    root.provider = provider;
    return {
        body: new TextEncoder().encode(JSON.stringify(root)),
        pinnedSessions,
    };
}
function parseSessionIds(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
        throw new AciConnectionError('invalid_serving_constraints', 'provider.aci_session_ids must be a non-empty array of lowercase 64-hex ids');
    }
    return [...new Set(value)];
}
async function digestRequest(request) {
    return digestBytes(new Uint8Array(await request.clone().arrayBuffer()));
}
async function digestResponse(response) {
    const hash = createHash('sha256');
    const reader = response.body?.getReader();
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            hash.update(value);
        }
    }
    return `sha256:${hash.digest('hex')}`;
}
function digestBytes(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function publicExchange(exchange) {
    return {
        receiptId: exchange.receiptId,
        method: exchange.method,
        path: exchange.path,
        status: exchange.status,
        recordedAt: exchange.recordedAt,
        responseComplete: exchange.responseComplete,
        ...(exchange.responseError === undefined ? {} : { responseError: exchange.responseError }),
    };
}
function citedSessionId(receipt) {
    const events = receipt.event_log;
    if (!Array.isArray(events))
        return undefined;
    for (const event of events) {
        if (event === null || typeof event !== 'object' || Array.isArray(event))
            continue;
        const fields = event;
        if (fields.type === 'upstream.verified' && fields.result === 'verified' && typeof fields.session_id === 'string') {
            return fields.session_id;
        }
    }
    return undefined;
}
function validateOptions(options) {
    const cap = options.receiptHistorySize ?? DEFAULT_RECEIPT_HISTORY_SIZE;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1_000) {
        throw new AciConnectionError('invalid_policy', 'receiptHistorySize must be an integer between 1 and 1000');
    }
    const composeHashes = options.policy?.acceptedComposeHashes;
    if (composeHashes !== undefined && (!Array.isArray(composeHashes) || composeHashes.length === 0)) {
        throw new AciConnectionError('invalid_policy', 'acceptedComposeHashes must be a non-empty array when supplied');
    }
    for (const hash of composeHashes ?? []) {
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
            throw new AciConnectionError('invalid_policy', 'acceptedComposeHashes entries must be 64-character SHA-256 hex digests');
        }
    }
    const sessions = options.serving?.acceptedSessionIds;
    if (sessions !== undefined && (!Array.isArray(sessions) || sessions.length === 0)) {
        throw new AciConnectionError('invalid_policy', 'acceptedSessionIds must be non-empty when supplied');
    }
    for (const id of sessions ?? []) {
        if (!/^[0-9a-f]{64}$/.test(id)) {
            throw new AciConnectionError('invalid_policy', 'acceptedSessionIds entries must be 64-character lowercase hex ids');
        }
    }
}
async function establishIdentity(attestationURL, origin, hostname, options) {
    const nonce = randomBytes(32).toString('hex');
    const report = await fetchAttestation(attestationURL, nonce, options);
    let transcript;
    try {
        transcript = await reportTranscript(report, nonce, {
            online: true,
            requireProductionOs: true,
            ...(options.pccsUrl === undefined ? {} : { pccsUrl: options.pccsUrl }),
            ...(options.policy?.acceptedComposeHashes === undefined
                ? {}
                : { acceptedComposeHashes: options.policy.acceptedComposeHashes }),
        });
    }
    catch (error) {
        throw new AciConnectionError('attestation_verification', `ACI attestation is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const required = ['id-1', 'id-2', 'id-3', 'id-4', 'policy-os'];
    const failed = required
        .map((id) => ({ id, line: transcript.lines.find((line) => line.id === id) }))
        .filter(({ line }) => line?.status !== 'pass');
    if (failed.length > 0) {
        const detail = failed
            .map(({ id, line }) => `${id}: ${line?.detail ?? 'check did not run'}`)
            .join('; ');
        throw new AciConnectionError('attestation_verification', `ACI attestation verification failed: ${detail}`);
    }
    const keyset = transcript.verification.keyset;
    const digest = transcript.verification.workloadKeysetDigest;
    const composeHash = transcript.composeHash;
    if (!keyset || !digest || !composeHash) {
        throw new AciConnectionError('attestation_verification', 'ACI attestation did not establish a workload identity');
    }
    const pins = tlsPinsForHost(keyset, hostname);
    const verifiedAt = Date.now();
    return {
        origin,
        hostname,
        report,
        keyset,
        workloadKeysetDigest: digest,
        composeHash,
        tlsSpkiPins: pins,
        verifiedAt,
        expiresAt: keyset.not_after * 1000,
        transcript,
    };
}
async function fetchAttestation(attestationURL, nonce, options) {
    const url = new URL(attestationURL);
    url.searchParams.set('nonce', nonce);
    const response = await timedFetch(options.bootstrapFetch ?? globalThis.fetch, url, {
        headers: {
            Accept: 'application/json',
        },
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!response.ok) {
        throw new AciConnectionError('attestation_fetch', `ACI attestation endpoint returned HTTP ${response.status}`);
    }
    try {
        return (await response.json());
    }
    catch (error) {
        throw new AciConnectionError('attestation_fetch', 'ACI attestation endpoint returned invalid JSON', {
            cause: error,
        });
    }
}
async function probePinnedChannel(transport, attestationURL, options) {
    const url = new URL(attestationURL);
    url.searchParams.set('nonce', randomBytes(32).toString('hex'));
    const response = await timedFetch(transport.fetch, url, {
        headers: {
            Accept: 'application/json',
        },
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!response.ok) {
        throw new AciConnectionError('channel_binding', `pinned ACI channel probe returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
}
async function timedFetch(fetchImpl, input, init, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new AciConnectionError('attestation_fetch', 'timeoutMs must be a positive number');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
        return await fetchImpl(input, { ...init, signal: controller.signal });
    }
    catch (error) {
        if (error instanceof AciConnectionError)
            throw error;
        throw new AciConnectionError('attestation_fetch', `ACI request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    finally {
        clearTimeout(timeout);
    }
}
function tlsPinsForHost(keyset, hostname) {
    const entries = Array.isArray(keyset.tls_public_keys) ? keyset.tls_public_keys : [];
    const normalizedHost = normalizeHostname(hostname);
    const pins = entries
        .filter((pin) => pin.domain === undefined || normalizeHostname(pin.domain) === normalizedHost)
        .map((pin) => pin.spki_sha256.toLowerCase());
    if (pins.length === 0) {
        throw new AciConnectionError('invalid_tls_pin', `ACI workload keyset has no valid TLS SPKI for ${hostname}`);
    }
    if (pins.some((pin) => !/^[0-9a-f]{64}$/.test(pin))) {
        throw new AciConnectionError('invalid_tls_pin', `ACI workload keyset has an invalid TLS SPKI for ${hostname}`);
    }
    return [...new Set(pins)];
}
function normalizeHostname(value) {
    return value.trim().toLowerCase().replace(/\.$/, '');
}
function normalizeBaseURL(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new AciConnectionError('invalid_base_url', 'baseURL must be an absolute HTTPS URL');
    }
    if (url.protocol !== 'https:') {
        throw new AciConnectionError('invalid_base_url', 'baseURL must use HTTPS');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new AciConnectionError('invalid_base_url', 'baseURL must not contain credentials, query parameters, or a fragment');
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    const baseURL = url.toString().replace(/\/$/, '');
    const rootPath = url.pathname.replace(/\/v\d+$/, '').replace(/\/+$/, '');
    const attestation = new URL(url.origin);
    attestation.pathname = `${rootPath}/v1/aci/attestation`;
    return {
        baseURL,
        origin: url.origin,
        hostname: url.hostname.toLowerCase().replace(/\.$/, ''),
        attestationURL: attestation.toString(),
    };
}
//# sourceMappingURL=connection.js.map