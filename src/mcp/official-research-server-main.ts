import { loadRuntimeConfig } from "../config/runtime-config.js";
import { MacOSKeychainKeyProvider } from "../security/keychain.js";
import { EncryptedStore } from "../storage/encrypted-store.js";
import { MessageRepository, StateRepository } from "../storage/repositories.js";
import { LiveResearchBroker } from "./live-research-broker.js";
import {
  OfficialResearchExecutor,
  type OfficialFetch,
} from "./official-research-executor.js";
import {
  connectOfficialResearchMcpStdio,
  createOfficialResearchRuntimeDependencies,
} from "./official-research-server.js";

const config = loadRuntimeConfig(process.env);
const store = new EncryptedStore(config.dataDir, new MacOSKeychainKeyProvider());
const broker = new LiveResearchBroker();
const officialFetch: OfficialFetch = (url, init) => fetch(url, init);

await connectOfficialResearchMcpStdio(createOfficialResearchRuntimeDependencies({
  state: new StateRepository(store),
  messages: new MessageRepository(store),
  broker,
  executor: new OfficialResearchExecutor({ broker, fetch: officialFetch }),
}));
