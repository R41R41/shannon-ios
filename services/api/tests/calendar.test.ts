import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { CALENDAR_LIMITS, CALENDAR_REQUEST_BYTES, calendarIngestEnabled, calendarRequestBytes } from '../src/calendarContract.js';
import { OwnerUpcoming } from '../src/ownerUpcoming.js';
import { SQLiteUpcomingStore } from '../src/upcomingStore.js';

const scope = 'owner';
const START = '2026-10-02T01:00:00.000Z'; // 10:00 in Tokyo
const HOUR = 60 * 60_000;
const at = (milliseconds: number) => new Date(Date.parse(START) + milliseconds).toISOString();

function harness(options: { calendarEnabled?: boolean } = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const stateStore = new InMemoryCompanionStateStore(now);
  const store = new SQLiteUpcomingStore(':memory:');
  const upcoming = new OwnerUpcoming({ store, snapshot: scopeKey => stateStore.snapshot(scopeKey), now, calendarEnabled: options.calendarEnabled ?? true });
  const api = createLocalApiKernel(now, { stateStore, upcoming });
  const put = (body: Record<string, unknown>, deviceId = 'iphone') => api.dispatch({ method: 'PUT', path: '/v1/calendar/upcoming', body: { scopeKey: scope, ...body }, deviceId });
  const get = (query: Record<string, string> = {}, deviceId = 'iphone') =>
    api.dispatch({ method: 'GET', path: '/v1/calendar/upcoming', query: new URLSearchParams({ scopeKey: scope, ...query }), deviceId });
  const remove = (deviceId = 'iphone') => api.dispatch({ method: 'DELETE', path: '/v1/calendar/upcoming', query: new URLSearchParams({ scopeKey: scope }), deviceId });
  return { clock, api, store, upcoming, put, get, remove };
}

