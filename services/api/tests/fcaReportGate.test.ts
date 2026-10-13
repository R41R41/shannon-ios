import { describe, expect, it } from 'vitest';
import { gatedProgress, reportGateDecision, reportGates, type ReportGateParts } from '../src/mind/action/fca/fcaReportGate.js';
import { createReportCards, REPORT_CARD_RECHECK_MS, REPORT_CARD_SPOKEN_WAIT_MS, REPORT_CARD_WINDOW_MS } from '../src/mind/action/fca/fcaReportCards.js';
import type { TaskProgress } from '../src/mind/action/taskRuntime/taskProgressPorts.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaConversationTurn } from '../src/mind/action/fca/fcaConversationPorts.js';
import { admitVoiceResearch, researchAfterAck, researchHeardInTurn, researchSaid } from '../src/surfaces/voice/voiceResearchTurn.js';
import { RESEARCH_UNDER_WAY_LINE, TURN_OUT_OF_TIME_LINE } from '../src/mind/action/respond/turnDeadline.js';

const noon = Date.parse('2026-10-13T03:00:00.000Z'); // 12:00 in Tokyo.
const night = Date.parse('2026-10-12T20:20:00.000Z'); // 5:20 in Tokyo.
const minutes = (value: number) => value * 60_000;
const iso = (value: number) => new Date(value).toISOString();

function task(id: string, goal: string, createdAt: number, phase = 'completed', extra: Partial<TaskView> = {}): TaskView {
  return { id, scopeKey: 'owner', parentId: 'conversation', kind: 'research', origin: 'owner_request', title: goal, goal, completionCriteria: '',
    status: phase === 'completed' ? 'completed' : 'active', pauseReason: null, summary: '', revision: 1, createdAt: iso(createdAt),
    updatedAt: iso(createdAt + minutes(1)), phase, childIds: [], ...extra } as TaskView;
}
function progress(text: string, updatedAt: number, status: TaskProgress['status'] = 'received', extra: Partial<NonNullable<TaskProgress['report']>> = {}): TaskProgress {
  return { currentStep: 'fca.result', status, startedAt: iso(updatedAt), updatedAt: iso(updatedAt), findings: [],
    report: { id: `r-${text.length}-${updatedAt}`, text, updatedAt: iso(updatedAt), ...extra } };
}
function world(at: number, tasks: Array<[TaskView, TaskProgress | null]>, history: Array<{ role: 'user' | 'assistant'; content: string; observedAt: string }> = [],
  steps: Record<string, string> = {}) {
  const parts: ReportGateParts = {
    ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => at, history: () => history,
    runtime: {
      get: (_scope, id) => tasks.find(([item]) => item.id === id)?.[0] ?? null,
      list: (_scope, options) => tasks.map(([item]) => item).filter(item => !options?.parentId || item.parentId === options.parentId),
      progress: (_scope, id) => tasks.find(([item]) => item.id === id)?.[1] ?? null,
      taskSources: (_scope, id) => [{ stepId: steps[id] ?? 's', experienceId: 'e', threadId: 'thread', observedAt: iso(at), recalledMemoryIds: [] }],
    } as ReportGateParts['runtime'],
  };
  const decide = (id: string, view: 'card' | 'call' = 'card') => {
    const [item, seen] = tasks.find(([entry]) => entry.id === id)!;
    return reportGateDecision(parts, item, seen!, view);
  };
  return { parts, decide };
}

