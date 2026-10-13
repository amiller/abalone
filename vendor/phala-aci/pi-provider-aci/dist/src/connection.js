function connectionConfig(config) {
    return JSON.stringify({
        baseUrl: config.baseUrl,
        acceptedComposeHashes: config.trust.acceptedComposeHashes,
        acceptedSessionIds: config.trust.acceptedSessionIds,
    });
}
export async function ensureAciConnection(state, createProvider) {
    const configKey = connectionConfig(state.config);
    if (state.provider && state.providerConfigKey === configKey)
        return;
    const activeSetup = state.connectionSetup;
    if (activeSetup) {
        await activeSetup.promise;
        if (activeSetup.configKey === configKey)
            return;
        return ensureAciConnection(state, createProvider);
    }
    const setup = (async () => {
        await closeAciProvider(state);
        state.connectionError = undefined;
        state.renderConnectionStatus?.();
        try {
            const provider = createProvider();
            await provider.connect();
            state.provider = provider;
            state.providerConfigKey = configKey;
        }
        catch (error) {
            state.connectionError = error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            state.renderConnectionStatus?.();
        }
    })();
    const pending = { configKey, promise: setup };
    state.connectionSetup = pending;
    try {
        await setup;
    }
    finally {
        if (state.connectionSetup === pending)
            state.connectionSetup = undefined;
    }
}
export async function closeAciProvider(state) {
    const provider = state.provider;
    state.provider = undefined;
    state.providerConfigKey = undefined;
    if (!provider)
        return;
    try {
        await provider.close();
    }
    catch (error) {
        console.error(`${state.profile.logPrefix} ACI connection close failed:`, error);
    }
}
//# sourceMappingURL=connection.js.map