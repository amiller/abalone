import { AppStorage, setAppStorage } from "@pi-components/storage/app-storage.js";
import { IndexedDBStorageBackend } from "@pi-components/storage/backends/indexeddb-storage-backend.js";
import { SettingsStore } from "@pi-components/storage/stores/settings-store.js";
import { ProviderKeysStore } from "@pi-components/storage/stores/provider-keys-store.js";
import { SessionsStore } from "@pi-components/storage/stores/sessions-store.js";
import { CustomProvidersStore } from "@pi-components/storage/stores/custom-providers-store.js";

export function createChatStorage() {
  const settings = new SettingsStore(), providerKeys = new ProviderKeysStore(),
    sessions = new SessionsStore(), customProviders = new CustomProvidersStore();
  const stores = [settings, providerKeys, sessions, customProviders];
  const backend = new IndexedDBStorageBackend({
    dbName: "abalone-web-agent-chats",
    version: 1,
    stores: [...stores.map((store) => store.getConfig()), SessionsStore.getMetadataConfig()],
  });
  for (const store of stores) store.setBackend(backend);
  const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
  setAppStorage(storage);
  return storage;
}
