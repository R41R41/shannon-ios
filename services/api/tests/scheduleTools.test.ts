import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { afterEach, describe, expect, it } from 'vitest';
import { validatedCalendarSnapshot, type CalendarEvent } from '../src/contracts/calendarContract.js';
import { OwnerUpcoming } from '../src/mind/memory/ownerUpcoming.js';
import { SQLiteUpcomingStore } from '../src/mind/memory/store/upcomingStore.js';
import { eventRef } from '../src/mind/memory/scheduleSearch.js';
import { resolveScheduleWhen } from '../src/mind/memory/scheduleWhen.js';
import { calendarDoneText, lastUndoable, undoOf } from '../src/mind/tools/shannonCalendarEditTools.js';
import { askedToolNames, asksForDeviceAction, asksToConfirmToolAction } from '../src/mind/tools/shannonToolSession.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { readToolExecutors } from '../src/mind/tools/shannonReadTools.js';
import { SHANNON_TOOLS, TOOL_SUMMARIES } from '../src/mind/tools/shannonTools.js';
import type { StoredDeviceAction } from '../src/surfaces/device/store/deviceActionStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { configuredDeviceActions } from '../src/wiring/deviceActionWiring.js';

/** Monday 2026-10-26, 10:00 in Tokyo. */
const NOW = '2026-10-26T01:00:00.000Z';
const ZONE = 'Asia/Tokyo';
/** An instant from Tokyo wall time. */
const jst = (local: string) => new Date(`${local}+09:00`).toISOString();
let clock = Date.parse(NOW);
const now = () => new Date(clock).toISOString();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); clock = Date.parse(NOW); });

function upcomingWith(events: CalendarEvent[]) {
  const store = new SQLiteUpcomingStore(':memory:');
  cleanup.push(() => store.close());
  const state = new InMemoryCompanionStateStore(() => NOW);
  const upcoming = new OwnerUpcoming({ store, snapshot: scope => state.snapshot(scope), now, ownerScopeKey: 'owner', timeZone: ZONE });
  store.replaceCalendar('owner', 'local', { generatedAt: NOW, timeZone: ZONE, windowStart: NOW, windowEnd: jst('2026-11-25T00:00:00'), events }, NOW);
  return upcoming;
}

const event = (id: string, title: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id, title, start: jst(start), end: jst(end), allDay: false, ...extra });

const WEEK = [
  event('standup', '朝会', '2026-11-04T09:30:00', '2026-11-04T10:00:00', { calendar: '仕事', recurring: true, id: 'standup@2026-11-04T00:30:00Z' }),
  event('review', '設計レビュー', '2026-11-04T14:00:00', '2026-11-04T15:00:00', { calendar: '仕事', location: '会議室A', attendees: ['田中 一郎', '佐藤'] }),
  event('dentist', '歯医者', '2026-10-27T13:00:00', '2026-10-27T14:00:00', { calendar: '個人', location: '駅前クリニック' }),
  event('lunch', 'ランチ', '2026-10-27T12:00:00', '2026-10-27T13:00:00', { calendar: '個人', attendees: ['田中 一郎'] }),
  { id: 'holiday', title: '文化の日', start: jst('2026-11-03T00:00:00'), end: jst('2026-11-04T00:00:00'), allDay: true, calendar: '祝日' },
];

