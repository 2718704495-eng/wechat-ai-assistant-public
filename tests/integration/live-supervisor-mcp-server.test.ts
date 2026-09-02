import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLiveSupervisorMcpServer,
  type LiveSupervisorMcpDependencies,
} from "../../src/mcp/live-supervisor-mcp-server.js";

const expectedTools = [
  "abort-draft",
  "close",
  "establish-control-boundary",
  "prepare-latest-reply",
  "read-control",
  "read-target",
  "show-comfort-station",
  "submit-authorized-draft",
  "verify-draft",
  "verify-send",
];

describe("live supervisor MCP server", () => {
  let client: Client;
  let closeServer: () => Promise<void>;
  let dependencies: LiveSupervisorMcpDependencies;
  let onCloseRequested: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let readControl: ReturnType<
    typeof vi.fn<LiveSupervisorMcpDependencies["readControlForSupervisor"]>
  >;
  let submitAuthorized: ReturnType<
    typeof vi.fn<LiveSupervisorMcpDependencies["submitAuthorizedDraftForSupervisor"]>
  >;

  beforeEach(async () => {
    readControl = vi.fn<LiveSupervisorMcpDependencies["readControlForSupervisor"]>()
      .mockResolvedValue({
        publicResult: { control: null, checkpointReady: true },
        proof: {
          capability: "CONTROL_CANARY",
          checkpoint: {
            epoch: "e".repeat(64),
            boundaryMessageId: "b".repeat(64),
            consumedCount: 0,
            prefixChainHash: "p".repeat(64),
          },
          verification: "ui-observed",
          gateRevision: "g".repeat(64),
        },
      });
    submitAuthorized = vi.fn<
      LiveSupervisorMcpDependencies["submitAuthorizedDraftForSupervisor"]
    >().mockResolvedValue({ submitted: true, conversationId: "example-contact" });
    dependencies = fakeDependencies({ readControl, submitAuthorized });
    onCloseRequested = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const server = createLiveSupervisorMcpServer(dependencies, { onCloseRequested });
    client = new Client({ name: "supervisor-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = async () => Promise.allSettled([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => closeServer());

  it("exposes exactly the ten high-level supervisor tools", async () => {
    expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(expectedTools);
  });

  it("rejects extra parameters before touching the runtime", async () => {
    const result = await client.callTool({
      name: "read-control",
      arguments: { conversationId: "example-contact" },
    });

    expect(result.isError).toBe(true);
    expect(readControl).not.toHaveBeenCalled();
  });

  it("keeps all capabilities and tokens internal through one authorized send", async () => {
    const results = [];
    results.push(await client.callTool({ name: "read-control", arguments: {} }));
    results.push(await client.callTool({ name: "read-target", arguments: {} }));
    results.push(await client.callTool({
      name: "prepare-latest-reply",
      arguments: { text: "收到，我晚点看看" },
    }));
    results.push(await client.callTool({ name: "verify-draft", arguments: {} }));
    results.push(await client.callTool({ name: "submit-authorized-draft", arguments: {} }));
    results.push(await client.callTool({ name: "verify-send", arguments: {} }));

    const serialized = JSON.stringify(results);
    for (const canary of ["CONTROL_CANARY", "TRIGGER_CANARY", "CANDIDATE_CANARY"]) {
      expect(serialized).not.toContain(canary);
    }
    expect(submitAuthorized).toHaveBeenCalledTimes(1);
  });

  it("sanitizes dependency errors instead of returning private text", async () => {
    readControl.mockRejectedValueOnce(
      new Error("private chat text: 今晚见"),
    );

    const result = await client.callTool({ name: "read-control", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("SUPERVISOR_OPERATION_FAILED");
    expect(JSON.stringify(result)).not.toContain("今晚见");
  });

  it("acknowledges close before asynchronously requesting coordinated shutdown", async () => {
    const result = await client.callTool({ name: "close", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(readTextContent(result.content)).toBe('{"closed":true}');
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalledTimes(1));
  });
});

function fakeDependencies(mocks: {
  readControl: LiveSupervisorMcpDependencies["readControlForSupervisor"];
  submitAuthorized: LiveSupervisorMcpDependencies["submitAuthorizedDraftForSupervisor"];
}): LiveSupervisorMcpDependencies {
  return {
    establishControlBoundaryForSupervisor: vi.fn().mockResolvedValue({
      status: "active",
      epoch: "e".repeat(64),
      boundaryMessageId: "b".repeat(64),
      consumedCount: 0,
      prefixChainHash: "p".repeat(64),
      markerOccurrenceCount: 1,
    }),
    readControlForSupervisor: mocks.readControl,
    readTargetForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { replyDecision: { action: "reply-latest-incoming" } },
      proof: {
        capability: "TRIGGER_CANARY",
        trigger: {
          triggerId: "t".repeat(64),
          baselineEpoch: "a".repeat(64),
          orderedSequenceHash: "o".repeat(64),
          triggerMessageId: "incoming-id",
          controlCheckpoint: {
            epoch: "e".repeat(64),
            boundaryMessageId: "b".repeat(64),
            consumedCount: 0,
            prefixChainHash: "p".repeat(64),
          },
          gateRevision: "g".repeat(64),
          createdAt: "2026-08-23T09:00:00.000Z",
        },
        comfortStationRequested: false,
      },
    }),
    readTargetDirectForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { replyDecision: { action: "wait" } },
      controlProof: null,
      proof: null,
    }),
    prepareLatestReplyForSupervisor: vi.fn().mockResolvedValue({
      candidateToken: "CANDIDATE_CANARY",
      prepared: true,
      conversationId: "example-contact",
    }),
    showComfortStationCardForSupervisor: vi.fn().mockResolvedValue({
      status: "verified",
      conversationId: "example-contact",
    }),
    verifyDraft: vi.fn().mockResolvedValue({
      draftVerified: true,
      conversationId: "example-contact",
    }),
    submitAuthorizedDraftForSupervisor: mocks.submitAuthorized,
    abortPreparedDraftForSupervisor: vi.fn().mockResolvedValue({
      aborted: true,
      conversationId: "example-contact",
    }),
    abortDraft: vi.fn().mockResolvedValue({
      aborted: true,
      conversationId: "example-contact",
    }),
    verifySend: vi.fn().mockResolvedValue({
      status: "verified",
      conversationId: "example-contact",
    }),
    getLiveState: vi.fn().mockResolvedValue({}),
    prepareDraft: vi.fn().mockResolvedValue({ candidateToken: "unused" }),
    readConversation: vi.fn().mockResolvedValue({}),
    readTargetConversationForAdvice: vi.fn().mockResolvedValue({}),
  };
}

function readTextContent(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("EXPECTED_CONTENT_ARRAY");
  const blocks: unknown[] = content;
  for (const block of blocks) {
    if (
      typeof block === "object"
      && block !== null
      && "type" in block
      && block.type === "text"
      && "text" in block
      && typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  throw new Error("EXPECTED_TEXT_RESULT");
}
