import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import { LiveResearchBroker } from "../../src/mcp/live-research-broker.js";
import { OfficialResearchExecutor } from "../../src/mcp/official-research-executor.js";
import {
  createOfficialResearchMcpServer,
  createOfficialResearchRuntimeDependencies,
  type OfficialResearchMcpDependencies,
} from "../../src/mcp/official-research-server.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import {
  MessageRepository,
  StateRepository,
  type TargetReplyTrigger,
} from "../../src/storage/repositories.js";

const NOW = Date.parse("2026-08-23T08:00:00.000Z");

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

describe("official research MCP server", () => {
  let rootDir: string;
  let store: EncryptedStore;
  let state: StateRepository;
  let messages: MessageRepository;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "official-research-server-"));
    store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
    state = new StateRepository(store, () => new Date(NOW));
    await activateBoundary(state);
    messages = new MessageRepository(store);
    close = () => Promise.resolve();
  });

  afterEach(async () => {
    await close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("exposes exactly one strict zero-parameter tool", async () => {
    const researchLatestTrigger = vi.fn<() => Promise<unknown>>()
      .mockResolvedValue(noSafeResult());
    await connect({ researchLatestTrigger });

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "research_latest_trigger",
    ]);
    for (const forbidden of [
      { query: "PRIVATE_QUERY_CANARY" },
      { url: "https://evil.example" },
      { domain: "evil.example" },
      { text: "PRIVATE_TEXT_CANARY" },
      { token: "PRIVATE_TOKEN_CANARY" },
    ]) {
      const result = await client.callTool({
        name: "research_latest_trigger",
        arguments: forbidden,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|evil\.example/u);
    }
    expect(researchLatestTrigger).not.toHaveBeenCalled();
  });

  it("resolves only the encrypted current incoming trigger and returns bounded official evidence", async () => {
    const { trigger, latest } = await seedTrigger("示例城市示例城区明天天气", {
      oldText: "PRIVATE_OLD_MESSAGE_CANARY 她住在某处",
    });
    const requested: string[] = [];
    await connect(runtimeDependencies((url) => {
      requested.push(url);
      return Promise.resolve(weatherResponse());
    }));

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });
    const serialized = readTextContent(result.content);

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      status: "VERIFIED",
      checkedAt: "2026-08-23T08:00:00.000Z",
      evidence: [{
        sourceName: "中国天气网（七日）",
        url: "https://www.weather.com.cn/weather/101190112.shtml",
        title: "示例城区天气预报,示例城区7天天气预报",
        publishedAt: "2026-08-23T00:00:00.000Z",
        eventDate: "2026-08-23T16:00:00.000Z",
        snippet: "24日（明天）：晴转多云，33℃/26℃",
      }],
    });
    expect(requested).toEqual(["https://www.weather.com.cn/weather/101190112.shtml"]);
    expect(serialized).not.toContain(latest.text);
    expect(serialized).not.toContain(trigger.triggerId);
    expect(serialized).not.toContain("PRIVATE_OLD_MESSAGE_CANARY");
    expect(serialized).not.toMatch(/capability|normalizedQuery|messageText/u);
  });

  it.each(["missing", "consumed", "ambiguous-message"] as const)(
    "returns a fixed trigger mismatch with zero fetch for %s state",
    async (scenario) => {
      let fetchCount = 0;
      if (scenario !== "missing") {
        const { trigger, latest } = await seedTrigger("示例城市示例城区明天天气");
        if (scenario === "consumed") await state.consumeTargetReplyTrigger(trigger.triggerId);
        if (scenario === "ambiguous-message") {
          const stored = await messages.list();
          await store.write("vault/messages.enc", { messages: [
            ...stored,
            { ...latest, occurredAt: "2026-08-23T08:01:00.000Z" },
          ] });
        }
      }
      await connect(runtimeDependencies(() => {
        fetchCount += 1;
        return Promise.resolve(weatherResponse());
      }));

      const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });

      expect(result.isError).toBe(true);
      expect(readTextContent(result.content)).toBe("RESEARCH_TRIGGER_MISMATCH");
      expect(fetchCount).toBe(0);
    },
  );

  it("re-reads the trigger before fetch and rejects drift with zero network", async () => {
    const { trigger } = await seedTrigger("示例城市示例城区明天天气");
    let fetchCount = 0;
    let listCount = 0;
    const driftingMessages = {
      list: async () => {
        const listed = await messages.list();
        listCount += 1;
        if (listCount === 1) await state.consumeTargetReplyTrigger(trigger.triggerId);
        return listed;
      },
    };
    const broker = new LiveResearchBroker({ now: () => NOW });
    await connect(createOfficialResearchRuntimeDependencies({
      state,
      messages: driftingMessages,
      broker,
      executor: new OfficialResearchExecutor({
        broker,
        now: () => NOW,
        fetch: () => {
        fetchCount += 1;
        return Promise.resolve(weatherResponse());
        },
      }),
      now: () => NOW,
    }));

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });

    expect(result.isError).toBe(true);
    expect(readTextContent(result.content)).toBe("RESEARCH_TRIGGER_MISMATCH");
    expect(fetchCount).toBe(0);
  });

  it("re-reads after fetch and discards verified evidence when the trigger drifted", async () => {
    const { trigger } = await seedTrigger("示例城市示例城区明天天气");
    let fetchCount = 0;
    await connect(runtimeDependencies(async () => {
      fetchCount += 1;
      await state.consumeTargetReplyTrigger(trigger.triggerId);
      return weatherResponse("PRIVATE_FETCH_BODY_CANARY");
    }));

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(readTextContent(result.content)).toBe("RESEARCH_TRIGGER_MISMATCH");
    expect(fetchCount).toBe(1);
    expect(serialized).not.toMatch(/中国天气网|晴转多云|PRIVATE_FETCH_BODY_CANARY/u);
  });

  it("rejects a trigger minted before a STOP and RESUME revision", async () => {
    await seedTrigger("示例城市示例城区明天天气");
    await state.setStopped("user-command");
    await state.resume();
    let fetchCount = 0;
    await connect(runtimeDependencies(() => {
      fetchCount += 1;
      return Promise.resolve(weatherResponse());
    }));

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });

    expect(result.isError).toBe(true);
    expect(readTextContent(result.content)).toBe("RESEARCH_TRIGGER_MISMATCH");
    expect(fetchCount).toBe(0);
  });

  it("rejects a mismatched weather location before fetch", async () => {
    await seedTrigger("上海明天天气");
    let fetchCount = 0;
    await connect(runtimeDependencies(() => {
      fetchCount += 1;
      return Promise.resolve(weatherResponse());
    }));

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(readTextContent(result.content))).toEqual(noSafeResult());
    expect(fetchCount).toBe(0);
  });

  it("claims one safe owner notice for sensitive text with zero network and no plaintext persistence", async () => {
    const privateText = "她最近需要去医院，帮我查怎么治疗 PRIVATE_OWNER_CANARY";
    const { trigger } = await seedTrigger(privateText);
    let fetchCount = 0;
    await connect(runtimeDependencies(() => {
      fetchCount += 1;
      return Promise.resolve(weatherResponse());
    }));

    const first = await client.callTool({ name: "research_latest_trigger", arguments: {} });
    const second = await client.callTool({ name: "research_latest_trigger", arguments: {} });
    const firstResult = JSON.parse(readTextContent(first.content)) as Record<string, unknown>;

    expect(firstResult.status).toBe("OWNER_NOTICE_REQUIRED");
    const ownerNotice = firstResult.ownerNotice;
    if (typeof ownerNotice !== "object" || ownerNotice === null) {
      throw new Error("EXPECTED_OWNER_NOTICE");
    }
    expect(ownerNotice).toMatchObject({
      reasonCode: "SENSITIVE_MEDICAL_REQUEST",
      triggerIdHash: sha256(trigger.triggerId),
    });
    expect("noticeId" in ownerNotice && ownerNotice.noticeId)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(readTextContent(second.content))).toEqual(noSafeResult());
    expect(fetchCount).toBe(0);
    expect(JSON.stringify([first, second])).not.toContain(privateText);
    const claimEntries = await readdir(path.join(rootDir, "state/owner-notice-claims"));
    expect(claimEntries).toHaveLength(1);
    const claimBytes = await readFile(
      path.join(rootDir, "state/owner-notice-claims", claimEntries[0] ?? "missing"),
    );
    expect(claimBytes.byteLength).toBe(0);
    expect((await state.getTargetReplyState()).lastOwnerNoticeKey).toBeNull();
  });

  it("maps dependency failures to one fixed safe MCP error", async () => {
    await connect({
      researchLatestTrigger: () => Promise.reject(new Error("PRIVATE_DEPENDENCY_CANARY")),
    });

    const result = await client.callTool({ name: "research_latest_trigger", arguments: {} });

    expect(result.isError).toBe(true);
    expect(readTextContent(result.content)).toBe("OFFICIAL_RESEARCH_FAILED");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DEPENDENCY_CANARY");
  });

  async function connect(dependencies: OfficialResearchMcpDependencies): Promise<void> {
    const server = createOfficialResearchMcpServer(dependencies);
    client = new Client({ name: "official-research-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  }

  function runtimeDependencies(fetch: (url: string) => Promise<Response>) {
    const broker = new LiveResearchBroker({ now: () => NOW });
    return createOfficialResearchRuntimeDependencies({
      state,
      messages,
      broker,
      executor: new OfficialResearchExecutor({ broker, fetch, now: () => NOW }),
      now: () => NOW,
    });
  }

  async function seedTrigger(
    latestText: string,
    options: { oldText?: string } = {},
  ): Promise<{ trigger: TargetReplyTrigger; latest: ChatMessage }> {
    const gate = await state.getPersistentStopGate();
    const checkpoint = gate.checkpoint;
    const old = message("old-visible", options.oldText ?? "旧消息");
    const latest = message("latest-incoming", latestText);
    const firstAdded = await messages.appendUnique([old]);
    await state.evaluateTargetReply({
      messages: [old],
      addedIds: firstAdded,
      unreadIndicator: false,
      controlCheckpoint: checkpoint,
      expectedGateRevision: gate.gateRevision,
    });
    const addedIds = await messages.appendUnique([latest]);
    const evaluated = await state.evaluateTargetReply({
      messages: [old, latest],
      addedIds,
      unreadIndicator: true,
      controlCheckpoint: checkpoint,
      expectedGateRevision: gate.gateRevision,
    });
    if (evaluated.trigger === null) throw new Error("EXPECTED_TRIGGER");
    return { trigger: evaluated.trigger, latest };
  }
});

function message(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-23T08:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
}

async function activateBoundary(state: StateRepository): Promise<void> {
  const issued = await state.issueControlBoundary();
  await state.activateControlBoundary({
    expectedEpoch: issued.epoch,
    boundaryMessageId: issued.boundaryMessageId,
    markerOccurrenceCount: 1,
  });
}

function weatherResponse(extra = ""): Response {
  return new Response(`<!doctype html><html><head>
    <title>示例城区天气预报,示例城区7天天气预报</title>
    <script>var fc_24h_internal_update_time = "2026082308";</script>
  </head><body><ul class="t clearfix">
    <li class="sky skyid lv1"><h1>24日（明天）</h1><p class="wea">晴转多云</p><p class="tem"><span>33</span>/<i>26℃</i></p></li>
  </ul><!--${extra}--></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function noSafeResult() {
  return {
    status: "NO_SAFE_RESEARCH_RESULT",
    checkedAt: "2026-08-23T08:00:00.000Z",
    evidence: [],
  };
}

function readTextContent(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("EXPECTED_CONTENT_ARRAY");
  for (const block of content as unknown[]) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  throw new Error("EXPECTED_TEXT_RESULT");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