describe('a span in the owner\'s words', () => {
  const span = (words: string) => {
    const window = resolveScheduleWhen(words, NOW, ZONE);
    return window && { from: window.from, until: window.until, daily: window.daily, label: window.label };
  };

  it('reads days, weeks, weekdays, dates and parts of a day in his zone', () => {
    expect(span('今日')).toMatchObject({ from: jst('2026-10-26T00:00:00'), until: jst('2026-10-27T00:00:00'), label: '10月26日(月)' });
    expect(span('明日の午後')).toMatchObject({ from: jst('2026-10-27T12:00:00'), until: jst('2026-10-27T18:00:00'), label: '10月27日(火) 12:00〜18:00' });
    expect(span('来週の水曜の午後')).toMatchObject({ from: jst('2026-11-04T12:00:00'), until: jst('2026-11-04T18:00:00') });
    expect(span('水曜')).toMatchObject({ from: jst('2026-10-28T00:00:00'), until: jst('2026-10-29T00:00:00') });
    // Today is a Monday: 「月曜」 is today, 「今度の月曜」 the next one.
    expect(span('月曜')).toMatchObject({ from: jst('2026-10-26T00:00:00') });
    expect(span('今度の月曜')).toMatchObject({ from: jst('2026-11-02T00:00:00') });
    expect(span('今週末')).toMatchObject({ from: jst('2026-10-31T00:00:00'), until: jst('2026-11-02T00:00:00') });
    expect(span('来週')).toMatchObject({ from: jst('2026-11-02T00:00:00'), until: jst('2026-11-09T00:00:00') });
    expect(span('今週')).toMatchObject({ from: jst('2026-10-26T00:00:00'), until: jst('2026-11-02T00:00:00') });
    expect(span('10月30日の15時から17時')).toMatchObject({ from: jst('2026-10-30T15:00:00'), until: jst('2026-10-30T17:00:00') });
    expect(span('11/3')).toMatchObject({ from: jst('2026-11-03T00:00:00') });
    expect(span('3日後')).toMatchObject({ from: jst('2026-10-29T00:00:00') });
    expect(span('午後3時以降')).toMatchObject({ from: jst('2026-10-26T15:00:00'), until: jst('2026-10-27T00:00:00') });
    expect(span('１月５日')).toMatchObject({ from: jst('2027-01-05T00:00:00') });
  });

  it('keeps a part of the day as the daily window of a span of several days', () => {
    expect(span('来週の午後')).toEqual({ from: jst('2026-11-02T00:00:00'), until: jst('2026-11-09T00:00:00'),
      daily: { startMinute: 12 * 60, endMinute: 18 * 60 }, label: '11月2日(月)〜11月8日(日)、各日 12:00〜18:00' });
  });

  it('does not read a length as a clock, and names nothing it does not know', () => {
    expect(span('来週2時間')).toMatchObject({ from: jst('2026-11-02T00:00:00') });
    expect(span('来週2時間')!.daily).toBeUndefined();
    expect(span('火星の三日後')).toBeNull();
    expect(span('')).toBeNull();
  });
});

describe('the schedule search', () => {
  it('narrows by the span, a person, a place and a calendar, and gives each event a ref', () => {
    const upcoming = upcomingWith(WEEK);
    const afternoon = upcoming.searchWithSources('owner', { when: '来週の水曜の午後' });
    expect(afternoon.prompt).toContain('範囲: 11月4日(水) 12:00〜18:00');
    expect(afternoon.prompt).toContain('設計レビュー');
    expect(afternoon.prompt).not.toContain('朝会');
    expect(afternoon.prompt).toContain('｜仕事｜参加: 田中 一郎、佐藤');
    expect(afternoon.prompt).toContain(`ref: ${eventRef('review', jst('2026-11-04T14:00:00'))}`);
    expect(afternoon.sourceIds).toEqual([`calendar:review@${jst('2026-11-04T14:00:00')}`]);

    const withTanaka = upcoming.searchWithSources('owner', { when: '来週末まで', who: '田中さん' });
    expect(withTanaka.prompt).toContain('ランチ');
    expect(withTanaka.prompt).toContain('設計レビュー');
    expect(withTanaka.prompt).not.toContain('歯医者');
    expect(upcoming.searchWithSources('owner', { when: '来週末まで', place: '駅前' }).prompt).toContain('歯医者');
    const work = upcoming.searchWithSources('owner', { when: '来週末まで', calendar: '仕事、祝日' });
    expect(work.prompt).toContain('文化の日');
    expect(work.prompt).not.toContain('ランチ');
    expect(work.prompt).toContain('朝会');
    expect(work.prompt).toContain('｜繰り返し');
    // The calendars the snapshot holds are named, so that she knows which accounts she sees.
    expect(work.prompt).toMatch(/カレンダー: (?=.*仕事)(?=.*個人)(?=.*祝日)/u);
  });

  it('says why a span cannot be read, through the tool', async () => {
    const upcoming = upcomingWith(WEEK);
    const executors = readToolExecutors({ upcoming: () => '', upcomingSearch: (scope, input) => {
      const read = upcoming.searchWithSources(scope, input);
      return { text: read.prompt, sourceIds: read.sourceIds };
    } });
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    const prepared = executors['schedule.upcoming']!({ when: '火星の三日後' }, context);
    if (!('run' in prepared)) throw new Error('not prepared');
    expect((await prepared.run()).result).toMatchObject({ ok: false, failure: 'invalid_input', text: expect.stringContaining('when を読めなかった') });
  });

  it('accepts attendees and the repeat flag in a snapshot, and refuses neither field when absent', () => {
    const body = (events: unknown[]) => ({ scopeKey: 'owner', generatedAt: NOW, timeZone: ZONE, windowStart: NOW, windowEnd: jst('2026-11-20T00:00:00'), events });
    const accepted = validatedCalendarSnapshot(body([{ ...WEEK[1], attendees: ['田中 一郎', ' ', '佐藤'], recurring: false }]));
    expect(typeof accepted === 'string' ? accepted : accepted.events[0]).toEqual({ ...WEEK[1], attendees: ['田中 一郎', '佐藤'] });
    expect(validatedCalendarSnapshot(body([{ id: 'a', title: 'x', start: NOW, end: NOW, allDay: false }]))).not.toBeTypeOf('string');
  });
});

