export declare function createPinnedServerIdentityCheck(expectedHostname: string, spkiPins: readonly string[], onVerified?: (spkiSha256: string) => void): NonNullable<import('node:tls').ConnectionOptions['checkServerIdentity']>;
export declare function requestUrl(input: RequestInfo | URL): URL;
//# sourceMappingURL=tls-pin.d.ts.map