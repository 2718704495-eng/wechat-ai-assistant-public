import { describe, expect, test } from "vitest";

import {
  assertSendGate,
  loadRuntimeConfig,
} from "../../src/config/runtime-config.js";

describe("runtime configuration", () => {
  test("defaults to a local dry-run with an exact conversation allowlist", () => {
    const config = loadRuntimeConfig({ HOME: "/Users/test" });

    expect(config).toMatchObject({
      dataDir: "/Users/test/Desktop/聊天助手",
      mode: "dry-run",
      allowedWechatConversations: ["example-contact", "file-transfer"],
      douyinWriteEnabled: false,
    });
  });

  test("rejects an unsupported run mode instead of guessing", () => {
    expect(() =>
      loadRuntimeConfig({
        HOME: "/Users/test",
        CHAT_ASSISTANT_MODE: "automatic",
      }),
    ).toThrow("INVALID_RUNTIME_CONFIG");
  });

  test("blocks sending when the contact consent is not confirmed", () => {
    const config = loadRuntimeConfig({
      HOME: "/Users/test",
      CHAT_ASSISTANT_MODE: "live",
    });

    expect(() =>
      assertSendGate(config, {
        consentConfirmed: false,
        initializationReportApproved: true,
      }),
    ).toThrow("CONSENT_NOT_CONFIRMED");
  });

  test("blocks sending until the current initialization report is approved", () => {
    const config = loadRuntimeConfig({
      HOME: "/Users/test",
      CHAT_ASSISTANT_MODE: "supervised-send",
    });

    expect(() =>
      assertSendGate(config, {
        consentConfirmed: true,
        initializationReportApproved: false,
      }),
    ).toThrow("INITIALIZATION_REPORT_NOT_APPROVED");
  });

  test("allows sending only in supervised or live mode after both gates", () => {
    const gateState = {
      consentConfirmed: true,
      initializationReportApproved: true,
    };

    expect(() =>
      assertSendGate(
        loadRuntimeConfig({ HOME: "/Users/test", CHAT_ASSISTANT_MODE: "observe" }),
        gateState,
      ),
    ).toThrow("SEND_MODE_DISABLED");

    expect(() =>
      assertSendGate(
        loadRuntimeConfig({
          HOME: "/Users/test",
          CHAT_ASSISTANT_MODE: "supervised-send",
        }),
        gateState,
      ),
    ).not.toThrow();
  });
});
