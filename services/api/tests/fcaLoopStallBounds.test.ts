import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from './support/fcaDenseWorld.js';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { writeMemoryControl } from './support/memoryControls.js';
import type { TaskSource } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Two things the loop-stall change must leave as they were. (1) A task memory read fails closed for an item whose sources reach more than
 * 5,000 distinct ids (`TASK_MEMORY_LINEAGE_LIMIT`, a bound of the walk that lists them): the read that does not list them
 * (`{ provenance: false }`, what the source guard asks) keeps the bound, counted over the same edges. (2) What the guard keeps for its
 * receipts for the length of an epoch (`FCA_MEMORY_EPOCH_MS`) follows the database, not the clock: it is dropped when the database changes.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const runtimeStub = { taskSources: () => [], get: () => null } as never;

describe('the bound on the sources of one remembered item is kept when they are not listed', () => {
  /** Turns that recall each other in three levels of at most 30 (leaves, hubs, supers), and two tops over them with 5,000 and 5,001 ids behind. */
  function wideWorld() {
    const world = memoryWorld(), store = world.store;
    const add = (label: string, recalled: string[]) => { world.advance(1000); return store.appendTurn('owner', 'thread-0', `質問${label}`, `返答${label}`, world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recalled }).id; };
    const leaves = Array.from({ length: 4832 }, (_, index) => add(`leaf${index}`, []));
    const hubs = Array.from({ length: Math.ceil(leaves.length / 30) }, (_, index) => add(`hub${index}`, leaves.slice(index * 30, index * 30 + 30)));
    const supers = Array.from({ length: Math.ceil(hubs.length / 30) }, (_, index) => add(`super${index}`, hubs.slice(index * 30, index * 30 + 30)));
    // 1 + 6 + 162 + 4,832 = 5,001 ids; without the last super (its hubs recalled directly) 5,000.
    const over = add('over', supers), edge = add('edge', [...supers.slice(0, -1), ...hubs.slice(30 * (supers.length - 1))]);
    const reach = (top: string) => {
      const found = new Set<string>(), pending = [top];
      while (pending.length) { const id = pending.pop()!; if (found.has(id)) continue; found.add(id); pending.push(...store.experiencesById('owner', [id])[0]?.recalledMemoryIds ?? []); }
      return found.size;
    };
    return { world, store, over, edge, reach };
  }

  it('fails closed above 5,000 reachable ids and not at 5,000, as a read that lists the sources does, and so does the source guard', () => {
    const { world, store, over, edge, reach } = wideWorld(); cleanups.push(() => world.close());
    expect(reach(over)).toBe(5001);
    expect(reach(edge)).toBe(5000);
    const now = () => new Date(world.clock.at + 1000).toISOString();
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now });
    const outcome = (top: string, options?: { provenance?: boolean }) => {
      try { const items = memory.read('owner', [top], OWNER_AUDIENCE, undefined, options); return `${items.length} items${items[0]?.provenance ? ` over ${items[0].provenance.sourceIds.length} ids` : ''}`; }
      catch (error) { return `throws ${(error as Error).message}`; }
    };
    expect(outcome(over)).toBe('throws TASK_MEMORY_LINEAGE_LIMIT');
    expect(outcome(over, { provenance: false })).toBe('throws TASK_MEMORY_LINEAGE_LIMIT');
    expect(outcome(edge)).toBe('1 items over 5000 ids');
    expect(outcome(edge, { provenance: false })).toBe('1 items');
    // Asked together with others (a chunk of the guard's walk) the read fails as a whole, as it did.
    expect(() => memory.read('owner', [edge, over], OWNER_AUDIENCE, undefined, { provenance: false })).toThrow('TASK_MEMORY_LINEAGE_LIMIT');
    // The guard fails closed on the wide lineage and passes the one at the bound.
    const guard = createFcaSourceGuard({ runtime: runtimeStub, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, log: () => {} });
    const task = { id: 't', scopeKey: 'owner', parentId: null, kind: 'conversation', origin: 'owner_request', title: 'x', goal: 'g', completionCriteria: 'c', summary: '', status: 'running',
      pauseReason: null, revision: 1, createdAt: now(), updatedAt: now(), phase: 'executing', childIds: [] } as never;
    const row = (id: string) => ({ kind: 'memory', stepId: `s-${id}`, experienceId: null, threadId: null, observedAt: now(), recalledMemoryIds: [id], readSourceIds: [] }) as unknown as TaskSource;
    expect(guard.sources('owner', task, [row(over)])).toBe(false);
    expect(guard.sources('owner', task, [row(edge)])).toBe(true);
  }, 120_000);
});

