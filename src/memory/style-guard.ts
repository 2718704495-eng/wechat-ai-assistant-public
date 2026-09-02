export type StyleViolationReason =
  | "BANNED_LAUGHTER"
  | "BANNED_A_PARTICLE"
  | "PRESSURE_FOR_REPLY"
  | "PASSIVE_AGGRESSION"
  | "TOO_MANY_QUESTIONS";

export interface StyleValidationResult {
  ok: boolean;
  reasons: StyleViolationReason[];
}

const sentenceBoundaryPattern = /[。！？!?；;.,，、:\r\n]+/u;

export function validateReplyStyle(text: string): StyleValidationResult {
  const normalizedText = text.replace(
    /[ \t\f\v\u00a0\u200b-\u200d\ufeff]/gu,
    "",
  );
  const clauses = normalizedText
    .split(sentenceBoundaryPattern)
    .filter((clause) => clause.length > 0);
  const reasons: StyleViolationReason[] = [];

  if (/哈哈/u.test(normalizedText)) reasons.push("BANNED_LAUGHTER");
  if (/啊/u.test(normalizedText)) reasons.push("BANNED_A_PARTICLE");
  if (clauses.some(isReplyPressure)) reasons.push("PRESSURE_FOR_REPLY");
  if (clauses.some(isPassiveAggression)) reasons.push("PASSIVE_AGGRESSION");
  if ((text.match(/[?？]/gu) ?? []).length > 1) {
    reasons.push("TOO_MANY_QUESTIONS");
  }

  return { ok: reasons.length === 0, reasons };
}

function isReplyPressure(clause: string): boolean {
  if (hasReplyToSpeakerTarget(clause)) return true;

  if (
    /^(?:(?:你)?还不回(?:我|消息)?|回我(?:一下)?|你倒是回(?:句|个)?话|(?:你)?已读不回|(?:你)?赶紧回|(?:你)?失踪了吗|(?:你)?人呢)/u.test(
      clause,
    )
  ) {
    return true;
  }

  if (/你.*(?:不|没)(?:搭理|理)我/u.test(clause)) {
    return true;
  }

  return hasDirectRecipientReplyQuestion(clause);
}

function hasReplyToSpeakerTarget(clause: string): boolean {
  return /回复我|回我|给我(?:回复|回)/u.test(clause);
}

function hasDirectRecipientReplyQuestion(clause: string): boolean {
  const withheldReply = /(?:没有|没|不).*(?:回复|回)/u.exec(clause);
  if (withheldReply?.index === undefined) return false;

  let questionIndex = -1;
  let questionLength = 0;
  for (const match of clause.matchAll(/为什么|怎么|为啥|咋/gu)) {
    if (match.index >= withheldReply.index) break;
    questionIndex = match.index;
    questionLength = match[0].length;
  }
  if (questionIndex < 0) return false;

  const embeddedSubject = removeReplyQuestionModifiers(
    clause.slice(questionIndex + questionLength, withheldReply.index),
  );
  if (embeddedSubject.length > 0) {
    return embeddedSubject.startsWith("你");
  }

  const outerPrefix = clause
    .slice(0, questionIndex)
    .replace(/^(?:请问)/u, "");
  if (outerPrefix.length === 0 || /(?:想知道|知道)$/u.test(outerPrefix)) {
    return true;
  }
  return outerPrefix.endsWith("你");
}

function removeReplyQuestionModifiers(text: string): string {
  return text
    .replace(/从.*?到现在/gu, "")
    .replace(
      /到现在|这么久|最近|还|一直|都|也|仍然|迟迟|总是|竟然|居然|已经/gu,
      "",
    );
}

function isPassiveAggression(clause: string): boolean {
  return /爱回不回|不(?:回复|回)(?:的话)?就算了|随便你|当我没说|终于舍得回|还知道回|不想理我.*直说|算了.*不用回|忙你的吧/u.test(
    clause,
  );
}

export function assertReplyStyle(text: string): void {
  const result = validateReplyStyle(text);
  if (!result.ok) {
    throw new Error(`STYLE_GUARD_REJECTED:${result.reasons.join(",")}`);
  }
}
