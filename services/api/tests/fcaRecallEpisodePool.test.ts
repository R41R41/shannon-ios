import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from './support/fcaDenseWorld.js';
import { SQLiteTaskExperiences } from '../src/mind/memory/store/taskExperiences.js';
import { taskExperienceId } from '../src/mind/memory/taskExperience.js';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../src/mind/recall/taskRecallPorts.js';

/**
 * Production run 15 (2026-10-19, 08:02-08:32Z): the first stretch of every decision of a Minecraft body task held the API's thread 2.5 s
 * at the run's start and 8.8 s by its end, and its recall packet another 3-6 s (31% of the run blocked). The remembered turns then held
 * 226 body-task episodes with one goal, each recalling 187-212 ids of one closed pool (mostly the earlier episodes): every walk of an
 * item's sources (`TaskMemory.sources`) queued ~44,000 edges and took them off the front with `shift()`, which moves the whole queue
 * each time. Offline (`tests/perf/recallStallBench.ts`, WSL) at 225 episodes: the recall's start 1,688 ms and its packet 488 ms before,
 * 73 ms and 21 ms after. The walk now reads its queue by an index; what it finds, and in which order, is the same.
 */
const GOAL = 'Minecraft でエンダードラゴンを討伐する。木を集めて道具を作り、夜に備え、鉄とダイヤを集める。';
let dense: ReturnType<typeof fcaDenseWorld>;
let memory: ReturnType<typeof createTaskMemory>;
const episodes: string[] = [];

beforeAll(() => {
  dense = fcaDenseWorld({ ordinary: 240, episodes: 20 });
  const writer = new SQLiteTaskExperiences(dense.world.store.fcaDatabase());
  const others = dense.ordinary.slice(100, 137);
  for (let index = 0; index < 90; index++) {
    dense.world.advance(60_000);
    const record = { scopeKey: 'owner', taskId: `body-task-${Math.floor(index / 8)}`, outcomeId: `segment-${index}`, observedAt: dense.world.now(),
      status: 'success' as const, goal: GOAL, context: `文脈${index}`, action: `行動${index}`, prediction: `予想${index}`, observedResult: `観測${index}`,
      interpretation: `解釈${index}`, sourceIds: [...others, ...episodes.slice(-75)], readSourceIds: dense.skillSources.slice(0, 20 + (index % 6)) };
    writer.write('owner', record);
    episodes.push(taskExperienceId('owner', record.taskId, record.outcomeId));
  }
  memory = createTaskMemory({ state: dense.world.store, conversations: dense.world.store, ownerScope: 'owner', ownerAlone: () => true,
    now: () => dense.world.now(), readSourceVisible: dense.readSourceVisible });
}, 120_000);
afterAll(async () => { await dense?.close(); });

/** The walk as it was before (breadth first, the queue shifted), over remembered turns only: the order its list must keep. */
function shiftedWalk(ids: readonly string[]): string[] {
  const found = new Set<string>(), pending = [...ids];
  while (pending.length) {
    const id = pending.shift()!;
    if (found.has(id)) continue;
    found.add(id);
    pending.push(...dense.world.store.experiencesById!('owner', [id])[0]?.recalledMemoryIds ?? []);
  }
  return [...found];
}

describe("a body task's episode pool", () => {
  it('lists the same sources in the same order as the shifted walk', () => {
    const snapshot = memory.readSnapshot!('owner');
    for (const ids of [[episodes.at(-1)!], [episodes[40]!, episodes.at(-1)!], [dense.ordinary[5]!, episodes[3]!, 'missing-id'], episodes.slice(-8)]) {
      const expected = shiftedWalk(ids);
      expect(memory.sources('owner', ids, snapshot)).toEqual(expected);
      expect(memory.sources('owner', ids)).toEqual(expected);
    }
    expect(shiftedWalk([episodes.at(-1)!]).length).toBeGreaterThan(100);
  });

  it('gives a recall packet whose items carry the shifted walk of their own sources', async () => {
    const recall = createTaskRecall({ state: dense.world.store, conversations: dense.world.store, memory, enrich: null, now: () => dense.world.now() });
    const input = { scopeKey: 'owner', taskId: 'task-1', contextVersion: 'v1', cue: `${GOAL}\n木を集めた。`, present: OWNER_AUDIENCE, semantic: false };
    recall.start(input);
    const packet = await recall.packet(input, { waitMilliseconds: 0 });
    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.items.some(item => episodes.includes(item.id))).toBe(true);
    // The reference walks remembered turns only (a thread, a document or a fact has edges of its own: `fcaLoopStallBounds.test.ts`).
    expect(packet.items.filter(item => !dense.world.store.experiencesById!('owner', [item.id]).length).map(item => item.id)).toEqual([]);
    expect(packet.sourceIds).toEqual(shiftedWalk(packet.items.map(item => item.id)));
    for (const item of memory.read('owner', packet.items.map(entry => entry.id), OWNER_AUDIENCE)) {
      expect(item.provenance?.sourceIds).toEqual(shiftedWalk([item.id]));
    }
  });

  it('never shifts a long queue, which moves the whole of it each time', () => {
    const original = Array.prototype.shift;
    let shifts = 0;
    // Only arrays this long count: what moving them costs is the stall; a short one shifted anywhere underneath is not.
    Array.prototype.shift = function (this: unknown[]) { if (this.length >= 1_000) shifts += 1; return original.call(this); };
    try { memory.sources('owner', episodes.slice(-8)); } finally { Array.prototype.shift = original; }
    expect(shifts).toBe(0);
  });
});