const event = (id: string, title: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  ({ id, title, start: at(start), end: at(end), allDay: false, ...extra });
const snapshot = (events: unknown[], extra: Record<string, unknown> = {}) =>
  ({ generatedAt: START, timeZone: 'Asia/Tokyo', windowStart: START, windowEnd: at(7 * 24 * HOUR), events, ...extra });
const titles = (response: { body: unknown }) => (response.body as { events: { title: string }[] }).events.map(item => item.title);

describe('PUT /v1/calendar/upcoming', () => {
  it('stores a snapshot and answers with the count and the time it was received', async () => {
    const { put, get } = harness();
    const stored = await put(snapshot([
      event('a', '歯医者', 2 * HOUR, 3 * HOUR, { calendar: '個人', location: '駅前' }),
      { id: 'b', title: '祝日', start: '2026-10-03T00:00:00+09:00', end: '2026-10-04T00:00:00+09:00', allDay: true },
    ]));
    expect(stored).toEqual({ status: 200, body: { schemaVersion: 1, stored: 2, receivedAt: START } });
    const read = await get({ hours: '48' });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ schemaVersion: 1, generatedAt: START, hours: 48, enabled: true, devices: 1 });
    // Times come back as canonical UTC, earliest first, with the optional fields that were sent.
    expect((read.body as { events: unknown[] }).events).toEqual([
      { id: 'a', title: '歯医者', start: at(2 * HOUR), end: at(3 * HOUR), allDay: false, calendar: '個人', location: '駅前' },
      { id: 'b', title: '祝日', start: '2026-10-02T15:00:00.000Z', end: '2026-10-03T15:00:00.000Z', allDay: true },
    ]);
  });

  it('refuses a snapshot outside the contract and stores nothing of it', async () => {
    const { put, get } = harness();
    const good = event('a', '歯医者', HOUR, 2 * HOUR);
    const refused: [string, Record<string, unknown>][] = [
      ['an unknown field', snapshot([good], { note: 'x' })],
      ['an unknown event field', snapshot([{ ...good, attendees: [] }])],
      ['more than 300 events', snapshot(Array.from({ length: CALENDAR_LIMITS.events + 1 }, (_, index) => event(`e${index}`, '予定', HOUR, 2 * HOUR)))],
      ['a window longer than 31 days', snapshot([good], { windowEnd: at(32 * 24 * HOUR) })],
      ['a window that ends before it starts', snapshot([good], { windowEnd: at(-HOUR) })],
      ['a title longer than 200 characters', snapshot([{ ...good, title: 'あ'.repeat(201) }])],
      ['a calendar name longer than 80 characters', snapshot([{ ...good, calendar: 'あ'.repeat(81) }])],
      ['a location longer than 200 characters', snapshot([{ ...good, location: 'あ'.repeat(201) }])],
      ['an id longer than 200 characters', snapshot([{ ...good, id: 'x'.repeat(201) }])],
      ['an empty id', snapshot([{ ...good, id: '' }])],
      ['a time that is not ISO 8601', snapshot([{ ...good, start: 'tomorrow at noon' }])],
      ['a time without an offset', snapshot([{ ...good, start: '2026-10-02T12:00:00' }])],
      ['an end before its start', snapshot([{ ...good, end: at(0) }])],
      ['a missing allDay', snapshot([{ id: 'a', title: 'x', start: at(HOUR), end: at(2 * HOUR) }])],
      ['an unknown time zone', snapshot([good], { timeZone: 'Mars/Olympus' })],
      ['a missing generatedAt', (({ generatedAt: _dropped, ...rest }) => rest)(snapshot([good]))],
      ['events that are not an array', snapshot([], { events: 'none' })],
    ];
    for (const [name, body] of refused) expect((await put(body)).status, name).toBe(400);
    expect((await get()).body).toMatchObject({ devices: 0, events: [] });
  });

  it('accepts the bounds themselves, and occurrences of a repeating event that share one id', async () => {
    const { put, get } = harness();
    const full = Array.from({ length: CALENDAR_LIMITS.events }, (_, index) => event('weekly', `朝会${index}`, (index + 1) * HOUR, (index + 1) * HOUR + 30 * 60_000));
    expect((await put(snapshot(full, { windowEnd: at(31 * 24 * HOUR) }))).body).toMatchObject({ stored: 300 });
    expect((await put(snapshot([{ ...event('a', 'あ'.repeat(200), HOUR, 2 * HOUR), calendar: 'か'.repeat(80), location: 'ば'.repeat(200) }]))).status).toBe(200);
    expect(titles(await get())).toEqual(['あ'.repeat(200)]);
    expect(calendarRequestBytes('/v1/calendar/upcoming')).toBe(CALENDAR_REQUEST_BYTES);
    expect(CALENDAR_REQUEST_BYTES).toBe(256 * 1024);
    expect(calendarRequestBytes('/v1/chat')).toBeNull();
  });

  it('replaces a device\'s snapshot whole, and merges devices without repeating an event both have', async () => {
    const { put, get } = harness();
    await put(snapshot([event('a', '歯医者', 2 * HOUR, 3 * HOUR), event('b', '打ち合わせ', 4 * HOUR, 5 * HOUR)]), 'iphone');
    // The Mac has the same dentist appointment under its own id, and one more event.
    await put(snapshot([event('mac-1', '歯医者', 2 * HOUR, 3 * HOUR), event('mac-2', '読書会', 6 * HOUR, 7 * HOUR)]), 'mac');
    expect(titles(await get())).toEqual(['歯医者', '打ち合わせ', '読書会']);
    expect((await get()).body).toMatchObject({ devices: 2 });
    // The owner deleted the meeting on the phone: its next snapshot no longer has it.
    await put(snapshot([event('a', '歯医者', 2 * HOUR, 3 * HOUR)]), 'iphone');
    expect(titles(await get())).toEqual(['歯医者', '読書会']);
  });

  it('reads only what is under way or begins inside the asked hours', async () => {
    const { put, get } = harness();
    await put(snapshot([
      event('past', '終わった予定', -3 * HOUR, -2 * HOUR), event('now', '進行中', -HOUR, HOUR),
      event('soon', 'もうすぐ', 23 * HOUR, 24 * HOUR), event('later', '明後日', 30 * HOUR, 31 * HOUR),
    ]));
    expect(titles(await get())).toEqual(['進行中', 'もうすぐ']);
    expect(titles(await get({ hours: '48' }))).toEqual(['進行中', 'もうすぐ', '明後日']);
    for (const hours of ['0', '745', '1.5', 'many']) expect((await get({ hours })).status, hours).toBe(400);
  });

  it('takes a device\'s snapshot away on DELETE, and an empty PUT is the same off signal', async () => {
    const { put, get, remove } = harness();
    await put(snapshot([event('a', '歯医者', 2 * HOUR, 3 * HOUR)]), 'iphone');
    await put(snapshot([event('m', '読書会', 6 * HOUR, 7 * HOUR)]), 'mac');
    expect(await remove('iphone')).toEqual({ status: 200, body: { schemaVersion: 1, removed: true } });
    expect(await remove('iphone')).toEqual({ status: 200, body: { schemaVersion: 1, removed: false } });
    expect(titles(await get())).toEqual(['読書会']);
    // PUT with no events: nothing of this device is left to read.
    expect((await put(snapshot([]), 'mac')).body).toMatchObject({ stored: 0 });
    expect(titles(await get())).toEqual([]);
  });

  it('stops using a snapshot seven days after it was received', async () => {
    const { put, get, clock } = harness();
    await put(snapshot([event('far', '来週の予定', 8 * 24 * HOUR, 8 * 24 * HOUR + HOUR)], { windowEnd: at(20 * 24 * HOUR) }));
    clock.at = at(6 * 24 * HOUR);
    expect(titles(await get({ hours: '72' }))).toEqual(['来週の予定']);
    clock.at = at(7 * 24 * HOUR + HOUR);
    expect((await get({ hours: '72' })).body).toMatchObject({ devices: 0, events: [] });
  });

  it('is switched off by SHANNON_CALENDAR_INGEST: nothing is stored or read, and a snapshot can still be taken away', async () => {
    expect(calendarIngestEnabled({})).toBe(true);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) expect(calendarIngestEnabled({ SHANNON_CALENDAR_INGEST: value }), value).toBe(false);
    const off = harness({ calendarEnabled: false });
    off.store.replaceCalendar(scope, 'iphone', { ...snapshot([]), events: [{ id: 'a', title: '歯医者', start: at(HOUR), end: at(2 * HOUR), allDay: false }] } as never, START);
    const refused = await off.put(snapshot([event('b', '打ち合わせ', HOUR, 2 * HOUR)]));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'CALENDAR_INGEST_DISABLED' });
    expect((await off.get()).body).toMatchObject({ enabled: false, devices: 0, events: [] });
    expect(off.upcoming.upcomingForOwner(scope, START, 24 * HOUR)).toEqual([]);
    expect((await off.remove()).body).toMatchObject({ removed: true });
  });

  it('needs a scope and a JSON object, and knows no other method', async () => {
    const { api } = harness();
    expect((await api.dispatch({ method: 'PUT', path: '/v1/calendar/upcoming', body: snapshot([]) })).status).toBe(400);
    expect((await api.dispatch({ method: 'PUT', path: '/v1/calendar/upcoming', body: [] })).status).toBe(400);
    expect((await api.dispatch({ method: 'GET', path: '/v1/calendar/upcoming', query: new URLSearchParams() })).status).toBe(400);
    expect((await api.dispatch({ method: 'DELETE', path: '/v1/calendar/upcoming' })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/calendar/upcoming', body: { scopeKey: scope } })).status).toBe(405);
  });
});
