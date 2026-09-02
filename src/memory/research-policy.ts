import type { MemoryScenario } from "./schema.js";

export type ResearchTopic = "weather" | "place" | "game" | "calendar";
export type ResearchPrivacyMode =
  | "none"
  | "local-personal-only"
  | "sanitized-external"
  | "mixed-sanitized";

export interface ResearchDecision {
  required: boolean;
  topic: ResearchTopic | null;
  location: "示例城市示例城区" | null;
  privacyMode: ResearchPrivacyMode;
  externalQuery: string | null;
  mayExternalizeRawQuery: false;
  needsClarification?: true;
  reason?: "SAFE_EXTERNAL_QUERY_UNAVAILABLE";
}

export type PublicSubjectId =
  | "nanjing-museum"
  | "nanjing-presidential-palace"
  | "honor-of-kings"
  | "peace-elite"
  | "minecraft";

export type PublicRelativeTime =
  | "today"
  | "tomorrow"
  | "tomorrow-evening"
  | "tonight"
  | "day-after-tomorrow"
  | "recent"
  | "this-week"
  | "weekend";

export type PublicResearchTime =
  | { kind: "relative"; value: PublicRelativeTime }
  | { kind: "month-day"; month: number; day: number };

export type PublicResearchAction =
  | "place-hours"
  | "place-closure"
  | "place-reservation"
  | "place-price"
  | "place-events"
  | "place-recommendations"
  | "game-events"
  | "game-update"
  | "game-season"
  | "game-version"
  | "game-esports";

export interface PublicResearchInput {
  subjectId: PublicSubjectId;
  time?: PublicResearchTime;
  action: PublicResearchAction;
}

interface PublicSubject {
  topic: "place" | "game";
  canonicalName: string;
  aliases: readonly string[];
}

const publicSubjectCatalog: Record<PublicSubjectId, PublicSubject> = {
  "nanjing-museum": {
    topic: "place",
    canonicalName: "示例城市博物院",
    aliases: ["示例城市博物院"],
  },
  "nanjing-presidential-palace": {
    topic: "place",
    canonicalName: "示例城市总统府",
    aliases: ["示例城市总统府"],
  },
  "honor-of-kings": {
    topic: "game",
    canonicalName: "示例游戏荣耀",
    aliases: ["示例游戏荣耀", "示例游戏"],
  },
  "peace-elite": {
    topic: "game",
    canonicalName: "和平精英",
    aliases: ["和平精英"],
  },
  minecraft: {
    topic: "game",
    canonicalName: "我的世界",
    aliases: ["我的世界"],
  },
};

const relativeTimeTokens: Record<PublicRelativeTime, string> = {
  today: "今天",
  tomorrow: "明天",
  "tomorrow-evening": "明晚",
  tonight: "今晚",
  "day-after-tomorrow": "后天",
  recent: "最近",
  "this-week": "本周",
  weekend: "周末",
};

const actionCatalog: Record<
  PublicResearchAction,
  { topic: "place" | "game"; token: string }
> = {
  "place-hours": { topic: "place", token: "营业时间" },
  "place-closure": { topic: "place", token: "临时闭馆信息" },
  "place-reservation": { topic: "place", token: "预约信息" },
  "place-price": { topic: "place", token: "票价信息" },
  "place-events": { topic: "place", token: "本地活动" },
  "place-recommendations": { topic: "place", token: "景点推荐" },
  "game-events": { topic: "game", token: "活动" },
  "game-update": { topic: "game", token: "更新" },
  "game-season": { topic: "game", token: "赛季更新" },
  "game-version": { topic: "game", token: "版本更新" },
  "game-esports": { topic: "game", token: "赛事" },
};

const weatherPattern = /天气|降温|高温|暴雨|大风/u;
const calendarPattern =
  /节气|节日|今天(?:是)?(?:周几|星期几|几号|什么日期)|今天.*日期/u;
const explicitCalendarPattern = /今天|当前|现在|日期|周几|星期几|几号/u;
const explicitCurrentMarkerPattern =
  /今天|明天|明晚|后天|今晚|最近|近期|当前|现在|最新|本周|周末|\d{1,2}月\d{1,2}日/u;
