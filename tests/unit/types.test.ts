import { expectTypeOf, test } from "vitest";

import type { ChatMessage, RunResult } from "../../src/domain/types.js";

test("shared contracts reject unsupported conversation and status values", () => {
  expectTypeOf<ChatMessage["conversationId"]>().toEqualTypeOf<
    "example-contact" | "file-transfer"
  >();
  expectTypeOf<RunResult["status"]>().toEqualTypeOf<
    "success" | "warning" | "error" | "blocked"
  >();
});