describe('which report reaches him (owner decision 2026-10-13)', () => {
  it('sends no 「調べきれなかった」 for a request a sibling answered or still works on, and one notice for two failures', () => {
    const asked = noon - minutes(15);
    const answered = world(noon, [
      [task('a', '17時に博多空港にいるには何時に出ればいい？', asked), progress('地下鉄で16分です。', asked + minutes(1))],
      [task('b', '大濠公園から博多空港の出発時刻', asked + 10_000, 'failed'), progress('調べきれませんでした。', asked + minutes(11), 'failed')],
    ]);
    // One turn's two tasks about the same thing (the router's for his words, the model's own question): one request.
    expect(answered.decide('b')).toBe('drop');
    expect(answered.decide('a')).toBe('deliver');
    const running = world(noon, [
      [task('a', '明日の天気', asked, 'executing'), null],
      [task('b', '明日の天気', asked + minutes(30), 'failed'), progress('止まりました。', asked + minutes(31), 'failed')],
    ]);
    expect(running.decide('b')).toBe('drop');
    const twice = world(noon, [
      [task('a', '明日の天気', asked, 'failed'), progress('止まりました。', asked + minutes(5), 'failed')],
      [task('b', '明日の天気', asked + minutes(1), 'failed'), progress('止まりました。', asked + minutes(6), 'failed')],
    ]);
    expect([twice.decide('a'), twice.decide('b')]).toEqual(['drop', 'deliver']);
  });

  it('reads a sibling\'s provenance only when it is about the same thing (2026-10-13: the scan read every sibling\'s sources)', () => {
    const tasks: Array<[TaskView, TaskProgress | null]> = [[task('a', '明日の東京の天気を調べる', noon - minutes(30)), progress('晴れ。', noon - minutes(20))]];
    for (let index = 0; index < 30; index++) tasks.push([task(`o${index}`, `新幹線の時刻その${index}を探す`, noon - minutes(40)), progress('x', noon - minutes(35))]);
    const { parts, decide } = world(noon, tasks);
    const read: string[] = [];
    const sources = parts.runtime.taskSources;
    parts.runtime.taskSources = (scope, id, ...rest) => { read.push(id); return sources(scope, id, ...rest); };
    expect(decide('a')).toBe('deliver');
    expect(read.filter(id => id !== 'a')).toEqual([]);
  });

  it('never takes two requests for one by time alone (review: the weather, then the shinkansen 30 s later)', () => {
    const asked = noon - minutes(10);
    const weather = task('a', '明日の東京の天気調べて', asked, 'executing'), train = task('b', 'あと新幹線の時刻も調べて', asked + 30_000);
    const apart = world(noon, [[weather, null], [train, progress('のぞみは毎時6本です。', asked + minutes(2))]], [], { a: 's1', b: 's2' });
    expect(apart.decide('b')).toBe('deliver');
    const failedTrain = world(noon, [[weather, null], [{ ...train, phase: 'failed' } as TaskView, progress('止まりました。', asked + minutes(2), 'failed')]], [], { a: 's1', b: 's2' });
    expect(failedTrain.decide('b')).toBe('deliver');
    // Even in one turn, two different things are two requests.
    const oneTurn = world(noon, [[{ ...weather, phase: 'completed' } as TaskView, progress('晴れです。', asked + minutes(1))],
      [train, progress('のぞみは毎時6本です。', asked + minutes(2))]]);
    expect([oneTurn.decide('a'), oneTurn.decide('b')]).toEqual(['deliver', 'deliver']);
  });

  it('gives one answer for one request: the first one; one said in its turn keeps its card and is never said again', () => {
    const asked = noon - minutes(10);
    const two = world(noon, [
      [task('a', '明日の天気は？', asked), progress('晴れです。', asked + minutes(1))],
      [task('b', '明日の天気は?', asked + minutes(5)), progress('晴れの予報です。', asked + minutes(6))],
    ]);
    expect([two.decide('a'), two.decide('b')]).toEqual(['deliver', 'drop']);
    const heard = world(noon, [[task('a', '明日の天気', asked), progress('晴れです。', asked + minutes(1), 'received', { heard: true })]]);
    expect([heard.decide('a', 'card'), heard.decide('a', 'call')]).toEqual(['deliver', 'drop']);
    // Said in a call at night: the card with its sources is in the Talk at once, not held for the morning.
    const atNight = world(night, [[task('a', '明日の天気', night - minutes(1)), progress('晴れです。', night, 'received', { heard: true })]]);
    expect([atNight.decide('a', 'card'), atNight.decide('a', 'call')]).toEqual(['deliver', 'drop']);
    const said = gatedProgress(heard.parts, id => heard.parts.runtime.progress!('owner', id), 'card')('a');
    expect(said?.report).toMatchObject({ text: '晴れです。', heard: true });
    expect(gatedProgress(heard.parts, id => heard.parts.runtime.progress!('owner', id), 'call')('a')?.report).toBeUndefined();
  });

  it('drops a failure an hour late, and a late result once he has talked about the same thing after it finished', () => {
    const asked = noon - minutes(400), finished = asked + minutes(10);
    expect(world(noon, [[task('a', '太宰府天満宮の太宰の語源', asked, 'failed'), progress('止まりました。', noon, 'failed')]]).decide('a')).toBe('drop');
    const later = [{ role: 'user' as const, content: '太宰府の由来ってなんだっけ', observedAt: iso(asked + minutes(200)) }];
    expect(world(noon, [[task('a', '太宰府天満宮の太宰の語源', asked), progress('大宰府に由来します。', finished)]], later).decide('a')).toBe('drop');
    // His asking message, and talk before the result existed, do not count; nor does one generic word in common.
    const asking = [{ role: 'user' as const, content: '太宰府天満宮の太宰の語源を調べて', observedAt: iso(asked) }];
    expect(world(noon, [[task('a', '太宰府天満宮の太宰の語源', asked), progress('大宰府に由来します。', finished)]], asking).decide('a')).toBe('deliver');
    const generic = [{ role: 'user' as const, content: '明日の天気を確認して', observedAt: iso(asked + minutes(200)) }];
    expect(world(noon, [[task('a', '明日の天気を確認して時間を教えて', asked), progress('晴れです。', finished)]], generic).decide('a')).toBe('deliver');
    const other = [{ role: 'user' as const, content: 'お腹すいた', observedAt: iso(asked + minutes(200)) }];
    expect(world(noon, [[task('a', '太宰府天満宮の太宰の語源', asked), progress('大宰府に由来します。', finished)]], other).decide('a')).toBe('deliver');
  });

  it('holds a result in his quiet hours until morning, unless he is talking in that Talk right now', () => {
    const asked = night - minutes(30);
    const quiet = world(night, [[task('a', 'アベンジャーズの最新作の公開日', asked), progress('12月18日公開です。', night)]]);
    expect(quiet.decide('a')).toBe('hold');
    const talking = world(night, [[task('a', 'アベンジャーズの最新作の公開日', asked), progress('12月18日公開です。', night)]],
      [{ role: 'user', content: 'まだ起きてるよ', observedAt: iso(night - minutes(2)) }]);
    expect(talking.decide('a')).toBe('deliver');
    // The card waits; the call (only spoken while he is in it) does not hold, it only drops.
    const card = gatedProgress(quiet.parts, id => quiet.parts.runtime.progress!('owner', id), 'card')('a');
    const call = gatedProgress(quiet.parts, id => quiet.parts.runtime.progress!('owner', id), 'call')('a');
    expect(card?.report).toBeUndefined();
    expect(call?.report?.text).toBe('12月18日公開です。');
  });
});

