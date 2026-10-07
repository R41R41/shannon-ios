/** A touch as an experience she recalls: its words and when (Syzygy ADR-0008 stage 3, S2: the rules of `bodyTouchMemory.ts`, moved out of the store unchanged). */
import { classifySensitivity, type MemoryDisclosure, OWNER_AUDIENCE, SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME, SHANNON_TOUCH_FEELINGS } from '@shannon/cognition';
import type { StoredTouchBurst } from '../../surfaces/body/store/bodyReactionStore.js';
import { bodyWhere, burstTouchPhrase, touchDetailPhrase } from '../../surfaces/body/bodyTouchWords.js';

/**
 * A touch as something she remembers. Touches of one kind that follow each other are one
 * experience, rewritten as it grows (how often, how long, what she said), so a day of
 * patting is a few memories and not hundreds.
 *
 * It is stored where every experience is (`experience_events`, type `turn.completed`) with the
 * source label `body.touch`, so the deterministic recall, the full-text index, the embedding
 * worker, the Memory screen and forgetting treat it like any other experience. It has no
 * conversation message, and its user side is a token, not words: the owner said nothing, so
 * nothing is learned about him from it (`speaker: unknown`), and it is in no Talk.
 */
export interface TouchExperience {
  id: string;
  observedAt: string;
  summary: string;
  /** What she said during it, joined. Empty when she stayed silent. */
  shannonReply: string;
  disclosure: MemoryDisclosure;
  touch: { type: string; count: number; totalDurationMs: number; lastAt: string; others: boolean };
}

export interface TouchExperienceWriter {
  /** Creates the experience or rewrites it. Never throws for a missing table: there is then nowhere to remember. */
  write(scopeKey: string, experience: TouchExperience): boolean;
}

const DAY_PARTS: ReadonlyArray<readonly [number, string]> = [[5, '深夜'], [11, '朝'], [13, '昼'], [18, '午後'], [23, '夜'], [24, '深夜']];

const localParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });

/** 「10月2日の午後」: the owner-local day and part of the day, so 「今日の午後」 finds it. */
export function touchWhen(at: string): string {
  const parts = Object.fromEntries(localParts.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  return `${parts.month}月${parts.day}日の${DAY_PARTS.find(([before]) => hour < before)?.[1] ?? '夜'}`;
}

const seconds = (milliseconds: number) => milliseconds >= 60_000 ? `${Math.round(milliseconds / 60_000)}分ほど` : `${Math.max(1, Math.round(milliseconds / 1_000))}秒ほど`;

/**
 * The memory in her own words. Fixed wording from the kind and the numbers, plus what she said. With `parts` (Syzygy
 * ADR-0006 stage 2) the part every touch of the burst named is kept, in factual words (首をつつかれた, 頭をなでられた), and a
 * burst that names no part keeps words of favour (頭をなでてもらった) only with `favour`: every stance she gave in it was
 * welcome or fine. Otherwise, and while none is known, it is told factually (頭に触れられた, 触れられた).
 */
export function touchExperienceSummary(burst: StoredTouchBurst, options: { parts?: boolean; favour?: boolean } = {}): string {
  const part = options.parts && burst.part ? touchDetailPhrase(burst.type, { part: burst.part }, 'done') : null;
  const neutral = options.parts && !options.favour;
  const done = part ?? burstTouchPhrase(burst.type, neutral ? { ...burst, reflex: true } : burst, 'memory', SHANNON_TOUCH_FEELINGS[burst.type].done);
  const amount = [
    burst.count >= 5 ? `たくさん、${burst.count}回` : burst.count > 1 ? `${burst.count}回` : '',
    burst.totalDurationMs >= 1_000 ? `合わせて${seconds(burst.totalDurationMs)}` : '',
  ].filter(Boolean).join('、');
  const said = burst.said.length ? `${SHANNON_FIRST_PERSON}は${burst.said.map(line => `「${line}」`).join('')}と言った。` : `${SHANNON_FIRST_PERSON}は何も言わなかった。`;
  return [
    // As for the cause of the feeling: with someone else around, it is not said who touched her.
    `体の記憶: ${touchWhen(burst.startedAt)}、${bodyWhere(burst.surface)}${burst.others ? '' : `${SHANNON_OWNER_NAME}に`}${done}${amount ? `（${amount}）` : ''}。`,
    burst.others ? 'ほかの人も見ている時だった。' : '',
    said,
  ].filter(Boolean).join('');
}

/**
 * What stands where a turn has the owner's words: one token, unique to the burst and found in no reply.
 * Forgetting reads a memory's evidence to decide which earlier replies restated it; with none it would
 * withhold every earlier reply. With this, forgetting a touch hides the touch and the replies that recalled it.
 */
export function touchEvidence(burstId: string): string {
  const letters = Array.from(burstId.toLowerCase().replace(/[^0-9a-f]/gu, ''), digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
  return `body-touch-${letters || 'unknown'}`;
}

export function touchExperience(burst: StoredTouchBurst, options: { parts?: boolean; favour?: boolean } = {}): TouchExperience {
  const shannonReply = burst.said.join(' ');
  // The fixed wording is ordinary; only her own words can make it something to protect.
  const decision = classifySensitivity(shannonReply);
  return {
    id: burst.id, observedAt: burst.startedAt, summary: touchExperienceSummary(burst, options), shannonReply,
    disclosure: Object.freeze({
      audience: OWNER_AUDIENCE, sensitivity: decision.sensitivity, ...(decision.category ? { category: decision.category } : {}),
      reason: decision.sensitivity === 'sensitive' ? decision.reason : '体に触れられたこと', decidedBy: 'rule' as const,
      // No owner words are in it: the turn refinement, the sleep batch and her nightly notes learn nothing about him from it.
      speaker: 'unknown' as const,
    }),
    touch: { type: burst.type, count: burst.count, totalDurationMs: burst.totalDurationMs, lastAt: burst.lastAt, others: burst.others },
  };
}
