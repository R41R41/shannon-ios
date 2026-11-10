import { describe, expect, it } from 'vitest';
import { furnaceLedgerLines } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';

// Run 5 (2026-11-11): the furnace ledger in the live state's jobs (where, what comes out, how long, what to do meanwhile).
const job = (patch: Record<string, unknown> = {}) => ({ status: 'waiting_external', remainingEstimateMs: 45_000, input: 'raw_iron', count: 8, position: { x: 264, y: 36, z: -111 },
  expects: 'iron_ingot×8', from: '東1・下1', completionVerified: false, ...patch });

describe('furnaceLedgerLines', () => {
  it('says where, what goes in and comes out, the seconds, and to go on with another act', () => {
    const [line] = furnaceLedgerLines([job()])!;
    expect(line).toContain('かまど (264,36,-111)（東1・下1）: raw_iron×8 → iron_ingot×8、焼き上がりまであと約 45 秒');
    expect(line).toContain('待たずに別の作業の act を足す');
    expect(line).toContain('furnace 264,36,-111 take の act を足す');
  });
  it('says the time is up (take now), another dimension, and the fuel that is short', () => {
    const lines = furnaceLedgerLines([job({ remainingEstimateMs: 0, status: 'verification_due' }), job({ status: 'different_dimension', position: { x: 1, y: 2, z: 3 }, from: undefined }),
      job({ unfueledInputCount: 3, position: { x: 5, y: 6, z: 7 } })])!;
    expect(lines[0]).toContain('焼き上がりの見込みの時間は来た。furnace 264,36,-111 take の act を足す');
    expect(lines[1]).toBe('かまど (1,2,3): raw_iron×8 → iron_ingot×8。別のディメンションにある');
    expect(lines[2]).toContain('燃料が足りず 3 個は焼けない');
  });
  it('works with a body that does not send the new fields, and gives null for a shape it does not know', () => {
    const [line] = furnaceLedgerLines([{ status: 'waiting_external', remainingEstimateMs: 10_000, input: 'beef', count: 3, position: { x: 1, y: 2, z: 3 } }])!;
    expect(line).toContain('かまど (1,2,3): beef×3、焼き上がりまであと約 10 秒');
    expect(furnaceLedgerLines([{ status: 'x' }])).toBeNull();
    expect(furnaceLedgerLines([])).toBeNull();
    expect(furnaceLedgerLines('furnace')).toBeNull();
  });
});