describe('a voice turn\'s research', () => {
  it('asks the research what her offer was about when he only said yes to it', () => {
    let goal = '';
    const turn = { delegate: (spec: { goal: string }) => { goal = spec.goal; return { id: 'w' } as TaskView; } } as unknown as FcaConversationTurn;
    admitVoiceResearch(turn, { transcript: 'うん、お願い', research: true, places: undefined, at: iso(noon), timeZone: 'Asia/Tokyo',
      route: { transcript: 'うん、お願い', participantMode: 'owner', context: [{ role: 'user', content: '博多の天気は？' }, { role: 'assistant', content: '晴れです。東京の天気も見ますか？' }] } });
    expect(goal).toBe('ライ氏「博多の天気は？」 → ボク「東京の天気も見ますか？」 → ライ氏「うん、お願い」');
  });

  it('says a result that arrives within the wait in the same turn and marks it heard; nothing otherwise', async () => {
    const said: string[] = [], heard: string[] = [];
    const report = { id: 'r1', text: '## 経路\n- 大濠公園から福岡空港は地下鉄で16分ほどです。\n出典: https://example.com', updatedAt: iso(noon) };
    const turn = { awaitWork: async () => ({ taskId: 'w', title: '空港まで', report }), hearWork: (id: string, reportId: string) => { heard.push(`${id}:${reportId}`); return true; } } as unknown as FcaConversationTurn;
    const say = (text: string) => { said.push(text); };
    const spoken = await researchHeardInTurn(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { before: 'ちょっと調べてみますね。', say });
    expect(spoken).toBe('大濠公園から福岡空港は地下鉄で16分ほどです。');
    expect(said).toEqual([spoken]);
    expect(heard).toEqual(['w:r1']);
    // An acknowledgement left open is closed first, in the text and in what the stream cuts into sentences.
    expect(await researchHeardInTurn(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { before: 'ちょっと調べてみますね', say }))
      .toBe('。大濠公園から福岡空港は地下鉄で16分ほどです。');
    const late = await researchHeardInTurn(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() - 30_000 }, { before: '', say });
    expect(late).toBe('');
    expect(await researchHeardInTurn(turn, { work: null, admittedAt: performance.now() }, { before: '', say })).toBe('');
    expect(said).toHaveLength(2);
    // Owner test 2026-10-13: the acknowledgement already went out before the wait; the result is said as its own sentence.
    said.length = 0;
    expect(await researchHeardInTurn(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { before: 'ちょっと調べてみますね', say, flushed: true }))
      .toBe('。大濠公園から福岡空港は地下鉄で16分ほどです。');
    expect(said).toEqual(['大濠公園から福岡空港は地下鉄で16分ほどです。']);
    // Review of 1a647abc: a reply cut at its length limit flushes nothing (half a sentence) and says nothing after it.
    said.length = 0;
    let flushes = 0;
    const stream = { onTextDelta: say, flushSpoken: async () => { flushes += 1; } };
    expect(await researchAfterAck(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { reply: 'ちょっと調べて', truncated: true }, stream))
      .toEqual({ acknowledged: 'ちょっと調べて', heard: '' });
    expect([flushes, said]).toEqual([0, []]);
    expect((await researchAfterAck(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { reply: '「ちょっと調べてみますね」' }, stream)))
      .toEqual({ acknowledged: 'ちょっと調べてみますね。', heard: '大濠公園から福岡空港は地下鉄で16分ほどです。' });
    expect([flushes, said]).toEqual([1, ['大濠公園から福岡空港は地下鉄で16分ほどです。']]);
    // Cut off while it was being said: not marked heard, so the card and the call still deliver it.
    const controller = new AbortController();
    heard.length = 0;
    await researchHeardInTurn(turn, { work: { id: 'w' } as TaskView, admittedAt: performance.now() }, { before: '', say: () => { controller.abort(); } }, controller.signal);
    expect(heard).toEqual([]);
  });

  it('never ends a turn whose research runs on with 「時間が足りなかった」', () => {
    expect(researchSaid(TURN_OUT_OF_TIME_LINE, { id: 'w' } as TaskView)).toBe(RESEARCH_UNDER_WAY_LINE);
    expect(researchSaid(TURN_OUT_OF_TIME_LINE, null)).toBe(TURN_OUT_OF_TIME_LINE);
  });
});

