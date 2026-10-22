import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from './support/fcaDenseWorld.js';
import { WITHHOLDING_QUESTIONS } from './support/callCounts.js';
import { SQLiteTaskExperiences } from '../src/mind/memory/store/taskExperiences.js';
import { taskExperienceId } from '../src/mind/memory/taskExperience.js';
import { createTaskMemory, type TaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { inTurns, whole } from '../src/mind/memory/memoryStepsPorts.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { writeMemoryControl } from './support/memoryControls.js';
import { createBodyTaskRecall, type BodyRecallCues } from '../src/mind/recall/bodyTaskRecall.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import type { TaskSource } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * recall-yield (2026-10-22). Production run 31: the body recall's first pool held the API's one thread 2,448 + 1,318 + 1,428 ms (its three
 * searches walking every candidate's lineage, then the read of what it shows and the FCA source guard's check of its 315 sources, 862 ms),
 * on remembered turns where each body task's episode recalls about 315 others. The recall now makes the same reads in steps and gives the
 * thread back between them (`memorySteps.ts`): a read in turns settles its ids' lineage a remembered turn at a time, children first, so
 * that no step walks the graph. Held here: on a world of that density (with a forget, a retired skill, a correction and a cycle in it),
 * the packets, the reads, the source lists and the guard's verdicts are the ones the reads at once give, id for id and in order; and the
 * most a turn of the loop asks of the recall graph is a small part of what one turn asked before (counted, not timed: a time bound fails on
 * a loaded machine; the seconds are `scratchpad recall-yield/bench`, see the commit).
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const GOAL = 'Minecraft でエンダードラゴンを討伐する。木を集めて道具を作り、夜に備え、鉄とダイヤを集める。';
const CUES: BodyRecallCues[] = [
  { words: ['鉄', 'iron', 'かまど'], tags: ['stage3'], urgent: ['夜', '縦穴'] },
  { words: ['ダイヤ', 'shelter'], tags: ['night', 'threat'], urgent: ['夜'] },
  { words: ['掘った'], tags: [], since: '2026-10-07T12:00:00.000Z' },
];

/**
 * Production's remembered turns in counts (`fcaDenseWorld.ts`), and body task episodes of one goal in three families, each recalling up
 * to 315 ids (its family's earlier episodes and ordinary turns; production 2026-10-22: 530 episodes, median 221, p90 303, max 314). In
 * family 0 an ordinary turn they recall from its 30th episode on is forgotten; in family 1 a skill read from its 40th on is retired; in
 * family 2 one episode is corrected, two recall a thread's summary, and (`cycle`) two recall each other.
 */
