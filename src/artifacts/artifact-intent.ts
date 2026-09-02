import type { ArtifactIntent } from "../conversation/response-plan.js";

const outputWord = /(?:攻略|路线|计划|规划|整理|对比|清单|HTML|页面|文件)/iu;
const outputWordGlobal = /(?:攻略|路线|计划|规划|整理|对比|清单|HTML|页面|文件)/giu;
const travelArtifactWord = /(?:攻略|路线|旅行|旅游|行程)/u;
const tripWord = /(?:去|到|玩|旅行|旅游|行程)/u;
const prefixedActionHead = /^(?:(?:麻烦|请)?(?:帮我|给我|替我)|(?:麻烦|请)|(?:能否|能不能|可以请你|可不可以)(?:帮我|给我|替我)?|(?:我想|准备|计划))(?<action>制作|生成|整理|规划|列出|做)/u;
const bareActionHead = /^(?<action>制作|生成|整理|规划|列出|做)/u;
const recipientRequestHead = /^(?:(?:麻烦|请)?(?:给我|发我)(?!的)|我想要|我需要|来)/u;
const actionAsOutput = /^(?:整理|规划|列出)$/u;
const artifactDeterminer = /^(?:一份|一个|这份|这个)/u;
const artifactDeterminerAnywhere = /(?:一份|一个|这份|这个)/u;
const leadingReferenceModifier = /^(?<modifier>(?:参考|参照|基于)[\s\S]*?(?:攻略|路线|计划|规划|整理|对比|清单|HTML|页面|文件)的)(?<target>[\s\S]+)$/iu;
const implicitRequestCue = /(?:怎么|如何|怎样)(?:安排|规划|玩|走|去|游)|(?:安排|规划|推荐|建议)(?:一下|下)?|(?:是否合适|比较顺|怎么玩|玩什么|哪里值得|哪些值得)/u;
const clauseBoundary = /[，。！？；;!?]+/u;
const leadingSeparator = /^[\s，。！？；;!?：:]+/u;
const validDayTokenGlobal = /(?<![0-9一二三四五六七八九十两])(?<days>\d{1,2}|[一二三四五六七八九两]|十[一二三四五六七八九]?|[二三]十[一二三四五六七八九]?)天(?!后)/gu;
const dayLikeTokenGlobal = /(?<![0-9一二三四五六七八九十两])(?<days>\d{1,2}|[一二三四五六七八九十两]+)天(?!后)/gu;
const standaloneDayToken = /^(?:\d{1,2}|[一二三四五六七八九两]|十[一二三四五六七八九]?|[二三]十[一二三四五六七八九]?)天$/u;
const departureOffsetAtStart = /^(?:\d{1,2}|[一二三四五六七八九十两]+)天后(?:出发|启程|动身)?(?:的)?/u;
const travelWordAtStart = /^(?:(?:去|到|玩|旅行|旅游|行程)\s*)+/u;
const travelWordAtEnd = /(?:(?:去|到|玩|旅行|旅游|行程)\s*)+$/u;
const destinationAfterDays = /^(?:去|到)(?<destination>.+?)(?=玩|旅行|旅游|行程|怎么|如何|攻略|路线|计划|规划|整理|对比|清单|HTML|页面|文件|[，。！？,.!?]|$)/iu;

const questionByField = {
  destination: "想去哪里",
  days: "准备玩几天",
} as const;

type MinimumArtifactField = keyof typeof questionByField;

interface DayMatch {
  days: number | undefined;
  index: number;
  token: string;
}

interface RequestHead {
  action: string | null;
  end: number;
  start: number;
}

interface TargetArtifactRole {
  output: string;
  text: string;
}

interface ExplicitArtifactRoles {
  referenceModifier: string | null;
  requestHead: RequestHead;
  sequentialTransition: string;
  targetArtifact: TargetArtifactRole;
}

interface RequestedArtifactSpan {
  output: string | null;
  text: string;
  trigger: ArtifactIntent["trigger"];
}

export interface ArtifactTurnAnalysis {
  intent: ArtifactIntent | null;
  fields: { destination?: string; days?: number } | null;
  missingInformation: MinimumArtifactField[];
  clarificationQuestions: string[];
}

