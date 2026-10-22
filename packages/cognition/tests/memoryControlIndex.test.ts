import { describe, expect, it } from 'vitest';
import { indexedMemoryControlFor as memoryControlFor, memoryControlFor as scanned } from '../src/memory.js';
import type { CompanionStateSnapshot } from '../src/types.js';

/**
 * mb-llmc r8 (run 32: 66,674 read-receipt answers in a minute, each finding its controls by a scan of all of them): a snapshot's controls are
 * read once into an index, and every id is answered as the scan answered it (the first control of an id), for a short list and a long one.
 */
const control = (memoryId: string, status: 'active' | 'forgotten' = 'active', order = 0) => ({ memoryId, kind: 'experience', status, pinned: false,
  updatedAt: `2026-10-22T00:00:${String(order % 60).padStart(2, '0')}.000Z`, changeReason: `c${order}` });
const snapshot = (controls: ReturnType<typeof control>[]) => ({ memoryControls: Object.freeze(controls) }) as unknown as CompanionStateSnapshot;

describe('memoryControlFor', () => {
  it('answers as a scan does, short or long: the first control of an id, none for an id with none', () => {
    for (const size of [0, 3, 11, 12, 13, 400]) {
      const controls = Array.from({ length: size }, (_, index) => control(`m${index % Math.max(1, Math.floor(size / 2))}`, index % 3 === 0 ? 'forgotten' : 'active', index));
      const state = snapshot(controls);
      for (const id of [...new Set(controls.map(item => item.memoryId)), 'none', 'm999']) {
        expect(memoryControlFor(state, id)).toBe(controls.find(item => item.memoryId === id));
        expect(scanned(state, id)).toBe(memoryControlFor(state, id));
      }
    }
  });

  it('a new list is a new index: a state change makes a new list, and the old snapshot keeps its answers', () => {
    const before = Array.from({ length: 30 }, (_, index) => control(`m${index}`, 'active', index));
    const old = snapshot(before);
    expect(memoryControlFor(old, 'm5')!.status).toBe('active');
    const after = snapshot([control('m5', 'forgotten', 99), ...before.filter(item => item.memoryId !== 'm5')]);
    expect(memoryControlFor(after, 'm5')!.status).toBe('forgotten');
    expect(memoryControlFor(old, 'm5')!.status).toBe('active');
  });

  it('is much quicker than the scan on a long list asked many times', () => {
    const controls = Array.from({ length: 400 }, (_, index) => control(`memory-${index}`, 'active', index));
    const state = snapshot(controls);
    memoryControlFor(state, 'memory-399');
    const started = performance.now();
    for (let index = 0; index < 60_000; index++) memoryControlFor(state, `memory-${index % 400}`);
    const indexed = performance.now() - started;
    const scanStarted = performance.now();
    for (let index = 0; index < 60_000; index++) controls.find(item => item.memoryId === `memory-${index % 400}`);
    const scanned = performance.now() - scanStarted;
    expect(indexed).toBeLessThan(scanned);
  });
});
