import { createHash, randomUUID } from 'node:crypto';
import {
  PROACTIVE_GATE_V1, decodeSignature, encodeSignature, minHashSignature, ownerActiveHoldMilliseconds, proactiveVerdict,
  type ProactiveHoldCode, type ProactiveReason,
} from '@shannon/mind';
import type { WithheldSink } from '../../contracts/withheldActionContract.js';
import type { EmitMindEvent } from '../../contracts/mindInboxContract.js';
import type { SQLiteProactiveTopics } from './store/proactiveTopicsStore.js';

/**
 * The proactive gate at the delivery points (Syzygy ADR-0008 stage 3, owner answer 2, `docs/mind-workspace-contract.md`): every
 * message she starts on her own passes it where it would be written, whoever asked for it: `reachOuts.say`, `sayAgain`,
 * `sayByPhone`, the initiative insert and the call request. In the order of `proactiveVerdict`: the owner active (max(2 minutes,
 * the existing 10)), the intent expired (30, 75 or 150 minutes by reason), the same intent within 30 minutes, the topic reused
 * (MinHash eff ≥ 0.9). Spacing stays today's 5 minutes, in today's code.
 *
 * A hold writes nothing of the message. It is a withheld action of stage 2 (`owner_active`, `intent_repeat`, `intent_expired`,
 * `topic_reused`) that her next thought is shown, and a notice (`【知らせ:止められた】`) for the conversation's workspace through
 * the mind's inbox. A delivery is noted in `proactive_topics` (closed reason and subject, the signature; never the words).
 *
 * The gate never throws: an error of its own lets the message through as before stage 3, and is logged (closed codes only).
 */
export const PROACTIVE_POINTS = ['say', 'say_again', 'say_by_phone', 'initiative', 'call'] as const;
export type ProactivePoint = typeof PROACTIVE_POINTS[number];

/** The registry tool each delivery point is, as a withheld action names it. */
export const PROACTIVE_POINT_TOOL: Readonly<Record<ProactivePoint, string>> = Object.freeze({
  say: 'owner.reach_out', say_again: 'owner.reach_out', say_by_phone: 'owner.call', call: 'owner.call', initiative: 'owner.initiative',
});

export interface ProactiveDeliveryIntent {
  point: ProactivePoint;
  reason: ProactiveReason;
  /** A closed key of what it is about (a message's id, a source item's id), or null. Made into a short digest when it is not one. */
  subject: string | null;
  /** When the intent arose (the thought that chose it); the delivery's own time when nobody knows better. */
  arisenAt: string;
  priority?: number;
  /** The words, only to compute the topic's signature here; never stored. Null: no topic check (a call rings a message already checked). */
  text: string | null;
}

export type ProactiveDeliveryVerdict = { verdict: 'deliver'; topicReuse: number } | { verdict: 'hold'; code: ProactiveHoldCode };

export interface ProactiveDeliveryGate {
  /** The verdict at `at`; a hold is recorded as a withheld action and a notice before it is answered. */
  check(scopeKey: string, intent: ProactiveDeliveryIntent, at: string): ProactiveDeliveryVerdict;
  /** A message was written: its intent and topic signature are noted. */
  delivered(scopeKey: string, intent: ProactiveDeliveryIntent, at: string): void;
}