describe('the card scan and a held report (review 2026-10-13)', () => {
  it('writes a report held overnight even after forty newer tasks pushed it out of the recent scan', async () => {
    const { createReportCards, REPORT_CARD_RECHECK_MS } = await import('../src/mind/action/fca/fcaReportCards.js');
    let at = night;
    const parent = { ...task('conversation', '', night), kind: 'conversation', parentId: null } as TaskView;
    const held = task('held', 'アベンジャーズの最新作の公開日', night - minutes(30));
    const newer = Array.from({ length: 40 }, (_, index) => ({ ...task(`n${index}`, `別件${index}`, night), phase: 'executing' }) as TaskView);
    let morning = false, scanned: TaskView[] = [held];
    const written: string[] = [];
    const full = progress('12月18日公開です。', night, 'received', { spoken: '12月18日公開です。' });
    const cards = createReportCards({
      ownerScope: 'owner', now: () => at,
      runtime: { list: () => scanned, get: (_scope: string, id: string) => id === 'conversation' ? parent : id === 'held' ? held : null,
        taskSources: () => [{ stepId: 's', experienceId: 'e', threadId: 'thread', observedAt: iso(night), recalledMemoryIds: [] }] } as never,
      conversations: { assistantMessage: () => null, appendReportCardOnce: (_scope: string, _thread: string, id: string) => { written.push(id); return true; } } as never,
      shown: id => id !== 'held' ? null : morning ? full : { ...full, report: undefined },
    });
    expect(cards.tick()).toBe(0); // Held: seen without its report.
    scanned = newer; morning = true;
    at += 2 * REPORT_CARD_RECHECK_MS; // A held report is looked at again after a recheck window, not every scan.
    expect(cards.tick()).toBe(1);
    expect(written).toHaveLength(1);
  });
});

