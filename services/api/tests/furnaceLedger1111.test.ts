import { describe, expect, it } from 'vitest';
import { furnaceLedgerLines } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';

// Run 5 (2026-11-11): the furnace ledger in the live state's jobs (where, what comes out, how long; what to do meanwhile is said once in the first line).
const job = (patch: Record<string, unknown> = {}) => ({ status: 'waiting_external', remainingEstimateMs: 45_000, input: 'raw_iron', count: 8, position: { x: 264, y: 36, z: -111 },
  expects: 'iron_ingot×8', from: '東1・下1', completionVerified: false, ...patch });

describe('furnaceLedgerLines', () => {
  it('says the instruction once, then where, what goes in and comes out, and the seconds', () => {
    const [head, line, ...rest] = furnaceLedgerLines([job()])!;
    expect(head).toContain('待たずに別の作業');
    expect(head).toContain('furnace X,Y,Z take');
    expect(head).toContain('離れ切る前に取る');
    expect(line).toBe('かまど (264,36,-111)（東1・下1）: raw_iron×8 → iron_ingot×8、あと約 45 秒');
    expect(rest).toEqual([]);
  });
  it('says the time is up (take), another dimension, and the fuel that is short; the soonest first', () => {
    const lines = furnaceLedgerLines([job({ status: 'different_dimension', position: { x: 1, y: 2, z: 3 }, from: undefined }),
      job({ unfueledInputCount: 3, position: { x: 5, y: 6, z: 7 } }), job({ remainingEstimateMs: 0, status: 'verification_due' })])!;
    expect(lines.slice(1)).toEqual([
      'かまど (264,36,-111)（東1・下1）: raw_iron×8 → iron_ingot×8、時間は来た（take）',
      'かまど (5,6,7)（東1・下1）: raw_iron×8 → iron_ingot×8、あと約 45 秒。燃料が足りず 3 個は焼けない（石炭か板を足す）',
      'かまど (1,2,3): raw_iron×8 → iron_ingot×8。別のディメンションにある']);
  });
  it('shows 4 furnaces at most and counts the rest; no instruction when every furnace is in another dimension', () => {
    const many = [1, 2, 3, 4, 5, 6].map(n => job({ remainingEstimateMs: n * 1000, position: { x: n, y: 1, z: 1 } }));
    const lines = furnaceLedgerLines(many)!;
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('(1,1,1)');
    expect(lines[5]).toBe('ほか 2 基');
    expect(furnaceLedgerLines([job({ status: 'different_dimension' })])).toHaveLength(1);
  });
  it('works with a body that does not send the new fields, and gives null for a shape it does not know', () => {
    const [, line] = furnaceLedgerLines([{ status: 'waiting_external', remainingEstimateMs: 10_000, input: 'beef', count: 3, position: { x: 1, y: 2, z: 3 } }])!;
    expect(line).toBe('かまど (1,2,3): beef×3、あと約 10 秒');
    expect(furnaceLedgerLines([{ status: 'x' }])).toBeNull();
    expect(furnaceLedgerLines([])).toBeNull();
    expect(furnaceLedgerLines('furnace')).toBeNull();
  });
});