describe('the bound counted without listing agrees with the walk that lists, edge for edge', () => {
  it('for every kind of id (turn, episode, thread, knowledge, fact), corrected or not, at limits that some ids pass and some do not, alone and in one shared read', () => {
    const world = fcaDenseWorld({ ordinary: 80, episodes: 16, skills: 2, seed: 4 }); cleanups.push(() => world.close());
    const store = world.world.store;
    const at = () => new Date(world.world.clock.at).toISOString();
    // Knowledge from several turns, facts standing on a turn and on an episode, and corrections: of a turn that recalls others (its sources are still
    // walked, though the lineage stops at it), of a fact (its source is not), and of a knowledge document's source.
    const knowledge = [0, 1, 2].map(index => store.createShannonKnowledge('owner', { title: `知識${index}`, bodyMarkdown: `本文${index}`, status: 'confirmed', applicability: '全般',
      sourceExperienceIds: world.ordinary.slice(10 + index * 7, 13 + index * 7) } as never, at(), 'test').id);
    const fact = (id: string, source: string | undefined) => store.apply('owner', { type: 'user-fact-upserted', source: 'sleep', fact: { id, statement: `事実${id}`, confidence: 0.8,
      observedAt: at(), evidence: `根拠${id}`, ...(source ? { sourceExperienceId: source } : {}), disclosure: { audience: { kind: 'owner' }, sensitivity: 'sensitive', category: 'work', decidedBy: 'rule' } } } as never);
    fact('fact-a', world.ordinary[60]); fact('fact-b', world.episodes.at(-3)); fact('fact-c', undefined);
    const withRecall = store.experienceCandidates('owner').filter(turn => (turn.recalledMemoryIds?.length ?? 0) > 2).map(turn => turn.id);
    expect(withRecall.length).toBeGreaterThan(5);
    world.world.advance(60_000);
    for (const memoryId of [withRecall[1]!, withRecall[4]!, 'fact-b']) writeMemoryControl(store, at(), memoryId, 'correct', { text: `直した本文${memoryId.slice(0, 6)}`, kind: memoryId.startsWith('fact') ? 'user-fact' : 'experience' });
    const ids = [...world.ids, ...knowledge.map(id => `knowledge:${id}`), 'thread:thread-0', 'thread:thread-1', 'fact-a', 'fact-b', 'fact-c'];
    const now = () => new Date(world.world.clock.at + 1000).toISOString();
    let throws = 0, passes = 0, limitsThatThrow = 0;
    for (const sourceWalkLimit of [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 5000]) {
      const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now, readSourceVisible: world.readSourceVisible, sourceWalkLimit });
      const outcome = (subset: readonly string[], options?: { provenance?: boolean }, shared?: Parameters<typeof memory.read>[3]) => {
        try { return memory.read('owner', subset, OWNER_AUDIENCE, shared, options).map(item => item.id); } catch (error) { return `throws ${(error as Error).message}`; }
      };
      const listed = ids.map(id => outcome([id])), plain = ids.map(id => outcome([id], { provenance: false }));
      expect(plain).toEqual(listed);
      const over = listed.filter(result => typeof result === 'string').length;
      throws += over; passes += listed.length - over;
      if (over > 0) limitsThatThrow += 1;
      // One shared read (the memos of one scope: edges and which start ids are over the bound) gives the same, in this order and the reverse.
      for (const order of [ids, [...ids].reverse()]) {
        const shared = memory.readSnapshot!('owner');
        const together = shared.withholding.withReadSnapshot(() => order.map(id => outcome([id], { provenance: false }, shared)));
        const alone = order.map(id => listed[ids.indexOf(id)]);
        expect(together).toEqual(alone);
      }
      // And a chunk of several ids at once.
      for (let offset = 0; offset + 25 <= ids.length; offset += 25) {
        const chunk = ids.slice(offset, offset + 25);
        expect(outcome(chunk, { provenance: false })).toEqual(outcome(chunk));
      }
    }
    // What the walk goes through is pinned too (the count and the list use one edge function; this holds it to what the walk always went through).
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now, readSourceVisible: world.readSourceVisible });
    const reach = (id: string, found = new Set<string>()): Set<string> => {
      if (found.has(id)) return found;
      found.add(id);
      for (const next of store.experiencesById('owner', [id])[0]?.recalledMemoryIds ?? []) reach(next, found);
      return found;
    };
    const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
    expect(memory.sources('owner', ['fact-a']).sort(), 'a fact reaches its turn and what that recalled').toEqual(sorted(['fact-a', ...reach(world.ordinary[60]!)]));
    expect(memory.sources('owner', ['fact-b']), 'a corrected fact does not reach its source').toEqual(['fact-b']);
    expect(store.experiencesById('owner', [withRecall[1]!])[0]!.recalledMemoryIds!.length).toBeGreaterThan(2);
    expect(memory.sources('owner', [withRecall[1]!]).sort(), 'a corrected turn still reaches what it recalled').toEqual(sorted(reach(withRecall[1]!)));
    const document = store.listShannonKnowledge('owner').find(row => row.id === knowledge[0])!;
    expect(memory.sources('owner', [`knowledge:${document.id}`]).sort(), 'a knowledge document reaches its turns and theirs')
      .toEqual(sorted([`knowledge:${document.id}`, ...document.sourceExperienceIds.flatMap(id => [...reach(id)])]));
    expect(memory.sources('owner', ['thread:thread-0']).length, 'a thread reaches the turns behind its messages').toBeGreaterThan(10);
    expect(throws, 'reads that exceed a limit').toBeGreaterThan(20);
    expect(limitsThatThrow, 'limits that some read exceeds').toBeGreaterThan(3);
    expect(passes, 'reads that stay within it').toBeGreaterThan(100);
  });
});