describe('free time', () => {
  it('finds the gaps between calendar events inside each day\'s hours, and does not let all-day events fill time', () => {
    const upcoming = upcomingWith(WEEK);
    const tomorrow = upcoming.freeTimeWithSources('owner', { when: '明日', fromHour: 9, toHour: 18, minMinutes: 60 });
    expect(tomorrow.prompt).toContain('- 10月27日(火) 9:00〜12:00（3時間）');
    expect(tomorrow.prompt).toContain('- 10月27日(火) 14:00〜18:00（4時間）');
    expect(tomorrow.prompt).not.toContain('12:00〜13:00');
    const holiday = upcoming.freeTimeWithSources('owner', { when: '11月3日' });
    expect(holiday.prompt).toContain('- 11月3日(火) 9:00〜21:00（12時間）');
    expect(holiday.prompt).toContain('終日の予定（空きを埋めていない）');
    expect(holiday.prompt).toContain('文化の日');
  });

  it('never offers time that has already passed, and takes the part of the day from the words', () => {
    const upcoming = upcomingWith([]);
    expect(upcoming.freeTimeWithSources('owner', { when: '今日' }).prompt).toContain('- 10月26日(月) 10:00〜21:00（11時間）');
    expect(upcoming.freeTimeWithSources('owner', { when: '明日の午後' }).prompt).toContain('- 10月27日(火) 12:00〜18:00（6時間）');
  });
});

