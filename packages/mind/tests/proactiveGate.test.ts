import { describe, expect, it } from 'vitest';
import {
  PROACTIVE_GATE_V1, PROACTIVE_HOLD_CODES, intentExpiresAt, minHashSignature, ownerActiveHoldMilliseconds, proactiveVerdict, topicDecay, topicReuse,
  type ProactiveHistory, type ProactiveIntent, type ProactiveVerdict,
} from '../src/index.js';

const AT = '2026-10-07T03:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (milliseconds: number) => new Date(Date.parse(AT) - milliseconds).toISOString();
const codeOf = (verdict: ProactiveVerdict) => (verdict.verdict === 'hold' ? verdict.code : null);
const empty: ProactiveHistory = { ownerLastActiveAt: null, delivered: [], topics: [] };
const TOPIC = '歯医者の予定が近いので、準備ができているか聞きたい';
const intent = (fields: Partial<ProactiveIntent> = {}): ProactiveIntent => ({
  reason: 'upcoming', subject: 'event-1', arisenAt: ago(5 * MINUTE), priority: 0.8, topic: minHashSignature(TOPIC), ...fields,
});

describe('the proactive gate (owner answer 2)', () => {
  it('keeps the spacing at 5 minutes and adds no spacing code', () => {
    expect(PROACTIVE_GATE_V1.spacingMinutes).toBe(5);
    expect(PROACTIVE_HOLD_CODES).toEqual(['owner_active', 'intent_repeat', 'intent_expired', 'topic_reused']);
    expect(PROACTIVE_HOLD_CODES).not.toContain('proactive_spacing' as never);
    // A message two minutes after the last one is not held by this gate: today's spacing holds it where it does today.
    expect(proactiveVerdict(intent(), { ...empty, delivered: [{ reason: 'wonder', subject: null, at: ago(2 * MINUTE) }] }, AT).verdict).toBe('deliver');
  });

  it('delivers with nothing in the way, at the intent\'s priority', () => {
    expect(proactiveVerdict(intent(), empty, AT)).toEqual({ verdict: 'deliver', priority: 0.8, topicReuse: 0 });
  });

  it('holds while the owner was active within max(2 minutes, the existing 10 minutes)', () => {
    expect(ownerActiveHoldMilliseconds()).toBe(10 * MINUTE);
    expect(ownerActiveHoldMilliseconds(30 * MINUTE)).toBe(30 * MINUTE);
    expect(ownerActiveHoldMilliseconds(Number.NaN)).toBe(10 * MINUTE);
    expect(proactiveVerdict(intent(), { ...empty, ownerLastActiveAt: ago(9 * MINUTE) }, AT)).toMatchObject({ verdict: 'hold', code: 'owner_active' });
    expect(proactiveVerdict(intent(), { ...empty, ownerLastActiveAt: ago(1 * MINUTE) }, AT)).toMatchObject({ verdict: 'hold', code: 'owner_active' });
    expect(proactiveVerdict(intent(), { ...empty, ownerLastActiveAt: ago(10 * MINUTE) }, AT).verdict).toBe('deliver');
    expect(proactiveVerdict(intent(), { ...empty, ownerLastActiveAt: ago(20 * MINUTE) }, AT, { ownerActiveMilliseconds: 30 * MINUTE }).verdict).toBe('hold');
    // A time in the future (a clock that went back) does not hold.
    expect(proactiveVerdict(intent(), { ...empty, ownerLastActiveAt: ago(-MINUTE) }, AT).verdict).toBe('deliver');
  });

  it('expires an intent 30, 75 or 150 minutes after it arose, by its reason', () => {
    expect(PROACTIVE_GATE_V1.expiryMinutes).toEqual({ upcoming: 30, promise: 30, share: 75, saw: 75, follow_up: 75, wonder: 150, world: 150 });
    for (const [reason, minutes] of Object.entries(PROACTIVE_GATE_V1.expiryMinutes) as Array<[ProactiveIntent['reason'], number]>) {
      expect(intentExpiresAt({ reason, arisenAt: AT })).toBe(new Date(Date.parse(AT) + minutes * MINUTE).toISOString());
      expect(proactiveVerdict(intent({ reason, arisenAt: ago((minutes - 1) * MINUTE) }), empty, AT).verdict, reason).toBe('deliver');
      expect(proactiveVerdict(intent({ reason, arisenAt: ago(minutes * MINUTE) }), empty, AT), reason).toMatchObject({ verdict: 'hold', code: 'intent_expired' });
    }
  });

  it('does not repeat the same intent (reason and subject) within 30 minutes', () => {
    const delivered = (at: string, subject: string | null = 'event-1', reason: ProactiveIntent['reason'] = 'upcoming') => ({ ...empty, delivered: [{ reason, subject, at }] });
    expect(proactiveVerdict(intent({ topic: null }), delivered(ago(29 * MINUTE)), AT)).toMatchObject({ verdict: 'hold', code: 'intent_repeat' });
    expect(proactiveVerdict(intent({ topic: null }), delivered(ago(30 * MINUTE)), AT).verdict).toBe('deliver');
    expect(proactiveVerdict(intent({ topic: null }), delivered(ago(5 * MINUTE), 'event-2'), AT).verdict).toBe('deliver');
    expect(proactiveVerdict(intent({ topic: null }), delivered(ago(5 * MINUTE), 'event-1', 'promise'), AT).verdict).toBe('deliver');
    expect(codeOf(proactiveVerdict(intent({ reason: 'wonder', subject: null, topic: null }), delivered(ago(5 * MINUTE), null, 'wonder'), AT))).toBe('intent_repeat');
  });

  it('decays topic reuse: 1 for five hours, then halving every 72 hours', () => {
    expect(topicDecay(0)).toBe(1);
    expect(topicDecay(5 * HOUR - 1)).toBe(1);
    expect(topicDecay(5 * HOUR)).toBe(1);
    expect(topicDecay(77 * HOUR)).toBeCloseTo(0.5);
    expect(topicDecay(149 * HOUR)).toBeCloseTo(0.25);
  });

  it('blocks a topic at eff ≥ 0.9, and otherwise lowers the priority by (1 − eff)', () => {
    const same = { ...empty, topics: [{ signature: minHashSignature(TOPIC)!, at: ago(HOUR) }] };
    expect(proactiveVerdict(intent(), same, AT)).toMatchObject({ verdict: 'hold', code: 'topic_reused', topicReuse: 1 });
    // The same topic three days after the 5-hour block halves: eff 0.5, priority 0.8 × 0.5.
    const old = { ...empty, topics: [{ signature: minHashSignature(TOPIC)!, at: ago(77 * HOUR) }] };
    const verdict = proactiveVerdict(intent(), old, AT);
    expect(verdict.verdict).toBe('deliver');
    expect(verdict.topicReuse).toBeCloseTo(0.5);
    expect(verdict.verdict === 'deliver' && verdict.priority).toBeCloseTo(0.4);
    // An unrelated topic changes nothing.
    const other = { ...empty, topics: [{ signature: minHashSignature('Minecraftで家を建てた話をしたい')!, at: ago(HOUR) }] };
    expect(topicReuse(minHashSignature(TOPIC), other.topics, AT)).toBeLessThan(0.1);
    // Without a topic, reuse is 0.
    expect(topicReuse(null, same.topics, AT)).toBe(0);
  });

  it('checks in a fixed order: the owner first, then expiry, then the repeat, then the topic', () => {
    const everything: ProactiveHistory = {
      ownerLastActiveAt: ago(MINUTE), delivered: [{ reason: 'upcoming', subject: 'event-1', at: ago(MINUTE) }], topics: [{ signature: minHashSignature(TOPIC)!, at: ago(MINUTE) }],
    };
    const old = intent({ arisenAt: ago(HOUR) });
    expect(codeOf(proactiveVerdict(old, everything, AT))).toBe('owner_active');
    expect(codeOf(proactiveVerdict(old, { ...everything, ownerLastActiveAt: null }, AT))).toBe('intent_expired');
    expect(codeOf(proactiveVerdict(intent(), { ...everything, ownerLastActiveAt: null }, AT))).toBe('intent_repeat');
    expect(codeOf(proactiveVerdict(intent(), { ...everything, ownerLastActiveAt: null, delivered: [] }, AT))).toBe('topic_reused');
  });

  it('clamps a priority out of range', () => {
    expect(proactiveVerdict(intent({ priority: 3, topic: null }), empty, AT)).toMatchObject({ priority: 1 });
    expect(proactiveVerdict(intent({ priority: Number.NaN, topic: null }), empty, AT)).toMatchObject({ priority: 0 });
  });
});
