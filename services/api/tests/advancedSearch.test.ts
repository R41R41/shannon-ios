import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { searchOptions } from '../src/infra/search/searchQuery.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { StudyStore, type StudyDraft } from '../src/mind/action/ownTime/store/studyStore.js';
import type { SQLiteAutonomyStore } from '../src/mind/action/ownTime/ownTimePorts.js';
import { OwnerUpcoming } from '../src/mind/memory/ownerUpcoming.js';
import { SQLiteUpcomingStore } from '../src/mind/memory/store/upcomingStore.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { studyExecutors } from '../src/mind/tools/shannonStudyTools.js';
import { readToolExecutors } from '../src/mind/tools/shannonReadTools.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { ToolInput } from '../src/mind/tools/shannonToolInput.js';
import type { MemoryToolPort, ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import type { FcaConversationPort } from '../src/mind/action/fca/fcaConversationPorts.js';
import { connectFcaMemoryTools } from '../src/wiring/fcaMemoryWiring.js';

const START = '2026-10-09T01:00:00.000Z';
const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(Date.parse(START) + hours * HOUR).toISOString();
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));

function studyFixture() {
  const database = new DatabaseSync(':memory:');
  cleanup.push(() => database.close());
  const study = new StudyStore(database);
  const create = (title: string, body: string, hours: number, extra: Partial<StudyDraft> = {}, scope = 'owner') => {
    const piece = study.create(scope, { kind: 'note', title, body, ...extra }, at(hours));
    if (typeof piece === 'string') throw new Error(piece);
    return piece;
  };
  return { study, create };
}

function memoryFixture() {
  const store = new SQLiteShannonStore({ path: ':memory:', now: () => START, moodHistory: null, predictionShadow: false, predictionLedger: false, choiceLedger: false });
  cleanup.push(() => store.close());
  const thread = store.createThread('owner');
  let alone = true;
  let sourceVisible = true;
  const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', now: () => START, ownerAlone: () => alone, readSourceVisible: () => sourceVisible });
  const add = (text: string, hours: number) => store.appendTurn('owner', thread, text, '記録しました。', at(hours));
  const forget = (id: string) => store.apply('owner', { type: 'memory-control-upserted', control: {
    memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: START, changeReason: 'owner requested forgetting',
    sourceEvidence: store.experiencesById('owner', [id])[0]?.userMessage,
  } });
  const context = { scopeKey: 'owner', present: OWNER_AUDIENCE, observe: (_ids: readonly string[]) => true };
  return { store, thread, memory, add, forget, context, ownerAlone: (value: boolean) => { alone = value; }, sourceVisible: (value: boolean) => { sourceVisible = value; } };
}

function scheduleFixture() {
  const store = new SQLiteUpcomingStore(':memory:');
  cleanup.push(() => store.close());
  const state = new InMemoryCompanionStateStore(() => START);
  const upcoming = new OwnerUpcoming({ store, snapshot: scope => state.snapshot(scope), now: () => START, ownerScopeKey: 'owner' });
  const calendar = (items: { id: string; title: string; hours: number; location?: string }[]) => store.replaceCalendar('owner', 'local', {
    generatedAt: START, timeZone: 'Asia/Tokyo', windowStart: START, windowEnd: at(31 * 24),
    events: items.map(item => ({ id: item.id, title: item.title, start: at(item.hours), end: at(item.hours + 1), allDay: false,
      ...(item.location ? { location: item.location } : {}) })),
  }, START);
  return { store, state, upcoming, calendar };
}

describe('advanced search input boundaries', () => {
  it('normalizes timezone-bearing instants and rejects unordered ranges and invalid pagination', () => {
    expect(searchOptions({ after: '2026-10-09T10:00:00+09:00', before: '2026-10-10T10:00:00+09:00', offset: 1000 })).toEqual({ after: START, before: at(24), offset: 1000 });
    for (const input of [{ after: '2026-10-09' }, { after: START, before: START }, { offset: -1 }, { offset: 0.5 }, { offset: 1001 }, { match: 'regex' }]) {
      expect(() => searchOptions(input)).toThrow();
    }
  });

  it('rejects impossible dates rather than silently searching a different day', () => {
    expect(() => searchOptions({ after: '2026-02-30T00:00:00Z' })).toThrow('SEARCH_DATE_INVALID');
  });
});

