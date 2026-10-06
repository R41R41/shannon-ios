import { describe, expect, it } from 'vitest';
import { SHANNON_PREDICTION_DOMAINS } from '@shannon/cognition';
import {
  CALL_ANSWER_OUTCOME,
  INTERVAL_80_Z,
  LEDGER_DOMAINS,
  LEDGER_DOMAIN_RULES,
  STORY_REACTION_OUTCOME,
  createLedgerMind,
  foldSettled,
  isLedgerDomain,
  ledgerOutcome,
  ledgerPrediction,
  recomputeLedger,
  roundedDerived,
  sameDerived,
  type LedgerRow,
} from '../src/index.js';

const MINUTE = 60_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7) + minutes * MINUTE).toISOString();

function row(id: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return { predictionId: id, domain: 'reply', key: 'wonder.evening', context: 'alone', madeAt: at(0), basisSeq: 0, outcome: null, outcomeSeq: null, settledAt: null, ...overrides };
}

describe('the ledger domains', () => {
  it('are the five new domains of ADR-0008 and the two existing ones, all known to the one prediction layer', () => {
    expect(LEDGER_DOMAINS).toEqual(['reply', 'call_answer', 'story_reacted', 'story_reaction', 'reading_used', 'step_success', 'body_stance']);
    for (const domain of ['call_answer', 'story_reacted', 'story_reaction', 'reading_used', 'step_success'] as const) {
      expect(SHANNON_PREDICTION_DOMAINS[domain].valence, domain).toBe(false);
    }
    expect(SHANNON_PREDICTION_DOMAINS.story_reaction).toMatchObject({ family: 'gaussian', lower: 0, upper: 1 });
    expect(isLedgerDomain('reply_time')).toBe(false);
    expect(isLedgerDomain('reading_used')).toBe(true);
  });

  it('expire a story without a reaction to 0 after 14 days, and leave a lost outcome unscored', () => {
    expect(LEDGER_DOMAIN_RULES.story_reacted).toEqual({ expiresAfterMs: 14 * 24 * 60 * MINUTE, expiryOutcome: 0 });
    expect(LEDGER_DOMAIN_RULES.story_reaction.expiryOutcome).toBeNull();
    expect(LEDGER_DOMAIN_RULES.reading_used.expiryOutcome).toBe(0);
    for (const domain of ['reply', 'call_answer', 'step_success', 'body_stance'] as const) expect(LEDGER_DOMAIN_RULES[domain].expiryOutcome).toBeNull();
    expect(STORY_REACTION_OUTCOME).toEqual({ like: 1, more: 0.5, unclear: 0 });
    expect(CALL_ANSWER_OUTCOME).toEqual({ answered: 1, declined: 0, unanswered: 0, failed: null });
    expect(ledgerOutcome('reply', 0.7)).toBe(1);
    expect(ledgerOutcome('story_reaction', 2)).toBe(1);
    expect(ledgerOutcome('body_stance', -0.5)).toBe(-0.5);
  });
});