describe('what the guard keeps for its receipts for an epoch follows the database', () => {
  it('gives the verdicts a guard made afresh gives, across turns, knowledge, a retired skill and a forget made inside one epoch window', () => {
    const world = fcaDenseWorld({ ordinary: 90, episodes: 10, skills: 3, seed: 9 }); cleanups.push(() => world.close());
    const store = world.world.store;
    const task = { id: 't', scopeKey: 'owner', parentId: null, kind: 'conversation', origin: 'owner_request', title: 'x', goal: 'g', completionCriteria: 'c', summary: '', status: 'running',
      pauseReason: null, revision: 1, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', phase: 'executing', childIds: [] } as never;
    const make = (clock?: () => number) => createFcaSourceGuard({ runtime: runtimeStub, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: world.readSourceVisible, log: () => {}, ...(clock ? { clock } : {}) });
    // One clock that never moves: the epoch (and every verdict) is always inside its window, so only the database can end it.
    const frozen = () => 1_000, kept = make(frozen);
    let step = 0;
    const row = (recalled: string[], reads: string[]) => ({ kind: 'memory', stepId: `s${++step}`, experienceId: null, threadId: null, observedAt: world.world.now(), recalledMemoryIds: recalled, readSourceIds: reads }) as unknown as TaskSource;
    const compare = (label: string, rows: TaskSource[], expected: boolean) => {
      expect(make(frozen).sources('owner', task, rows), `${label}: a guard made afresh`).toBe(expected);
      expect(kept.sources('owner', task, rows), `${label}: the guard kept across the events`).toBe(expected);
    };
    const [turnA, turnB] = world.ordinary.slice(20, 22) as [string, string], [skill0, skill1] = world.skillSources;
    compare('baseline', [row([turnA], [skill0!])], true);
    // A turn appended inside the window that recalls a turn: readable at once.
    world.world.advance(1_000);
    const added = store.appendTurn('owner', 'thread-0', '足した話', '足した返事', world.world.now(), { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: [turnA] }).id;
    compare('a turn appended', [row([added], [])], true);
    // Knowledge made from it, then retired.
    const document = store.createShannonKnowledge('owner', { title: '知識', bodyMarkdown: '本文', status: 'confirmed', applicability: '全般', sourceExperienceIds: [added] } as never, world.world.now(), 'test');
    compare('knowledge made', [row([`knowledge:${document.id}`], [])], true);
    store.retireShannonKnowledge('owner', document.id, 'test', world.world.now());
    compare('knowledge retired', [row([`knowledge:${document.id}`], [])], false);
    // A skill retired: its receipt is gone for the next check.
    const skillId = decodeURIComponent(/^shannon-skill:\/\/([^/]+)/u.exec(skill1!)![1]!);
    compare('a skill before it is retired', [row([turnB], [skill1!])], true);
    expect(world.memory.retire('owner', skillId, 'test', world.world.now())).toBe(true);
    compare('a skill retired', [row([turnB], [skill1!])], false);
    // A forget made inside the window.
    compare('a turn before it is forgotten', [row([turnB], [skill0!])], true);
    world.world.advance(1_000);
    writeMemoryControl(store, world.world.now(), turnB, 'forget', { evidence: store.experienceCandidates('owner').find(turn => turn.id === turnB)?.userMessage ?? '' });
    compare('a turn forgotten', [row([turnB], [skill0!])], false);
    compare('a turn that recalled the forgotten one', [row([store.appendTurn('owner', 'thread-0', 'また足した話', 'また足した返事', world.world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: [turnB] }).id], [])], false);
  });

  it('asks the store for a receipt\'s turn again after the database changed, and not before', () => {
    const world = fcaDenseWorld({ ordinary: 40, episodes: 4, skills: 2, seed: 2 }); cleanups.push(() => world.close());
    const store = world.world.store, original = store.experiencesById.bind(store);
    let asked = 0;
    store.experiencesById = ((...args: Parameters<typeof original>) => { asked += 1; return original(...args); }) as typeof original;
    const task = { id: 't', scopeKey: 'owner', parentId: null, kind: 'conversation', origin: 'owner_request', title: 'x', goal: 'g', completionCriteria: 'c', summary: '', status: 'running',
      pauseReason: null, revision: 1, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', phase: 'executing', childIds: [] } as never;
    const guard = createFcaSourceGuard({ runtime: runtimeStub, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: world.readSourceVisible, log: () => {}, clock: () => 1_000 });
    let step = 0;
    // Rows that recall nothing and read one receipt: the only ids the epoch's receipt withholding looks up are the receipt's own.
    const check = () => { const before = asked; guard.sources('owner', task, [{ kind: 'memory', stepId: `s${++step}`, experienceId: null, threadId: null, observedAt: world.world.now(), recalledMemoryIds: [],
      readSourceIds: [world.skillSources[0]!] }] as unknown as TaskSource[]); return asked - before; };
    const first = check();
    expect(first, 'the first check looks the receipt up').toBeGreaterThan(0);
    expect(check(), 'a check with the database unchanged looks nothing up again').toBe(0);
    world.world.advance(1_000);
    store.appendTurn('owner', 'thread-0', '足した話', '足した返事', world.world.now());
    expect(check(), 'after a write it does').toBeGreaterThan(0);
    expect(check(), 'and then not again').toBe(0);
  });
});