/**
 * The card scan with the gate first (2026-10-13, after 2d3820fe: a held or dropped report's visibility walk still cost 160–1,300 ms
 * a scan, every 60–120 s for a day). `shown` stands for the visibility walk: it is counted, and must not run for a report the gate
 * holds or drops.
 */
function gateFirst(start: number, entries: Array<[TaskView, TaskProgress | null]>, walk?: (id: string) => TaskProgress | null) {
  const clock = { at: start };
  const messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; observedAt: string }> = [];
  const parent = { ...task('conversation', '', start), kind: 'conversation', parentId: null } as TaskView;
  const find = (id: string) => entries.find(([item]) => item.id === id);
  const runtime = {
    get: (_scope: string, id: string) => id === parent.id ? parent : find(id)?.[0] ?? null,
    list: (_scope: string, options?: { parentId?: string }) => entries.map(([item]) => item).filter(item => !options?.parentId || item.parentId === options.parentId),
    progress: (_scope: string, id: string) => find(id)?.[1] ?? null,
    taskSources: () => [{ stepId: 's', experienceId: 'e', threadId: 'thread', observedAt: iso(start), recalledMemoryIds: [] }],
  } as unknown as ReportGateParts['runtime'];
  const recentThreadMessages = (_scope: string, _thread: string, limit: number) => messages.slice(-limit);
  const gates = reportGates({ runtime, ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => clock.at,
    conversations: { recentThreadMessages, conversationHistory: () => messages } }, id => runtime.progress!('owner', id));
  const counts = { shown: 0, verdicts: 0 }, shown: string[] = [], written: string[] = [], lines: string[] = [];
  const cards = createReportCards({ runtime: runtime as never, ownerScope: 'owner', now: () => clock.at, ownerAlone: () => true,
    conversations: { assistantMessage: () => null, appendReportCardOnce: (_scope: string, _thread: string, _id: string, note: { card: { taskId: string } }) => {
      written.push(note.card.taskId); return true; }, recentThreadMessages } as never,
    shown: id => { counts.shown += 1; shown.push(id); return walk ? walk(id) : runtime.progress!('owner', id); },
    gate: { verdict: (item, seen) => { counts.verdicts += 1; return gates.cardGate.verdict(item, seen); }, quiet: gates.cardGate.quiet },
    log: line => lines.push(line) });
  const scan = (scans: number, step = 5_000) => { for (let index = 0; index < scans; index++) { cards.tick(); clock.at += step; } };
  return { clock, messages, counts, shown, written, lines, cards, scan, entries };
}
/** A distinct thing to ask about per index (two kanji of its own: no two share a topic piece, none contains another). */
const about = (index: number) => `${String.fromCharCode(0x4e00 + index * 2)}${String.fromCharCode(0x4e01 + index * 2)}について`;
const morning = Date.parse('2026-10-12T22:00:00.000Z'); // 7:00 in Tokyo, the morning after `night`.