const interrogativePronounPattern = /[谁孰啥什怎哪几何多]/u;
const polarQuestionMarkerPattern = /否/u;
const alternativeQuestionPattern =
  /([\p{Script=Han}]{1,2})(?:不|没)\1/u;
const negativeCompletionQuestionPattern =
  /\p{Script=Han}{2,}(?:没有|没)(?:呀|呢)?[?？]?$/u;
const sentenceFinalQuestionParticlePattern = /[?？吗么嘛呢何样]$/u;
const privateOwnerReferencePattern = /^(?:她|示例联系人|示例联系人|联系人A|对方|对象)/u;
const personalPredicateStartPattern =
  /^(?:在|住在|去|到|从|和|跟|喜欢|偏好|说|提|想|常去)/u;
const placeCurrentPattern =
  /营业|开门|开放|关门|闭馆|闭园|预约|票价|景点|哪里好玩|演出|展览/u;
const gameCurrentPattern = /游戏|手游|赛季|版本|赛事|更新|活动|热点|新内容/u;
const privateSignalPattern =
  /她|示例联系人|示例联系人|联系人A|对方|对象|住址|住在|地址|联系方式|电话|手机号|微信号|账号|工作单位|身份证|家人|生日|班次|上班|喜欢|偏好|说过|提过|想吃|常去|就医|看病|住院|病史|常住|居住|定位/u;
const personalMemoryQuestionPattern =
  /喜欢(?:什么|哪个)|(?:说过|提过|偏好).*(?:什么|哪个)|想吃什么/u;
const volatileOperationPattern =
  /营业|开门|开放|关门|闭馆|闭园|预约|票价|活动|演出|展览|更新|赛季|版本|赛事|热点|新内容/u;

export function decideResearch(input: {
  scenario: MemoryScenario;
  query: string;
}): ResearchDecision {
  const normalized = normalizeQuery(input.query);
  const containsPrivateSignal = hasPrivateSignal(input.query, normalized);

  const weatherRequested =
    input.scenario === "weather" || weatherPattern.test(input.query);
  if (weatherRequested) {
    if (containsPrivateSignal && isStablePersonalFactQuery(input.query)) {
      return localPersonalDecision();
    }
    const publicSlot = parseStrictWeatherSlot(normalized, input.scenario);
    if (publicSlot === null) {
      return clarificationDecision(
        "weather",
        containsPrivateSignal ? "mixed-sanitized" : "sanitized-external",
      );
    }
    return {
      required: true,
      topic: "weather",
      location: "示例城市示例城区",
      privacyMode: "sanitized-external",
      externalQuery: ["示例城市示例城区", publicSlot.time, "实时天气与短时预报"]
        .filter((part) => part !== null)
        .join(" "),
      mayExternalizeRawQuery: false,
    };
  }

  if (calendarPattern.test(input.query)) {
    if (containsPrivateSignal) {
      return explicitCalendarPattern.test(input.query)
        ? clarificationDecision("calendar", "mixed-sanitized")
        : localPersonalDecision();
    }
    const publicSlot = parseStrictCalendarSlot(normalized);
    if (publicSlot === null) {
      return clarificationDecision("calendar", "sanitized-external");
    }
    return {
      required: true,
      topic: "calendar",
      location: null,
      privacyMode: "sanitized-external",
      externalQuery: `${publicSlot.time} 日期 星期 节气 节日`,
      mayExternalizeRawQuery: false,
    };
  }

  if (!containsPrivateSignal) {
    const trustedInput = parseStrictPublicQuery(normalized);
    if (trustedInput !== null) return decidePublicResearch(trustedInput);
  }

  if (containsPrivateSignal && isStablePersonalFactQuery(input.query)) {
    return localPersonalDecision();
  }

  const topic = inferDynamicTopic(input.query) ?? topicForScenario(input.scenario);
  if (topic === "place" || topic === "game") {
    return clarificationDecision(
      topic,
      containsPrivateSignal ? "mixed-sanitized" : "sanitized-external",
    );
  }

  if (hasUnresolvedCurrentIntent(input.query)) {
    return clarificationDecision(
      inferUnresolvedTopic(input.query),
      containsPrivateSignal ? "mixed-sanitized" : "sanitized-external",
    );
  }

  return containsPrivateSignal
    ? localPersonalDecision()
    : {
        required: false,
        topic: null,
        location: null,
        privacyMode: "none",
        externalQuery: null,
        mayExternalizeRawQuery: false,
      };
}

