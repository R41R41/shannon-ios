import type { ProspectiveMemory } from '@shannon/cognition';
import { commitmentDeadline } from '../action/respond/respondPorts.js';
import { containsUnresolvedConversationReference } from '../action/respond/respondPorts.js';
import { isExactTimeAlertRequest, matchPromise } from '../action/respond/respondPorts.js';
import { classifyRememberRequest, isRememberRequest } from '../action/respond/respondPorts.js';
import { extractExplicitUserIntent } from '../action/respond/respondPorts.js';

/** Shannon speaks to the owner in a throttled daily slot; she has no clock alarm. */
export const EXACT_TIME_NOTE = '時刻ちょうどにはお知らせできません。1日1回の声かけの枠でお知らせします。';
export const EXACT_TIME_DECLINED = '時刻ちょうどにお知らせすることは、まだできません。タイマーやアラームは時計アプリでお願いします。この依頼は約束として残していません。';

export interface PromiseCapture {
  memory: ProspectiveMemory;
  /** What was promised, without the time expression; the owner-visible short text. */
  topic: string;
  note?: string;
}

function prospectiveId(summary: string): string {
  let hash = 2_166_136_261;
  for (const character of summary.toLocaleLowerCase('ja-JP')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `prospective-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sentencesOf(userMessage: string): string[] {
  return (userMessage.replace(/\s+/g, ' ').trim().match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .filter(raw => !/[？?]\s*$/u.test(raw))
    .map(raw => raw.replace(/[。！!]\s*$/u, '').trim().slice(0, 200))
    .filter(sentence => sentence && !/(?:かもしれない|たぶん|多分|予定は未定)/u.test(sentence));
}

/** True when the owner asked for a clock alarm or timer, which is declined rather than stored. */
export function requestsExactTimeAlert(userMessage: string): boolean {
  return sentencesOf(userMessage).some(isExactTimeAlertRequest);
}

/** Captures only explicit future intent; vague predictions and questions are ignored. */
export function extractPromiseCaptures(
  userMessage: string,
  observedAt: string,
  sourceExperienceId?: string,
  timeZone = 'Asia/Tokyo',
): readonly PromiseCapture[] {
  const captures = new Map<string, PromiseCapture>();
  for (const sentence of sentencesOf(userMessage)) {
    let deadlineText: string;
    let topic: string;
    let exact = false;
    if (isRememberRequest(sentence)) {
      const request = classifyRememberRequest(sentence);
      if (request?.kind !== 'commitment') continue;
      deadlineText = request.content;
      topic = request.content;
      exact = request.verb === 'リマインドして' && Boolean(commitmentDeadline(request.content, observedAt, timeZone).dueAt);
    } else {
      // 「…を今月中に配信したい」 is a continuing goal; the intention ledger owns it, not a reminder.
      const promise = extractExplicitUserIntent(sentence, '', observedAt) ? null : matchPromise(sentence);
      if (!promise) continue;
      deadlineText = promise.clause;
      topic = promise.topic;
      exact = promise.wantsExactTime;
    }
    if (containsUnresolvedConversationReference(topic)) continue;
    const id = prospectiveId(`${sourceExperienceId ?? observedAt}:${sentence}`);
    captures.set(id, Object.freeze({
      memory: Object.freeze({
        id,
        summary: sentence,
        status: 'pending' as const,
        createdAt: observedAt,
        updatedAt: observedAt,
        ...commitmentDeadline(deadlineText, observedAt, timeZone),
        ...(sourceExperienceId ? { sourceExperienceId } : {}),
        evidence: sentence,
      }),
      topic: promiseTopic(topic),
      ...(exact ? { note: EXACT_TIME_NOTE } : {}),
    }));
  }
  return Object.freeze([...captures.values()].slice(0, 4));
}

export function extractProspectiveMemories(
  userMessage: string,
  observedAt: string,
  sourceExperienceId?: string,
  timeZone = 'Asia/Tokyo',
): readonly ProspectiveMemory[] {
  return Object.freeze(extractPromiseCaptures(userMessage, observedAt, sourceExperienceId, timeZone).map(item => item.memory));
}

/** 「牛乳を買うの」→「牛乳を買う」: the nominaliser belongs to the request, not to the promise. */
function promiseTopic(topic: string): string {
  return topic.replace(/^(?:一緒に|いっしょに)\s*/u, '').replace(/(?<=[うくぐすつぬぶむる])(?:の|こと)$/u, '').trim().slice(0, 120);
}