describe('the card scan asks the gate first (2026-10-13: 160–1,300 ms a scan for held and dropped reports)', () => {
  it('walks no sources for a report it holds or drops, and asks the gate about them once while nothing changes', () => {
    const asked = night - minutes(30);
    const w = gateFirst(night, [
      [task('stale', about(1), night - minutes(400), 'failed'), progress('止まりました。', night - minutes(390), 'failed')],
      [task('held', about(2), asked), progress('12月18日公開です。', night - minutes(5), 'received', { spoken: '12月18日公開です。' })],
      [task('first', '明日の天気は？', asked), progress('晴れです。', night - minutes(20), 'received', { spoken: '晴れです。' })],
      [task('second', '明日の天気は?', asked + minutes(1)), progress('晴れの予報です。', night - minutes(10), 'received', { spoken: '晴れの予報です。' })],
    ]);
    w.scan(1);
    expect(w.counts).toEqual({ shown: 0, verdicts: 4 }); // stale: drop; held and first: hold (night); second: drop (sibling)
    w.scan(12 * 30); // Thirty minutes of scans, still night, nothing changed.
    expect(w.counts).toEqual({ shown: 0, verdicts: 4 });
    expect(w.written).toEqual([]);
  });

  it('asks again about a held report when the quiet hours end, and only then walks its sources and writes its card', () => {
    const w = gateFirst(morning - minutes(10), [[task('held', about(3), night), progress('12月18日公開です。', night, 'received', { spoken: '公開は12月18日です。' })]]);
    w.scan(1);
    expect(w.counts).toEqual({ shown: 0, verdicts: 1 });
    w.clock.at = morning - 1_000;
    w.scan(1);
    expect(w.counts).toEqual({ shown: 0, verdicts: 1 }); // 6:59:59: still held, not asked.
    w.clock.at = morning;
    w.scan(1);
    expect(w.counts).toEqual({ shown: 1, verdicts: 2 });
    expect(w.written).toEqual(['held']); // At the first scan of 7:00, as the gate decides.
  });

  it('asks again about a held report at once when something is said in its Talk (he is talking: delivered now)', () => {
    const w = gateFirst(night, [[task('held', about(4), night - minutes(30)), progress('答えです。', night - minutes(1), 'received', { spoken: '答えです。' })]]);
    w.scan(12);
    expect(w.counts).toEqual({ shown: 0, verdicts: 1 });
    w.messages.push({ id: 'm1', role: 'user', content: 'まだ起きてるよ', observedAt: iso(w.clock.at) });
    w.scan(1);
    expect(w.counts).toEqual({ shown: 1, verdicts: 2 });
    expect(w.written).toEqual(['held']);
  });

  it('waits for the spoken form of a report it held from the moment it lets it through, as for a new report', () => {
    const entry: [TaskView, TaskProgress | null] = [task('held', about(5), night), progress('長い報告です。\n- 一つ目\n- 二つ目', night)];
    const w = gateFirst(morning - minutes(1), [entry]);
    w.scan(1);
    w.clock.at = morning;
    w.scan(1);
    expect(w.counts.shown).toBe(1); // Walked (and its spoken form asked for) only now.
    expect(w.written).toEqual([]); // Not a plain cut at once although the report is hours old.
    w.clock.at = morning + REPORT_CARD_SPOKEN_WAIT_MS - 5_000;
    w.scan(1);
    expect(w.written).toEqual([]);
    entry[1] = { ...entry[1]!, report: { ...entry[1]!.report!, spoken: '報告です。' } }; // The spoken form is written: the mark changes.
    w.scan(1);
    expect(w.written).toEqual(['held']);
  });

  it('settles a dropped report until it or its progress changes, or (for a sibling\'s drop) the siblings change', () => {
    const asked = noon - minutes(10);
    const entries: Array<[TaskView, TaskProgress | null]> = [
      [task('stale', about(6), noon - minutes(400), 'failed'), progress('止まりました。', noon - minutes(390), 'failed')],
      [task('running', '明日の天気', asked, 'executing'), null],
      [task('failure', '明日の天気', asked + minutes(1), 'failed'), progress('止まりました。', asked + minutes(2), 'failed')],
    ];
    const w = gateFirst(noon, entries);
    w.scan(12 * 10);
    expect(w.counts).toEqual({ shown: 0, verdicts: 2 });
    // The stale failure's progress changes (a new report): asked again at once, dropped again.
    entries[0]![1] = progress('まだ止まっています。', w.clock.at, 'failed');
    w.scan(1);
    expect(w.counts).toEqual({ shown: 0, verdicts: 3 });
    // The sibling stops without an answer: the failure is no longer superseded and is delivered, as the gate would have before.
    entries[1]![0] = { ...entries[1]![0], phase: 'failed', updatedAt: iso(w.clock.at) } as TaskView;
    w.scan(1);
    expect(w.counts).toEqual({ shown: 1, verdicts: 4 });
    // Its spoken form is asked for only now (it was dropped until now): the card waits for it as for a new report.
    expect(w.written).toEqual([]);
    w.scan(REPORT_CARD_SPOKEN_WAIT_MS / 5_000);
    expect(w.written).toEqual(['failure']);
  });

  it('counts: thirty finished reports at night cost one gate question each, and a walk only for those delivered', () => {
    const entries: Array<[TaskView, TaskProgress | null]> = [];
    for (let index = 0; index < 10; index++) {
      entries.push([task(`stale-${index}`, about(10 + index), night - minutes(400), 'failed'), progress('止まりました。', night - minutes(390), 'failed')]);
      entries.push([task(`held-${index}`, about(30 + index), night - minutes(30)), progress(`答え${index}。`, night - minutes(20), 'received', { spoken: `答え${index}。` })]);
      entries.push([task(`heard-${index}`, about(50 + index), night - minutes(30)),
        progress(`聞いた答え${index}。`, night - minutes(20), 'received', { spoken: `聞いた答え${index}。`, heard: true })]);
    }
    const w = gateFirst(night, entries);
    w.scan(12 * 60); // An hour of scans (5:20 to 6:20).
    expect(w.counts).toEqual({ shown: 10, verdicts: 30 }); // Before: every one walked, again every 60–120 s.
    expect(w.written.sort()).toEqual(Array.from({ length: 10 }, (_, index) => `heard-${index}`).sort());
    w.clock.at = morning;
    w.scan(1); // The held ones, at the first scan of the morning.
    expect(w.counts).toEqual({ shown: 20, verdicts: 40 });
    expect(w.written).toHaveLength(20);
    w.scan(12 * 60);
    expect(w.counts).toEqual({ shown: 20, verdicts: 40 }); // Settled.
  });

  it('decides again every task it looks at: one never visible, one that throws, or one leaving the 24 h window never keeps a held one waiting', () => {
    // Review 2026-10-13 (owner-test-fixes-1): a scan that skipped or failed a task without advancing it starved the held reports.
    const heard = (text: string) => progress(text, night - minutes(25), 'received', { heard: true, spoken: text });
    const entries: Array<[TaskView, TaskProgress | null]> = [
      [task('hidden', about(70), night - minutes(30)), heard('見えない答え。')],
      [task('broken', about(71), night - minutes(30)), heard('壊れた答え。')],
      // Held too, but its 24 h window ends before the morning: it gets no card then (as before), and is no longer looked at.
      [task('leaving', about(72), morning - REPORT_CARD_WINDOW_MS - minutes(60)), progress('古い答え。', night - minutes(20), 'received', { spoken: '古い答え。' })],
      [task('held', about(73), night - minutes(30)), progress('朝の答え。', night - minutes(20), 'received', { spoken: '朝の答え。' })],
    ];
    const w = gateFirst(night, entries, id => {
      if (id === 'broken') throw new Error('broken');
      return id === 'hidden' ? null : entries.find(([item]) => item.id === id)![1];
    });
    w.scan(1);
    // hidden and broken deliver (heard) and are walked; leaving and held are held without a walk.
    expect(w.shown.sort()).toEqual(['broken', 'hidden']);
    expect(w.written).toEqual([]);
    expect(w.lines).toEqual(['Shannon report card skipped code=report_card_failed']);
    // Hidden and broken are walked again once per recheck window (60–120 s), never on every scan.
    w.shown.length = 0;
    w.scan(12 * 20); // Twenty minutes.
    const walks = (id: string) => w.shown.filter(walked => walked === id).length;
    expect(walks('hidden')).toBeGreaterThanOrEqual(10);
    expect(walks('hidden')).toBeLessThanOrEqual(20);
    expect(walks('broken')).toBeGreaterThanOrEqual(10);
    expect(walks('broken')).toBeLessThanOrEqual(20);
    expect(walks('held') + walks('leaving')).toBe(0);
    // In the morning: the held report is asked again and written at its first scan, whatever the others do.
    w.clock.at = morning;
    w.shown.length = 0;
    w.scan(1);
    expect(w.written).toEqual(['held']);
    expect(w.shown).toContain('held');
    expect(w.shown).not.toContain('leaving');
    expect(Date.parse(entries[2]![0].updatedAt) + REPORT_CARD_WINDOW_MS).toBeLessThan(w.clock.at);
    w.clock.at += 2 * REPORT_CARD_RECHECK_MS;
    w.shown.length = 0;
    w.scan(1);
    expect(w.shown.sort()).toEqual(['broken', 'hidden']);
  });

  it('waits for the spoken form after a restart across 7:00 too, not a plain cut at once of a report written in the night', () => {
    // Review of 90bffd77 (Low-1): the scan's memory of what it held is gone after a restart.
    const entry: [TaskView, TaskProgress | null] = [task('held', about(80), night), progress('長い報告です。\n- 一つ目\n- 二つ目', night)];
    const w = gateFirst(morning + minutes(1), [entry]); // A new scan, first run at 7:01.
    w.scan(1);
    expect(w.counts.shown).toBe(1);
    expect(w.written).toEqual([]);
    w.clock.at = morning + minutes(1) + REPORT_CARD_SPOKEN_WAIT_MS - 1_000;
    w.scan(1);
    expect(w.written).toEqual([]);
    w.clock.at = morning + minutes(1) + REPORT_CARD_SPOKEN_WAIT_MS;
    w.scan(1);
    expect(w.written).toEqual(['held']); // No spoken form came: the plain cut, after the same wait as for a new report.
    // A report met within its wait (the usual case) still waits from when it was written, as before.
    const fresh: [TaskView, TaskProgress | null] = [task('fresh', about(81), noon - minutes(5)), progress('長い報告です。\n- 一つ目', noon - 10_000)];
    const v = gateFirst(noon, [fresh]);
    v.scan(1);
    v.clock.at = noon - 10_000 + REPORT_CARD_SPOKEN_WAIT_MS;
    v.scan(1);
    expect(v.written).toEqual(['fresh']);
  });

  it('delivers nothing when the gate cannot read the stored progress (closed), and asks again after a while', () => {
    // Review of 90bffd77 (Low-3): without `runtime.progress` the card's gate cannot judge.
    let shown = 0, at = night;
    const parent = { ...task('conversation', '', night), kind: 'conversation', parentId: null } as TaskView;
    const held = task('held', about(82), night - minutes(30));
    const cards = createReportCards({ ownerScope: 'owner', now: () => at, ownerAlone: () => true,
      runtime: { list: () => [held], get: (_scope: string, id: string) => id === parent.id ? parent : held,
        taskSources: () => [{ stepId: 's', experienceId: 'e', threadId: 'thread', observedAt: iso(night), recalledMemoryIds: [] }] } as never,
      conversations: { assistantMessage: () => null, appendReportCardOnce: () => { throw new Error('no card may be written'); } } as never,
      shown: () => { shown += 1; return progress('答え。', night, 'received', { spoken: '答え。' }); },
      gate: { verdict: () => ({ decision: 'deliver', reason: 'deliver' }), quiet: () => true } });
    for (let scan = 0; scan < 40; scan++) { expect(cards.tick()).toBe(0); at += 5_000; }
    expect(shown).toBe(0);
  });
});