describe('changing the calendar: a proposal, his yes in a later turn, the device, and undo', () => {
  function harness(options: { supports?: boolean } = {}) {
    const upcoming = upcomingWith(WEEK);
    const service = createInMemoryAutonomyService(now);
    const wiring = configuredDeviceActions({}, ':memory:', now, service.tools, upcoming);
    cleanup.push(() => wiring.close());
    const actions = wiring.actions!;
    if (options.supports !== false) {
      void actions.poll('owner', 'phone', { platform: 'ios', foreground: false, inCall: false, kinds: ['calendar.create_event', 'calendar.update_event', 'calendar.delete_event'], wait: false });
    }
    const call = (name: string, input: Record<string, unknown>, turn: string, threadId = 'talk') =>
      service.tools.call(name, JSON.stringify(input), { scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(turn), threadId, timeMilliseconds: 0 });
    const outbox = () => actions.recent('owner', '2026-01-01T00:00:00.000Z');
    return { upcoming, actions, call, outbox };
  }
  const reviewRef = eventRef('review', jst('2026-11-04T14:00:00'));
  const confirmOf = (text: string) => /confirm: ([0-9a-f]{6})/u.exec(text)![1]!;

  it('shows the change and writes nothing until he answers in a later turn', async () => {
    const { call, outbox } = harness();
    const proposal = await call('calendar.update_event', { ref: reviewRef, start: '2026-11-05T15:00' }, 'turn-1');
    expect(proposal.ok).toBe(true);
    expect(proposal.text).toContain('まだ何も変えていない');
    expect(proposal.text).toContain('変える予定: 11月4日(水) 14:00〜15:00「設計レビュー」 ＠会議室A（仕事）');
    expect(proposal.text).toContain('- 時間: 11月4日(水) 14:00〜15:00 → 11月5日(木) 15:00〜16:00');
    expect(outbox()).toHaveLength(0);
    const token = confirmOf(proposal.text);

    // The same turn is not his answer: refused, and the proposal stays.
    expect(await call('calendar.update_event', { confirm: token }, 'turn-1')).toMatchObject({ ok: false, failure: 'refused' });
    expect(outbox()).toHaveLength(0);
    // Another Talk is not where it was shown.
    expect(await call('calendar.update_event', { confirm: token }, 'turn-2', 'other-talk')).toMatchObject({ ok: false, failure: 'invalid_input' });

    const done = await call('calendar.update_event', { confirm: token }, 'turn-2');
    expect(done).toMatchObject({ ok: true });
    const [written] = outbox();
    expect(written).toMatchObject({ kind: 'calendar.update_event', status: 'pending' });
    expect(written!.payload).toMatchObject({
      title: '設計レビュー', eventId: 'review', occurrenceStart: jst('2026-11-04T14:00:00'),
      expect: { title: '設計レビュー', start: jst('2026-11-04T14:00:00'), end: jst('2026-11-04T15:00:00') },
      changes: { startAt: jst('2026-11-05T15:00:00'), endAt: jst('2026-11-05T16:00:00'), allDay: false },
    });
    // A proposal is written once.
    expect(await call('calendar.update_event', { confirm: token }, 'turn-3')).toMatchObject({ ok: false, failure: 'not_found' });
  });

  it('lets a proposal lapse after 15 minutes, and refuses a confirm meant for the other tool', async () => {
    const { call, outbox } = harness();
    const token = confirmOf((await call('calendar.delete_event', { ref: reviewRef }, 'turn-1')).text);
    expect(await call('calendar.update_event', { confirm: token }, 'turn-2')).toMatchObject({ ok: false, failure: 'invalid_input' });
    clock += 16 * 60_000;
    expect(await call('calendar.delete_event', { confirm: token }, 'turn-2')).toMatchObject({ ok: false, failure: 'conflict' });
    expect(outbox()).toHaveLength(0);
  });

  it('deletes one occurrence of a repeating event by its own id and start', async () => {
    const { call, outbox } = harness();
    const ref = eventRef('standup@2026-11-04T00:30:00Z', jst('2026-11-04T09:30:00'));
    const proposal = await call('calendar.delete_event', { ref }, 'turn-1');
    expect(proposal.text).toContain('（繰り返しの予定のうち、この回だけ）');
    await call('calendar.delete_event', { confirm: confirmOf(proposal.text) }, 'turn-2');
    expect(outbox()[0]!.payload).toMatchObject({ eventId: 'standup', occurrenceStart: jst('2026-11-04T09:30:00'), recurring: true });
  });

  it('says plainly when the ref is unknown, nothing would change, or the app is too old', async () => {
    const { call } = harness();
    expect(await call('calendar.update_event', { ref: 'ev00000000', title: 'x' }, 'turn-1')).toMatchObject({ ok: false, failure: 'not_found' });
    expect(await call('calendar.update_event', { ref: reviewRef }, 'turn-1')).toMatchObject({ ok: false, failure: 'invalid_input' });
    expect(await call('calendar.update_event', { ref: reviewRef, start: '2026-10-01T10:00' }, 'turn-1')).toMatchObject({ ok: false, failure: 'invalid_input' });
    const old = harness({ supports: false });
    expect(await old.call('calendar.delete_event', { ref: reviewRef }, 'turn-1')).toMatchObject({ ok: false, failure: 'not_offered' });
  });

  it('undoes her newest calendar write from what the device reported, and never undoes an undo', () => {
    const action = (id: string, kind: StoredDeviceAction['kind'], payload: Record<string, unknown>, result: Record<string, unknown> | null,
      status: StoredDeviceAction['status'] = 'done'): StoredDeviceAction => ({
      id, kind, payload, result, status, scopeKey: 'owner', requestedAt: NOW, expiresAt: NOW, targetDeviceId: null, claimedBy: 'phone', code: null,
      reportedAt: NOW, told: true,
    });
    const before = { title: '設計レビュー', startAt: jst('2026-11-04T14:00:00'), endAt: jst('2026-11-04T15:00:00'), allDay: false, location: '会議室A', calendar: '仕事' };
    const created = action('c', 'calendar.create_event', { title: '歯医者', start: '2026-10-28T10:00' }, { id: 'item-1' });
    const updated = action('u', 'calendar.update_event', { title: '設計レビュー', eventId: 'review', changes: { startAt: 'x' } }, { id: 'review', before, after: { startAt: 'y' } });
    const deleted = action('d', 'calendar.delete_event', { title: '設計レビュー', eventId: 'review' }, { id: 'review', before });
    expect(undoOf(created)).toEqual({ kind: 'calendar.delete_event', payload: { title: '歯医者', eventId: 'item-1', idKind: 'item', undoOf: 'c' } });
    expect(undoOf(deleted)).toEqual({ kind: 'calendar.create_event', payload: { ...before, notes: '', undoOf: 'd' } });
    expect(undoOf(updated)).toMatchObject({ kind: 'calendar.update_event', payload: { eventId: 'review', occurrenceStart: 'y', changes: { ...before, notes: '' }, undoOf: 'u' } });
    expect(undoOf(action('old', 'calendar.delete_event', { title: 'x' }, {}))).toBe('元の内容が端末から届いていない');

    const music = action('m', 'music.play', {}, {});
    expect(lastUndoable([music, deleted, updated])?.id).toBe('d');
    const undoneDelete = action('ud', 'calendar.create_event', { undoOf: 'd' }, { id: 'item-2' });
    expect(lastUndoable([undoneDelete, deleted, updated])?.id).toBe('u');
    expect(lastUndoable([action('f', 'calendar.create_event', { undoOf: 'd' }, null, 'failed'), deleted])?.id).toBe('d');
    expect(calendarDoneText(undoneDelete)).toContain('元に戻した');
    expect(calendarDoneText(deleted)).toContain('calendar_undo で戻せる');
  });

  it('makes no proposal outside a turn of the owner (a task without a conversation turn)', async () => {
    const upcoming = upcomingWith(WEEK);
    const service = createInMemoryAutonomyService(now);
    const wiring = configuredDeviceActions({}, ':memory:', now, service.tools, upcoming);
    cleanup.push(() => wiring.close());
    const result = await service.tools.call('calendar.delete_event', JSON.stringify({ ref: reviewRef }),
      { scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(), timeMilliseconds: 0 });
    expect(result).toMatchObject({ ok: false, failure: 'refused' });
  });

  it('has no undo when nothing of hers is there to undo', async () => {
    const { call } = harness();
    expect(await call('calendar.undo', {}, 'turn-1')).toMatchObject({ ok: false, failure: 'not_found' });
  });

  it('puts a new event in the calendar he names', async () => {
    const { call, outbox } = harness();
    await call('calendar.create_event', { title: '打ち合わせ', start: '2026-10-28T10:00', calendar: '仕事' }, 'turn-1');
    expect(outbox()[0]!.payload).toMatchObject({ title: '打ち合わせ', calendar: '仕事' });
  });
});