describe('SQLite study search', () => {
  it('applies field, term, kind, status, scope and date filters before pagination', () => {
    const { study, create } = studyFixture();
    create('alpha beta hidden by date', 'body', 0);
    const first = create('alpha', 'beta first', 1);
    const second = create('alpha', 'beta second', 2);
    create('alpha beta story', 'body', 2.5, { kind: 'story' });
    create('alpha beta other scope', 'body', 2.5, {}, 'other');
    create('alpha beta exclusive boundary', 'body', 3);
    const options = { match: 'all' as const, kind: 'note' as const, status: 'ready' as const, after: at(1), before: at(3), order: 'oldest' as const };
    expect(study.search('owner', 'alpha beta', 1, 'exclude', options).map(row => row.id)).toEqual([first.id]);
    expect(study.search('owner', 'alpha beta', 1, 'exclude', { ...options, offset: 1 }).map(row => row.id)).toEqual([second.id]);
    expect(study.search('owner', 'alpha beta', 10, 'exclude', { ...options, field: 'title' })).toEqual([]);
    expect(study.search('owner', 'first absent', 10, 'exclude', { ...options, field: 'body', match: 'any' }).map(row => row.id)).toEqual([first.id]);
    expect(study.search('owner', 'alpha beta', 10, 'exclude', { ...options, match: 'phrase' })).toEqual([]);
  });

  it('keeps SQL wildcard and quotation characters literal', () => {
    const { study, create } = studyFixture();
    const exact = create('literal 100%_\\ "quoted"', 'body', 1);
    create('literal 100percentX "quoted"', 'body', 2);
    expect(study.search('owner', '100%_\\', 10, 'exclude', {}).map(row => row.id)).toEqual([exact.id]);
    expect(study.search('owner', "' OR 1=1 --", 10, 'exclude', {})).toEqual([]);
  });

  it('keeps trash restorable with all versions and searches the current body only', () => {
    const { study, create } = studyFixture();
    const piece = create('retained note', 'previous unique wording', 0);
    expect(study.revise('owner', piece.id, { body: 'current unique wording', changeNote: 'clarified wording' }, at(1))).toMatchObject({ version: 2 });
    expect(study.search('owner', 'previous unique', 10, 'include', {})).toEqual([]);
    study.softDelete('owner', piece.id, at(2));
    expect(study.search('owner', 'current unique', 10, 'exclude', {})).toEqual([]);
    expect(study.search('owner', 'current unique', 10, 'only', {}).map(row => row.id)).toEqual([piece.id]);
    expect(study.versions('owner', piece.id).map(row => row.body)).toEqual(['previous unique wording', 'current unique wording']);
    study.restore('owner', piece.id, at(3));
    expect(study.search('owner', 'current unique', 10, 'exclude', {}).map(row => row.id)).toEqual([piece.id]);
  });

  it('preserves searchable informed pieces and returns provenance for exactly the selected page', async () => {
    const { study, create } = studyFixture();
    const first = create('alpha visible first', 'body', 1);
    const second = create('alpha visible second', 'body', 2);
    const hidden = create('alpha unlisted private', 'body', 3);
    const executors = studyExecutors({ study } as SQLiteAutonomyStore, () => START);
    const prepared = executors['study.search']!({ query: 'alpha', limit: 1, offset: 1, order: 'newest' }, {
      scopeKey: 'owner', surface: 'autonomy', audience: 'owner_alone', memory: toolSessionMemory(),
      unlisted: id => id === `shannon-study://${hidden.id}`,
    });
    if (!('run' in prepared)) throw new Error('search was not prepared');
    const result = await prepared.run();
    expect(result.result.text).toContain(second.title);
    expect(result.result.text).not.toContain(first.title);
    expect(result.result.text).not.toContain(hidden.title);
    expect(result.documents?.read).toEqual([`shannon-study://${second.id}`]);
    expect(result.result.text).toContain('1件:');
  });

  it('returns a nonretryable input failure for invalid date and excessive all-term searches', () => {
    const { study, create } = studyFixture();
    create('alpha note', 'body', 1);
    const execute = studyExecutors({ study } as SQLiteAutonomyStore, () => START)['study.search']!;
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    const invalid: ToolInput[] = [{ query: 'alpha', after: '2026-02-30T00:00:00Z' }, { query: Array.from({ length: 17 }, (_, i) => `t${i}`).join(' '), match: 'all' }];
    for (const input of invalid) {
      expect(execute(input, context)).toMatchObject({ ok: false, failure: 'invalid_input', retryable: false });
    }
  });
});