function bodyWorld(options: { perFamily?: number; cycle?: boolean } = {}) {
  const dense = fcaDenseWorld({ ordinary: 420, episodes: 60, skills: 12, seed: 11 });
  const store = dense.world.store, writer = new SQLiteTaskExperiences(store.fcaDatabase());
  const perFamily = options.perFamily ?? 110, families: string[][] = [[], [], []];
  // The latest ordinary turn: no other ordinary turn recalls it, so only the episodes that do are withheld for it.
  const forgotten = dense.ordinary.at(-1)!, retired = dense.skillSources[7]!, thread = 'thread:thread-recall';
  dense.world.advance(60_000);
  store.appendTurn('owner', 'thread-recall', '鉄の掘り方を話した', '夜の前に掘ると話した', dense.world.now());
  const ordinary = dense.ordinary.filter(id => id !== forgotten);
  const write = (family: number, index: number, extra: readonly string[] = []) => {
    dense.world.advance(60_000);
    const earlier = families[family]!.slice(-250);
    const sourceIds = [...new Set([...earlier, ...Array.from({ length: 315 - earlier.length }, (_, k) => ordinary[(index * 37 + family * 101 + k * 7) % ordinary.length]!),
      ...extra])].slice(0, 316);
    const reads = [...dense.skillSources.filter(source => source !== retired).slice(0, 5 + (index % 5)), ...family === 1 && index >= 40 ? [retired] : []];
    const record = { scopeKey: 'owner', taskId: `body-${family}-${Math.floor(index / 8)}`, outcomeId: `segment-${index}`, observedAt: dense.world.now(),
      status: index % 3 ? 'success' as const : 'failure' as const, goal: GOAL, context: `文脈${family}-${index}`,
      action: index % 4 ? `{"name":"mc.mine-block","input":{"blockName":"iron_ore"}}` : `{"name":"mc.dig-shelter","input":{}}`, prediction: `予想${index}`,
      observedResult: index % 4 ? `鉄鉱石を${index % 5}個掘った（${family}）` : `夜に縦穴に入った${index}`, interpretation: `解釈${index}`, sourceIds, readSourceIds: reads };
    writer.write('owner', record);
    families[family]!.push(taskExperienceId('owner', record.taskId, record.outcomeId));
  };
  for (let index = 0; index < perFamily; index++) {
    write(0, index, index >= 30 ? [forgotten] : []);
    write(1, index);
    write(2, index, index === 50 || index === 70 ? [thread] : []);
  }
  if (options.cycle) {
    // Two episodes that recall each other (a rewrite of a task's record merges its sources): the reads in turns find no order there.
    const first = taskExperienceId('owner', 'cycle', 'a'), second = taskExperienceId('owner', 'cycle', 'b');
    for (const [outcomeId, other] of [['a', second], ['b', first]] as const) {
      dense.world.advance(60_000);
      writer.write('owner', { scopeKey: 'owner', taskId: 'cycle', outcomeId, observedAt: dense.world.now(), status: 'failure', goal: GOAL, context: 'c',
        action: '{"name":"mc.dig-shelter","input":{}}', prediction: 'p', observedResult: `夜に縦穴に入った輪${outcomeId}`, interpretation: 'i',
        sourceIds: [...families[2]!.slice(-20), other], readSourceIds: [] });
    }
  }
  writeMemoryControl(store, dense.world.now(), forgotten, 'forget');
  // The latest episode of family 2 (the turns before a correction that recalled the item are withheld: none recall this one).
  writeMemoryControl(store, dense.world.now(), families[2]!.at(-1)!, 'correct', { text: '直した記憶: 鉄は夜の前に掘る' });
  const match = /^shannon-skill:\/\/([^/]+)\/revision\/([^/]+)$/u.exec(retired)!;
  expect(dense.memory.retire('owner', decodeURIComponent(match[1]!), 'test', dense.world.now())).toBe(true);
  dense.world.advance(60_000);
  const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => dense.world.now(),
    readSourceVisible: dense.readSourceVisible });
  cleanups.push(() => dense.close());
  return { dense, store, memory, families, forgotten, thread };
}

/** The same memory without its steps: every caller runs the synchronous calls, as before this change. */
const atOnce = (memory: TaskMemory): TaskMemory => ({ ...memory, steps: undefined });

/** A packet as the decision reads it (its time aside) and the measure's counts. */
async function packets(memory: TaskMemory, store: Parameters<typeof createBodyTaskRecall>[0]['state'], jev = false) {
  const decide = async (input: { state: { memories: Record<string, string> } }) => ({ value: Object.keys(input.state.memories).map((_, index) => index % 2 ? 0.9 : 0.2),
    source: 'jev' as const });
  const recall = createBodyTaskRecall({ memory, state: store, ...(jev ? { jev: { decide: decide as never }, jevOn: true } : {}) });
  const shown: string[] = [];
  for (const cues of [...CUES, CUES[0]!]) {
    const { packet, measure } = await recall.packet({ scopeKey: 'owner', taskId: 'same', goal: GOAL, cues, present: OWNER_AUDIENCE });
    shown.push(JSON.stringify({ status: packet.status, items: packet.items, sources: packet.sourceIds, pool: measure.pool, groups: measure.groups,
      shown: measure.shown, chars: measure.chars, jev: measure.jev && { kept: measure.jev.kept, source: measure.jev.source } }));
  }
  return shown;
}

