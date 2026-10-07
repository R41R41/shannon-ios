import { signatureSimilarity, type MinHashSignature } from './minhash.js';

/**
 * The proactive gate (Syzygy ADR-0008 stage 3, owner answer 2 of 2026-10-07, `docs/mind-workspace-contract.md`): what holds one of
 * her own messages at a delivery point, beside what already holds it today.
 *
 * - Spacing stays today's 5 minutes, in today's code (`reachOutsRemaining`); this gate adds no spacing and no spacing code.
 * - Owner active: held while the owner wrote or spoke within max(2 minutes, the existing 10-minute hold).
 * - The same intent is not repeated within 30 minutes.
 * - An intent expires 30, 75 or 150 minutes after it arose, by its reason.
 * - Topic reuse is damped: eff = sim × (age < 5 h ? 1 : 2^(−(age − 5 h)/72 h)); blocked at eff ≥ 0.9, otherwise the priority is
 *   multiplied by (1 − eff). Similarity is MinHash over character 3-grams; only signatures are compared and stored.
 *
 * Every hold is a withheld action she is shown as a fact (closed codes below). Pure: the caller hands the history and the time.
 */
export const PROACTIVE_GATE_V1 = Object.freeze({
  version: 'proactive.v1',
  /** Miru's hold while the person is talking; the existing hold of 10 minutes is the larger and stays. */
  ownerActiveMinimumMinutes: 2,
  existingOwnerQuietMinutes: 10,
  /** Kept for reference: today's spacing, enforced where it is today (owner answer 2: not raised to 15). */
  spacingMinutes: 5,
  intentRepeatMinutes: 30,
  expiryMinutes: Object.freeze({ upcoming: 30, promise: 30, share: 75, saw: 75, follow_up: 75, wonder: 150, world: 150 }),
  topic: Object.freeze({ blockHours: 5, halfLifeHours: 72, blockAt: 0.9 }),
});

export type ProactiveReason = keyof typeof PROACTIVE_GATE_V1.expiryMinutes;
export const PROACTIVE_REASONS = Object.freeze(Object.keys(PROACTIVE_GATE_V1.expiryMinutes)) as readonly ProactiveReason[];

/** The closed withheld codes of the gate (no spacing code: spacing stays today's). */
export const PROACTIVE_HOLD_CODES = Object.freeze(['owner_active', 'intent_repeat', 'intent_expired', 'topic_reused'] as const);
export type ProactiveHoldCode = typeof PROACTIVE_HOLD_CODES[number];

export interface ProactiveIntent {
  reason: ProactiveReason;
  /** What it is about, as a closed key (an upcoming item's id, a piece's id), or null for the reason alone. Never her words. */
  subject: string | null;
  /** When the intent arose (the thought that chose it). */
  arisenAt: string;
  /** In [0, 1]; the caller's order among intents. */
  priority: number;
  /** The MinHash signature of what the message is about, or null when it has none. */
  topic: MinHashSignature | null;
}

export interface ProactiveHistory {
  /** When the owner last wrote or spoke, or null. */
  ownerLastActiveAt: string | null;
  /** Her messages delivered before, with their intent. */
  delivered: readonly { reason: ProactiveReason; subject: string | null; at: string }[];
  /** The topics of her messages delivered before (signatures only). */
  topics: readonly { signature: MinHashSignature; at: string }[];
}

export type ProactiveVerdict =
  | { verdict: 'deliver'; priority: number; topicReuse: number }
  | { verdict: 'hold'; code: ProactiveHoldCode; topicReuse: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The owner-active hold in milliseconds: max(2 minutes, the existing hold, which is max(the loop's setting, 10 minutes)). */
export function ownerActiveHoldMilliseconds(configuredMilliseconds = 0): number {
  const existing = Math.max(Number.isFinite(configuredMilliseconds) ? configuredMilliseconds : 0, PROACTIVE_GATE_V1.existingOwnerQuietMinutes * MINUTE);
  return Math.max(PROACTIVE_GATE_V1.ownerActiveMinimumMinutes * MINUTE, existing);
}

/** 1 within 5 hours, then halving every 72 hours. */
export function topicDecay(ageMilliseconds: number): number {
  const { blockHours, halfLifeHours } = PROACTIVE_GATE_V1.topic;
  const age = Math.max(0, ageMilliseconds);
  return age < blockHours * HOUR ? 1 : 2 ** (-(age - blockHours * HOUR) / (halfLifeHours * HOUR));
}

/** The highest eff = sim × decay over her earlier topics (0 without a topic). */
export function topicReuse(topic: MinHashSignature | null, earlier: ProactiveHistory['topics'], at: string): number {
  if (!topic) return 0;
  const now = Date.parse(at);
  let highest = 0;
  for (const item of earlier) {
    const age = now - Date.parse(item.at);
    if (!Number.isFinite(age) || age < 0) continue;
    highest = Math.max(highest, signatureSimilarity(topic, item.signature) * topicDecay(age));
  }
  return highest;
}

export function intentExpiresAt(intent: Pick<ProactiveIntent, 'reason' | 'arisenAt'>): string {
  return new Date(Date.parse(intent.arisenAt) + PROACTIVE_GATE_V1.expiryMinutes[intent.reason] * MINUTE).toISOString();
}

/**
 * The gate's answer for one intent at `at`, in a fixed order: the owner active, the intent expired, the same intent within 30
 * minutes, the topic reused. `ownerActiveMilliseconds` is the loop's setting (`SHANNON_AUTONOMY_OWNER_ACTIVE_*`), if any.
 */
export function proactiveVerdict(intent: ProactiveIntent, history: ProactiveHistory, at: string, options: { ownerActiveMilliseconds?: number } = {}): ProactiveVerdict {
  const now = Date.parse(at);
  const reuse = topicReuse(intent.topic, history.topics, at);
  const hold = (code: ProactiveHoldCode): ProactiveVerdict => ({ verdict: 'hold', code, topicReuse: reuse });
  if (history.ownerLastActiveAt !== null) {
    const since = now - Date.parse(history.ownerLastActiveAt);
    if (since >= 0 && since < ownerActiveHoldMilliseconds(options.ownerActiveMilliseconds)) return hold('owner_active');
  }
  if (now >= Date.parse(intentExpiresAt(intent))) return hold('intent_expired');
  const repeat = history.delivered.some(item => item.reason === intent.reason && item.subject === intent.subject
    && now - Date.parse(item.at) >= 0 && now - Date.parse(item.at) < PROACTIVE_GATE_V1.intentRepeatMinutes * MINUTE);
  if (repeat) return hold('intent_repeat');
  if (reuse >= PROACTIVE_GATE_V1.topic.blockAt) return hold('topic_reused');
  const priority = Math.min(1, Math.max(0, Number.isFinite(intent.priority) ? intent.priority : 0));
  return { verdict: 'deliver', priority: priority * (1 - reuse), topicReuse: reuse };
}
