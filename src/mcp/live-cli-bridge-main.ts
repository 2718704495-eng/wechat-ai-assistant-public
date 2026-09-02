import { createLiveProductionRuntime } from "./live-bootstrap.js";
import { runLiveCliBridgeProcess } from "./live-cli-bridge.js";

process.exitCode = await runLiveCliBridgeProcess({
  arguments: process.argv.slice(2),
  createRuntime: createLiveProductionRuntime,
  input: process.stdin,
  output: process.stdout,
  signals: process,
});
