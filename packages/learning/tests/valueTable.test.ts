import { describe, expect, it } from 'vitest';
import {
  ROOT_VALUE,
  VALUE_SCALE_VARIANCE,
  foldValues,
  nightlyDecision,
  rollbackTarget,
  valueCells,
  valueOf,
  valuePath,
  versionsToPrune,
  type ValueEvidence,
  type ValueVersionRecord,
} from '../src/index.js';

const HOUR = 60 * 60_000;
const evidence = (choice: string, context: string, reward: number, hours: number): ValueEvidence => ({
  choice, context, reward, world: reward / 2, serve: reward, growth: 1, costYen: 3, settledAt: new Date(Date.UTC(2026, 9, 7) + hours * HOUR).toISOString(),
});

describe('the value table', () => {
  it('reads cells from the most specific to the root, and the root prior before anything was learned', () => {
    expect(valuePath('reach_out.wonder', 'night.alone').map(step => `${step.level}:${step.choice}:${step.context}`)).toEqual([
      'root::', 'family:reach_out:', 'choice:reach_out.wonder:', 'band:reach_out.wonder:night', 'presence:reach_out.wonder:night.alone',
    ]);
    expect(valueOf([], 'draft', 'night.alone', 'v0')).toEqual({ ...ROOT_VALUE, version: 'v0' });
  });

  it('learns from rewards, and a cell with evidence is read before its parent', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => evidence('reach_out.wonder', 'night.alone', -0.4, index)),
      ...Array.from({ length: 8 }, (_, index) => evidence('reach_out.wonder', 'evening.alone', 0.8, 10 + index)),
    ];
    const cells = valueCells(foldValues(rows));
    const night = valueOf(cells, 'reach_out.wonder', 'night.alone', 'v1');
    const evening = valueOf(cells, 'reach_out.wonder', 'evening.alone', 'v1');
    expect(night.level).toBe('presence');
    expect(night.mean).toBeLessThan(0);
    expect(evening.mean).toBeGreaterThan(0.5);
    // A presence never seen falls back to its band; a band never seen to its choice; a choice never seen to its family.
    expect(valueOf(cells, 'reach_out.wonder', 'night.others', 'v1')).toMatchObject({ level: 'band', mean: cells.find(cell => cell.level === 'band' && cell.context === 'night')!.mean });
    expect(valueOf(cells, 'reach_out.wonder', 'morning.alone', 'v1').level).toBe('choice');
    expect(valueOf(cells, 'reach_out.share', 'morning.alone', 'v1').level).toBe('family');
    expect(valueOf(cells, 'draft', 'morning.alone', 'v1').level).toBe('root');
    const choice = cells.find(cell => cell.level === 'choice')!;
    expect(choice).toMatchObject({ n: 16, costYen: 3, growth: 1 });
    expect(choice.uncertainty).toBeLessThan(VALUE_SCALE_VARIANCE);
  });

  it('starts a new cell from its parent, with the siblings\' spread once there are three of them', () => {
    const rows = ['a', 'b', 'c'].flatMap((name, family) => Array.from({ length: 5 }, (_, index) => evidence(`tool.${name}`, 'night.alone', family / 2, family * 10 + index)));
    const table = foldValues(rows);
    const before = valueCells(table);
    const parent = before.find(cell => cell.level === 'family' && cell.choice === 'tool')!;
    const siblings = before.filter(cell => cell.level === 'choice');
    expect(siblings).toHaveLength(3);
    const fresh = valueCells(foldValues([...rows, evidence('tool.d', 'night.alone', 0.2, 100)])).find(cell => cell.choice === 'tool.d' && cell.level === 'choice')!;
    expect(fresh.n).toBe(1);
    // It moved from its parent's mean toward 0.2 by a gain set by the spread it started with.
    expect(Math.abs(fresh.mean - parent.mean)).toBeGreaterThan(0);
    expect(Math.abs(fresh.mean - 0.2)).toBeLessThan(Math.abs(parent.mean - 0.2));
  });

  it('is a fold: the same evidence in the same order gives the same cells', () => {
    const rows = Array.from({ length: 30 }, (_, index) => evidence(index % 2 ? 'draft' : 'reach_out.share', index % 3 ? 'night.alone' : 'morning.others', ((index * 7) % 11) / 10 - 0.5, index));
    expect(valueCells(foldValues(rows))).toEqual(valueCells(foldValues(rows)));
    expect(valueCells(foldValues(rows))).not.toEqual(valueCells(foldValues(rows.slice(1))));
  });
});

const version = (id: string, overrides: Partial<ValueVersionRecord> = {}): ValueVersionRecord => ({
  versionId: id, createdAt: '2026-10-07T00:00:00.000Z', madeBy: 'sleep', formula: 'r1', weights: {}, baseVersion: null, evidenceFrom: 1, evidenceTo: 10, state: 'retired', frozen: false, ...overrides,
});

describe('versions', () => {
  it('writes a nightly version only with new evidence and never while frozen', () => {
    expect(nightlyDecision(null, 0)).toBe('empty');
    expect(nightlyDecision(null, 3)).toBe('snapshot');
    expect(nightlyDecision(version('a', { evidenceTo: 3 }), 3)).toBe('unchanged');
    expect(nightlyDecision(version('a', { evidenceTo: 3 }), 5)).toBe('snapshot');
    expect(nightlyDecision(version('a', { evidenceTo: 3, frozen: true }), 5)).toBe('frozen');
    expect(nightlyDecision(version('a', { evidenceTo: 3 }), 5, true)).toBe('already');
    expect(nightlyDecision(version('a', { evidenceTo: 3, frozen: true }), 5, true)).toBe('frozen');
  });

  it('rolls back to the newest version that learned from less, and never forward to the one rolled away from', () => {
    const a = version('a', { evidenceTo: 5 });
    const b = version('b', { evidenceTo: 9, createdAt: '2026-10-08T00:00:00.000Z' });
    const c = version('c', { evidenceTo: 12, createdAt: '2026-10-09T00:00:00.000Z', state: 'active' });
    expect(rollbackTarget([a, b, c], c)).toBe(b);
    const rolled = version('r', { madeBy: 'owner_rollback', evidenceTo: 9, baseVersion: 'b', createdAt: '2026-10-10T00:00:00.000Z', state: 'active', frozen: true });
    expect(rollbackTarget([a, b, c, rolled], rolled)).toBe(a);
    expect(rollbackTarget([a, b, c], c, 'a')).toBe(a);
    expect(rollbackTarget([a, b, c], c, 'zzz')).toBe('VALUES_VERSION_NOT_FOUND');
    expect(rollbackTarget([a], a)).toBe('VALUES_NO_EARLIER_VERSION');
    expect(rollbackTarget([], null)).toBe('VALUES_NO_ACTIVE_VERSION');
  });

  it('prunes nightly versions after 30 days, never the active one or one the owner made', () => {
    const old = '2026-08-01T00:00:00.000Z';
    expect(versionsToPrune([
      version('old-sleep', { createdAt: old }), version('old-active', { createdAt: old, state: 'active' }),
      version('old-owner', { createdAt: old, madeBy: 'owner_rollback' }), version('recent', { createdAt: '2026-10-06T00:00:00.000Z' }),
    ], '2026-10-07T00:00:00.000Z')).toEqual(['old-sleep']);
  });
});
