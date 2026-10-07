import { isOwnerMemoryEvidence } from '@shannon/cognition';
import { containsCommitmentTime, promiseGuarded } from './promiseRules.js';
import { explicitFactStatement } from '../../sleep/sleepFactPorts.js';

/**
 * 「…覚えておいて」 is the owner's most common request, but it means two
 * different things: "keep this fact about me" and "do not let me forget to do
 * this". The content decides the shelf; an unclassifiable fragment is left as
 * conversation instead of becoming an undated promise.
 */
export type RememberRequest =
  | { kind: 'knowledge'; statement: string; evidence: string }
  | { kind: 'commitment'; content: string; verb: string };

const VERB = /(覚えておいて|覚えといて|忘れないで|リマインドして)(?:ね|よ|ください|くれる|ほしい|欲しい)?$/u;
const STATIVE = /(?:ある|いる|ている|てる|でいる)(?:の|こと)?$/u;
const ACTION = /(?:[うくぐすつぬぶむる]|ます)(?:の|こと|ように)?$/u;
const PREFERENCE = /(?:好き|嫌い|苦手|好物|得意|アレルギー|派)(?:です|だ|なんだ)?$/u;
const EMPHASIS = /^(?:特に|とくに|中でも|なかでも)[、,\s]*(.{1,40})$/u;

function requestParts(sentence: string): { text: string; verb: string; content: string } | null {
  const text = sentence.trim().replace(/[。！!]+$/u, '');
  const verb = text.match(VERB)?.[1];
  if (!verb) return null;
  const content = text.replace(VERB, '').replace(/[、,\s]+$/u, '').replace(/(?:を|は|って)$/u, '').trim();
  return content.length >= 1 && content.length <= 180 ? { text, verb, content } : null;
}

export function isRememberRequest(sentence: string): boolean {
  return requestParts(sentence) !== null;
}

/** The part of a remember request that states the thing to remember. */
export function rememberRequestContent(sentence: string): string | null {
  return requestParts(sentence)?.content ?? null;
}

/** `likedSubject` is a preference stated earlier in the same message ("寿司" for 「僕は寿司が好き」). */
export function classifyRememberRequest(sentence: string, likedSubject?: string): RememberRequest | null {
  const parts = requestParts(sentence);
  if (!parts || promiseGuarded(parts.text)) return null;
  const { text, verb, content } = parts;
  if (verb === 'リマインドして') return { kind: 'commitment', content, verb };
  // Only the owner's own information is knowledge; other people's stay conversation.
  const owned = isOwnerMemoryEvidence(text);
  const explicit = owned ? explicitFactStatement(content) : null;
  if (explicit) return { kind: 'knowledge', statement: explicit, evidence: text };
  if (containsCommitmentTime(content) || (ACTION.test(content) && !STATIVE.test(content))) return { kind: 'commitment', content, verb };
  if (owned) {
    const emphasis = content.match(EMPHASIS)?.[1]?.replace(/が(?:大)?好き$/u, '').trim();
    if (emphasis && likedSubject) {
      return { kind: 'knowledge', statement: `ユーザーは${likedSubject}の中でも特に${emphasis}が好き`, evidence: text };
    }
    const own = content.replace(/^(?:僕|私|自分|俺)(は|の)[、,\s]*/u, (_all, particle: string) => particle === 'の' ? 'ユーザーの' : '');
    if (!emphasis && PREFERENCE.test(own)) {
      return { kind: 'knowledge', statement: own.startsWith('ユーザーの') ? own : `ユーザーは${own}`, evidence: text };
    }
    if (!emphasis && /^.{1,60}?は.{1,80}$/u.test(own)) return { kind: 'knowledge', statement: own, evidence: text };
  }
  // 「傘を忘れないで」 is a reminder; a bare noun after 「覚えておいて」 is not a promise.
  return verb === '忘れないで' ? { kind: 'commitment', content, verb } : null;
}