describe('the body recall in turns gives what the recall at once gives (production-dense memory)', () => {
  it('the same packets, decision after decision, under a forget, a retired skill, a correction, a thread and a cycle; with Jev too', async () => {
    const { memory, store, families, forgotten } = bodyWorld({ cycle: true });
    // The fixture holds what the gate decides: readable episodes, and episodes it withholds for each reason.
    const readable = (ids: readonly string[]) => memory.read('owner', ids, OWNER_AUDIENCE, undefined, { provenance: false }).map(item => item.id);
    expect(readable(families[0]!.slice(0, 20))).toHaveLength(20);
    expect(readable(families[0]!.slice(40, 60))).toEqual([]);
    expect(readable(families[1]!.slice(50, 70))).toEqual([]);
    expect(readable(families[2]!.slice(60, 100)).length).toBeGreaterThan(30);
    expect(readable([forgotten])).toEqual([]);
    for (const jev of [false, true]) {
      const whole = await packets(atOnce(memory), store, jev), turns = await packets(memory, store, jev);
      expect(turns).toEqual(whole);
      expect(whole.some(shown => JSON.parse(shown).items.length > 0)).toBe(true);
      expect(whole.some(shown => JSON.parse(shown).sources.length > 300)).toBe(true);
    }
  }, 180_000);

  it('the same searches, reads and source lists from the memory\'s own steps, for every kind of id and order', async () => {
    const { memory, families, dense, thread } = bodyWorld({ cycle: true });
    const steps = memory.steps!;
    const all = [...families.flat(), ...dense.ordinary, ...dense.episodes, thread, 'thread:none', 'unknown-id', taskExperienceId('owner', 'cycle', 'a')];
    const pick = (seed: number, count: number) => Array.from({ length: count }, (_, k) => all[(seed * 7919 + k * 104_729) % all.length]!);
    const shared = await inTurns(steps.snapshot('owner'));
    const release = shared.withholding.hold();
    // A clock that ticks once a step: the work gives the loop back every few steps, whatever the machine.
    let ticks = 0;
    const held = { longestMs: 0, turns: 0 }, turns = { measure: held, clock: () => ticks++ };
    try {
      const at = memory.readSnapshot!('owner');
      const once = <T>(work: () => T) => at.withholding.withReadSnapshot(work);
      for (const query of [GOAL, `マイクラ ${GOAL}`, 'ゲームの記憶 マイクラ', '鉄鉱石', '縦穴']) {
        const inSteps = await inTurns(steps.search('owner', query, OWNER_AUDIENCE, 40, { kind: 'experience' }, shared, { provenance: false }), turns);
        expect(inSteps).toEqual(once(() => memory.search('owner', query, OWNER_AUDIENCE, 40, { kind: 'experience' }, at, { provenance: false })));
      }
      for (let seed = 1; seed <= 12; seed++) {
        const ids = pick(seed, 40);
        const read = await inTurns(steps.read('owner', ids, OWNER_AUDIENCE, shared, { provenance: false }), turns);
        expect(read).toEqual(once(() => memory.read('owner', ids, OWNER_AUDIENCE, at, { provenance: false })));
        expect(read).toEqual(memory.read('owner', ids, OWNER_AUDIENCE, undefined, { provenance: false }));
        const listed = await inTurns(steps.sources('owner', read.map(item => item.id), shared));
        expect(listed).toEqual(memory.sources('owner', read.map(item => item.id), at));
      }
      // With provenance listed, as `memory.read` gives it to a tool.
      const ids = pick(13, 40);
      expect(await inTurns(steps.read('owner', ids, OWNER_AUDIENCE, shared))).toEqual(once(() => memory.read('owner', ids, OWNER_AUDIENCE, at)));
    } finally { release(); }
    expect(held.turns).toBeGreaterThan(100);
  }, 180_000);

  it('reads what it shows again when a source row changed while it read: a memory forgotten meanwhile is not shown', async () => {
    const { memory, store, dense } = bodyWorld({ perFamily: 60 });
    const steps = memory.steps!;
    let forgotten: string | null = null, asked: readonly string[] = [], reads = 0;
    // The read of what is shown, with a forget of its first id written after its first step (between two turns of the loop).
    const watched: TaskMemory = { ...memory, steps: { ...steps, read: (scope, ids, present, shared, options) => (function* () {
      [asked, reads] = [ids, reads + 1];
      const inner = steps.read(scope, ids, present, shared, options);
      let step = inner.next();
      if (forgotten === null && ids.length) {
        forgotten = ids[0]!;
        writeMemoryControl(store, dense.world.now(), forgotten, 'forget');
      }
      while (!step.done) {
        yield;
        step = inner.next();
      }
      return step.value;
    })() } };
    const { packet } = await createBodyTaskRecall({ memory: watched, state: store })
      .packet({ scopeKey: 'owner', taskId: 'forget', goal: GOAL, cues: CUES[0]!, present: OWNER_AUDIENCE });
    // Read again in turns after the forget, and what it gives is the read at once of the same ids now (the corrected episode, shown as
    // corrected, still lists what it recalled among its sources: the gate's own rule, the same either way).
    expect(forgotten).not.toBeNull();
    expect(reads).toBe(2);
    expect(asked).toContain(forgotten);
    const at = memory.readSnapshot!('owner');
    const now = at.withholding.withReadSnapshot(() => {
      const items = memory.read('owner', asked, OWNER_AUDIENCE, at, { provenance: false });
      return { ids: items.map(item => item.id), sources: memory.sources('owner', items.map(item => item.id), at) };
    });
    expect(packet.items.map(item => item.id)).toEqual(now.ids);
    expect(packet.sourceIds).toEqual(now.sources);
    expect(now.ids).not.toContain(forgotten);
    expect(now.ids.length).toBeGreaterThan(0);
  }, 120_000);

  it('reads the remembered turns a page at a time as the read at once gives them, and again at once when one changed meanwhile', () => {
    const { store, dense } = bodyWorld({ perFamily: 20 });
    const fresh = () => { dense.world.advance(1_000); store.appendTurn('owner', 'thread-x', `話${dense.world.now()}`, '返事', dense.world.now()); };
    fresh();
    const paged = whole(store.experienceCandidateSteps('owner'));
    expect(paged).toBe(store.experienceCandidates('owner'));
    fresh();
    const steps = store.experienceCandidateSteps('owner');
    steps.next();
    fresh(); // a turn written between two pages: what is given is the read at once after it
    let step = steps.next();
    while (!step.done) step = steps.next();
    expect(step.value.map(turn => turn.id)).toEqual(store.experienceCandidates('owner').map(turn => turn.id));
    expect(step.value.at(-1)!.userMessage).toMatch(/^話/u);
  }, 120_000);
});

