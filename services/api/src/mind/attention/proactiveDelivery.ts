import { createHash, randomUUID } from 'node:crypto';
import { ownerDay } from '@shannon/cognition';
import {
  PROACTIVE_GATE_V1, decodeSignature, encodeSignature, minHashSignature, ownerActiveHoldMilliseconds, proactiveVerdict, topicReuse,
  type ProactiveHoldCode, type ProactiveReason,
} from '@shannon/mind';
import type { WithheldSink } from '../../contracts/withheldActionContract.js';
import type { EmitMindEvent } from '../../contracts/mindInboxContract.js';
import type { SQLiteProactiveTopics } from './store/proactiveTopicsStore.js';

/**
 * The proactive gate at the delivery points (Syzygy ADR-0008 stage 3, owner answer 2, `docs/mind-workspace-contract.md`): every
 * message she starts on her own passes it where it would be written, whoever asked for it: `reachOuts.say`, `sayAgain`,
 * `sayByPhone`, the initiative insert, the call request and telling a piece (`share`). In the order of `proactiveVerdict`: the owner active (max(2 minutes,
 * the existing 10)), the intent expired (30, 75 or 150 minutes by reason), the same intent within 30 minutes, the topic reused
 * (MinHash eff ≥ 0.9). Spacing stays today's 5 minutes, in today's code.
 *
 * A hold writes nothing of the message. It is a withheld action of stage 2 (`owner_active`, `intent_repeat`, `intent_expired`,
 * `topic_reused`) that her next thought is shown, and a notice (`【知らせ:止められた】`) for the conversation's workspace through
 * the mind's inbox. A delivery is noted in `proactive_topics` (closed reason and subject, the signature; never the words).
 *
 * The gate never throws, and it fails closed: an error of its own holds the message with the code `gate_error` (proactive speech
 * is inhibition; coordinator decision of stage 3), recorded and noticed like any hold as far as they still work, and logged
 * (closed codes only).
 *
 * Inside the writer's transaction (stage 3 review): a point that writes a message under `BEGIN IMMEDIATE` asks `decide` on its own
 * connection after its day-limit slot, so a message the limit refuses records no hold and two processes cannot both pass; it notes
 * the delivery with `deliveredWithin` in the same transaction (a failure there rolls the message back and is a `gate_error` hold),
 * and records a hold with `hold` after its rollback. A hold is recorded and noticed once a day per point, subject (or reason) and code.
 */
export const PROACTIVE_POINTS = ['say', 'say_again', 'say_by_phone', 'initiative', 'call', 'share'] as const;
export type ProactivePoint = typeof PROACTIVE_POINTS[number];

/** The registry tool each delivery point is, as a withheld action names it. */
export const PROACTIVE_POINT_TOOL: Readonly<Record<ProactivePoint, string>> = Object.freeze({
  say: 'owner.reach_out', say_again: 'owner.reach_out', say_by_phone: 'owner.call', call: 'owner.call', initiative: 'owner.initiative',
  share: 'study.tell',
});

export interface ProactiveDeliveryIntent {
  point: ProactivePoint;
  reason: ProactiveReason;
  /** A closed key of what it is about (a message's id, a source item's id), or null. Made into a short digest when it is not one. */
  subject: string | null;
  /** When the intent arose (the thought that chose it); the delivery's own time when nobody knows better. */
  arisenAt: string;
  priority?: number;
  /**
   * What the message is about, only to compute the topic's signature here; never stored: the variable part (her words, a title, a
   * topic), not the fixed wording around it. Null: no topic check (a call rings a line already checked).
   */
  text: string | null;
}

/** The verdict inside a writer's transaction, not yet recorded. */
export type ProactiveDecision = { verdict: 'deliver'; topicReuse: number } | { verdict: 'hold'; code: ProactiveDeliveryHold; retryAt: string | null };

/** The connection of a delivery point that writes under `BEGIN IMMEDIATE` (a `DatabaseSync`, by its shape). */
export interface ProactiveGateConnection {
  prepare(sql: string): { run(...values: never[]): unknown; get(...values: never[]): unknown; all(...values: never[]): unknown[] };
}

/** Why a delivery point held a message: one of the gate's four codes, or `gate_error` when the gate itself failed (fail closed). */
export type ProactiveDeliveryHold = ProactiveHoldCode | 'gate_error';

export type ProactiveDeliveryVerdict = { verdict: 'deliver'; topicReuse: number } | { verdict: 'hold'; code: ProactiveDeliveryHold };

