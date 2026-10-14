import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { TASK_EXPERIENCE_SOURCE_VERDICT_MS, taskExperienceHandler } from '../src/mind/memory/taskExperienceHandler.js';
import type { MemoryTargets } from '../src/mind/memory/memoryOps.js';
import type { MemoryOp } from '../src/mind/memory/memoryOpCodec.js';

const worlds: ReturnType<typeof memoryWorld>[] = [];
afterEach(() => { worlds.splice(0).forEach(world => world.close()); vi.restoreAllMocks(); });

let clock = Date.parse('2026-10-14T05:00:00.000Z');
function fixture(visible: (id: string) => boolean = () => true) {
  const w = memoryWorld(); worlds.push(w);
  let reads = 0;
  const targets = { conversations: w.store, taskExperiences: { recorded: () => false, write: () => true },
    taskSourceVisible: (_scope: string, id: string) => { reads++; return visible(id); } } as unknown as MemoryTargets;
  // Each fixture its own window: the reuse is per process and keyed by the owner state, which every fresh world starts alike.
  clock += 10 * TASK_EXPERIENCE_SOURCE_VERDICT_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  return { w, targets, reads: () => reads, state: () => w.store.snapshot('owner') };
}
let seq = 40;
const opOf = (w: ReturnType<typeof memoryWorld>, outcome: string, options: { observedAt?: string; readSourceIds?: string[]; sourceIds?: string[]; goal?: string } = {}) => ({
  seq: ++seq, scopeKey: 'owner', payload: { record: { scopeKey: 'owner', taskId: 'task', outcomeId: outcome, observedAt: options.observedAt ?? w.now(),
    status: 'completed', goal: options.goal ?? '空港までの時間', context: '', action: 'web.search', prediction: '', observedResult: '16分', interpretation: '',
    sourceIds: options.sourceIds ?? [], readSourceIds: options.readSourceIds ?? ['notion-page://0123456789abcdef0123456789abcdef'] } } }) as unknown as MemoryOp;

describe('a task experience under the write lock (2026-10-13)', () => {
  it('walks its sources once when the owner state did not move between the first check and the locked one, and again when it did', () => {
    const f = fixture(), op = opOf(f.w, 'step');
    expect(taskExperienceHandler.blocked!(f.targets, op, f.state(), undefined)).toBeNull();
    expect(f.reads()).toBe(1);
    expect(taskExperienceHandler.blocked!(f.targets, op, f.state(), undefined)).toBeNull(); // under the lock, nothing moved
    expect(f.reads()).toBe(1);
    f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'other', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: f.w.now(), changeReason: 'owner' } });
    taskExperienceHandler.blocked!(f.targets, op, f.state(), undefined); // the owner's state moved: walked again
    expect(f.reads()).toBe(2);
  });
});

describe('the outcomes of one step share their sources\' verdict (Minecraft run 7, 2026-10-14)', () => {
  it('reuses a clear verdict for another op with the same sources, observed no earlier, under the same state, within the window', () => {
    const f = fixture(), first = opOf(f.w, 'call-a');
    expect(taskExperienceHandler.blocked!(f.targets, first, f.state(), undefined)).toBeNull();
    expect(f.reads()).toBe(1);
    f.w.advance(2_000);
    // Another outcome of the same step, its words different: the sources are not walked again, the words are still judged.
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'call-b', { goal: '別の言葉' }), f.state(), undefined)).toBeNull();
    expect(f.reads()).toBe(1);
    // Observed before the verdict's time: walked (an earlier time can be withheld where a later one is not).
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'call-c', { observedAt: '2026-10-07T02:00:00.000Z' }), f.state(), undefined)).toBeNull();
    expect(f.reads()).toBe(2);
    // Other sources: walked.
    taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'call-d', { readSourceIds: ['notion-page://fedcba9876543210fedcba9876543210'] }), f.state(), undefined);
    expect(f.reads()).toBe(3);
    // After the window: walked.
    clock += TASK_EXPERIENCE_SOURCE_VERDICT_MS;
    taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'call-e'), f.state(), undefined);
    expect(f.reads()).toBe(4);
  });

  it('never reuses a withheld verdict, and judges each op\'s own words and the owner\'s controls afresh', () => {
    const f = fixture(id => !id.includes('fedcba'));
    const hidden = { readSourceIds: ['notion-page://fedcba9876543210fedcba9876543210'] };
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'hidden-a', hidden), f.state(), undefined)).toBe('source_withheld');
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'hidden-b', hidden), f.state(), undefined)).toBe('source_withheld');
    expect(f.reads()).toBe(2);
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'clear-a'), f.state(), undefined)).toBeNull();
    // A forget is a new state: the same sources are walked again, and the recalled id it withholds is found.
    const recalled = f.w.store.appendTurn('owner', 'thread', '質問', '返答', f.w.now(), { capturedStateVersion: 0,
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' } }).id;
    const withSource = { sourceIds: [recalled] };
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'clear-b', withSource), f.state(), undefined)).toBeNull();
    f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: recalled, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: f.w.now(), changeReason: 'owner' } });
    expect(taskExperienceHandler.blocked!(f.targets, opOf(f.w, 'clear-c', withSource), f.state(), undefined)).toBe('forgotten');
  });
});