export function analyzeArtifactTurn(text: string): ArtifactTurnAnalysis {
  const span = findRequestedArtifactSpan(text.trim());

  if (span === null) {
    return {
      intent: null,
      fields: null,
      missingInformation: [],
      clarificationQuestions: [],
    };
  }

  const kind = classifyArtifactKind(span);
  if (kind !== "travel-guide") {
    return {
      intent: { kind, trigger: span.trigger },
      fields: {},
      missingInformation: [],
      clarificationQuestions: [],
    };
  }

  const duration = selectDuration(span.text);
  const destination = extractDestination(span.text, duration);
  const fields = {
    ...(destination === undefined ? {} : { destination }),
    ...(duration?.days === undefined ? {} : { days: duration.days }),
  };
  const missingInformation = (["destination", "days"] as const)
    .filter((field) => fields[field] === undefined);

  return {
    intent: { kind, trigger: span.trigger },
    fields,
    missingInformation,
    clarificationQuestions: missingInformation
      .slice(0, 2)
      .map((field) => questionByField[field]),
  };
}

function findRequestedArtifactSpan(text: string): RequestedArtifactSpan | null {
  const explicitRoles = parseExplicitArtifactRoles(text);
  if (explicitRoles.length > 0) {
    if (explicitRoles.length !== 1) return null;

    const roles = explicitRoles[0];
    return roles === undefined
      ? null
      : {
        output: roles.targetArtifact.output,
        text: roles.targetArtifact.text,
        trigger: "explicit",
      };
  }

  const implicitCandidates = text
    .split(clauseBoundary)
    .map((segment) => segment.trim())
    .filter((segment) => isImplicitTravelRequest(segment));
  return implicitCandidates.length === 1
    ? { output: null, text: implicitCandidates[0] ?? "", trigger: "implicit" }
    : null;
}

function parseExplicitArtifactRoles(text: string): ExplicitArtifactRoles[] {
  const requestHeads = findRequestHeads(text);

  return requestHeads.flatMap((requestHead, index) => {
    const nextHead = requestHeads[index + 1];
    const body = text.slice(requestHead.end, nextHead?.start ?? text.length);
    const parsedTarget = parseTargetArtifact(body, requestHead.action);
    if (parsedTarget === null) return [];

    return [{
      referenceModifier: parsedTarget.referenceModifier,
      requestHead,
      sequentialTransition: text.slice(
        requestHeads[index - 1]?.end ?? 0,
        requestHead.start,
      ),
      targetArtifact: parsedTarget.targetArtifact,
    }];
  });
}

function findRequestHeads(text: string): RequestHead[] {
  const heads: RequestHead[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const suffix = text.slice(cursor);
    const prefixed = prefixedActionHead.exec(suffix);
    const recipient = recipientRequestHead.exec(suffix);
    const bare = bareActionHead.exec(suffix);
    const bareAllowed = cursor === 0 || (
      bare !== null
      && artifactDeterminer.test(suffix.slice(bare[0].length).trimStart())
    );
    const candidates = [
      prefixed,
      recipient,
      ...(bareAllowed ? [bare] : []),
    ].filter((match): match is RegExpExecArray => match !== null);
    const match = candidates.reduce<RegExpExecArray | null>(
      (longest, candidate) => (
        longest === null || candidate[0].length > longest[0].length
          ? candidate
          : longest
      ),
      null,
    );

    if (match === null) {
      cursor += 1;
      continue;
    }

    heads.push({
      action: match.groups?.action ?? null,
      end: cursor + match[0].length,
      start: cursor,
    });
    cursor += match[0].length;
  }

  return heads;
}

function parseTargetArtifact(
  body: string,
  requestAction: string | null,
): Pick<ExplicitArtifactRoles, "referenceModifier" | "targetArtifact"> | null {
  let targetText = body.replace(leadingSeparator, "").trim();
  const referenceMatch = leadingReferenceModifier.exec(targetText);
  const referenceModifier = referenceMatch?.groups?.modifier ?? null;
  if (referenceMatch !== null) {
    targetText = referenceMatch.groups?.target?.trim() ?? "";
  }
  targetText = targetText.replace(artifactDeterminer, "");

  const outputMatch = outputWord.exec(targetText);
  if (outputMatch === null) {
    return requestAction !== null
      && actionAsOutput.test(requestAction)
      && targetText.length > 0
      ? {
        referenceModifier,
        targetArtifact: { output: requestAction, text: targetText },
      }
      : null;
  }

  const outputEnd = outputMatch.index + outputMatch[0].length;
  const targetThroughOutput = targetText.slice(0, outputEnd);
  if (artifactDeterminerAnywhere.test(targetThroughOutput)) return null;

  const suffix = targetText.slice(outputEnd);
  const trailingField = suffix.replace(leadingSeparator, "").trim();
  const targetWithTrailingDuration = suffix !== trailingField
    && standaloneDayToken.test(trailingField)
    ? `${targetThroughOutput}，${trailingField}`
    : targetThroughOutput;

  return {
    referenceModifier,
    targetArtifact: {
      output: outputMatch[0],
      text: targetWithTrailingDuration,
    },
  };
}

