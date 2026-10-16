import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from '../src/mind/memory/conversationContract.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { deepWalk, settleDeepChains } from '../src/mind/memory/recallChainDepth.js';

const at = '2026-10-09T00:00:00.000Z';
/**
 * One long chain: every turn recalled only the turn before it (a game chat that goes on for days). The first turn read a source;
 * `cycle` makes that first turn recall the last one.
 */
function chain(depth: number, options: { cycle?: boolean } = {}) {
  let visible = true;
  const rows = new Map<string, ShannonExperience>();
  const time = (index: number) => new Date(Date.parse(at) + index * 1000).toISOString();
  for (let index = 0; index < depth; index += 1) {
    const recalled = index ? [`episode-${index - 1}`] : options.cycle ? [`episode-${depth - 1}`] : undefined;
    rows.set(`episode-${index}`, { id: `episode-${index}`, observedAt: time(index), summary: `chat ${index}`, userMessage: 'hello', shannonReply: 'hi',
      ...(index === 0 ? { readSourceIds: ['aether-document://original'] } : {}), ...(recalled ? { recalledMemoryIds: recalled } : {}) });
  }
  const root = `episode-${depth - 1}`, observedAt = time(depth);
  const state = new InMemoryCompanionStateStore(() => observedAt);
  const store = {
    experienceCandidates: () => [...rows.values()],
    experiencesById: (_scope: string, ids: readonly string[]) => ids.flatMap(id => rows.has(id) ? [rows.get(id)!] : []),
    threadSummaryLineage: () => ({ messages: [{ id: 'message', sourceExperienceId: root, role: 'assistant' as const, content: 'summary', observedAt, recalledMemoryIds: [root] }], updatedAt: observedAt }),
    readSourceVisible: () => visible,
    hasReadSourceProvenance: () => true,
  } as unknown as ConversationStore;
  const reader = () => new MemoryWithholding(state.snapshot('owner'), store, 'owner');
  const task = () => createTaskMemory({ state, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => observedAt,
    readSourceVisible: store.readSourceVisible }).read('owner', [root], OWNER_AUDIENCE).length;
  return { root, observedAt, reader, task, visible(value: boolean) { visible = value; } };
}

describe('a long chain of turns that each recalled the one before', () => {
  // 2026-10-17: past ~2,000 the walks overflowed the stack and every game-chat turn failed with a bare RangeError.
  for (const depth of [3000, 4500]) {
    it(`is judged at ${depth} turns as it is at a few`, () => {
      const f = chain(depth);
      expect(f.reader().withholdsReply({ text: 'x', observedAt: f.observedAt, recalledMemoryIds: [f.root] })).toBe(false);
      expect(f.reader().withholdsThreadSummary('thread')).toBe(false);
      expect(f.task()).toBe(1);
      f.visible(false);
      expect(f.reader().withholdsReply({ text: 'x', observedAt: f.observedAt, recalledMemoryIds: [f.root] })).toBe(true);
      expect(f.reader().withholdsThreadSummary('thread')).toBe(true);
      expect(f.task()).toBe(0);
    });
  }
  it('still treats a cycle as withheld', () => {
    const f = chain(3000, { cycle: true });
    expect(f.reader().withholdsReply({ text: 'x', observedAt: f.observedAt, recalledMemoryIds: [f.root] })).toBe(true);
    expect(f.task()).toBe(0);
  });
  it('answers a chain at the walks\' own bound with their cautious result', () => {
    const f = chain(5200);
    expect(f.reader().withholdsReply({ text: 'x', observedAt: f.observedAt, recalledMemoryIds: [f.root] })).toBe(true);
    expect(f.task()).toBe(0);
  });
});

describe('settleDeepChains', () => {
  it('warms children before parents, only above the settle height, without recursion', () => {
    const edges = new Map<string, string[]>(); for (let i = 1; i < 20_000; i += 1) edges.set(`n${i}`, [`n${i - 1}`]);
    const warmed: string[] = [];
    expect(settleDeepChains(['n4000'], id => edges.get(id) ?? [], id => warmed.push(id))).toBe('ok');
    expect(warmed[0]).toBe('n200'); expect(warmed.at(-1)).toBe('n4000'); expect(warmed).toHaveLength(3801);
    expect(settleDeepChains(['n9000'], id => edges.get(id) ?? [], () => {})).toBe('too_deep');
  });
  it('leaves a walk that does not overflow alone, and rethrows other errors', () => {
    expect(deepWalk(() => 7, () => { throw new Error('not called'); }, 0)).toBe(7);
    expect(() => deepWalk(() => { throw new TypeError('x'); }, () => 'ok', 0)).toThrow(TypeError);
  });
});