describe('a prediction', () => {
  it('starts from the uniform prior with its 80 % interval, and the prior equals it for an empty domain', () => {
    const empty = ledgerPrediction(createLedgerMind().model, { domain: 'reply', key: 'k', context: '', at: 0 });
    expect(empty.expectation).toBeCloseTo(0.5, 9);
    expect(empty.prior).toBeCloseTo(0.5, 9);
    expect(empty.intervalLow).toBeCloseTo(0.5 - INTERVAL_80_Z * Math.sqrt(empty.uncertainty), 9);
    const stance = ledgerPrediction(createLedgerMind().model, { domain: 'body_stance', key: 'k', context: '', at: 0 });
    // A gaussian interval is about the outcome: it includes the noise, and it never leaves the scale.
    expect(stance.intervalLow).toBe(-1);
    expect(stance.intervalHigh).toBe(1);
  });

  it('learns from settled outcomes in their order, and moves away from the domain prior for a key with evidence', () => {
    const mind = createLedgerMind();
    for (let index = 1; index <= 12; index += 1) foldSettled(mind, { domain: 'reply', key: 'wonder.night', context: 'alone', outcome: 0, outcomeSeq: index, settledAt: at(index) });
    for (let index = 13; index <= 24; index += 1) foldSettled(mind, { domain: 'reply', key: 'wonder.evening', context: 'alone', outcome: 1, outcomeSeq: index, settledAt: at(index) });
    expect(mind.seq).toBe(24);
    // An outcome already folded (or out of order) is not folded twice.
    foldSettled(mind, { domain: 'reply', key: 'wonder.night', context: 'alone', outcome: 1, outcomeSeq: 3, settledAt: at(30) });
    expect(mind.folded).toBe(24);
    const night = ledgerPrediction(mind.model, { domain: 'reply', key: 'wonder.night', context: 'alone', at: Date.parse(at(30)) });
    const evening = ledgerPrediction(mind.model, { domain: 'reply', key: 'wonder.evening', context: 'alone', at: Date.parse(at(30)) });
    expect(night.expectation).toBeLessThan(0.2);
    expect(evening.expectation).toBeGreaterThan(0.8);
    expect(night.prior).toBeCloseTo(evening.prior, 9);
    expect(night.prior).toBeGreaterThan(night.expectation);
    expect(night.intervalHigh).toBeLessThan(0.5);
  });
});

describe('recomputing the ledger', () => {
  const rows: LedgerRow[] = [];
  let seq = 0;
  for (let index = 0; index < 30; index += 1) {
    const basis = seq;
    const settled = index % 5 !== 4;
    if (settled) seq += 1;
    rows.push(row(`p${index}`, {
      domain: index % 3 === 0 ? 'story_reaction' : 'reply', key: index % 2 ? 'wonder.night' : 'share.morning', madeAt: at(index * 10), basisSeq: basis,
      ...(settled ? { outcome: index % 3 === 0 ? (index % 4) / 4 : index % 2, outcomeSeq: seq, settledAt: at(index * 10 + 3) } : {}),
    }));
  }

  it('gives every row what the incremental fold gave it when it was opened', () => {
    const mind = createLedgerMind();
    const incremental = new Map<string, ReturnType<typeof ledgerPrediction>>();
    // Opened in order: each from the outcomes settled before it; then its own outcome is folded when it arrives.
    for (const item of rows) {
      incremental.set(item.predictionId, ledgerPrediction(mind.model, { domain: item.domain, key: item.key, context: item.context, at: Date.parse(item.madeAt) }));
      foldSettled(mind, item);
    }
    const { derived, mind: recomputed } = recomputeLedger([...rows].reverse());
    for (const item of rows) expect(sameDerived(derived.get(item.predictionId)!, incremental.get(item.predictionId)!), item.predictionId).toBe(true);
    expect(recomputed.seq).toBe(mind.seq);
    expect(recomputeLedger(rows).derived).toEqual(derived);
  });

  it('changes what came after a forgotten outcome, and nothing before it', () => {
    const before = recomputeLedger(rows).derived;
    const forgotten = rows.filter(item => item.predictionId !== 'p6');
    const after = recomputeLedger(forgotten).derived;
    const sixth = rows.find(item => item.predictionId === 'p6')!;
    for (const item of forgotten) {
      const same = sameDerived(before.get(item.predictionId)!, after.get(item.predictionId)!);
      if (item.basisSeq < sixth.outcomeSeq!) expect(same, item.predictionId).toBe(true);
    }
    expect(forgotten.some(item => !sameDerived(before.get(item.predictionId)!, after.get(item.predictionId)!))).toBe(true);
  });

  it('rounds to six decimals, the precision a round trip through SQLite keeps', () => {
    const value = roundedDerived({ expectation: 0.123456789, uncertainty: 1 / 3, noise: 0.25, intervalLow: -0.0000004, intervalHigh: 1, prior: 0.5 });
    expect(value).toEqual({ expectation: 0.123457, uncertainty: 0.333333, noise: 0.25, intervalLow: -0, intervalHigh: 1, prior: 0.5 });
  });
});
