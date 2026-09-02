import type { ChatMessage } from "../domain/types.js";
import type { ArtifactIntent, ConversationSignals } from "./response-plan.js";

const selfReportedNegative = /(?:^|[，。！？、\s])(?:我|咱们?)(?:整个人|心里|心情|感觉|觉得)?(?:真的?|好|很|太|挺|有点|特别)*(?:烦|累|委屈|难受|难过|闹心|无语|离谱|倒霉|崩溃|生气)(?:(?:死了|透了|得慌|得很|了|啊|呀|呢)?(?=$|[，。！？、\s])|的(?=$|[，。！？、\s]|人|事))/u;
const describedNegative = /(?:整个人|心里|心情|感觉|觉得)(?:真的?|好|很|太|挺|有点|特别)*(?:烦|累|委屈|难受|难过|闹心|无语|离谱|倒霉|崩溃|生气)(?:(?:死了|透了|得慌|得很|了|啊|呀|呢)?(?=$|[，。！？、\s])|的(?=$|[，。！？、\s]|人|事))/u;
const qualifiedNegative = /(?:真的?|好|很|太|挺|有点|特别)+(?:烦|累|委屈|难受|难过|闹心|无语|离谱|倒霉|崩溃|生气)(?:(?:死了|透了|得慌|得很|了|啊|呀|呢)?(?=$|[，。！？、\s])|的(?=$|[，。！？、\s]|人|事))/u;
const strongNegative = /(?:烦|累|崩溃|气)(?:死了|透了)(?=$|[，。！？、\s])/u;
const negativeEvent = /(?:个|件|事)离谱(?=$|[，。！？、\s]|的|了|人)|心情不好(?=$|[，。！？、\s])/u;
const positiveExperience = /(?:开心|高兴|顺利|惊喜|期待|好玩)/u;
const adviceRequest = /(?:^(?:你觉得|那我|我(?:现在|接下来)?|这(?:件)?事|这种情况).*(?:该怎么办|该怎么|怎么处理)|^(?:能不能|可以|可不可以).*(?:给我)?.*(?:建议|办法)|^(?:请|帮我|给我).*(?:建议|出主意))/u;
const explicitDiscourseContinuation = /(?:这件事|那件事|这回事|那回事|刚才|刚刚|之前|前面|上次|后来|然后|结果|所以|因此)/u;
const concreteEventContinuation = /(?:把|被).+(?:了|着)|.+(?:走|跑|离开)了(?:[。！]|$)/u;
const continuationMarker = /(?:因为|然后|接着|还在|正在|仍然|但是|不过|可是|又|再)/u;
const terminalEvent = /(?:(?:已经|终于|总算|最终|最后).*)?(?:解决|结束|完成|搞定|处理好|过去)了(?:[。！]|$)|(?:走|跑|离开)了(?:[。！]|$)/u;
const artifactLabel = /(?:攻略|路线|规划|整理|对比|清单|HTML|页面)/iu;
const requestLead = /^(?:请|麻烦|帮(?:我)?|给(?:我)?|能否|能不能|可以|可不可以|我想(?:要)?|我需要|我要)/u;
const fileOutputRequest = /(?:生成|制作|导出|整理成|写成|发(?:给|我)).*文件|文件.*(?:生成|制作|导出|整理)/u;
const travelSignal = /(?:去(?:玩)?|旅行|旅游|出游|行程).*(?:天|周)|(?:天|周).*(?:去(?:玩)?|旅行|旅游|出游|行程)/u;
const travelArtifact = /(?:攻略|路线|行程)|(?:去(?:玩)?|旅行|旅游|出游).*(?:规划|整理|页面|文件)/u;

export function analyzeConversationSignals(
  current: ChatMessage,
  recentMessages: ChatMessage[],
): ConversationSignals {
  const currentNegative = hasNegativeExperience(current.text);
  const currentAdviceRequested = adviceRequest.test(current.text);
  const continuesPriorTopic = explicitDiscourseContinuation.test(current.text)
    || concreteEventContinuation.test(current.text)
    || currentAdviceRequested;
  const inheritedNegativeMessages = !currentNegative
    && current.direction === "incoming"
    && continuesPriorTopic
    ? recentMessages.slice(-2).filter(({ direction, text }) => (
        direction === "incoming" && hasNegativeExperience(text)
      ))
    : [];
  const inheritedNegative = inheritedNegativeMessages.length > 0;
  const emotionalState = currentNegative || inheritedNegative
    ? "negative"
    : positiveExperience.test(current.text)
      ? "positive"
      : /[?？]/u.test(current.text)
        ? "uncertain"
        : "neutral";

  return {
    emotionalState,
    intensity: /(?:崩溃|气死|特别|太.+了|死了)/u.test(
      [...inheritedNegativeMessages.map(({ text }) => text), current.text].join("\n"),
    ) ? "medium" : "light",
    storyComplete: !continuationMarker.test(current.text) && terminalEvent.test(current.text),
    adviceRequested: currentAdviceRequested,
    directQuestion: /[?？]|(?:吗|嘛|呢)$|(?:什么|为啥|为什么|怎么|咋|哪|几|多少|谁|是否)/u.test(current.text.trim()),
    artifactIntent: inferArtifactIntent(current.text),
    missingInformation: [],
    evidenceMessageIds: [
      ...new Set([...inheritedNegativeMessages.map(({ id }) => id), current.id]),
    ],
  };
}

function hasNegativeExperience(text: string): boolean {
  return [
    selfReportedNegative,
    describedNegative,
    qualifiedNegative,
    strongNegative,
    negativeEvent,
  ].some((pattern) => pattern.test(text));
}

function inferArtifactIntent(text: string): ArtifactIntent | null {
  const explicitArtifact = artifactLabel.test(text) || fileOutputRequest.test(text);
  const travelRequest = travelSignal.test(text) || travelArtifact.test(text);

  if (!requestLead.test(text) || (!explicitArtifact && !travelRequest)) {
    return null;
  }

  if (travelRequest) {
    return { kind: "travel-guide", trigger: explicitArtifact ? "explicit" : "implicit" };
  }

  if (/对比/u.test(text)) return { kind: "comparison", trigger: "explicit" };
  if (/清单/u.test(text)) return { kind: "checklist", trigger: "explicit" };

  return { kind: "plan", trigger: "explicit" };
}
