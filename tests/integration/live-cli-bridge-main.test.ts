import { afterEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  bootstrapOwner: "",
  inputIsProcessStdin: false,
  outputIsProcessStdout: false,
  signalsIsProcess: false,
  arguments: [] as string[],
}));

vi.mock("../../src/mcp/live-bootstrap.js", () => ({
  createLiveProductionRuntime: (options: { ownerKind: string }) => {
    observed.bootstrapOwner = options.ownerKind;
    return Promise.resolve({
      dependencies: { marker: "production-runtime" },
      close: () => Promise.resolve(),
    });
  },
}));

vi.mock("../../src/mcp/live-cli-bridge.js", () => ({
  runLiveCliBridgeProcess: async (options: {
    arguments: string[];
    createRuntime(input: { ownerKind: "cli" }): Promise<unknown>;
    input: unknown;
    output: unknown;
    signals: unknown;
  }) => {
    observed.arguments = options.arguments;
    observed.inputIsProcessStdin = options.input === process.stdin;
    observed.outputIsProcessStdout = options.output === process.stdout;
    observed.signalsIsProcess = options.signals === process;
    await options.createRuntime({ ownerKind: "cli" });
    return 0;
  },
}));

describe("live CLI bridge main", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    observed.bootstrapOwner = "";
    observed.inputIsProcessStdin = false;
    observed.outputIsProcessStdout = false;
    observed.signalsIsProcess = false;
    observed.arguments = [];
    vi.resetModules();
  });

  it("boots the shared production factory as the cli owner and binds stdio", async () => {
    await import("../../src/mcp/live-cli-bridge-main.js");

    expect(observed.bootstrapOwner).toBe("cli");
    expect(observed.inputIsProcessStdin).toBe(true);
    expect(observed.outputIsProcessStdout).toBe(true);
    expect(observed.signalsIsProcess).toBe(true);
    expect(observed.arguments).toEqual(process.argv.slice(2));
    expect(process.exitCode).toBe(0);
  });
});
