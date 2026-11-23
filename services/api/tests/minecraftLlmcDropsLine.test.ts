import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { dropsLine, withDrops } from '../src/surfaces/minecraft/minecraftLlmcDropsLine.js';

const frame = (nearbyEntities: unknown[]): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { nearbyEntities } as never } });
const result = (text: string) => ({ ok: true, text }) as never;

describe('the drops a kill leaves, named in its result (11/24)', () => {
  const near = [{ name: 'item', id: 20172, distance: 2.4, item: 'rotten_flesh' }, { name: 'item', id: 20173, distance: 12, item: 'bone' },
    { name: 'item', id: 20174, distance: 3, droppedByMe: true, item: 'dirt' }, { name: 'cow', id: 9, distance: 4 }];
  it('lists the drops within 8 m, not the far ones, not what she threw, not the creatures', () => {
    const line = dropsLine(frame(near))!;
    expect(line).toContain('#20172');
    expect(line).not.toContain('#20173');
    expect(line).not.toContain('#20174');
    expect(line).toContain('自動では拾わない');
    expect(dropsLine(frame([]))).toBeNull();
  });
  it('adds the line to a result that says it killed, and leaves other results as they are', () => {
    expect(withDrops(result('倒した（3回振って 8秒）'), frame(near)).text).toContain('落とし物（近く）');
    expect(withDrops(result('届かなかった'), frame(near)).text).toBe('届かなかった');
    expect(withDrops(result('倒した（3回振って 8秒）'), frame([])).text).toBe('倒した（3回振って 8秒）');
  });
});
