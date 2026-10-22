import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, memoryWithholdingRules, ruleWithholdsText } from '@shannon/cognition';
import { fcaDenseWorld, rng } from './support/fcaDenseWorld.js';
import { MEMORY_AT } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { writeMemoryControl } from './support/memoryControls.js';

const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };

/**
 * A task memory read keeps, for the length of one synchronous read, what it found visible and the time it was found visible at
 * (`ScopeMemos.lineages`, `taskMemory.ts`): an id found visible at one time is visible at every later one, so a later reading is answered
 * from it. That is true only because every rule that depends on the time of a reading hides the EARLIER readings (a reply no later than
 * a control's boundary) and never a later one. These tests hold that premise three ways: the rules are listed from the source, so one
 * of another direction (or one added) fails here before it can make the memo carry "visible" the wrong way; the premise is checked on the
 * real rules over a grid of times around every control's boundary; and a shared read gives what separate reads give for every order of
 * times at the boundary (a reading just before it, at it, just after it). Mutants made by hand (the memo ignoring the time, running it the
 * wrong way, keeping an invisible result; a verdict kept as timeless where a control names the item; a memo keyed without the time; each rule
 * reversed) each fail at least two of them. One that kept a later time than the earliest would be equivalent: it only answers less from the memo.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const iso = (time: number) => new Date(time).toISOString();

describe('the rules that depend on the time of a reading are the ones the lineage memo assumes', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  // Every file that decides what a task memory read may show, and so every place a time can enter its decision.
  const FILES = ['packages/cognition/src/withholding.ts', 'packages/cognition/src/memory.ts', 'packages/cognition/src/memoryEvidence.ts',
    'services/api/src/mind/memory/memoryVisibility.ts', 'services/api/src/mind/memory/taskMemory.ts', 'services/api/src/mind/memory/recallChainDepth.ts',
    'services/api/src/mind/inhibition/disclosurePorts.ts', 'services/api/src/wiring/fcaReadSources.ts'];
  const TIME = /\b(observedAt|boundary|contextInvalidatedAt|updatedAt|startedAt|chainStartedAt|Date\.parse|currentAt)\b/u;
  const COMPARISON = /<=|>=|(?<=\s)[<>](?=\s)/u;
  const found = () => FILES.flatMap(file => readFileSync(`${ROOT}${file}`, 'utf8').split('\n').flatMap(line => {
    const code = line.replace(/\s\/\/\s.*$/u, ''), text = code.trim();
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return [];
    return TIME.test(code) && COMPARISON.test(code) ? [`${file}: ${text.replace(/\s+/gu, ' ')}`] : [];
  }));
  const CORRECTED = 'Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt))';
  const EXPECTED = [
    // Hide the EARLIER readings (observedAt <= the boundary), whatever follows it: the direction the memo needs.
    'packages/cognition/src/withholding.ts: return observedAt <= rule.boundary && (rule.wide || restatesWithheldMemory(rule, text));',
    `services/api/src/mind/memory/memoryVisibility.ts: return control.status !== 'active' || ${CORRECTED};`,
    // The same boundary read the other way round: a corrected item is the corrected text after it.
    "services/api/src/mind/memory/memoryVisibility.ts: if (control?.status === 'active' && control.overrideText && observedAt > (control.contextInvalidatedAt ?? control.updatedAt)) return false;",
    // Not rules on the time of a reading: which rules a thread summary's chain makes relevant (by when the chain began).
    'services/api/src/mind/memory/memoryVisibility.ts: const relevant = new Set(this.rules.filter(rule => !started || rule.boundary >= started).map(rule => rule.memoryId));',
    'services/api/src/mind/memory/memoryVisibility.ts: const relevant = new Set(this.rules.filter(rule => rule.boundary >= summary.chainStartedAt).map(rule => rule.memoryId));',
    // The same hide-the-earlier rule for a skill receipt (two reads and the retained check), and a receipt's time being a time (not a rule).
    `services/api/src/wiring/fcaReadSources.ts: return control && (control.status !== 'active' || ${CORRECTED});`,
    `services/api/src/wiring/fcaReadSources.ts: return control && (control.status !== 'active' || ${CORRECTED});`,
    'services/api/src/wiring/fcaReadSources.ts: if (sourceId.length > 240 || !Number.isFinite(Date.parse(observedAt))) return false;',
    `services/api/src/wiring/fcaReadSources.ts: return control && (control.status !== 'active' || ${CORRECTED});`,
  ];

  it('lists every comparison against a time in the files that decide a reading, and holds each to what the memo assumes', () => {
    const now = found();
    expect(now, 'A comparison against a time was added, removed or changed in a file that decides what a task memory read may show. '
      + 'ScopeMemos.lineages (taskMemory.ts) assumes that every rule depending on the time of a reading hides EARLIER readings and never a later one. '
      + 'Check that the change keeps to that (or stop the memo), then update EXPECTED.').toEqual(EXPECTED);
  });

  it('uses the time of the reading in the lineage decision at exactly the places the memo accounts for', () => {
    const source = readFileSync(`${ROOT}services/api/src/mind/memory/taskMemory.ts`, 'utf8');
    const uses = source.split('\n').filter(line => line.includes('parts.now()') && !line.trim().startsWith('//')).map(line => line.trim());
    expect(uses.length, `uses of the reading time in taskMemory.ts: ${uses.join(' | ')}`).toBe(4);
    // the memo's own clock, the lineage decision, and the item's own decision: all three are the one reading time of the read.
    expect(uses.filter(line => line.includes('withholdsReply({')).length).toBe(2);
    expect(uses.filter(line => line.includes('since = withheld.memos.lineages')).length).toBe(1);
    // recall-yield: a read in turns notes the time it settled an id at (`settle`); that time only says which verdicts are made before
    // the read, never what one is (`recallYield.test.ts` holds a read in turns to the read at once).
    expect(uses.filter(line => line.includes('settled = withheld.memos.settled')).length).toBe(1);
  });

  it('hides a reply from the boundary down and never above it, for every rule of a real state', () => {
    const world = timeWorld(); cleanups.push(() => world.close());
    const rules = memoryWithholdingRules(world.store.snapshot('owner'));
    expect(rules.length).toBeGreaterThanOrEqual(5);
    let restating = 0, wide = 0;
    for (const rule of rules) {
      const boundary = Date.parse(rule.boundary);
      // A text that restates the item (the owner's words the control recognises it by), and a rule that restates nothing in particular (wide):
      // both hide at and before the boundary and not after it.
      const text = world.evidenceOf(rule.memoryId);
      if (!rule.wide && !(rule.terms.length > 0 && text)) continue;
      if (rule.wide) wide += 1; else restating += 1;
      for (const [at, hidden] of [[boundary - 86_400_000, true], [boundary - 1, true], [boundary, true], [boundary + 1, false], [boundary + 86_400_000, false]] as const) {
        expect(ruleWithholdsText(rule, text, iso(at)), `${rule.wide ? 'wide ' : ''}${rule.memoryId} at ${iso(at)}`).toBe(hidden);
      }
    }
    expect(restating, 'rules that restate').toBeGreaterThanOrEqual(3);
    expect(wide, 'rules that hide every earlier reply').toBeGreaterThanOrEqual(1);
  });
});

describe('what is readable at one time stays readable at every later one, on the real rules', () => {
  it('for task memory reads of every id, the withholding of a reply, and the read receipts of skills, over a grid of times around every boundary', () => {
    const world = timeWorld(); cleanups.push(() => world.close());
    const { store, ids, grid } = world;
    let clockAt = grid[0]!;
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => iso(clockAt), readSourceVisible: world.readSourceVisible });
    const readable = (shared?: Parameters<typeof memory.read>[3]) => {
      const out = new Set<string>();
      for (let offset = 0; offset < ids.length; offset += 40) for (const item of memory.read('owner', ids.slice(offset, offset + 40), OWNER_AUDIENCE, shared, { provenance: false })) out.add(item.id);
      return out;
    };
    const readSeries = grid.map(time => { clockAt = time; return { time, on: readable() }; });
    expectRising('task memory read', readSeries);
    // The fixture must hold the premise's two sides: what a boundary makes readable, and what no time does (forgotten, rejected, forgotten receipts).
    const first = readSeries[0]!.on, last = readSeries.at(-1)!.on;
    expect([...last].filter(id => !first.has(id)).length, 'ids that become readable with time').toBeGreaterThan(3);
    expect(ids.filter(id => !last.has(id)).length, 'ids never readable').toBeGreaterThan(1);
    // A corrected item is the original up to its boundary (withheld) and the correction after it; it may wait for a later boundary of something it stands on (above: rising).
    let readsAfter = 0;
    for (const id of world.corrected) {
      const before = readSeries.filter(step => step.time <= world.boundaryOf(id)), after = readSeries.filter(step => step.time > world.boundaryOf(id));
      expect(before.every(step => !step.on.has(id)), `the corrected ${id} reads up to its boundary`).toBe(true);
      if (after.at(-1)!.on.has(id)) readsAfter += 1;
    }
    expect(readsAfter, 'corrected items that read after their boundary').toBeGreaterThanOrEqual(1);
    // The chain over the corrected root reads from the root's boundary on, each link through the root alone (the time enters only there).
    const rootBoundary = world.boundaryOf(world.chain[0]!);
    for (const id of world.chain) {
      expect(readSeries.filter(step => step.time <= rootBoundary).some(step => step.on.has(id)), `${id} of the chain reads up to the root's boundary`).toBe(false);
      expect(readSeries.filter(step => step.time > rootBoundary).every(step => step.on.has(id)), `${id} of the chain reads after it`).toBe(true);
    }

    // The withholding of a reply that recalled each id: not withheld at one time means not withheld at every later one.
    const state = store.snapshot('owner'), candidates = store.experienceCandidates('owner');
    for (const text of ['', ...world.corrected.map(id => world.evidenceOf(id))]) {
      const series = grid.map(time => {
        const withholding = new MemoryWithholding(state, store, 'owner', candidates, world.readSourceVisible);
        return { time, on: new Set(ids.filter(id => !withholding.withholdsReply({ text, observedAt: iso(time), recalledMemoryIds: [id] }))) };
      });
      expectRising(`reply${text ? ' restating a corrected item' : ''} not withheld`, series);
    }

    // The read receipts of skills: a source visible at one time is visible at every later one.
    const receipts = [...world.skillSources, ...world.skillSources.map(source => `${source}/gist`)];
    const receiptSeries = grid.map(time => ({ time, on: new Set(receipts.filter(source => world.readSourceVisible('owner', source, iso(time)))) }));
    expectRising('read receipts', receiptSeries);
    expect(receiptSeries.at(-1)!.on.size, 'receipts visible at the end').toBeGreaterThan(0);
    expect(receiptSeries[0]!.on.size, 'receipts visible at the start').toBeLessThan(receiptSeries.at(-1)!.on.size);
    expect(receipts.filter(source => !receiptSeries.at(-1)!.on.has(source)).length, 'receipts never visible').toBeGreaterThan(0);
    // The forgotten receipt is never visible; the corrected one is visible after its boundary and not up to it.
    const [forgottenSkill, correctedSkill] = world.skillSources as [string, string], correctedAt = world.boundaryOf(correctedSkill);
    expect(receiptSeries.some(step => step.on.has(forgottenSkill)), 'a forgotten receipt is visible at some time').toBe(false);
    expect(receiptSeries.filter(step => step.time <= correctedAt).some(step => step.on.has(correctedSkill)), 'the corrected receipt is visible up to its boundary').toBe(false);
    expect(receiptSeries.filter(step => step.time > correctedAt).every(step => step.on.has(correctedSkill)), 'the corrected receipt is visible after its boundary').toBe(true);
  });
});

describe('a shared read gives what separate reads give, for every order of readings at a boundary', () => {
  it('for every sequence of three readings just before, at and just after each control\'s boundary, over the ids that boundaries change', () => {
    const world = timeWorld(); cleanups.push(() => world.close());
    const { store, ids } = world;
    let clockAt = 0;
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => iso(clockAt), readSourceVisible: world.readSourceVisible });
    const readable = (subset: readonly string[], shared?: Parameters<typeof memory.read>[3]) =>
      new Set(memory.read('owner', subset, OWNER_AUDIENCE, shared, { provenance: false }).map(item => item.id));
    // The ids that a boundary changes (readable on one side only), found by separate reads, and a few that no boundary changes.
    const changing = new Set<string>(), steady: string[] = [];
    const around = world.boundaries.flatMap(boundary => [boundary - 1, boundary, boundary + 1]);
    const alone = new Map<number, Set<string>>();
    for (const time of around) { clockAt = time; const on = new Set<string>(); for (let offset = 0; offset < ids.length; offset += 40) for (const id of readable(ids.slice(offset, offset + 40))) on.add(id); alone.set(time, on); }
    for (const boundary of world.boundaries) {
      for (const id of ids) if (alone.get(boundary - 1)!.has(id) !== alone.get(boundary + 1)!.has(id) || alone.get(boundary)!.has(id) !== alone.get(boundary + 1)!.has(id)) changing.add(id);
    }
    for (const id of ids) if (!changing.has(id) && alone.get(around[0]!)!.has(id) && steady.length < 12) steady.push(id);
    expect(changing.size, 'ids that a boundary changes').toBeGreaterThan(3);
    for (const id of world.chain) expect(changing.has(id), `${id} of the chain is changed by the root's boundary`).toBe(true);
    const subset = [...new Set([...world.chain, ...changing, ...steady])].slice(0, 40);
    let sequences = 0;
    for (const boundary of world.boundaries) {
      const times = [boundary - 1, boundary, boundary + 1];
      for (const a of times) for (const b of times) for (const c of times) {
        const shared = memory.readSnapshot!('owner'), got: string[][] = [];
        shared.withholding.withReadSnapshot(() => { for (const time of [a, b, c]) { clockAt = time; got.push([...readable(subset, shared)].sort()); } });
        const expected = [a, b, c].map(time => { clockAt = time; return [...readable(subset)].sort(); });
        expect(got, `readings at ${[a, b, c].map(time => time - boundary).join(', ')} ms from the boundary ${iso(boundary)}`).toEqual(expected);
        sequences += 1;
      }
    }
    expect(sequences).toBe(world.boundaries.length * 27);
  });

  it('and a forget or correction made between two reads is seen by the second, in either order of the reads', () => {
    const world = timeWorld(); cleanups.push(() => world.close());
    const { store } = world, end = world.world.clock.at;
    let clockAt = end;
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => iso(clockAt), readSourceVisible: world.readSourceVisible });
    const random = rng(3), readable = (subset: readonly string[], shared?: Parameters<typeof memory.read>[3]) =>
      new Set(memory.read('owner', subset, OWNER_AUDIENCE, shared, { provenance: false }).map(item => item.id));
    const pool = world.ordinary.filter(id => !world.corrected.includes(id) && readable([id]).has(id));
    const target = [...new Set(Array.from({ length: 8 }, () => pool[Math.floor(random() * pool.length)]!))];
    expect(target.length).toBeGreaterThan(3);
    // A snapshot kept under the database's mark is read first, then the state changes, then it is read again (later and earlier than the change): seen at once.
    for (const [index, id] of target.entries()) {
      const early = end + (index + 1) * 1_000;
      clockAt = early;
      const kept = memory.readSnapshot!('owner');
      expect(readable([id], kept).has(id), `${id} readable before it is changed`).toBe(true);
      writeMemoryControl(store, iso(early + 500), id, index % 2 ? 'forget' : 'reject', { evidence: world.evidenceOf(id) });
      for (const when of [early + 600, early - 5_000]) {
        clockAt = when;
        const again = memory.readSnapshot!('owner');
        expect(again, 'a snapshot of the changed database is a new one').not.toBe(kept);
        expect(readable([id], again).has(id), `${id} after it is changed, read at ${when - early} ms from the first read`).toBe(false);
        expect(readable([id]).has(id)).toBe(false);
      }
    }
  });
});

/** Each step's set of ids is within the next step's: a rising series in time. */
function expectRising(label: string, series: ReadonlyArray<{ time: number; on: ReadonlySet<string> }>): void {
  for (let index = 0; index + 1 < series.length; index++) {
    const lost = [...series[index]!.on].filter(id => !series[index + 1]!.on.has(id));
    expect(lost, `${label}: ids on at ${iso(series[index]!.time)} but off at the later ${iso(series[index + 1]!.time)}`).toEqual([]);
  }
}

