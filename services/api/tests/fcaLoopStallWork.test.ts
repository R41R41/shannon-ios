import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_AUDIENCE, memoryWithholdingRules, restatedMemoryKept, restatesWithheldMemory, type MemoryWithholdingRule } from '@shannon/cognition';
import { fcaDenseWorld, rng } from './support/fcaDenseWorld.js';
import { MEMORY_AT } from './support/memoryWorld.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { createTaskMemory } from '../src/mind/memory/taskMemoryPorts.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { prepared } from '../src/infra/sqlite/sqliteOpen.js';
import { versionRevisionId } from '../src/mind/memory/skillLineage.js';
import { counting } from './support/callCounts.js';

/**
 * Production run 14 (2026-10-17): `event loop blocked` 204 times in 30 minutes, median 3.3 s, while a Minecraft task ran. Offline, on a
 * world with the shape of production's remembered turns (`fcaDenseWorld.ts`, counts only), a walk of the task's provenance and the
 * recall of each step were found to ask the same questions of the recall graph over and over: every chunk of 40 ids walked the whole
 * graph below it again, every check of a receipt began a scope of its own, every re-asked receipt read its skill's every revision.
 * The budgets below are questions asked of the graph, counted, not seconds: they do not move with the machine, and the old code is far
 * over each (the numbers in the comments are origin/main's, 0c0ad93). `fcaLoopStallBudget.test.ts` holds the same kind of budget over a whole
 * task run, also counted; the seconds are `tests/perf/loopStallBudget.ts` (not in CI: a time bound fails on a loaded machine).
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

describe('a walk of a production-dense provenance asks the recall graph a bounded number of questions', () => {
  it('asks no more than a third of what origin/main asked for 190 ids over 100 provenance rows', () => {
    const world = fcaDenseWorld(); cleanups.push(() => world.close());
    const task = world.runtime.createChild('owner', world.runtime.ensureRoot('owner').id, { title: 'walk', goal: 'walk goal', completionCriteria: 'x', kind: 'generic' }, 'walk');
    const rows = world.provenance(100);
    const guard = createFcaSourceGuard({ runtime: world.runtime, state: world.world.store, conversations: world.world.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: world.readSourceVisible, log: () => {} });
    const { value, counts } = counting(['withholdsReply', 'recalledWithheldWithin', 'provenanceWithheld', 'sourceVisible', 'withholdsExperience'], () => guard.sources('owner', task, rows));
    expect(value).toBe(true);
    expect(new Set(rows.flatMap(row => row.recalledMemoryIds)).size).toBeGreaterThan(150);
    // origin/main: withholdsReply 18,466, recalledWithheldWithin 162,997, provenanceWithheld 33,979, sourceVisible 33,929, withholdsExperience 7,769.
    expect(counts.withholdsReply).toBeLessThan(8_000);
    expect(counts.recalledWithheldWithin).toBeLessThan(40_000);
    expect(counts.provenanceWithheld).toBeLessThan(6_000);
    expect(counts.sourceVisible).toBeLessThan(12_000);
    expect(counts.withholdsExperience).toBeLessThan(2_500);
  });

  it('re-asks the receipts of a verdict it reuses without a withholding of its own for each, and reads a skill\'s one revision, not all', () => {
    const world = fcaDenseWorld({ ordinary: 200, episodes: 60, skills: 12 }); cleanups.push(() => world.close());
    const task = world.runtime.createChild('owner', world.runtime.ensureRoot('owner').id, { title: 'reuse', goal: 'reuse goal', completionCriteria: 'x', kind: 'generic' }, 'reuse');
    const rows = world.provenance(30, 60, 30, 12);
    let now = 0;
    const guard = createFcaSourceGuard({ runtime: world.runtime, state: world.world.store, conversations: world.world.store, ownerScope: 'owner', ownerAlone: () => true,
      clock: () => now, readSourceVisible: world.readSourceVisible, log: () => {} });
    expect(guard.sources('owner', task, rows)).toBe(true);
    now = 1_000;
    const revisions = world.memory.store.revisions.bind(world.memory.store);
    let listed = 0;
    world.memory.store.revisions = ((...args: Parameters<typeof revisions>) => { listed += 1; return revisions(...args); }) as typeof revisions;
    // Every scope of reading begins with one question to the store whether any remembered turn holds a read receipt.
    const store = world.world.store, original = store.hasReadSourceProvenance.bind(store);
    let scopes = 0;
    store.hasReadSourceProvenance = (scope: string) => { scopes += 1; return original(scope); };
    for (let call = 0; call < 20; call++) expect(guard.sources('owner', task, rows)).toBe(true);
    store.hasReadSourceProvenance = original;
    // 20 reuses of a verdict: the 12 skills' receipts asked again each time, never by listing every revision of a skill (origin/main: 240 listings).
    expect(listed).toBe(0);
    // One scope for all the receipts of a reuse (origin/main: one per receipt, 12 x 20).
    expect(scopes).toBeLessThanOrEqual(40);
  });
});

describe('what a shared read remembers gives the verdicts reads that share nothing give', () => {
  it('under a forget and corrections made at different times, for ids read at rising and falling times', () => {
    const world = fcaDenseWorld({ ordinary: 240, episodes: 90, skills: 8, seed: 5 }); cleanups.push(() => world.close());
    const store = world.world.store, service = new ShannonMemoryService(store, store, world.world.now), random = rng(99);
    // Controls made in the middle of the timeline: what a correction withholds depends on the time of the reading that recalled it.
    const end = world.world.clock.at, at = (minutes: number) => Date.parse(MEMORY_AT) + minutes * 60_000 + 30_000;
    world.world.clock.at = at(120); service.mutate('owner', { memoryId: world.episodes.at(-20)!, action: 'correct', text: '直した記憶の本文' });
    world.world.clock.at = at(160); service.mutate('owner', { memoryId: world.episodes.at(-40)!, action: 'forget' });
    world.world.clock.at = at(200); service.mutate('owner', { memoryId: world.episodes.at(-60)!, action: 'correct', text: '二つ目の直した本文' });
    world.world.clock.at = end;
    const times = [at(30), at(125), at(165), at(205), at(235), Date.parse(MEMORY_AT) + 400 * 60_000];
    let clockAt = times[0]!;
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => new Date(clockAt).toISOString(),
      readSourceVisible: world.readSourceVisible });
    const readable = (ids: readonly string[], shared?: ReturnType<NonNullable<typeof memory.readSnapshot>>) =>
      new Set(memory.read('owner', ids, OWNER_AUDIENCE, shared, { provenance: false }).map(item => item.id));
    let withheldSomewhere = 0, visibleSomewhere = 0, total = 0;
    for (let trial = 0; trial < 12; trial++) {
      const shared = memory.readSnapshot!('owner');
      // The ids of one walk, at times that rise, fall and repeat: the second time an id is asked it may be earlier than the first.
      const chunks = Array.from({ length: 6 }, () => Array.from({ length: 30 }, () => world.ids[Math.floor(random() * world.ids.length)]!));
      const order = chunks.map(() => times[Math.floor(random() * times.length)]!);
      shared.withholding.withReadSnapshot(() => {
        chunks.forEach((chunk, index) => {
          clockAt = order[index]!;
          const together = readable(chunk, shared), alone = readable(chunk);
          expect([...together].sort()).toEqual([...alone].sort());
          total += chunk.length; visibleSomewhere += together.size; withheldSomewhere += new Set(chunk).size - together.size;
        });
      });
    }
    // The fixture must hold both: ids that read, and ids that a control withholds.
    expect(visibleSomewhere).toBeGreaterThan(total / 4);
    expect(withheldSomewhere).toBeGreaterThan(0);
  });

  it('never carries "readable" back to an earlier time: a turn that recalled a corrected item reads after the correction and not before it', () => {
    const world = fcaDenseWorld({ ordinary: 240, episodes: 90, skills: 8, seed: 5 }); cleanups.push(() => world.close());
    const store = world.world.store, service = new ShannonMemoryService(store, store, world.world.now);
    const end = world.world.clock.at, boundary = Date.parse(MEMORY_AT) + 120 * 60_000 + 30_000;
    world.world.clock.at = boundary; service.mutate('owner', { memoryId: world.episodes.at(-20)!, action: 'correct', text: '直した記憶の本文' }); world.world.clock.at = end;
    const before = boundary - 90 * 60_000, after = boundary + 90 * 60_000;
    let clockAt = before;
    const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => new Date(clockAt).toISOString(),
      readSourceVisible: world.readSourceVisible });
    const readable = (ids: readonly string[], shared?: ReturnType<NonNullable<typeof memory.readSnapshot>>) =>
      new Set(memory.read('owner', ids, OWNER_AUDIENCE, shared, { provenance: false }).map(item => item.id));
    const recalling = store.experienceCandidates('owner').filter(turn => turn.recalledMemoryIds?.includes(world.episodes.at(-20)!)).map(turn => turn.id);
    expect(recalling.length).toBeGreaterThan(2);
    clockAt = before; const early = readable(recalling).size;
    clockAt = after; const late = readable(recalling).size;
    expect(late).toBeGreaterThan(early); // The time of the reading must matter to the fixture, or this proves nothing.
    for (const order of [[after, before, after], [before, after, before]]) {
      const shared = memory.readSnapshot!('owner');
      shared.withholding.withReadSnapshot(() => {
        for (const when of order) {
          clockAt = when;
          expect([...readable(recalling, shared)].sort()).toEqual([...readable(recalling)].sort());
        }
      });
    }
  });
});

describe('the small caches stay exact', () => {
  it('keeps a thread\'s lineage while the database is unchanged and reads it again after a write', () => {
    const world = fcaDenseWorld({ ordinary: 60, episodes: 10, skills: 3 }); cleanups.push(() => world.close());
    const store = world.world.store;
    const thread = store.listThreads('owner')[0]!.threadId;
    const first = store.threadSummaryLineage('owner', thread);
    expect(store.threadSummaryLineage('owner', thread)).toBe(first);
    const turn = store.appendTurn('owner', thread, 'あとから足した話', 'あとから足した返事', new Date(world.world.clock.at + 1_000).toISOString());
    const again = store.threadSummaryLineage('owner', thread);
    expect(again).not.toBe(first);
    expect(again.messages.length).toBe(first.messages.length + 2);
    expect(again.messages.some(message => message.sourceExperienceId === turn.id)).toBe(true);
  });

  it('sees a skill retired, and a control on its revision, at once', () => {
    const world = fcaDenseWorld({ ordinary: 40, episodes: 5, skills: 4 }); cleanups.push(() => world.close());
    const source = world.skillSources[0]!, match = /^shannon-skill:\/\/([^/]+)\/revision\/([^/]+)$/u.exec(source)!;
    const [skillId, revisionId] = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)];
    const at = new Date(world.world.clock.at).toISOString();
    expect(world.skills.readSource!('owner', skillId, revisionId)).not.toBeNull();
    expect(world.readSourceVisible('owner', source, at)).toBe(true);
    expect(world.memory.retire('owner', skillId, 'test', at)).toBe(true);
    expect(world.skills.readSource!('owner', skillId, revisionId)).toBeNull();
    expect(world.readSourceVisible('owner', source, at)).toBe(false);
  });

  it('reads one saved version of a skill as the list of its revisions gives it', () => {
    const world = fcaDenseWorld({ ordinary: 40, episodes: 5, skills: 4 }); cleanups.push(() => world.close());
    const skill = world.memory.store.all('owner')[0]!;
    const listed = world.memory.store.revisions('owner', skill.skillId).find(item => item.kind === 'version' && item.revisionId === versionRevisionId(skill.skillId, skill.version))!;
    expect(world.memory.store.version('owner', skill.skillId, listed.revisionId)).toEqual(listed);
    expect(world.memory.store.version('owner', skill.skillId, 'no-such-revision')).toBeNull();
    expect(world.memory.store.version('owner', 'no-such-skill', listed.revisionId)).toBeNull();
  });

  it('answers whether a text restates an item as it did, for texts long and short, and keeps one rule object per snapshot', () => {
    const world = fcaDenseWorld({ ordinary: 80, episodes: 5, skills: 2 }); cleanups.push(() => world.close());
    const state = world.world.store.snapshot('owner');
    const rules = memoryWithholdingRules(state);
    expect(rules.length).toBeGreaterThan(0);
    expect(memoryWithholdingRules(state)).toBe(rules);
    const rule: MemoryWithholdingRule = { memoryId: 'm', boundary: '2026-01-01T00:00:00.000Z', wide: false, needed: 2,
      terms: Object.freeze([Object.freeze(['火山']), Object.freeze(['温泉']), Object.freeze(['登山'])]) };
    const long = `${'あ'.repeat(300)}火山の温泉`, short = '火山の温泉', other = `${'い'.repeat(300)}火山だけ`;
    for (let round = 0; round < 3; round++) {
      expect(restatesWithheldMemory(rule, long)).toBe(true);
      expect(restatesWithheldMemory(rule, short)).toBe(true);
      expect(restatesWithheldMemory(rule, other)).toBe(false);
      expect(restatesWithheldMemory(rule, 'ＡＢＣ')).toBe(false);
    }
  });

  it('holds the restatement answers to a bound over all rules (entries and characters), and answers as an uncached check does at every step', () => {
    const rules = Array.from({ length: 40 }, (_, index): MemoryWithholdingRule => Object.freeze({ memoryId: `m${index}`, boundary: '2026-01-01T00:00:00.000Z', wide: false,
      needed: 1, terms: Object.freeze([Object.freeze([`語${index}号`])]) }));
    // Texts of 600 characters fill the entry bound; texts of 20,000 characters fill the character bound long before it.
    for (const length of [600, 20_000]) {
      let mostCharacters = 0, mostEntries = 0, drops = 0, before = restatedMemoryKept().entries;
      for (let round = 0; round < 3; round++) for (const [index, rule] of rules.entries()) for (let k = 0; k < 60; k++) {
        const has = k % 2 === 0, text = `${'あ'.repeat(length - 20)}${has ? `語${index}号` : `語${index + 1}号`}${String(k).padStart(8, '0')}`;
        expect(restatesWithheldMemory(rule, text)).toBe(has);
        const held = restatedMemoryKept();
        expect(held.entries).toBeLessThanOrEqual(1_024);
        expect(held.characters).toBeLessThanOrEqual(4_000_000);
        if (held.entries < before) drops += 1;
        before = held.entries; mostEntries = Math.max(mostEntries, held.entries); mostCharacters = Math.max(mostCharacters, held.characters);
      }
      // It did hold answers (it is worth its keep), up to the bound that applies to these texts, and was dropped, not grown, when full.
      expect(drops).toBeGreaterThan(0);
      if (length === 600) expect(mostEntries).toBe(1_024); else expect(mostCharacters).toBeGreaterThan(3_000_000);
    }
  });

  it('moves the change mark for another connection\'s commit and for this one\'s row changes, not for its schema changes, with its statements prepared once', () => {
    const world = fcaDenseWorld({ ordinary: 20, episodes: 2, skills: 2 }); cleanups.push(() => world.close());
    const store = world.world.store, database = store.fcaDatabase();
    const mark = () => store.changeMark()!;
    const first = mark();
    expect(mark()).toBe(first);
    // Another connection to the same file: a commit moves the mark, a checkpoint and its reads do not.
    const other = new DatabaseSync(world.world.path);
    try {
      other.exec('CREATE TABLE IF NOT EXISTS loop_stall_mark(x INTEGER)');
      const afterOther = mark();
      expect(afterOther).not.toBe(first);
      expect(mark()).toBe(afterOther);
      other.exec('INSERT INTO loop_stall_mark VALUES (1)');
      const afterInsert = mark();
      expect(afterInsert).not.toBe(afterOther);
      other.prepare('SELECT count(*) AS n FROM loop_stall_mark').get();
      expect(mark()).toBe(afterInsert);
      // This connection: a schema change changes no row, so it does not move the mark (documented at `changeMark`); a row change does, a rolled back one too.
      database.exec('CREATE TABLE loop_stall_own(x INTEGER)');
      expect(mark()).toBe(afterInsert);
      database.exec('INSERT INTO loop_stall_own VALUES (1)');
      const afterOwn = mark();
      expect(afterOwn).not.toBe(afterInsert);
      database.exec('BEGIN; INSERT INTO loop_stall_own VALUES (2); ROLLBACK;');
      expect(mark()).not.toBe(afterOwn);
    } finally { other.close(); }
    // Statements: once the two are prepared, a mark compiles nothing.
    mark();
    const { counts } = counting([], () => { for (let call = 0; call < 200; call++) mark(); }, { statements: true });
    expect(counts.prepare).toBe(0);
  });

  it('prepares a statement once per connection and text, and answers as a fresh one does', () => {
    const world = fcaDenseWorld({ ordinary: 20, episodes: 2, skills: 2 }); cleanups.push(() => world.close());
    const database = world.world.store.fcaDatabase();
    const text = 'SELECT COUNT(*) AS n FROM experience_events WHERE scope_key = ?';
    expect(prepared(database, text)).toBe(prepared(database, text));
    expect(prepared(database, text).get('owner')).toEqual(database.prepare(text).get('owner'));
    expect(prepared(database, `${text} AND 1`)).not.toBe(prepared(database, text));
  });
});
