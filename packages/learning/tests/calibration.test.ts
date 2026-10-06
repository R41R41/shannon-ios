import { describe, expect, it } from 'vitest';
import { calibration, reliabilityBins, type CalibrationRow } from '../src/index.js';

const reply = (expectation: number, outcome: number, prior = 0.5): CalibrationRow => ({
  domain: 'reply', expectation, outcome, prior, intervalLow: Math.max(0, expectation - 0.2), intervalHigh: Math.min(1, expectation + 0.2),
});

describe('calibration', () => {
  it('scores yes/no predictions by the Brier score and the skill over the domain prior', () => {
    const rows = [reply(0.9, 1), reply(0.8, 1), reply(0.2, 0), reply(0.1, 0)];
    const report = calibration(rows);
    const domain = report.domains[0]!;
    expect(domain.n).toBe(4);
    expect(domain.brier).toBeCloseTo((0.01 + 0.04 + 0.04 + 0.01) / 4, 12);
    // The prior 0.5 scores 0.25 on every row: κ = 1 − 0.025 / 0.25.
    expect(domain.skill).toBeCloseTo(0.9, 12);
    expect(domain.coverage80).toBeNull();
    expect(report.overall).toMatchObject({ n: 4 });
    expect(report.overall.skill).toBeCloseTo(0.9, 12);
  });

  it('is worse than no skill when the expectation is further off than the prior', () => {
    expect(calibration([reply(0.1, 1), reply(0.9, 0)]).domains[0]!.skill).toBeLessThan(0);
    // A reference of 0 (the prior was exact every time) has no skill to speak of.
    expect(calibration([reply(0.5, 1, 1)]).domains[0]!.skill).toBeNull();
  });

  it('normalises a gaussian domain by its width and counts how often the outcome fell in the 80 % interval', () => {
    const stance = (expectation: number, outcome: number): CalibrationRow => ({ domain: 'body_stance', expectation, outcome, prior: 0, intervalLow: expectation - 0.5, intervalHigh: expectation + 0.5 });
    const report = calibration([stance(0.5, 1), stance(0.5, 0.2), stance(-0.5, -1), stance(0, 1)]);
    const domain = report.domains[0]!;
    expect(domain.brier).toBeCloseTo((0.25 + 0.09 + 0.25 + 1) / 4 / 4, 12);
    expect(domain.coverage80).toBeCloseTo(3 / 4, 12);
  });

  it('bins by expectation into five bins of equal count, fewer when there are fewer rows', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ expectation: index / 11, outcome: index % 2 }));
    const bins = reliabilityBins(rows);
    expect(bins.map(bin => bin.n)).toEqual([2, 3, 2, 3, 2]);
    expect(bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(12);
    expect(bins[0]!.expected).toBeLessThan(bins[4]!.expected);
    expect(reliabilityBins(rows.slice(0, 3)).map(bin => bin.n)).toEqual([1, 1, 1]);
    expect(reliabilityBins([])).toEqual([]);
  });

  it('reports nothing for nothing, and leaves out a row that is not a number', () => {
    expect(calibration([])).toEqual({ domains: [], overall: { n: 0, brier: null, skill: null } });
    expect(calibration([reply(Number.NaN, 1)]).overall.n).toBe(0);
  });
});