describe('the FCA source guard\'s walk in turns keeps the verdict the walk at once makes', () => {
  it('visible and withheld provenance alike, and the check right after it is a reuse', async () => {
    const { dense, store, families, memory } = bodyWorld();
    const task = dense.runtime.createChild('owner', dense.runtime.ensureRoot('owner').id, { title: 'body', goal: GOAL, completionCriteria: 'x', kind: 'generic' }, 'body');
    const visible = memory.sources('owner', families[2]!.slice(90, 93), memory.readSnapshot!('owner'));
    const rowsOf = (ids: readonly string[]) => [{ kind: 'memory', stepId: 's0001', experienceId: null, threadId: null, observedAt: dense.world.now(),
      recalledMemoryIds: [...ids], readSourceIds: dense.skillSources.slice(0, 3) }] as unknown as TaskSource[];
    const guardOf = () => createFcaSourceGuard({ runtime: dense.runtime, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: dense.readSourceVisible, log: () => {} });
    for (const [ids, expected] of [[visible, true], [[...visible.slice(0, 200), families[0]![50]!], false], [[...visible, families[1]![60]!], false]] as const) {
      expect(guardOf().sources('owner', task, rowsOf(ids), undefined, 'memory')).toBe(expected);
      const guard = guardOf();
      await guard.warm!('owner', task, rowsOf(ids), undefined, 'memory');
      expect(guard.sources('owner', task, rowsOf(ids), undefined, 'memory')).toBe(expected);
      expect(guard.walks!()).toMatchObject({ walked: 1, reused: 1 });
    }
    expect(visible.length).toBeGreaterThan(300);
  }, 180_000);

  it('keeps nothing when the state changed while it walked: the check then walks at once', async () => {
    const { dense, store, families, memory } = bodyWorld({ perFamily: 40 });
    const task = dense.runtime.createChild('owner', dense.runtime.ensureRoot('owner').id, { title: 'body', goal: GOAL, completionCriteria: 'x', kind: 'generic' }, 'body');
    const ids = memory.sources('owner', families[2]!.slice(30, 33), memory.readSnapshot!('owner'));
    const rows = [{ kind: 'memory', stepId: 's0001', experienceId: null, threadId: null, observedAt: dense.world.now(), recalledMemoryIds: ids,
      readSourceIds: [] }] as unknown as TaskSource[];
    let ticks = 0;
    const guard = createFcaSourceGuard({ runtime: dense.runtime, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: dense.readSourceVisible, log: () => {}, monotonic: () => ticks++ });
    const warming = guard.warm!('owner', task, rows, undefined, 'memory');
    // While it walks (it gives the loop back every few steps on this clock): one of the ids it walks is forgotten.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    writeMemoryControl(store, dense.world.now(), ids[5]!, 'forget');
    await warming;
    expect(guard.sources('owner', task, rows, undefined, 'memory')).toBe(false);
    expect(guard.walks!()).toMatchObject({ walked: 2, reused: 0 });
  }, 120_000);
});