/**
 * A world with a control of every kind, each made at its own moment on the timeline: a correction of a turn and of a task episode, a rejection, a
 * forget, and a forgotten and a corrected skill receipt. `grid` is the times just before, at and just after each boundary, and far either side.
 */
function timeWorld() {
  const world = fcaDenseWorld({ ordinary: 160, episodes: 24, skills: 4, seed: 5 });
  const store = world.world.store;
  const end = world.world.clock.at, base = Date.parse(MEMORY_AT), at = (minutes: number) => base + minutes * 60_000 + 30_000;
  const candidates = store.experienceCandidates('owner'), recalledBy = new Map<string, number>();
  for (const turn of candidates) for (const recalled of turn.recalledMemoryIds ?? []) recalledBy.set(recalled, (recalledBy.get(recalled) ?? 0) + 1);
  const evidenceOf = (id: string) => candidates.find(candidate => candidate.id === id)?.userMessage ?? '';
  // The items the controls name: the ones that most other turns recalled (the last two turns are already forgotten by the shape of the world).
  const named = candidates.slice(0, -2).map(turn => turn.id).sort((a, b) => (recalledBy.get(b) ?? 0) - (recalledBy.get(a) ?? 0)).slice(0, 4);
  expect(named.length).toBe(4);
  const corrected = [named[0]!, named[1]!];
  const doAt = (minutes: number, work: (stamp: string) => void) => work(new Date(at(minutes)).toISOString());
  const forSkill = (stamp: string, memoryId: string, mode: 'forget' | 'correct') => writeMemoryControl(store, stamp, memoryId, mode, { text: '直した手順' });
  doAt(90, stamp => writeMemoryControl(store, stamp, corrected[0]!, 'correct', { evidence: evidenceOf(corrected[0]!), text: '直した記憶の本文その一' }));
  doAt(100, stamp => writeMemoryControl(store, stamp, named[2]!, 'reject', { evidence: evidenceOf(named[2]!) }));
  doAt(110, stamp => forSkill(stamp, world.skillSources[0]!, 'forget'));
  doAt(120, stamp => forSkill(stamp, world.skillSources[1]!, 'correct'));
  doAt(130, stamp => writeMemoryControl(store, stamp, corrected[1]!, 'correct', { evidence: evidenceOf(corrected[1]!), text: '直した記憶の本文その二' }));
  doAt(140, stamp => writeMemoryControl(store, stamp, named[3]!, 'forget', { evidence: evidenceOf(named[3]!) }));
  // A chain of turns that recall each other down to a corrected root, and that nothing else touches: whether they read depends on the time of
  // the reading only through the root (their own checks never withhold them, and no wide rule is in force at that time).
  // (Their words share nothing with the root's, so that the correction's key terms restate in none of them: only the time of the reading decides.)
  const link = (user: string, reply: string, recalled: string[]) => { world.world.advance(1000); return store.appendTurn('owner', 'thread-0', user, reply, world.world.now(),
    { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recalled }).id; };
  // The links are written after the correction (a turn that recalled the original before it carries it for good), recalling the corrected root.
  const root = link('天文台予約', 'ペルセウス座', []);
  world.world.advance(1000);
  writeMemoryControl(store, world.world.now(), root, 'correct', { evidence: '天文台予約', text: '直した天体観測の記録' });
  const first = link('猫散歩', 'ふわふわ', [root]), second = link('犬散歩', 'わんわん', [first]);
  const third = link('鳥歌', 'ぴよぴよ', [second, root]), chain = [root, first, second, third];
  corrected.push(root);
  const controls = store.snapshot('owner').memoryControls;
  const boundaryTimes = (control: (typeof controls)[number]) => Date.parse(control.contextInvalidatedAt ?? control.updatedAt);
  const boundaries = [...new Set(controls.map(boundaryTimes))].sort((a, b) => a - b);
  const grid = [...new Set([base - 86_400_000, ...boundaries.flatMap(boundary => [boundary - 1, boundary, boundary + 1]), end + 86_400_000])].sort((a, b) => a - b);
  return {
    ...world, store, ids: [...world.ids, ...chain, 'thread:thread-0', 'thread:thread-1'], corrected, chain, boundaries, grid, evidenceOf: (id: string) => controls.find(control => control.memoryId === id)?.sourceEvidence ?? '',
    boundaryOf: (id: string) => boundaryTimes(controls.find(control => control.memoryId === id)!),
  };
}
