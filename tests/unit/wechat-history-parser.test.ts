import { describe, expect, test } from "vitest";

import { parseWechatHistoryPages } from "../../src/application/wechat-history-parser.js";

describe("parseWechatHistoryPages", () => {
  test("turns sender-time-text groups into chronological messages", () => {
    const result = parseWechatHistoryPages([
      [
        line("2025年11月2日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("2025年11月2日20:35", 0.69, 0.68, 0.5),
        line("好兄弟", 0.66),
        line("示例联系人", 0.30),
        line("2025年11月2日20:36", 0.30, 0.68, 0.5),
        line("我知道啦", 0.27),
      ],
    ]);

    expect(result.messages.map(({ direction, text, occurredAt }) => ({ direction, text, occurredAt }))).toEqual([
      { direction: "outgoing", text: "好兄弟", occurredAt: "2025-11-02T12:35:00.000Z" },
      { direction: "incoming", text: "我知道啦", occurredAt: "2025-11-02T12:36:00.000Z" },
    ]);
    expect(result.gaps).toEqual([]);
  });

  test("infers the year from the page date and joins wrapped text", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年5月10日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("5月11日 00:08", 0.69, 0.74, 0.5),
        line("TM写个论文，查重一次你要我100多", 0.66, 0.185, 0.5),
        line("重也是用ai，有意思吗", 0.63),
      ],
    ]);

    expect(result.messages).toMatchObject([
      {
        occurredAt: "2026-05-10T16:08:00.000Z",
        text: "TM写个论文，查重一次你要我100多重也是用ai，有意思吗",
      },
    ]);
  });

  test("redacts private contact details and records contentless media as gaps", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年8月7日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("8月7日 18:51", 0.69, 0.74, 0.5),
        line("示例城市某区某小区3号楼 13800000000", 0.66),
        line("示例联系人", 0.30),
        line("8月7日 18:52", 0.30, 0.74, 0.5),
        line("定位到聊天位置", 0.27, 0.75),
      ],
    ]);

    expect(result.messages).toEqual([]);
    expect(result.gaps.map(({ reason }) => reason)).toEqual([
      "SENSITIVE_PRIVATE_CONTENT_REDACTED",
      "NON_TEXT_CONTENT_NOT_EXTRACTED",
    ]);
  });

  test("uses the page date for yesterday and weekday timestamps", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年8月18日", 0.74, 0.12),
        line("示例联系人", 0.69),
        line("昨天 23:02", 0.69, 0.80, 0.5),
        line("我都不认识他", 0.66),
      ],
      [
        line("2026年8月17日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("星期一 19:55", 0.69, 0.80, 0.5),
        line("打游戏", 0.66),
      ],
    ]);

    expect(result.messages.map(({ occurredAt }) => occurredAt)).toEqual([
      "2026-08-17T11:55:00.000Z",
      "2026-08-18T15:02:00.000Z",
    ]);
  });

  test("rolls an omitted year forward when one page crosses New Year", () => {
    const result = parseWechatHistoryPages([
      [
        line("2025年11月8日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("2025年11月8日 00:03", 0.69, 0.68, 0.5),
        line("睡觉", 0.66),
        line("示例联系人", 0.30),
        line("2月26日 13:05", 0.30, 0.74, 0.5),
        line("起床了", 0.27),
      ],
    ]);

    expect(result.messages.map(({ occurredAt }) => occurredAt)).toEqual([
      "2025-11-07T16:03:00.000Z",
      "2026-02-26T05:05:00.000Z",
    ]);
  });

  test("removes navigation labels and trailing timestamps from OCR text", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年4月7日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("4月7日 18:35", 0.69, 0.74, 0.5),
        line("我哥们最近老是装死 定位到聊天位置", 0.66, 0.185, 0.5),
        line("也看不到，你说这咋办4月7日 18:36", 0.63),
      ],
    ]);

    expect(result.messages).toMatchObject([{ text: "我哥们最近老是装死也看不到，你说这咋办" }]);
  });

  test("treats timestamp-only OCR content as a non-text gap", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年3月2日", 0.74, 0.12),
        line("锦春意年", 0.69),
        line("3月2日 23:40", 0.69, 0.74, 0.5),
        line("3月2日23:41", 0.66),
      ],
    ]);

    expect(result.messages).toEqual([]);
    expect(result.gaps).toHaveLength(1);
  });

  test("removes a timestamp split across OCR lines after joining content", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年3月19日", 0.74, 0.12),
        line("示例联系人", 0.69),
        line("3月19日 00:15", 0.69, 0.74, 0.5),
        line("起码目前没遇到我会结婚的3月19日", 0.66),
        line("00:16", 0.63),
      ],
    ]);

    expect(result.messages).toMatchObject([{ text: "起码目前没遇到我会结婚的" }]);
  });

  test("treats a media duration as a non-text gap", () => {
    const result = parseWechatHistoryPages([
      [
        line("2026年3月31日", 0.74, 0.12),
        line("示例联系人", 0.69),
        line("3月31日 00:28", 0.69, 0.74, 0.5),
        line("0:07", 0.66),
      ],
    ]);

    expect(result.messages).toEqual([]);
    expect(result.gaps).toHaveLength(1);
  });
});

function line(text: string, y: number, x = 0.185, confidence = 1) {
  return { text, confidence, bounds: { x, y, width: 0.2, height: 0.02 } };
}
