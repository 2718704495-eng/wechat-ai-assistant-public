import { describe, expect, it } from "vitest";

import { parseCliCommand } from "../../src/cli.js";

describe("parseCliCommand", () => {
  it("parses initialization and report commands", () => {
    expect(parseCliCommand(["init"])).toEqual({ name: "init" });
    expect(parseCliCommand(["report"])).toEqual({ name: "report" });
  });

  it("uses a default or explicit import batch size", () => {
    expect(parseCliCommand(["import-wechat"])).toEqual({ name: "import-wechat", batchSize: 100 });
    expect(parseCliCommand(["import-douyin", "--batch-size", "25"])).toEqual({ name: "import-douyin", batchSize: 25 });
  });

  it("requires a valid report hash", () => {
    const hash = "a".repeat(64);
    expect(parseCliCommand(["approve-report", "--sha256", hash])).toEqual({ name: "approve-report", hash });
    expect(() => parseCliCommand(["approve-report", "bad"])).toThrow("INVALID_CLI_COMMAND");
  });
});