describe('SQLite task memory search', () => {
  it('filters forgotten rows before offset even when they fill more than one forty-row read batch', async () => {
    const f = memoryFixture();
    const oldest = f.add('spectrometer visible oldest', -3);
    const middle = f.add('spectrometer visible middle', -2);
    const newest = f.add('spectrometer visible newest', -1);
    for (let index = 0; index < 45; index++) f.forget(f.store.appendTurn('owner', f.thread, `秘密の電話番号${index}`, 'spectrometer forgotten account', at(index)).id);
    const observed: string[][] = [];
    const result = await f.memory.execute('memory.search', { query: 'spectrometer', kind: 'experience', match: 'phrase', order: 'newest', offset: 1, limit: 1 }, {
      ...f.context, observe: ids => { observed.push([...ids]); return true; },
    });
    expect(result.status).toBe('ready');
    expect(result.items.map(item => item.id)).toEqual([middle.id]);
    expect(result.sourceIds).toEqual([middle.id]);
    expect(observed).toEqual([[middle.id]]);
    expect(result.search).toEqual({ coverage: 'bounded_candidates', candidateLimit: 1200, offset: 1, limit: 1 });
    expect(JSON.stringify(result)).not.toContain('forgotten');
    expect(result.items[0]).toMatchObject({ observedAt: middle.observedAt, applicability: 'recorded observation' });
    expect(f.memory.search('owner', 'spectrometer', OWNER_AUDIENCE, 40, { order: 'oldest', kind: 'experience' }).map(row => row.id)).toEqual([oldest.id, middle.id, newest.id]);
  });

  it('combines literal matching, date intervals and chronological order while preserving query-only behavior', async () => {
    const f = memoryFixture();
    const first = f.add('alpha beta 100%_\\', -3);
    const second = f.add('beta alpha', -2);
    f.add('alpha unrelated', -1);
    const search = (input: Record<string, unknown>) => f.memory.execute('memory.search', input, f.context);
    expect((await search({ query: 'alpha beta', match: 'all', after: at(-3), before: at(-1), order: 'oldest', limit: 10 })).items.map(row => row.id)).toEqual([first.id, second.id]);
    expect((await search({ query: 'alpha beta', match: 'phrase', order: 'oldest' })).items.map(row => row.id)).toEqual([first.id]);
    expect((await search({ query: '100%_\\', match: 'phrase' })).items.map(row => row.id)).toEqual([first.id]);
    const legacy = await search({ query: 'alpha' });
    expect(legacy.search).toBeUndefined();
    expect(legacy.items.map(row => row.id)).toEqual(f.memory.search('owner', 'alpha', OWNER_AUDIENCE).map(row => row.id));
  });

  it('sorts source timestamps by instant when their timezone spellings differ', async () => {
    const f = memoryFixture();
    const earlier = f.store.appendTurn('owner', f.thread, 'spectrometer earlier', 'recorded', '2026-10-09T10:00:00+09:00');
    const later = f.store.appendTurn('owner', f.thread, 'spectrometer later', 'recorded', '2026-10-09T02:00:00.000Z');
    const result = await f.memory.execute('memory.search', { query: 'spectrometer', kind: 'experience', order: 'oldest', after: START, before: at(2) }, f.context);
    expect(result.items.map(row => row.id)).toEqual([earlier.id, later.id]);
    expect(result.items.map(row => row.observedAt)).toEqual([earlier.observedAt, later.observedAt]);
  });

  it('searches knowledge with original evidence and rechecks its outside source availability', async () => {
    const f = memoryFixture(), source = f.add('original telescope measurements', -2);
    const document = f.store.createShannonKnowledge('owner', {
      title: 'spectrometer calibration', bodyMarkdown: '## Result\nCalibration requires a reference.', status: 'hypothesis',
      applicability: 'only while the reference is current', sourceExperienceIds: [source.id], aetherReferences: [{ documentId: 'reference-one', version: 1 }],
    }, at(-1), 'organized original evidence');
    const input = { query: 'spectrometer', kind: 'knowledge', match: 'phrase' };
    const result = await f.memory.execute('memory.search', input, f.context);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: `knowledge:${document.id}`, observedAt: at(-1), applicability: document.applicability, evidence: source.id });
    expect(result.sourceIds).toEqual([`knowledge:${document.id}`, source.id]);
    expect(await f.memory.execute('memory.search', input, {
      ...f.context, observe: () => { f.sourceVisible(false); return true; },
    })).toEqual({ status: 'withheld', items: [], sourceIds: [] });
    expect((await f.memory.execute('memory.search', input, f.context)).items).toEqual([]);
  });

  it('withholds a derived experience and summary when their source was forgotten', async () => {
    const f = memoryFixture();
    const source = f.add('original private detail', -3);
    const derived = f.store.appendTurn('owner', f.thread, 'spectrometer derived account', 'spectrometer summary', at(-2), {
      capturedStateVersion: 0, messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' },
      recalledMemoryIds: [source.id], threadSummary: 'spectrometer rolling summary',
    });
    expect((await f.memory.execute('memory.search', { query: 'spectrometer', match: 'phrase' }, f.context)).items.map(row => row.id)).toContain(derived.id);
    f.forget(source.id);
    const result = await f.memory.execute('memory.search', { query: 'spectrometer', match: 'phrase' }, f.context);
    expect(result).toMatchObject({ status: 'no_match', items: [], sourceIds: [] });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('excludes archived summaries and never releases results to another scope, audience or changed owner presence', async () => {
    const f = memoryFixture();
    f.store.appendTurn('owner', f.thread, 'spectrometer account', 'recorded', at(-1), {
      capturedStateVersion: 0, messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' }, threadSummary: 'spectrometer rolling summary',
    });
    const input = { query: 'spectrometer', kind: 'thread', match: 'phrase' };
    expect((await f.memory.execute('memory.search', input, f.context)).items.map(row => row.id)).toEqual([`thread:${f.thread}`]);
    f.store.archiveThread('owner', f.thread);
    expect((await f.memory.execute('memory.search', input, f.context)).items).toEqual([]);
    expect(await f.memory.execute('memory.search', input, { ...f.context, scopeKey: 'other' })).toEqual({ status: 'withheld', items: [], sourceIds: [] });
    expect(await f.memory.execute('memory.search', input, { ...f.context, present: { kind: 'group', groupKey: 'public' } })).toEqual({ status: 'withheld', items: [], sourceIds: [] });
    expect(await f.memory.execute('memory.search', { query: 'spectrometer', kind: 'experience' }, {
      ...f.context, observe: () => { f.ownerAlone(false); return true; },
    })).toEqual({ status: 'withheld', items: [], sourceIds: [] });
  });

  it('rechecks forgetting after the provenance observation callback', async () => {
    const f = memoryFixture(), source = f.add('spectrometer observation', -1);
    expect(await f.memory.execute('memory.search', { query: 'spectrometer', match: 'phrase' }, {
      ...f.context, observe: () => { f.forget(source.id); return true; },
    })).toEqual({ status: 'withheld', items: [], sourceIds: [] });
  });

  it('the native task bridge returns invalid_input without observing or retrying invalid searches', async () => {
    const f = memoryFixture();
    let memoryPort: MemoryToolPort | undefined;
    connectFcaMemoryTools({
      tools: { useMemory: (port: MemoryToolPort) => { memoryPort = port; } } as ShannonToolRunner,
      memory: f.memory, conversation: { taskToolsAvailable: () => true, observeSources: () => { throw new Error('must not observe invalid inputs'); } } as unknown as FcaConversationPort,
      ownerScope: 'owner', ownerAlone: () => true,
    });
    if (!memoryPort) throw new Error('memory port not connected');
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    for (const input of [{ query: 'alpha', before: 'not an instant' }, { query: 'alpha', offset: 1001 }, { query: 'alpha', limit: 41 }]) {
      expect(await memoryPort.execute('memory.search', input, context)).toMatchObject({ ok: false, failure: 'invalid_input', retryable: false });
    }
  });
});

