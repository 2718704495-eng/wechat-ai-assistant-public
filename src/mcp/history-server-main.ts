import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeBridge } from "../adapters/native-bridge.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { MacOSKeychainKeyProvider } from "../security/keychain.js";
import { EncryptedStore } from "../storage/encrypted-store.js";
import { MessageRepository } from "../storage/repositories.js";
import { createLocalHistoryDependencies } from "./history-runtime.js";
import { connectHistoryMcpStdio } from "./history-server.js";

const config = loadRuntimeConfig(process.env);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const executablePath = path.join(
  projectRoot,
  "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
);
const store = new EncryptedStore(config.dataDir, new MacOSKeychainKeyProvider());
const bridge = new NativeBridge({ executablePath, dataDir: config.dataDir });

await connectHistoryMcpStdio(
  createLocalHistoryDependencies(bridge, new MessageRepository(store), store),
);
