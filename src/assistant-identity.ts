export const ASSISTANT_DISPLAY_NAME = "示例用户" as const;
export const ASSISTANT_SIGNATURE = `——${ASSISTANT_DISPLAY_NAME}` as const;
export const LEGACY_ASSISTANT_SIGNATURES = ["——聊天助手"] as const;

export const ALL_ASSISTANT_SIGNATURES = [
  ASSISTANT_SIGNATURE,
  ...LEGACY_ASSISTANT_SIGNATURES,
] as const;