describe('received schedule search', () => {
  it('filters title and location before pagination and exposes only the returned closed source subjects', () => {
    const f = scheduleFixture();
    f.calendar([{ id: 'noise', title: 'unrelated', hours: 1 }, { id: 'one', title: '100%_ review', location: 'Tokyo', hours: 2 },
      { id: 'two', title: '100%_ review', location: 'Tokyo', hours: 3 }, { id: 'not-literal', title: '100percentX review', location: 'Tokyo', hours: 4 }]);
    const result = f.upcoming.searchWithSources('owner', { query: '100%_ Tokyo', kind: 'calendar', offset: 1, limit: 1 });
    expect(result.sourceIds).toEqual([`calendar:two@${at(3)}`]);
    expect(result.prompt).toContain(`calendar:two@${at(3)}`);
    expect(result.prompt).not.toContain('calendar:one@');
    expect(result.prompt).not.toContain('unrelated');
    expect(result.prompt).toContain('受信済み');
  });

  it('judges snapshot freshness at observation time when the search begins tomorrow', () => {
    const f = scheduleFixture();
    f.store.replaceTasks('owner', 'voyager', [{ id: 'fresh', title: 'tomorrow task', dueAt: at(25) }], START);
    const result = f.upcoming.searchWithSources('owner', { kind: 'task', after: at(24), before: at(48) });
    expect(result.sourceIds).toEqual(['task:fresh']);
    expect(result.prompt).toContain('tomorrow task');
  });

  it('retains day versus week horizons when optional search conditions are present', () => {
    const f = scheduleFixture();
    f.calendar([{ id: 'today', title: 'review today', hours: 2 }, { id: 'later', title: 'review next week', hours: 72 }]);
    expect(f.upcoming.searchWithSources('owner', { query: 'review', range: 'day' }).sourceIds).toEqual([`calendar:today@${at(2)}`]);
    expect(f.upcoming.searchWithSources('owner', { query: 'review', range: 'week' }).sourceIds).toEqual([`calendar:today@${at(2)}`, `calendar:later@${at(72)}`]);
  });

  it('the schedule executor reports impossible and out-of-bounds dates as invalid_input', async () => {
    const f = scheduleFixture();
    const executor = readToolExecutors({ upcoming: () => '', upcomingSearch: (scope, input) => {
      const result = f.upcoming.searchWithSources(scope, input);
      return { text: result.prompt, sourceIds: result.sourceIds };
    } })['schedule.upcoming']!;
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    const invalid: ToolInput[] = [{ after: '2026-02-30T00:00:00Z' }, { after: at(-1) }, { before: at(32 * 24) }];
    for (const input of invalid) {
      const prepared = executor(input, context);
      if (!('run' in prepared)) throw new Error('schedule search not prepared');
      expect((await prepared.run()).result).toMatchObject({ ok: false, failure: 'invalid_input', retryable: false });
    }
  });

  it('drops stale tasks and forgotten promises without hidden counts or provenance', () => {
    const f = scheduleFixture();
    f.store.replaceTasks('owner', 'voyager', [{ id: 'stale', title: 'stale secret task', dueAt: at(3) }], at(-7));
    f.state.apply('owner', { type: 'prospective-memory-upserted', memory: { id: 'forgotten', summary: 'forgotten secret promise', status: 'pending', createdAt: START, updatedAt: START, dueAt: at(3) } });
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'forgotten', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: START, changeReason: 'owner requested forgetting' } });
    const result = f.upcoming.searchWithSources('owner', {});
    expect(result.sourceIds).toEqual([]);
    expect(result.prompt).not.toContain('secret');
    expect(result.prompt).not.toContain('forgotten');
    expect(result.prompt).toContain('この検索条件では見つからなかった');
  });

  it('applies exclusive instant boundaries to all-day promises as well as timed promises', () => {
    const f = scheduleFixture();
    for (const [id, dueDate] of [['same-day', '2026-10-09'], ['next-day', '2026-10-10']] as const) {
      f.state.apply('owner', { type: 'prospective-memory-upserted', memory: { id, summary: id, dueDate, timeZone: 'Asia/Tokyo', status: 'pending', createdAt: START, updatedAt: START } });
    }
    const result = f.upcoming.searchWithSources('owner', { kind: 'promise', after: START, before: '2026-10-09T15:00:00.000Z' });
    expect(result.sourceIds).toEqual([]);
  });

  it('preserves the twelve-line legacy projection cap while rich search can request fifty', () => {
    const f = scheduleFixture();
    f.calendar(Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: `meeting ${index}`, hours: index + 1 })));
    expect(f.upcoming.upcomingForOwner('owner', START, 24 * HOUR, { limit: 500 })).toHaveLength(12);
    expect(f.upcoming.searchWithSources('owner', { kind: 'calendar', limit: 50 }).sourceIds).toHaveLength(20);
    expect(f.upcoming.promptWithSources('owner', '今日の予定は？').sourceIds).toHaveLength(12);
  });
});
