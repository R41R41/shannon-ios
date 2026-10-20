import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFcaReadSources, type FcaReadSourcesOptions } from '../src/wiring/fcaReadSources.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibilityPorts.js';
import { run6RecallShape } from './support/run6RecallShape.js';

/**
 * A read receipt is answered once per moment and given to every check of it (`fcaReadSourceAnswers.ts`; production run 18: 45.5 s of
 * re-asked receipts). The answers given are the ones a reader with nothing kept gives at that instant, after every kind of change that
 * can withhold a source: a skill retired or withdrawn in her skills' own database, a forget, a connection lost, the skill checks made
 * anew, and inside a transaction; and the owner no longer alone.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

function world() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Her skills are in a database of their own here (`run6RecallShape`): a skill's change does not move the turns' mark.
  const f = run6RecallShape({ turns: 200, recallingTurns: 10, tasks: 6, recalledPerTask: 10, taskRecallsOfTasks: 2, readsPerTask: 4, skills: 4 });
  cleanups.push(() => f.close());
  let clock = Date.parse(f.world.now()), connected = true;
  const skills = skillTurnPorts(f.skillMemory, scope => f.world.store.snapshot(scope), f.world.store, () => clock);
  /** The skill reads and folder questions of the reader that keeps answers (the fresh readers' are not counted). */
  const counts = { skill: 0, folder: 0 };
  const parts = (kept: boolean): FcaReadSourcesOptions => ({ ownerScope: 'owner', ownerAlone: f.ownerAlone, state: f.world.store, conversations: f.world.store,
    aetherAvailable: () => connected,
    folderAvailable: (_scope, host) => { if (kept) counts.folder += 1; return host === 'owner-mac' && connected; },
    skill: (scope, id, revision) => { if (kept) counts.skill += 1; return skills.readSource!(scope, id, revision); },
    ...(kept ? { skillChecks: (scope: string, renew: boolean) => skills.readSourceChecks!(scope, renew) } : {}) });
  const kept = createFcaReadSources(parts(true));
  f.world.store.readSourceVisible = kept;
  const receipts = [...f.skillSources, 'aether-document://doc-1', `shannon-folder://owner-mac/${'a'.repeat(64)}`];
  const times = [f.world.now(), new Date(clock - 3_600_000).toISOString()];
  let moment = { state: f.world.store.snapshot('owner') }, withholding = new MemoryWithholding(moment.state, f.world.store, 'owner');
  /** A new moment, as the guard's epoch is made anew: the state now and a withholding of it. */
  const next = () => { moment = { state: f.world.store.snapshot('owner') }; withholding = new MemoryWithholding(moment.state, f.world.store, 'owner'); };
  /** One walk of every receipt at every time: the kept reader's answers, and a fresh reader's (nothing kept) at the same instant. */
  const walk = () => {
    const shared = { state: moment.state, withholding, walk: {} }, fresh = createFcaReadSources(parts(false));
    const freshShared = { state: moment.state, withholding: new MemoryWithholding(moment.state, f.world.store, 'owner'), walk: {} };
    const answers = receipts.flatMap(id => times.map(at => withholding.withReadSnapshot(() => kept('owner', id, at, shared))));
    const expected = receipts.flatMap(id => times.map(at => freshShared.withholding.withReadSnapshot(() => fresh('owner', id, at, freshShared))));
    return { answers, expected };
  };
  const skillIds = f.skillMemory.store.all('owner').map(skill => skill.skillId);
  return { f, counts, walk, next, skillIds, receipts, setConnected: (value: boolean) => { connected = value; }, advance: (ms: number) => { clock += ms; } };
}

describe('FCA read receipts answered once a moment', () => {
  it('reads each skill once for every check of a moment, and asks a folder again each time', () => {
    const w = world();
    const first = w.walk();
    expect(first.answers).toEqual(first.expected);
    expect(first.answers.filter(Boolean).length).toBeGreaterThan(8);
    // The first check read every skill pin (one read per skill and revision: the walk's own memo), and asked the folder at each time.
    const pins = w.receipts.length - 2;
    expect(w.counts.skill).toBe(pins);
    expect(w.counts.folder).toBe(2);
    // Two more checks of the same moment: no skill read, the same answers; the folder (outside the database) is asked again each time.
    for (let check = 0; check < 2; check++) expect(w.walk().answers).toEqual(first.answers);
    expect(w.counts.skill).toBe(pins);
    expect(w.counts.folder).toBe(6);
    // A write to the turns' database is a new moment: the skills are read again.
    w.f.world.store.appendTurn('owner', 'thread-0', '次の質問', '次の返答', w.f.world.now());
    expect(w.walk().answers).toEqual(first.answers);
    expect(w.counts.skill).toBe(2 * pins);
  });

  it('gives every answer a reader with nothing kept gives, after each change that can withhold a source', () => {
    const w = world();
    const step = (what: string) => { const { answers, expected } = w.walk(); expect(answers, what).toEqual(expected); return answers; };
    const start = step('at first');
    // A connection lost, with nothing else changed: the Aether and folder receipts at once.
    w.setConnected(false);
    expect(step('disconnected')).not.toEqual(start);
    w.setConnected(true);
    expect(step('reconnected')).toEqual(start);
    // A skill retired in her skills' own database: the turns' mark has not moved.
    expect(w.f.skillMemory.retire('owner', w.skillIds[0]!, 'test', w.f.world.now())).toBe(true);
    const retired = step('retired');
    expect(retired.filter(Boolean).length).toBeLessThan(start.filter(Boolean).length);
    // A skill withdrawn from export.
    w.f.skillMemory.holdExport('owner', w.skillIds[1]!, 'withdrawn', w.f.world.now());
    const withdrawn = step('withdrawn');
    expect(withdrawn.filter(Boolean).length).toBeLessThan(retired.filter(Boolean).length);
    // The skill checks made anew (their two seconds over), under the same moment.
    w.advance(2_500);
    step('checks made anew');
    // A forget of a skill: a new state version and a new moment.
    w.f.world.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: w.skillIds[2]!, kind: 'experience', status: 'forgotten',
      pinned: false, updatedAt: w.f.world.now(), changeReason: 'owner' } });
    w.next();
    const forgotten = step('forgotten');
    expect(forgotten.filter(Boolean).length).toBeLessThan(withdrawn.filter(Boolean).length);
    // The owner no longer alone: nothing is visible.
    w.f.setAlone(false);
    expect(step('not alone').some(Boolean)).toBe(false);
    w.f.setAlone(true);
    expect(step('alone again')).toEqual(forgotten);
  });

  it('keeps nothing inside a transaction, where a read may be taken back', () => {
    const w = world();
    w.walk();
    const db = w.f.world.store.fcaDatabase();
    db.exec('BEGIN');
    try {
      const before = w.counts.skill;
      w.walk();
      const once = w.counts.skill - before;
      w.walk();
      // The kept reader reads every skill again at each check (as the fresh reader does): twice the reads of one check's fresh reader.
      expect(w.counts.skill - before).toBe(2 * once);
    } finally { db.exec('ROLLBACK'); }
  });
});