export interface ProactiveDeliveryGate {
  /** The verdict at `at`; a hold is recorded as a withheld action and a notice before it is answered. */
  check(scopeKey: string, intent: ProactiveDeliveryIntent, at: string): ProactiveDeliveryVerdict;
  /** A message was written: its intent and topic signature are noted. */
  delivered(scopeKey: string, intent: ProactiveDeliveryIntent, at: string): void;
  /** The verdict inside the caller's write transaction on `connection`, read there; records nothing. Never throws (`gate_error`). */
  decide(scopeKey: string, intent: ProactiveDeliveryIntent, at: string, connection: ProactiveGateConnection): ProactiveDecision;
  /** A hold `decide` answered, recorded (withheld action and notice, once a day) after the caller's transaction ended. */
  hold(scopeKey: string, intent: ProactiveDeliveryIntent, decision: Extract<ProactiveDecision, { verdict: 'hold' }>, at: string): ProactiveDeliveryVerdict;
  /** Notes the delivery inside the caller's transaction on `connection`; throws, so that the message is rolled back with it. */
  deliveredWithin(scopeKey: string, intent: ProactiveDeliveryIntent, at: string, connection: ProactiveGateConnection): void;
  /** Whether this point held this subject (or reason, without one) on the owner's day of `at`: a selector then tries another. */
  heldToday(scopeKey: string, point: ProactivePoint, intent: Pick<ProactiveDeliveryIntent, 'reason' | 'subject'>, at: string): boolean;
  /** eff of a topic against her earlier messages (0 without one, or on any error): a selector damps a priority by (1 − eff). */
  topicReuse(scopeKey: string, text: string | null, at: string): number;
}

