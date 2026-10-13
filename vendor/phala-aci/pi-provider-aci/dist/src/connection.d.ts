interface AciConnectionConfig {
    baseUrl: string;
    trust: {
        acceptedComposeHashes?: readonly string[];
        acceptedSessionIds?: readonly string[];
    };
}
export interface ConnectableAciProvider {
    connect(): Promise<unknown>;
    close(): Promise<void>;
}
export interface AciConnectionSetup {
    configKey: string;
    promise: Promise<void>;
}
export interface AciConnectionState<TProvider extends ConnectableAciProvider> {
    profile: {
        logPrefix: string;
    };
    config: AciConnectionConfig;
    provider: TProvider | undefined;
    providerConfigKey: string | undefined;
    connectionSetup: AciConnectionSetup | undefined;
    connectionError: string | undefined;
    renderConnectionStatus: (() => void) | undefined;
}
export declare function ensureAciConnection<TProvider extends ConnectableAciProvider>(state: AciConnectionState<TProvider>, createProvider: () => TProvider): Promise<void>;
export declare function closeAciProvider<TProvider extends ConnectableAciProvider>(state: AciConnectionState<TProvider>): Promise<void>;
export {};
//# sourceMappingURL=connection.d.ts.map