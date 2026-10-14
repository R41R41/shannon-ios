import { afterEach, describe, expect, it } from 'vitest';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../src/mind/recall/taskRecallPorts.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * The shared withholding of one read (Minecraft run 6) changes no privacy verdict: every remembered turn, every task memory read,
 * every FCA recall packet and every turn context is judged as by the separate reads of before (each read receipt asked of the
 * native reader with a freshly read state), at baseline and after a forget, a correction, a skill withdrawal and with others present.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function verdicts(f: Run6RecallShape, shared: boolean) {
  const store = f.world.store, reader = f.readSourceVisible;
  // Before: the reader was asked without the read's state, withholding or walk, and read the state again for every receipt.
  const readSourceVisible = shared ? reader : (scope: string, id: string, at: string) => reader(scope, id, at);
  store.readSourceVisible = readSourceVisible;
  try {
    const memory = createTaskMemory({ state: store, conversations: shared ? store : withoutChangeMark(store),
      ownerScope: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, readSourceVisible });
    const recall = createTaskRecall({ state: store, conversations: store, memory: shared ? memory : { ...memory, readSnapshot: undefined }, enrich: null, now: f.world.now });
    const state = store.snapshot('owner');
    const candidates = store.experienceCandidates('owner');
    const withholding = new MemoryWithholding(state, store, 'owner', candidates);
    const perTurn = shared ? withholding.withReadSnapshot(() => candidates.map(item => withholding.withholdsExperience(item)))
      : candidates.map(item => new MemoryWithholding(state, store, 'owner', candidates).withholdsExperience(item));
    const ids = [...f.tasks, ...f.turns.slice(-200)];
    const read = memory.read('owner', ids.slice(0, 40), f.present).map(item => item.id);
    const searched = memory.search('owner', '調べもの', f.present, 12).map(item => item.id);
    const context = prepareTurnCognitiveContext(state, store, { scopeKey: 'owner', message: '調べもの12の結果を覚えてる？', occurredAt: f.world.now(),
      channel: 'text', present: f.present, threadId: 'thread-1' }).memories.map(item => item.id);
    return { perTurn, read, searched, context, recall };
  } finally { store.readSourceVisible = reader; }
}
/** The store as a read of before saw it: no change mark, so nothing is kept between reads. */
function withoutChangeMark<T extends object>(store: T): T {
  return new Proxy(store, { get: (target, key) => {
    if (key === 'changeMark') return undefined;
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function packet(recall: ReturnType<typeof verdicts>['recall'], f: Run6RecallShape, round: string) {
  const input = { scopeKey: 'owner', taskId: `task-${round}`, contextVersion: round, cue: '調べもの12の結果', present: f.present, semantic: false };
  recall.start(input);
  const value = await recall.packet(input);
  return { status: value.status, items: value.items.map(item => item.id), sources: value.sourceIds };
}
async function compare(f: Run6RecallShape, round: string) {
  const before = verdicts(f, false), after = verdicts(f, true);
  expect(after.perTurn).toEqual(before.perTurn);
  expect(after.read).toEqual(before.read);
  expect(after.searched).toEqual(before.searched);
  expect(after.context).toEqual(before.context);
  expect(await packet(after.recall, f, `${round}-a`)).toEqual(await packet(before.recall, f, `${round}-b`));
  return after;
}

describe('the shared withholding of one read', () => {
  it('gives the verdicts of separate reads at baseline, after a forget, a correction and a skill withdrawal, and with others present', async () => {
    const f = run6RecallShape({ turns: 300, recallingTurns: 30, tasks: 24 }); cleanups.push(() => f.close());
    const baseline = await compare(f, 'baseline');
    expect(baseline.perTurn.filter(Boolean).length).toBeGreaterThan(0);
    expect(baseline.read.length).toBeGreaterThan(0);

    f.memoryService.mutate('owner', { memoryId: f.tasks[3]!, action: 'forget' });
    const forgotten = await compare(f, 'forget');
    expect(forgotten.read).not.toContain(f.tasks[3]);
    expect(forgotten.perTurn.filter(Boolean).length).toBeGreaterThan(baseline.perTurn.filter(Boolean).length);

    f.memoryService.mutate('owner', { memoryId: f.tasks[5]!, action: 'correct', text: '調べもの5は別の結果だった' });
    await compare(f, 'correct');

    const read = f.skillSources[2]!;
    const skillId = decodeURIComponent(/^shannon-skill:\/\/([^/]+)\//u.exec(read)![1]!);
    expect(f.skillMemory.retire('owner', skillId, 'owner_request', f.world.now())).toBe(true);
    const withdrawn = await compare(f, 'withdrawn');
    expect(withdrawn.perTurn.filter(Boolean).length).toBeGreaterThan(forgotten.perTurn.filter(Boolean).length);

    f.setAlone(false);
    const others = await compare(f, 'others');
    expect(others.read).toEqual([]);
  }, 300_000);
});