export interface ProactiveGateDependencies {
  topics: SQLiteProactiveTopics;
  /** The topics store on a delivery point's own connection (wiring builds it; the table exists, the gate's connection made it). */
  topicsOn?: (connection: ProactiveGateConnection) => Pick<SQLiteProactiveTopics, 'since' | 'record' | 'ownerLastActiveAt'>;
  /** The owner's zone for the day of a hold. */
  timeZone?: string;
  /** Which process the gate runs in, as its notices name it: her own time's worker (default) or the world worker (`worker`). */
  source?: 'own_time' | 'worker';
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
  const toolOf = (intent: ProactiveDeliveryIntent): string => { try { return PROACTIVE_POINT_TOOL[intent.point] ?? 'owner.reach_out'; } catch { return 'owner.reach_out'; } };
  const holdKey = (intent: Pick<ProactiveDeliveryIntent, 'reason' | 'subject'>) => closedSubject(intent.subject) ?? `reason:${String(intent.reason)}`;
  /** A hold: the withheld action her next thought is shown and the workspace's notice, once a day per point and subject. */
  const held = (scopeKey: string, intent: ProactiveDeliveryIntent, code: ProactiveDeliveryHold, retryAt: string | null, at: string): ProactiveDeliveryVerdict => {
    const tool = toolOf(intent);
    let first = true;
    try { first = dependencies.topics.noteHold({ scopeKey, day: ownerDay(at, dependencies.timeZone), point: intent.point, key: holdKey(intent), code, at }); } catch { first = true; }
    if (first) {
      try { dependencies.withheld?.(scopeKey, { surface: 'autonomy', tool, reason: code, rail: 'gate', retryAt }, at); } catch { log(`proactive gate: withheld write failed`); }
      try {
        let audience: 'owner' | 'others' = 'owner';
        try { audience = dependencies.audience?.(scopeKey, at) ?? 'owner'; } catch { audience = 'others'; }
        dependencies.emit?.(scopeKey, { kind: 'notice', code: 'withheld', audience, source: dependencies.source ?? 'own_time', sourceId: `withheld-${randomUUID()}`, tool, reason: code }, at);
      } catch { log(`proactive gate: notice failed`); }
    }
    log(`proactive gate: ${String(intent.point)} held ${code}${first ? '' : ' again today'}`);
    return { verdict: 'hold', code };
  };
  const decideOn = (topics: Pick<SQLiteProactiveTopics, 'since' | 'ownerLastActiveAt'>, scopeKey: string, intent: ProactiveDeliveryIntent, at: string): ProactiveDecision => {
    try {
      const now = Date.parse(at);
      const rows = topics.since(scopeKey, new Date(now - TOPIC_LOOKBACK_MILLISECONDS).toISOString());
      const subject = closedSubject(intent.subject);
      const ownerLastActiveAt = dependencies.ownerLastActiveAt ? dependencies.ownerLastActiveAt(scopeKey) : topics.ownerLastActiveAt(scopeKey);
      // A call rings a line already delivered with the same intent: only an earlier call is a repeat of it.
      const repeats = intent.point === 'call' ? rows.filter(row => row.point === 'call') : rows;
      const verdict = proactiveVerdict({
        reason: intent.reason, subject, arisenAt: intent.arisenAt, priority: intent.priority ?? 1,
        topic: intent.text ? minHashSignature(intent.text) : null,
      }, {
        ownerLastActiveAt,
        delivered: repeats.map(row => ({ reason: row.reason as ProactiveReason, subject: row.subject, at: row.at })),
        topics: rows.flatMap(row => { const signature = decodeSignature(row.signature); return signature ? [{ signature, at: row.at }] : []; }),
      }, at, { ownerActiveMilliseconds: dependencies.ownerActiveMilliseconds ?? 0 });
      if (verdict.verdict === 'deliver') return { verdict: 'deliver', topicReuse: verdict.topicReuse };
      const retryAt = verdict.code === 'owner_active' && ownerLastActiveAt
        ? new Date(Math.min(Date.parse(ownerLastActiveAt), now) + ownerActiveHoldMilliseconds(dependencies.ownerActiveMilliseconds ?? 0)).toISOString()
        : verdict.code === 'intent_repeat'
          ? new Date(Math.max(...repeats.filter(row => row.reason === intent.reason && row.subject === subject).map(row => Date.parse(row.at))) + PROACTIVE_GATE_V1.intentRepeatMinutes * MINUTE).toISOString()
          : null;
      return { verdict: 'hold', code: verdict.code, retryAt };
    } catch (error) {
      // Fail closed: the message is held, and recorded as held as far as that still works.
      log(`proactive gate: check failed ${error instanceof Error ? error.name : 'unknown'}`);
      return { verdict: 'hold', code: 'gate_error', retryAt: null };
    }
  };
  const record = (topics: Pick<SQLiteProactiveTopics, 'record'>, scopeKey: string, intent: ProactiveDeliveryIntent, at: string) => {
    const signature = intent.text ? minHashSignature(intent.text) : null;
    topics.record({ scopeKey, at, point: intent.point, reason: intent.reason, subject: closedSubject(intent.subject), signature: signature ? encodeSignature(signature) : null });
  };
  return {
    check(scopeKey, intent, at) {
      const decision = decideOn(dependencies.topics, scopeKey, intent, at);
      return decision.verdict === 'deliver' ? decision : held(scopeKey, intent, decision.code, decision.retryAt, at);
    },
    decide(scopeKey, intent, at, connection) {
      let topics: Pick<SQLiteProactiveTopics, 'since' | 'ownerLastActiveAt'>;
      try {
        if (!dependencies.topicsOn) throw new Error('topicsOn');
        topics = dependencies.topicsOn(connection);
      } catch {
        log('proactive gate: no topics on the writer\'s connection');
        return { verdict: 'hold', code: 'gate_error', retryAt: null };
      }
      return decideOn(topics, scopeKey, intent, at);
    },
    hold(scopeKey, intent, decision, at) {
      return held(scopeKey, intent, decision.code, decision.retryAt, at);
    },
    deliveredWithin(scopeKey, intent, at, connection) {
      if (!dependencies.topicsOn) throw new Error('proactive gate: topicsOn is not wired');
      record(dependencies.topicsOn(connection), scopeKey, intent, at);
    },
    delivered(scopeKey, intent, at) {
      try {
        record(dependencies.topics, scopeKey, intent, at);
        dependencies.topics.prune(new Date(Date.parse(at) - 30 * 24 * HOUR).toISOString());
      } catch (error) {
        log(`proactive gate: note failed ${error instanceof Error ? error.name : 'unknown'}`);
      }
    },
    heldToday(scopeKey, point, intent, at) {
      try { return dependencies.topics.heldOn(scopeKey, ownerDay(at, dependencies.timeZone), point, holdKey(intent)); } catch { return false; }
    },
    topicReuse(scopeKey, text, at) {
      if (!text) return 0;
      try {
        const rows = dependencies.topics.since(scopeKey, new Date(Date.parse(at) - TOPIC_LOOKBACK_MILLISECONDS).toISOString());
        return topicReuse(minHashSignature(text), rows.flatMap(row => { const signature = decodeSignature(row.signature); return signature ? [{ signature, at: row.at }] : []; }), at);
      } catch { return 0; }
    },
  };
}