/**
 * The most questions of the recall graph (`WITHHOLDING_QUESTIONS`) asked within one turn of the event loop while `work` runs, and in all.
 * `clock`: milliseconds as questions asked (one per 100), for the work's own slicing: so what a turn holds does not move with the machine.
 */
async function questionsPerTurn<T>(work: (clock: () => number) => Promise<T>): Promise<{ value: T; most: number; total: number }> {
  type Method = (...args: unknown[]) => unknown;
  const proto = MemoryWithholding.prototype as unknown as Record<string, Method>, originals = new Map<string, Method>();
  let asked = 0, last = 0, most = 0, on = true;
  for (const name of WITHHOLDING_QUESTIONS) {
    const original = proto[name]!;
    originals.set(name, original);
    proto[name] = function (this: unknown, ...args: unknown[]) { asked += 1; return original.apply(this, args); };
  }
  const tick = () => {
    most = Math.max(most, asked - last);
    last = asked;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const value = await work(() => asked / 100);
    on = false;
    most = Math.max(most, asked - last);
    return { value, most, total: asked };
  } finally {
    for (const [name, original] of originals) proto[name] = original;
  }
}

describe('no turn of the loop holds the recall\'s walk of the graph (run 31: 2,448 ms at once)', () => {
  it('asks the recall graph a small part of what it asks in all within any one turn, for the pool, what it shows and the guard\'s check', async () => {
    const { dense, store, memory } = bodyWorld();
    const task = dense.runtime.createChild('owner', dense.runtime.ensureRoot('owner').id, { title: 'body', goal: GOAL, completionCriteria: 'x', kind: 'generic' }, 'body');
    const recall = await questionsPerTurn(clock => createBodyTaskRecall({ memory, state: store, clock })
      .packet({ scopeKey: 'owner', taskId: 'stall', goal: GOAL, cues: CUES[0]!, present: OWNER_AUDIENCE }));
    expect(recall.value.packet.sourceIds.length).toBeGreaterThan(300);
    const rows = [{ kind: 'memory', stepId: 's0001', experienceId: null, threadId: null, observedAt: dense.world.now(),
      recalledMemoryIds: [...recall.value.packet.sourceIds], readSourceIds: [] }] as unknown as TaskSource[];
    const check = await questionsPerTurn(async clock => {
      const guard = createFcaSourceGuard({ runtime: dense.runtime, state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true,
        readSourceVisible: dense.readSourceVisible, log: () => {}, monotonic: clock });
      await guard.warm?.('owner', task, rows, undefined, 'memory');
      return guard.sources('owner', task, rows, undefined, 'memory');
    });
    expect(check.value).toBe(true);
    // Before (297c3ed): the recall asked 70,408 of its 181,371 questions in one turn, the guard's check all its 41,084 in one. Now the most in
    // a turn is about 1,300 for each (of 112,540 and 41,653: the pool's three searches share what they decided).
    for (const [name, run] of [['recall', recall], ['check', check]] as const) {
      expect.soft(run.total, name).toBeGreaterThan(5_000);
      expect.soft(run.most, `${name}: ${run.most} of ${run.total} in one turn`).toBeLessThan(3_000);
    }
  }, 180_000);
});
