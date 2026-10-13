import { afterEach, describe, expect, it } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { taskExperienceHandler } from '../src/mind/memory/taskExperienceHandler.js';
import type { MemoryTargets } from '../src/mind/memory/memoryOps.js';
import type { MemoryOp } from '../src/mind/memory/memoryOpCodec.js';

const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));

describe('a task experience under the write lock (2026-10-13)', () => {
  it('walks its sources once when the owner state did not move between the first check and the locked one, and again when it did', () => {
    const w = memoryWorld(); worlds.push(w);
    let reads = 0;
    const targets = { conversations: w.store, taskExperiences: { recorded: () => false, write: () => true },
      taskSourceVisible: () => { reads++; return true; } } as unknown as MemoryTargets;
    const op = { seq: 41, scopeKey: 'owner', payload: { record: { scopeKey: 'owner', taskId: 'task', outcomeId: 'step', observedAt: w.now(),
      status: 'completed', goal: '空港までの時間', context: '', action: 'web.search', prediction: '', observedResult: '16分', interpretation: '',
      sourceIds: [], readSourceIds: ['notion-page://0123456789abcdef0123456789abcdef'] } } } as unknown as MemoryOp;
    const state = () => w.store.snapshot('owner');
    expect(taskExperienceHandler.blocked!(targets, op, state(), undefined)).toBeNull();
    expect(reads).toBe(1);
    expect(taskExperienceHandler.blocked!(targets, op, state(), undefined)).toBeNull(); // under the lock, nothing moved
    expect(reads).toBe(1);
    expect(taskExperienceHandler.blocked!(targets, op, state(), undefined)).toBeNull(); // a later check walks again
    expect(reads).toBe(2);
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'other', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.now(), changeReason: 'owner' } });
    taskExperienceHandler.blocked!(targets, op, state(), undefined); // the owner's state moved: walked again
    expect(reads).toBe(3);
  });
});
