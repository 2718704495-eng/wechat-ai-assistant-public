import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runSupervisedAcceptanceCli } from "../../src/runtime-v2/supervised-acceptance-cli.js";

describe("supervised acceptance CLI", () => {
  it("keeps live execution disabled by default", async () => {
    await expect(runSupervisedAcceptanceCli({
      argv: ["--stage", "A"],
      input: new PassThrough(),
      output: new PassThrough(),
    })).rejects.toThrow("ACCEPTANCE_LIVE_EXECUTION_DISABLED");
  });

  it.each([
    ["--target", "example-contact"],
    ["--text", "hello"],
    ["--x", "10"],
    ["--enable-send", "true"],
  ])("rejects forbidden caller-controlled arguments %s", async (name, value) => {
    await expect(runSupervisedAcceptanceCli({
      argv: ["--stage", "B1", name, value],
      input: new PassThrough(),
      output: new PassThrough(),
    })).rejects.toThrow("ACCEPTANCE_ARGUMENTS_INVALID");
  });

  it("reads the B1 decision from one bounded stdin record, never argv or env", async () => {
    const input = new PassThrough();
    input.end('{"decision":"approve"}\n');
    const runB1 = vi.fn(() => Promise.resolve({ stage: "B1", status: "verified" }));
    const output = new PassThrough();

    await runSupervisedAcceptanceCli({
      argv: ["--stage", "B1"],
      input,
      output,
      testOnlyService: { runA: vi.fn(), runB0: vi.fn(), runB1 },
      releaseBinding: {
        payloadManifestSha256: "a".repeat(64),
        nativeSha256: "b".repeat(64),
        effectiveConfigSha256: "c".repeat(64),
      },
    });

    expect(runB1).toHaveBeenCalledWith(expect.any(Object), "approve");
    const rendered = output.read() as Buffer | null;
    expect(rendered?.toString("utf8")).toBe('{"stage":"B1","status":"verified"}\n');
  });
});