describe('her words and the registry', () => {
  it('loads the change tools for words that change, move or delete an event, and free time for words that look for it', () => {
    expect(askedToolNames('明日の会議、15時にずらして')).toEqual(expect.arrayContaining(['schedule.upcoming', 'calendar.update_event', 'calendar.delete_event']));
    expect(askedToolNames('さっきの予定、やっぱり戻して')).toContain('calendar.undo');
    expect(askedToolNames('来週の午後で空いてる時間ある？')).toContain('schedule.free_time');
    expect(askedToolNames('問題を起こして')).toEqual([]);
    expect(asksForDeviceAction('歯医者の予定をキャンセルして')).toBe(true);
    // Her proposal asks for his yes, so that a spoken 「うん」 may write (the confirm) when the words were not scored.
    expect(asksToConfirmToolAction('設計レビューを11月5日(木) 15:00〜16:00に変えます。この予定を変えていいですか？')).toBe(true);
    expect(asksToConfirmToolAction('この予定を消してもいいですか？')).toBe(true);
  });

  it('keeps every new tool for the owner alone, in a conversation, with a short summary', () => {
    for (const name of ['schedule.free_time', 'calendar.update_event', 'calendar.delete_event', 'calendar.undo']) {
      const tool = SHANNON_TOOLS.find(item => item.name === name)!;
      expect(tool.audiences).toEqual(['owner_alone']);
      expect(tool.surfaces).not.toContain('autonomy');
      expect(TOOL_SUMMARIES[name]!.length).toBeLessThanOrEqual(60);
      expect(tool.description.length).toBeLessThan(220);
    }
  });
});
