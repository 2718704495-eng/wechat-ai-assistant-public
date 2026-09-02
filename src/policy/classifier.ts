import type { ChatMessage, Decision } from "../domain/types.js";

export interface ClassificationContext {
  requiresUserFact?: boolean;
}

const pauseRules: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: "SENSITIVE_AI_IDENTITY",
    pattern: /(?:是不是|是否|这句|这条).*(?:AI|ai|机器人)|(?:AI|ai|机器人).*(?:写|回|生成)/u,
  },
  {
    reason: "SENSITIVE_RELATIONSHIP",
    pattern: /表白|我.*喜欢你|(?:是不是|是否|你)?喜欢我(?:吗)?|在一起|做我(?:女|男)朋友|算什么关系|确定关系|分手/u,
  },
  {
    reason: "SENSITIVE_MEETING",
    pattern: /见个?面|碰个面|约(?:你|会)|来示例城市|去示例城市|买.*票|订.*票|几点到|请假.*(?:去|来|见)/u,
  },
  {
    reason: "SENSITIVE_CONFLICT",
    pattern: /吵架|生气|不高兴|冷战|道歉|对不起/u,
  },
  {
    reason: "SENSITIVE_EX_PARTNER",
    pattern: /前任|前女友|前男友/u,
  },
  {
    reason: "SENSITIVE_SEXUAL",
    pattern: /接吻|亲(?:我|你)|上床|裸照|开房|性生活/u,
  },
  {
    reason: "SENSITIVE_MONEY",
    pattern: /借我?.*钱|转账|红包|银行卡|工资|多少钱|两千块钱|付款/u,
  },
  {
    reason: "SENSITIVE_PRIVACY",
    pattern: /身份证|家庭住址|住哪(?:里|儿)|手机号|隐私|密码/u,
  },
  {
    reason: "SENSITIVE_ITINERARY",
    pattern: /行程|航班|车次|什么时候(?:来|走|到)|哪天(?:来|走|到)/u,
  },
];

const generalKnowledgePattern = /最早|传统|科普|百科|是什么|为什么会|原理|历史|天气/u;

export function classifyMessage(
  message: ChatMessage,
  context: ClassificationContext,
): Decision {
  if (message.text.trim().length === 0 || message.confidence < 0.85) {
    return { action: "clarify", reason: "LOW_CONFIDENCE_CONTENT" };
  }

  if (context.requiresUserFact === true) {
    return { action: "pause", reason: "USER_FACT_REQUIRED" };
  }

  for (const rule of pauseRules) {
    if (rule.pattern.test(message.text)) {
      return { action: "pause", reason: rule.reason };
    }
  }

  if (generalKnowledgePattern.test(message.text)) {
    return { action: "reply", reason: "GENERAL_KNOWLEDGE" };
  }

  return { action: "reply", reason: "EVERYDAY_CONVERSATION" };
}