export function decidePublicResearch(input: unknown): ResearchDecision {
  if (!isObjectRecord(input)) {
    return clarificationDecision(null, "sanitized-external");
  }

  const subject = publicSubjectFor(input.subjectId);
  const action = publicActionFor(input.action);
  const topic = subject?.topic ?? null;
  if (
    subject === undefined ||
    action === undefined ||
    subject.topic !== action.topic
  ) {
    return clarificationDecision(topic, "sanitized-external");
  }

  const timeToken = validateAndRenderTime(input.time);
  if (input.time !== undefined && timeToken === null) {
    return clarificationDecision(topic, "sanitized-external");
  }

  return {
    required: true,
    topic,
    location: null,
    privacyMode: "sanitized-external",
    externalQuery: [subject.canonicalName, timeToken, action.token]
      .filter((part) => part !== null)
      .join(" "),
    mayExternalizeRawQuery: false,
  };
}

function parseStrictPublicQuery(normalized: string): PublicResearchInput | null {
  const core = normalized.replace(/[吗?？]$/u, "");
  for (const [subjectId, subject] of Object.entries(publicSubjectCatalog) as Array<
    [PublicSubjectId, PublicSubject]
  >) {
    for (const alias of [...subject.aliases].sort((a, b) => b.length - a.length)) {
      const parsed =
        subject.topic === "place"
          ? parseStrictPlaceQuery(core, subjectId, alias)
          : parseStrictGameQuery(core, subjectId, alias);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

interface FixedPublicTimeSlot {
  time: string | null;
}

function parseStrictWeatherSlot(
  normalized: string,
  scenario: MemoryScenario,
): FixedPublicTimeSlot | null {
  if (normalized.length === 0) {
    return scenario === "weather" ? { time: null } : null;
  }
  const match =
    /^(?:示例城市(?:市)?示例城区|上海)?(?:(明晚|今晚|今天|明天|后天|最近|本周|周末)|(\d{1,2})月(\d{1,2})日)?天气$/u.exec(
      normalized,
    );
  if (match === null) return null;
  if (match[2] !== undefined && match[3] !== undefined) {
    const time = renderMonthDay(Number(match[2]), Number(match[3]));
    return time === null ? null : { time };
  }
  return { time: match[1] ?? null };
}

function parseStrictCalendarSlot(normalized: string): { time: string } | null {
  const match =
    /^(?:(今天|明天|后天|明晚|今晚|本周|周末)|(\d{1,2})月(\d{1,2})日)(?:是)?(?:什么节气|什么节日|周几|星期几|几号|什么日期|日期)$/u.exec(
      normalized,
    );
  if (match === null) return null;
  if (match[2] !== undefined && match[3] !== undefined) {
    const time = renderMonthDay(Number(match[2]), Number(match[3]));
    return time === null ? null : { time };
  }
  return match[1] === undefined ? null : { time: match[1] };
}

function parseStrictPlaceQuery(
  core: string,
  subjectId: PublicSubjectId,
  alias: string,
): PublicResearchInput | null {
  const actions = [
    ["开门", "place-hours"],
    ["开放", "place-hours"],
    ["营业", "place-hours"],
    ["闭馆", "place-closure"],
    ["闭园", "place-closure"],
    ["预约", "place-reservation"],
    ["票价", "place-price"],
    ["有什么活动", "place-events"],
    ["景点推荐", "place-recommendations"],
    ["哪里好玩", "place-recommendations"],
  ] as const;
  return matchStrictGrammar(core, subjectId, alias, actions);
}

function parseStrictGameQuery(
  core: string,
  subjectId: PublicSubjectId,
  alias: string,
): PublicResearchInput | null {
  const actions = [
    ["什么活动", "game-events"],
    ["有什么活动", "game-events"],
    ["有啥活动", "game-events"],
    ["什么时候更新", "game-update"],
    ["新赛季什么时候更新", "game-season"],
    ["版本更新", "game-version"],
    ["有什么赛事", "game-esports"],
  ] as const;
  return matchStrictGrammar(core, subjectId, alias, actions);
}

function matchStrictGrammar(
  core: string,
  subjectId: PublicSubjectId,
  alias: string,
  actions: ReadonlyArray<readonly [string, PublicResearchAction]>,
): PublicResearchInput | null {
  const times = strictTimeCandidates(core);
  for (const [actionText, action] of actions) {
    for (const { raw, value } of times) {
      if (
        core === `${alias}${raw}${actionText}` ||
        (raw.length > 0 && core === `${raw}${alias}${actionText}`)
      ) {
        return { subjectId, time: value, action };
      }
    }
    if (core === `${alias}${actionText}`) return { subjectId, action };
  }
  return null;
}

function strictTimeCandidates(core: string): Array<{
  raw: string;
  value: PublicResearchTime;
}> {
  const relative = Object.entries(relativeTimeTokens).map(([value, raw]) => ({
    raw,
    value: { kind: "relative", value: value as PublicRelativeTime } as const,
  }));
  const dateMatch = /(\d{1,2})月(\d{1,2})日/u.exec(core);
  if (dateMatch === null) return relative;
  return [
    ...relative,
    {
      raw: dateMatch[0],
      value: {
        kind: "month-day" as const,
        month: Number(dateMatch[1]),
        day: Number(dateMatch[2]),
      },
    },
  ];
}

function validateAndRenderTime(time: unknown): string | null {
  if (time === undefined) return null;
  if (!isObjectRecord(time)) return null;
  if (time.kind === "relative") {
    return hasExactOwnKeys(time, ["kind", "value"]) &&
      typeof time.value === "string" &&
      Object.hasOwn(relativeTimeTokens, time.value)
      ? relativeTimeTokens[time.value as PublicRelativeTime]
      : null;
  }
  if (time.kind !== "month-day") return null;
  if (!hasExactOwnKeys(time, ["kind", "month", "day"])) return null;
  return renderMonthDay(time.month, time.day);
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function renderMonthDay(month: unknown, day: unknown): string | null {
  if (
    typeof month !== "number" ||
    typeof day !== "number" ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return null;
  }
  const maximumDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  return maximumDay !== undefined && day <= maximumDay
    ? `${month}月${day}日`
    : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicSubjectFor(value: unknown): PublicSubject | undefined {
  return typeof value === "string" && Object.hasOwn(publicSubjectCatalog, value)
    ? publicSubjectCatalog[value as PublicSubjectId]
    : undefined;
}

function publicActionFor(
  value: unknown,
): (typeof actionCatalog)[PublicResearchAction] | undefined {
  return typeof value === "string" && Object.hasOwn(actionCatalog, value)
    ? actionCatalog[value as PublicResearchAction]
    : undefined;
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/gu, "");
}

function hasPrivateSignal(query: string, normalized: string): boolean {
  return (
    privateSignalPattern.test(query) ||
    /1[3-9]\d{9}|\d{15,18}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/iu.test(
      normalized,
    )
  );
}

function inferDynamicTopic(query: string): "place" | "game" | null {
  if (placeCurrentPattern.test(query)) return "place";
  if (gameCurrentPattern.test(query)) return "game";
  return null;
}

function hasUnresolvedCurrentIntent(query: string): boolean {
  return (
    explicitCurrentMarkerPattern.test(query) &&
    isInformationQuestion(query)
  );
}

function inferUnresolvedTopic(query: string): "place" | "game" | null {
  const catalogTopic = inferCatalogTopic(query);
  if (catalogTopic !== null) return catalogTopic;
  if (placeCurrentPattern.test(query)) return "place";
  if (/活动|游戏|手游|赛季|版本|赛事|更新|热点/u.test(query)) return "game";
  return null;
}

function inferCatalogTopic(query: string): "place" | "game" | null {
  for (const subject of Object.values(publicSubjectCatalog)) {
    if (subject.aliases.some((alias) => query.includes(alias))) {
      return subject.topic;
    }
  }
  return null;
}

function topicForScenario(scenario: MemoryScenario): "place" | "game" | null {
  if (scenario === "place" || scenario === "game") return scenario;
  return null;
}

function isStablePersonalFactQuery(query: string): boolean {
  return (
    isStablePersonalAttributeQuestion(query) ||
    (personalMemoryQuestionPattern.test(query) &&
      !volatileOperationPattern.test(query))
  );
}

function isStablePersonalAttributeQuestion(query: string): boolean {
  const normalized = normalizeQuery(query);
  const sentenceCore = normalized.replace(/[?？]$/u, "");
  if (
    !isInformationQuestion(normalized) ||
    /[，。！？!?；;、:]/u.test(sentenceCore) ||
    containsClosedPublicQueryFragment(normalized)
  ) {
    return false;
  }

  const scope = privateAttributeScope(normalized);
  if (scope === null || scope.attribute.length === 0) return false;
  return (
    scope.explicitPossessive ||
    !personalPredicateStartPattern.test(scope.attribute)
  );
}

function isInformationQuestion(query: string): boolean {
  const questionCore = normalizeQuestionCore(query);
  if (isExistentialNegativeDeclaration(questionCore)) return false;
  return (
    sentenceFinalQuestionParticlePattern.test(questionCore) ||
    interrogativePronounPattern.test(questionCore) ||
    polarQuestionMarkerPattern.test(questionCore) ||
    alternativeQuestionPattern.test(questionCore) ||
    isNegativeCompletionQuestion(questionCore)
  );
}

function normalizeQuestionCore(query: string): string {
  return normalizeQuery(query).replace(/[。！!]+$/u, "");
}

function isNegativeCompletionQuestion(query: string): boolean {
  return negativeCompletionQuestionPattern.test(query);
}

function isExistentialNegativeDeclaration(questionCore: string): boolean {
  if (/[?？]$/u.test(questionCore)) return false;
  let core = questionCore;
  core = core.replace(/[呀呢啦啊哦]$/u, "");
  return /一个\p{Script=Han}*(?:都|也)没有$/u.test(core);
}

function containsClosedPublicQueryFragment(normalized: string): boolean {
  for (let index = 1; index < normalized.length; index += 1) {
    if (parseStrictPublicQuery(normalized.slice(index)) !== null) return true;
  }
  return false;
}

function privateAttributeScope(
  normalized: string,
): { attribute: string; explicitPossessive: boolean } | null {
  const possessive = /^([^，。！？!?；;、:]+?)的(.+)$/u.exec(normalized);
  if (
    possessive?.[1] !== undefined &&
    possessive[2] !== undefined &&
    hasPrivateSignal(possessive[1], possessive[1])
  ) {
    return { attribute: possessive[2], explicitPossessive: true };
  }

  const owner = privateOwnerReferencePattern.exec(normalized)?.[0];
  return owner === undefined
    ? null
    : { attribute: normalized.slice(owner.length), explicitPossessive: false };
}

function clarificationDecision(
  topic: ResearchTopic | null,
  privacyMode: "sanitized-external" | "mixed-sanitized",
): ResearchDecision {
  return {
    required: true,
    topic,
    location: null,
    privacyMode,
    externalQuery: null,
    mayExternalizeRawQuery: false,
    needsClarification: true,
    reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
  };
}

function localPersonalDecision(): ResearchDecision {
  return {
    required: false,
    topic: null,
    location: null,
    privacyMode: "local-personal-only",
    externalQuery: null,
    mayExternalizeRawQuery: false,
  };
}
