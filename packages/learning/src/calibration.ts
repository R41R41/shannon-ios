import { SHANNON_PREDICTION_DOMAINS } from '@shannon/cognition';
import type { LedgerDomain } from './predictionLedger.js';

/**
 * How well her predictions are calibrated (Syzygy ADR-0008 §4 「較正」; `docs/cognition-ledger-contract.md`). Pure.
 *
 * Per domain, over the settled rows that have an outcome:
 * - Brier score: the mean squared error, divided by the scale's width squared (for a yes/no domain, the Brier score itself).
 * - Reliability: five equal-count bins by expectation, each with its count, mean expectation and mean outcome.
 * - 80 % coverage: the share of outcomes inside the interval, for gaussian domains; null for yes/no domains, whose interval
 *   is about the probability and not about the outcome.
 * - Skill κ (Murphy 1973): 1 − Σ(outcome − expectation)² / Σ(outcome − prior)², against the domain prior the row was opened
 *   with; null while that reference is 0 (or there is nothing to score).
 */
export interface CalibrationRow {
  domain: LedgerDomain;
  expectation: number;
  outcome: number;
  prior: number;
  intervalLow: number;
  intervalHigh: number;
}

export interface ReliabilityBin { n: number; expected: number; observed: number }

export interface DomainCalibration {
  domain: LedgerDomain;
  n: number;
  brier: number | null;
  skill: number | null;
  coverage80: number | null;
  bins: ReliabilityBin[];
}

export interface CalibrationReport {
  domains: DomainCalibration[];
  /** Over every domain, each error normalised by its scale. */
  overall: { n: number; brier: number | null; skill: number | null };
}

export const RELIABILITY_BINS = 5;

export function calibration(rows: readonly CalibrationRow[]): CalibrationReport {
  const byDomain = new Map<LedgerDomain, CalibrationRow[]>();
  for (const row of rows) {
    if (![row.expectation, row.outcome, row.prior].every(Number.isFinite)) continue;
    byDomain.set(row.domain, [...(byDomain.get(row.domain) ?? []), row]);
  }
  const domains = [...byDomain.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([domain, items]) => domainCalibration(domain, items));
  let squared = 0;
  let reference = 0;
  let n = 0;
  for (const [domain, items] of byDomain) {
    const width = scaleWidth(domain);
    for (const row of items) {
      squared += ((row.outcome - row.expectation) / width) ** 2;
      reference += ((row.outcome - row.prior) / width) ** 2;
      n += 1;
    }
  }
  return { domains, overall: { n, brier: n ? squared / n : null, skill: n && reference > 0 ? 1 - squared / reference : null } };
}

function domainCalibration(domain: LedgerDomain, rows: readonly CalibrationRow[]): DomainCalibration {
  const width = scaleWidth(domain);
  const squared = rows.reduce((sum, row) => sum + (row.outcome - row.expectation) ** 2, 0);
  const reference = rows.reduce((sum, row) => sum + (row.outcome - row.prior) ** 2, 0);
  const gaussian = SHANNON_PREDICTION_DOMAINS[domain].family !== 'bernoulli';
  const inside = rows.filter(row => row.outcome >= row.intervalLow - 1e-9 && row.outcome <= row.intervalHigh + 1e-9).length;
  return {
    domain, n: rows.length,
    brier: rows.length ? squared / rows.length / (width * width) : null,
    skill: rows.length && reference > 0 ? 1 - squared / reference : null,
    coverage80: gaussian && rows.length ? inside / rows.length : null,
    bins: reliabilityBins(rows),
  };
}

/** Equal-count bins by expectation (sizes differ by at most one; ties keep the rows' order); fewer when there are fewer rows. */
export function reliabilityBins(rows: readonly Pick<CalibrationRow, 'expectation' | 'outcome'>[], count = RELIABILITY_BINS): ReliabilityBin[] {
  const sorted = rows.map((row, index) => ({ row, index })).sort((left, right) => left.row.expectation - right.row.expectation || left.index - right.index).map(item => item.row);
  const bins: ReliabilityBin[] = [];
  const total = sorted.length;
  const parts = Math.min(count, total);
  let start = 0;
  for (let part = 0; part < parts; part += 1) {
    const end = Math.round(((part + 1) * total) / parts);
    const slice = sorted.slice(start, end);
    bins.push({
      n: slice.length,
      expected: slice.reduce((sum, row) => sum + row.expectation, 0) / slice.length,
      observed: slice.reduce((sum, row) => sum + row.outcome, 0) / slice.length,
    });
    start = end;
  }
  return bins;
}

function scaleWidth(domain: LedgerDomain): number {
  const spec = SHANNON_PREDICTION_DOMAINS[domain];
  return Math.max(1e-9, spec.upper - spec.lower);
}
