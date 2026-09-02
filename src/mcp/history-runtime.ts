import { z } from "zod";

import type { NativeBridge, OCRLine, WindowDescriptor } from "../adapters/native-bridge.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import type { MessageRepository } from "../storage/repositories.js";
import type { HistoryMcpDependencies, HistoryNavigationAction } from "./history-server.js";

const targetBundleID = "com.tencent.xinWeChat";
const targetTitle = "与“示例联系人”的聊天记录";

export function createLocalHistoryDependencies(
  bridge: NativeBridge,
  messages: MessageRepository,
  store: EncryptedStore,
): HistoryMcpDependencies {
  async function locate(): Promise<WindowDescriptor> {
    const matches = (await bridge.listWindows(targetBundleID)).filter((window) => window.title === targetTitle);
    if (matches.length !== 1) throw new Error(matches.length === 0 ? "TARGET_HISTORY_WINDOW_NOT_FOUND" : "TARGET_HISTORY_WINDOW_AMBIGUOUS");
    return matches[0] as WindowDescriptor;
  }

  async function navigate(action: HistoryNavigationAction): Promise<void> {
    const window = await locate();
    if (action.type === "scroll") {
      await bridge.scrollReadOnly({ windowID: window.windowID, bundleID: targetBundleID, title: targetTitle, deltaY: action.deltaY });
      return;
    }
    await bridge.dragScrollbarReadOnly({
      windowID: window.windowID,
      bundleID: targetBundleID,
      title: targetTitle,
      fromY: action.fromY,
      toY: action.toY,
    });
  }

  return {
    locateTargetWindow: async () => {
      const window = await locate();
      return { windowID: window.windowID, title: window.title, bounds: window.bounds };
    },
    captureTargetOcr: async (): Promise<OCRLine[]> => {
      const window = await locate();
      return bridge.ocr(await bridge.capture(window.windowID));
    },
    scrollTarget: async (deltaY) => {
      const window = await locate();
      await bridge.scrollReadOnly({ windowID: window.windowID, bundleID: targetBundleID, title: targetTitle, deltaY });
    },
    dragTargetScrollbar: async (fromY, toY) => {
      const window = await locate();
      await bridge.dragScrollbarReadOnly({ windowID: window.windowID, bundleID: targetBundleID, title: targetTitle, fromY, toY });
    },
    scanTargetBatch: async (actions) => {
      const pages: Array<{ index: number; action: HistoryNavigationAction; lines: OCRLine[] }> = [];
      for (const [index, action] of actions.entries()) {
        await navigate(action);
        const window = await locate();
        const lines = await bridge.ocr(await bridge.capture(window.windowID));
        pages.push({ index, action, lines });
      }
      return { pages };
    },
    listImportedMessages: async (offset, limit) => {
      const all = await messages.list();
      return { total: all.length, offset, limit, messages: all.slice(offset, offset + limit) };
    },
    getCheckpoint: async () => (await store.read("state/history-import.enc", z.unknown())) ?? { sources: {} },
  };
}
