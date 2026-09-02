import { constants, closeSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const parent = required("RUNTIME_V2_ROUND9_PRIVATE_PARENT");
const basename = required("RUNTIME_V2_ROUND9_PRIVATE_BASENAME");
const ready = required("RUNTIME_V2_ROUND9_PRIVATE_READY");
const receipt = required("RUNTIME_V2_ROUND9_PRIVATE_RECEIPT");
const privateRoot = path.join(parent, basename);
const identity = lstatSync(privateRoot);
const addonPath = path.resolve(
  "native", "kernel-lock", "build", `${process.platform}-${process.arch}`, "kernel_lock.node",
);
const addon = createRequire(import.meta.url)(addonPath);
const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
try {
  writeFileSync(ready, "ready\n", { mode: 0o600 });
  const result = addon.removePrivateTreeAtExpected(
    parentFd,
    basename,
    Number(identity.dev),
    Number(identity.ino),
    identity.uid,
  );
  writeFileSync(receipt, `${JSON.stringify(result)}\n`, { mode: 0o600 });
} finally {
  closeSync(parentFd);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}
