import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("simulated conversation acceptance fixture", () => {
  it("covers every safety-critical state without real personal content", async () => {
    const document = JSON.parse(
      await readFile(new URL("../fixtures/simulated-conversation.json", import.meta.url), "utf8"),
    ) as { synthetic: boolean; scenarios: Array<{ type: string }> };

    expect(document.synthetic).toBe(true);
    expect(document.scenarios.map(({ type }) => type).sort()).toEqual([
      "cold-reply",
      "daily-review",
      "duplicate-message",
      "ordinary",
      "proactive-share",
      "resume-command",
      "sensitive-topic",
      "stop-command",
      "uncertain-send",
    ]);
  });
});