function isImplicitTravelRequest(text: string): boolean {
  const duration = selectDuration(text);
  return duration?.days !== undefined
    && duration.days > 1
    && tripWord.test(text)
    && implicitRequestCue.test(text);
}

function classifyArtifactKind(
  span: RequestedArtifactSpan,
): ArtifactIntent["kind"] {
  if (span.trigger === "implicit") return "travel-guide";
  if (span.output === "对比") return "comparison";
  if (span.output === "清单" || span.output === "列出") return "checklist";
  if (travelArtifactWord.test(span.text)) return "travel-guide";
  return "plan";
}

function selectDuration(text: string): DayMatch | undefined {
  const validMatches = [...text.matchAll(validDayTokenGlobal)].map((match) => ({
    days: parseDayCount(match.groups?.days ?? ""),
    index: match.index,
    token: match[0],
  }));
  const candidates = validMatches.length > 0
    ? validMatches
    : [...text.matchAll(dayLikeTokenGlobal)].map((match) => ({
      days: undefined,
      index: match.index,
      token: match[0],
    }));

  if (candidates.length === 0) return undefined;

  const outputIndexes = [...text.matchAll(outputWordGlobal)]
    .map((match) => match.index);
  const outputIndex = outputIndexes.at(-1);
  if (outputIndex === undefined) return candidates[0];

  return candidates.reduce((nearest, candidate) => (
    Math.abs(outputIndex - candidate.index) < Math.abs(outputIndex - nearest.index)
      ? candidate
      : nearest
  ));
}

function extractDestination(
  text: string,
  duration: DayMatch | undefined,
): string | undefined {
  const outputMatch = outputWord.exec(text);

  if (outputMatch !== null) {
    let candidate = text
      .slice(0, outputMatch.index)
      .replace(departureOffsetAtStart, "");
    if (duration !== undefined) {
      candidate = removeLastOccurrence(candidate, duration.token);
    }
    return normalizeDestination(candidate);
  }

  if (duration === undefined) return normalizeDestination(text);

  const durationIndex = text.lastIndexOf(duration.token);
  const beforeDays = durationIndex < 0 ? "" : text.slice(0, durationIndex);
  const destinationBeforeDays = normalizeDestination(beforeDays);
  if (destinationBeforeDays !== undefined) return destinationBeforeDays;

  const afterDays = durationIndex < 0
    ? text
    : text.slice(durationIndex + duration.token.length);
  return normalizeDestination(
    destinationAfterDays.exec(afterDays)?.groups?.destination ?? "",
  );
}

function removeLastOccurrence(text: string, token: string): string {
  const index = text.lastIndexOf(token);
  return index < 0
    ? text
    : `${text.slice(0, index)}${text.slice(index + token.length)}`;
}

function normalizeDestination(candidate: string): string | undefined {
  const normalized = candidate
    .trim()
    .replace(/^[，。！？,.!?]+|[，。！？,.!?]+$/gu, "")
    .replace(travelWordAtStart, "")
    .replace(travelWordAtEnd, "")
    .trim();

  return normalized.length === 0 ? undefined : normalized;
}

function parseDayCount(token: string): number | undefined {
  if (/^\d{1,2}$/u.test(token)) {
    const parsed = Number(token);
    return parsed >= 1 && parsed <= 30 ? parsed : undefined;
  }

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  let parsed: number | undefined;
  if (token === "十") parsed = 10;
  else if (/^十[一二三四五六七八九]$/u.test(token)) {
    parsed = 10 + (digits[token[1] ?? ""] ?? 0);
  } else if (/^[二三]十$/u.test(token)) {
    parsed = (digits[token[0] ?? ""] ?? 0) * 10;
  } else if (/^[二三]十[一二三四五六七八九]$/u.test(token)) {
    parsed = (digits[token[0] ?? ""] ?? 0) * 10 + (digits[token[2] ?? ""] ?? 0);
  } else if (token.length === 1) parsed = digits[token];

  return parsed !== undefined && parsed >= 1 && parsed <= 30
    ? parsed
    : undefined;
}