export interface ProactiveGateDependencies {
  topics: SQLiteProactiveTopics;
  /** When the owner last wrote or spoke; the topics store reads it from the conversation's table by default. */
  ownerLastActiveAt?: (scopeKey: string) => string | null;
  /** The loop's own owner-active setting (`SHANNON_AUTONOMY_OWNER_ACTIVE_*`), if any; the hold is never below 10 minutes. */
  ownerActiveMilliseconds?: number;
  withheld?: WithheldSink | null;
  emit?: EmitMindEvent | null;
  /** Who could see her when she was held, for the notice; `owner` when nobody says. */
  audience?: (scopeKey: string, at: string) => 'owner' | 'others';
  log?: (line: string) => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$/u;
/** How far back topics are compared: past it, a 0.9 similarity has decayed below one percent. */
const TOPIC_LOOKBACK_MILLISECONDS = 14 * 24 * HOUR;

export function closedSubject(subject: string | null): string | null {
  if (subject === null || subject === '') return null;
  return SUBJECT.test(subject) ? subject : `h-${createHash('sha256').update(subject).digest('hex').slice(0, 24)}`;
}

export function createProactiveGate(dependencies: ProactiveGateDependencies): ProactiveDeliveryGate {
  const log = (line: string) => { try { dependencies.log?.(line); } catch { /* the log is optional */ } };
  const ownerLast = (scopeKey: string) => (dependencies.ownerLastActiveAt ?? (key => dependencies.topics.ownerLastActiveAt(key)))(scopeKey);
  return {
    check(scopeKey, intent, at) {
      try {
        const now = Date.parse(at);
        const rows = dependencies.topics.since(scopeKey, new Date(now - TOPIC_LOOKBACK_MILLISECONDS).toISOString());
        const subject = closedSubject(intent.subject);
        const ownerLastActiveAt = ownerLast(scopeKey);
        const verdict = proactiveVerdict({
          reason: intent.reason, subject, arisenAt: intent.arisenAt, priority: intent.priority ?? 1,
          topic: intent.text ? minHashSignature(intent.text) : null,
        }, {
          ownerLastActiveAt,
          delivered: rows.map(row => ({ reason: row.reason as ProactiveReason, subject: row.subject, at: row.at })),
          topics: rows.flatMap(row => { const signature = decodeSignature(row.signature); return signature ? [{ signature, at: row.at }] : []; }),
        }, at, { ownerActiveMilliseconds: dependencies.ownerActiveMilliseconds ?? 0 });
        if (verdict.verdict === 'deliver') return { verdict: 'deliver', topicReuse: verdict.topicReuse };
        const retryAt = verdict.code === 'owner_active' && ownerLastActiveAt
          ? new Date(Date.parse(ownerLastActiveAt) + ownerActiveHoldMilliseconds(dependencies.ownerActiveMilliseconds ?? 0)).toISOString()
          : verdict.code === 'intent_repeat'
            ? new Date(Math.max(...rows.filter(row => row.reason === intent.reason && row.subject === subject).map(row => Date.parse(row.at))) + PROACTIVE_GATE_V1.intentRepeatMinutes * MINUTE).toISOString()
            : null;
        const tool = PROACTIVE_POINT_TOOL[intent.point];
        try { dependencies.withheld?.(scopeKey, { surface: 'autonomy', tool, reason: verdict.code, rail: 'gate', retryAt }, at); } catch { log(`proactive gate: withheld write failed`); }
        try {
          let audience: 'owner' | 'others' = 'owner';
          try { audience = dependencies.audience?.(scopeKey, at) ?? 'owner'; } catch { audience = 'others'; }
          dependencies.emit?.(scopeKey, { kind: 'notice', code: 'withheld', audience, source: 'own_time', sourceId: `withheld-${randomUUID()}`, tool, reason: verdict.code }, at);
        } catch { log(`proactive gate: notice failed`); }
        log(`proactive gate: ${intent.point} held ${verdict.code}`);
        return { verdict: 'hold', code: verdict.code };
      } catch (error) {
        log(`proactive gate: check failed ${error instanceof Error ? error.name : 'unknown'}`);
        return { verdict: 'deliver', topicReuse: 0 };
      }
    },
    delivered(scopeKey, intent, at) {
      try {
        const signature = intent.text ? minHashSignature(intent.text) : null;
        dependencies.topics.record({ scopeKey, at, point: intent.point, reason: intent.reason, subject: closedSubject(intent.subject), signature: signature ? encodeSignature(signature) : null });
        dependencies.topics.prune(new Date(Date.parse(at) - 30 * 24 * HOUR).toISOString());
      } catch (error) {
        log(`proactive gate: note failed ${error instanceof Error ? error.name : 'unknown'}`);
      }
    },
  };
}
