import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanionStateEvent, ShannonExpressiveEmotion } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { configuredAwakeClock } from '../src/autonomyAwakeClock.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { emotionTiming } from '../src/emotionTiming.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { isNewMoodPoint, moodPointOf, type StoredMoodPoint } from '../src/moodHistory.js';
import {
  MOOD_HISTORY_LIMITS, MOOD_HISTORY_PATH, moodHistoryEnabled, moodHistoryRecording, type MoodHistoryResponse,
} from '../src/moodHistoryContract.js';
import { SQLiteMoodHistoryReader, downsampleMoodPoints } from '../src/moodHistoryReader.js';
import { createMoodHistoryRoute, moodHistoryResponse, requestedHours } from '../src/serverMoodHistoryRoute.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

vi.setConfig({ testTimeout: 30_000 });

const OWNER = 'owner';
const START = '2026-10-05T00:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (milliseconds: number, from = START) => new Date(Date.parse(from) + milliseconds).toISOString();
const RECORDING = { ownerScopeKey: OWNER };

const directories: string[] = [];
const closers: Array<{ close(): void }> = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const handle of closers.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-mood-history-test-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

function store(options: { path?: string; recording?: typeof RECORDING | null; start?: string } = {}) {
  const path = options.path ?? databasePath();
  const clock = { at: options.start ?? START };
  const opened = new SQLiteShannonStore({ path, now: () => clock.at, moodHistory: options.recording === undefined ? RECORDING : options.recording });
  closers.push(opened);
  return { path, clock, store: opened };
}

function rows(path: string, scopeKey = OWNER): StoredMoodPoint[] {
  const reader = new SQLiteMoodHistoryReader(path);
  try { return reader.points(scopeKey, '0000'); } finally { reader.close(); }
}

const feeling = (primary: ShannonExpressiveEmotion['primary'], intensity: number, startedAt: string): ShannonExpressiveEmotion => ({
  primary, secondary: [], intensity, target: 'ライ氏', cause: 'CAUSE FROM THE CONVERSATION', arousal: 0.5, valence: 0.5,
  visibility: 'expressed', startedAt, decay: 0.48, carryover: 0.6, updatedAt: startedAt,
});

describe('recording: coalesced points beside committed state writes', () => {
  it('writes a point on the first write, on a change of face or kind, on a mood step of 0.05, and otherwise every ten minutes while writes happen', () => {
    const { path, clock, store: shannon } = store();
    shannon.snapshot(OWNER);
    // Creating the first state is no change of her state: nothing is recorded for it.
    expect(rows(path)).toEqual([]);
    shannon.apply(OWNER, { type: 'awake-observed' });
    expect(rows(path)).toHaveLength(1);

    // Small moves that add up: a point once the sum since the last point reaches 0.05, not before.
    for (const minute of [1, 2, 3, 4]) {
      clock.at = at(minute * MINUTE);
      shannon.apply(OWNER, { type: 'emotion-adjusted', delta: { arousal: 0.0125 } });
    }
    expect(rows(path)).toHaveLength(1);
    clock.at = at(5 * MINUTE);
    shannon.apply(OWNER, { type: 'emotion-adjusted', delta: { arousal: 0.0125 } });
    expect(rows(path)).toHaveLength(2);
    expect(rows(path)[1]!.arousal - rows(path)[0]!.arousal).toBeGreaterThanOrEqual(0.0499);

    // A feeling that shows: a new point with its kind and strength, at once.
    clock.at = at(5 * MINUTE + 10_000);
    shannon.apply(OWNER, { type: 'expressive-emotion-updated', emotion: feeling('happy', 0.8, clock.at) });
    const happy = rows(path).at(-1)!;
    expect(happy).toMatchObject({ at: clock.at, presentKind: 'happy' });
    expect(happy.presentIntensity).toBeGreaterThan(0.3);

    // Writes that change nothing worth a point: one point per ten minutes.
    const before = rows(path).length;
    for (let minute = 6; minute <= 25; minute += 1) {
      clock.at = at(minute * MINUTE);
      shannon.apply(OWNER, { type: 'interest-observed', interest: `topic ${minute}` });
    }
    const quiet = rows(path).slice(before);
    // The feeling of the moment faded meanwhile (half-life 5 awake minutes); its end is a change of kind, so it is a point too.
    for (const [index, point] of quiet.entries()) {
      const previous = index === 0 ? happy : quiet[index - 1]!;
      const gap = Date.parse(point.at) - Date.parse(previous.at);
      const changed = point.presentKind !== previous.presentKind || point.expression !== previous.expression;
      expect(changed || gap >= 10 * MINUTE, JSON.stringify({ previous, point })).toBe(true);
    }
    expect(quiet.length).toBeLessThanOrEqual(3);
    expect(quiet.length).toBeGreaterThanOrEqual(1);
  });

  it('follows the rule exactly as a pure function', () => {
    const base: StoredMoodPoint = { at: START, valence: 0.1, arousal: 0.4, openness: 0.6, expression: 'calm', feeling: null, presentKind: null, presentIntensity: null };
    expect(isNewMoodPoint(null, base)).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(9 * MINUTE + 59_000), valence: 0.149 })).toBe(false);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), valence: 0.15 })).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), arousal: 0.35 })).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), openness: 0.65 })).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), expression: 'concerned' })).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), feeling: 'proud' })).toBe(true);
    expect(isNewMoodPoint(base, { ...base, at: at(MINUTE), presentKind: 'happy', presentIntensity: 0.4 })).toBe(true);
    // A strength alone is not a change of kind.
    const showing = { ...base, presentKind: 'happy', presentIntensity: 0.8 };
    expect(isNewMoodPoint(showing, { ...showing, at: at(MINUTE), presentIntensity: 0.5 })).toBe(false);
    expect(isNewMoodPoint(base, { ...base, at: at(10 * MINUTE) })).toBe(true);
  });

  it('never changes her state: the same writes with and without recording store the same bytes', () => {
    const recorded = store();
    const plain = store({ recording: null });
    const events: Array<[number, CompanionStateEvent]> = [
      [0, { type: 'awake-observed' }],
      [MINUTE, { type: 'expressive-emotion-updated', emotion: feeling('sulky', 0.85, at(MINUTE)) }],
      [3 * MINUTE, { type: 'emotion-adjusted', delta: { valence: -0.2, arousal: 0.1 } }],
      [40 * MINUTE, { type: 'awake-observed' }],
      [2 * HOUR, { type: 'feeling-eased', by: 'apology' }],
      [2 * HOUR + MINUTE, { type: 'expressive-emotion-updated', emotion: feeling('happy', 0.6, at(2 * HOUR + MINUTE)) }],
    ];
    for (const [offset, event] of events) {
      for (const side of [recorded, plain]) {
        side.clock.at = at(offset);
        side.store.apply(OWNER, event);
      }
    }
    expect(rows(recorded.path).length).toBeGreaterThan(2);
    expect(rows(plain.path)).toEqual([]);
    const raw = (path: string) => {
      const database = new DatabaseSync(path);
      try {
        return {
          state: database.prepare('SELECT version, updated_at, snapshot_json FROM companion_states').all(),
          events: (database.prepare('SELECT event_type, observed_at, payload_json FROM experience_events ORDER BY sequence').all()),
          projection: database.prepare('SELECT state_version, content, updated_at FROM prompt_projections').all(),
        };
      } finally { database.close(); }
    };
    expect(raw(recorded.path)).toEqual(raw(plain.path));
    expect(recorded.store.snapshot(OWNER)).toEqual(plain.store.snapshot(OWNER));
  });

  it('lets the state write stand when recording fails, and logs the error by name only', () => {
    const path = databasePath();
    // A table of that name in a shape the recorder cannot write.
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE shannon_mood_history (point_id INTEGER PRIMARY KEY, scope_key TEXT NOT NULL, recorded_at TEXT NOT NULL)');
    raw.close();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = store({ path });
    const plain = store({ recording: null });
    for (const side of [broken, plain]) {
      side.store.apply(OWNER, { type: 'expressive-emotion-updated', emotion: feeling('sulky', 0.85, START) });
    }
    expect(broken.store.snapshot(OWNER)).toEqual(plain.store.snapshot(OWNER));
    expect(errors).toHaveBeenCalledWith('Shannon mood history failed', 'Error', expect.any(String));
    expect(JSON.stringify(errors.mock.calls)).not.toContain('CAUSE FROM THE CONVERSATION');
    // Inside a transaction a caller holds, only the point is undone.
    const context = (broken.store as unknown as { context: { transaction<T>(operation: () => T): T } }).context;
    context.transaction(() => broken.store.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: 0.3 } }));
    expect(broken.store.snapshot(OWNER).emotion.valence).toBeCloseTo(plain.store.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: 0.3 } }).emotion.valence, 6);
  });

  it('records the owner\'s scope only, and nothing while SHANNON_MOOD_HISTORY is off', () => {
    const { path, store: shannon } = store();
    shannon.apply('guest-of-the-evening', { type: 'expressive-emotion-updated', emotion: feeling('happy', 0.8, START) });
    expect(rows(path, 'guest-of-the-evening')).toEqual([]);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) {
      expect(moodHistoryEnabled({ SHANNON_MOOD_HISTORY: value })).toBe(false);
      expect(moodHistoryRecording({ SHANNON_MOOD_HISTORY: value })).toBeNull();
    }
    expect(moodHistoryRecording({})).toEqual({ ownerScopeKey: 'owner' });
    expect(moodHistoryRecording({ SHANNON_OWNER_SCOPE_KEY: 'rai' })).toEqual({ ownerScopeKey: 'rai' });
    // The store reads the switch from its process when it is not told.
    vi.stubEnv('SHANNON_MOOD_HISTORY', 'off');
    const switchedOff = new SQLiteShannonStore({ path: databasePath(), now: () => START });
    closers.push(switchedOff);
    switchedOff.apply(OWNER, { type: 'expressive-emotion-updated', emotion: feeling('happy', 0.8, START) });
    const raw = new DatabaseSync((switchedOff as unknown as { context: { options: { path: string } } }).context.options.path);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM shannon_mood_history').get()).toEqual({ count: 0 });
    raw.close();
  });

  it('keeps fourteen days and deletes older points when a point is written; a restart keeps the rest', () => {
    const { path, clock, store: shannon } = store();
    shannon.apply(OWNER, { type: 'awake-observed' });
    clock.at = at(13 * DAY);
    shannon.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: 0.1 } });
    expect(rows(path).map(point => point.at)).toEqual([START, at(13 * DAY)]);
    clock.at = at(14 * DAY + MINUTE);
    shannon.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: 0.1 } });
    expect(rows(path).map(point => point.at)).toEqual([at(13 * DAY), at(14 * DAY + MINUTE)]);
    shannon.close();
    closers.splice(closers.indexOf(shannon), 1);
    // Reopened: the table and its rows are there, and opening again creates nothing new.
    const again = store({ path, start: at(14 * DAY + 2 * MINUTE) });
    expect(rows(path)).toHaveLength(2);
    again.store.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: -0.3 } });
    expect(rows(path)).toHaveLength(3);
  });

  it('records the awake clock\'s write from the activity loop\'s process, and nothing there without the table or the switch', () => {
    const { path, clock, store: shannon } = store();
    shannon.apply(OWNER, { type: 'expressive-emotion-updated', emotion: feeling('sulky', 0.85, START) });
    const first = rows(path).length;
    const loop = configuredAwakeClock(path, { now: () => clock.at, moodHistory: RECORDING });
    closers.push(loop);
    for (let minute = 1; minute <= 30; minute += 1) {
      clock.at = at(minute * MINUTE);
      loop.observe(OWNER);
    }
    const added = rows(path).slice(first);
    expect(added.length).toBeGreaterThanOrEqual(2);
    // Each point is the state as it was then stored.
    const last = added.at(-1)!;
    expect(last).toEqual(moodPointOf(shannon.snapshot(OWNER), last.at, emotionTiming()));

    // Without the switch the loop's process adds nothing.
    const silent = configuredAwakeClock(path, { now: () => clock.at, moodHistory: null });
    closers.push(silent);
    const count = rows(path).length;
    for (let minute = 31; minute <= 60; minute += 1) {
      clock.at = at(minute * MINUTE);
      silent.observe(OWNER);
    }
    expect(rows(path)).toHaveLength(count);

    // A database whose API never created the table: the clock still runs, no table is created.
    const older = databasePath();
    const legacy = new SQLiteShannonStore({ path: older, now: () => START, moodHistory: RECORDING });
    legacy.apply(OWNER, { type: 'expressive-emotion-updated', emotion: feeling('sulky', 0.85, START) });
    legacy.close();
    const drop = new DatabaseSync(older);
    drop.exec('DROP TABLE shannon_mood_history');
    drop.close();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const oldLoop = configuredAwakeClock(older, { now: () => at(5 * MINUTE), moodHistory: RECORDING });
    oldLoop.observe(OWNER);
    oldLoop.close();
    const check = new DatabaseSync(older);
    expect(check.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'shannon_mood_history'`).get()).toEqual({ count: 0 });
    expect(JSON.parse((check.prepare('SELECT snapshot_json FROM companion_states').get() as { snapshot_json: string }).snapshot_json).emotionClock.awakeMs).toBe(5 * MINUTE);
    check.close();
    expect(errors).not.toHaveBeenCalled();
  });
});

class PlainModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = '嬉しいです、ありがとうございます。';
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
}

describe('recording: a turn with others present', () => {
  it('stores nothing of that turn: no point, and every point is the stored state', async () => {
    const { path, clock, store: shannon } = store();
    const model = new PlainModel();
    const api = createLocalApiKernel(() => clock.at, {
      chatModel: model, stateStore: shannon, conversationStore: shannon, knowledgeStore: shannon,
      background: new BackgroundUpdateCoordinator(shannon, shannon),
      memoryStore: new ShannonMemoryService(shannon, shannon, () => clock.at, shannon),
    });
    const chat = async (message: string, extra: Record<string, unknown> = {}) => {
      const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: OWNER, threadId: 'thread', message, ...extra } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      await new Promise<void>(done => setImmediate(done));
      await api.waitForBackground(OWNER);
    };
    await chat('褒めてくれてありがとう');
    const alone = rows(path);
    expect(alone.length).toBeGreaterThan(0);

    // Half an hour later, with friends watching: she may look pleased, and nothing of it is stored.
    clock.at = at(30 * MINUTE);
    const stateBefore = shannon.snapshot(OWNER);
    model.reply = 'ふふ、照れますね。';
    await chat('友達と一緒にいるよ', { audience: 'others' });
    await chat('今日は楽しかったね', { audience: 'others' });
    const stateAfter = shannon.snapshot(OWNER);
    expect({ emotion: stateAfter.emotion, expressiveEmotion: stateAfter.expressiveEmotion, lingering: stateAfter.lingering, clock: stateAfter.emotionClock })
      .toEqual({ emotion: stateBefore.emotion, expressiveEmotion: stateBefore.expressiveEmotion, lingering: stateBefore.lingering, clock: stateBefore.emotionClock });
    // Those turns wrote nothing of her state, so the history has nothing new either.
    expect(shannon.events(OWNER).filter(event => event.observedAt >= at(30 * MINUTE) && event.type.startsWith('state.'))).toEqual([]);
    expect(rows(path)).toEqual(alone);
    // A write that does happen meanwhile (her activity loop's clock) is recorded as the state stores it, never as the face the guests saw.
    const loop = configuredAwakeClock(path, { now: () => clock.at, moodHistory: RECORDING });
    closers.push(loop);
    clock.at = at(31 * MINUTE);
    loop.observe(OWNER);
    const after = rows(path);
    expect(after.length).toBe(alone.length + 1);
    expect(after.at(-1)).toEqual(moodPointOf(shannon.snapshot(OWNER), clock.at, emotionTiming()));
    expect(after.every(point => point.presentKind !== 'giggle' && point.presentKind !== 'shy' && point.presentKind !== 'bashful')).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(/友達|照れ|CAUSE|ライ氏/u);
  });
});

describe('downsampling', () => {
  const point = (index: number, expression = 'calm', presentKind: string | null = null): StoredMoodPoint => ({
    at: at(index * MINUTE), valence: Math.sin(index / 50) / 2, arousal: 0.4, openness: 0.6, expression, feeling: null, presentKind, presentIntensity: presentKind ? 0.5 : null,
  });

  it('returns at most 300 points, oldest first, keeping the first, the last and every change of face', () => {
    const points = Array.from({ length: 2_000 }, (_, index) => point(index, index >= 700 && index < 900 ? 'concerned' : 'calm', index % 97 === 0 ? 'happy' : null));
    const thinned = downsampleMoodPoints(points);
    expect(thinned).toHaveLength(MOOD_HISTORY_LIMITS.maxPoints);
    expect(thinned.map(item => item.at)).toEqual([...thinned.map(item => item.at)].sort());
    expect(thinned[0]).toBe(points[0]);
    expect(thinned.at(-1)).toBe(points.at(-1));
    const changes = points.filter((item, index) => index > 0 && (item.expression !== points[index - 1]!.expression || item.presentKind !== points[index - 1]!.presentKind));
    expect(changes.length).toBeGreaterThan(20);
    for (const change of changes) expect(thinned).toContain(change);
  });

  it('leaves a short history as it is, and thins the changes themselves only when they alone exceed the bound', () => {
    const short = Array.from({ length: 300 }, (_, index) => point(index));
    expect(downsampleMoodPoints(short)).toEqual(short);
    const flapping = Array.from({ length: 1_000 }, (_, index) => point(index, index % 2 ? 'calm' : 'happy'));
    const thinned = downsampleMoodPoints(flapping);
    expect(thinned).toHaveLength(300);
    expect(thinned[0]).toBe(flapping[0]);
    expect(thinned.at(-1)).toBe(flapping.at(-1));
  });
});

type Caller = { scopeKey: string; deviceId: string } | null;

async function route(options: { path?: string; environment?: Record<string, string>; now?: string } = {}) {
  const path = options.path ?? databasePath();
  const clock = { at: options.now ?? START };
  const reader = new SQLiteMoodHistoryReader(path);
  closers.push(reader);
  const environment = options.environment ?? {};
  const handle = createMoodHistoryRoute({
    reader, now: () => clock.at, enabled: () => moodHistoryEnabled(environment),
    ownerScopeKey: moodHistoryRecording({ ...environment, SHANNON_MOOD_HISTORY: 'on' })!.ownerScopeKey,
  });
  const callers: Record<string, Caller> = {
    'Bearer owner-phone': { scopeKey: OWNER, deviceId: 'iphone' },
    'Bearer owner-mac': { scopeKey: OWNER, deviceId: 'mac' },
    'Bearer guest-phone': { scopeKey: 'guest-of-the-evening', deviceId: 'guest-iphone' },
    'Bearer fixed-local-token': null,
  };
  const server = createServer((request, response) => handle(request, response, callers[request.headers.authorization ?? ''] ?? null));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  const read = async (query = '', authorization = 'Bearer owner-phone', method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${MOOD_HISTORY_PATH}${query}`, { method, headers: { authorization } });
    return { status: response.status, body: await response.json() as MoodHistoryResponse & { error?: string } };
  };
  return { path, clock, read };
}

/** A deterministic day: the fixture of `docs/mood-history-contract.md`. */
function fixtureDay(path: string) {
  const clock = { at: START };
  const shannon = new SQLiteShannonStore({ path, now: () => clock.at, moodHistory: RECORDING, emotionTiming: emotionTiming() });
  const step = (offset: number, event: CompanionStateEvent) => { clock.at = at(offset); shannon.apply(OWNER, event); };
  step(0, { type: 'awake-observed' });
  step(2 * MINUTE, { type: 'expressive-emotion-updated', emotion: feeling('happy', 0.6, at(2 * MINUTE)) });
  step(3 * MINUTE, { type: 'emotion-adjusted', delta: { valence: 0.2, arousal: 0.1 } });
  step(40 * MINUTE, { type: 'awake-observed' });
  step(3 * HOUR, { type: 'expressive-emotion-updated', emotion: feeling('sulky', 0.85, at(3 * HOUR)) });
  step(3 * HOUR + MINUTE, { type: 'emotion-adjusted', delta: { valence: -0.45 } });
  step(5 * HOUR, { type: 'feeling-eased', by: 'apology' });
  shannon.close();
  return at(6 * HOUR);
}

describe('GET /v1/shannon/mood-history', () => {
  it('answers the owner\'s paired device and nobody else, with the codes of /v1/shannon/now', async () => {
    const { read } = await route();
    expect((await read()).status).toBe(200);
    expect(await read('', 'Bearer guest-phone')).toMatchObject({ status: 403, body: { error: 'MOOD_HISTORY_OWNER_ONLY' } });
    expect(await read('', 'Bearer fixed-local-token')).toMatchObject({ status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED' } });
    expect(await read('', 'Bearer nobody')).toMatchObject({ status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED' } });
    expect((await read('', 'Bearer owner-phone', 'POST')).status).toBe(405);
    // The scope is the device's own; a scope in the query is ignored.
    const path = databasePath();
    fixtureDay(path);
    const owner = await route({ path, now: at(6 * HOUR) });
    expect((await owner.read('?scopeKey=guest-of-the-evening')).body.points.length).toBeGreaterThan(0);
    expect((await owner.read('', 'Bearer guest-phone')).body).not.toHaveProperty('points');
  });

  it('is switched off by SHANNON_MOOD_HISTORY and limits reads to 60 a minute per device', async () => {
    const off = await route({ environment: { SHANNON_MOOD_HISTORY: 'off' } });
    expect(await off.read()).toMatchObject({ status: 403, body: { error: 'MOOD_HISTORY_DISABLED' } });
    const { read } = await route();
    for (let index = 0; index < MOOD_HISTORY_LIMITS.readsPerMinute; index += 1) expect((await read()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
    // Another device of the owner has its own allowance.
    expect((await read('', 'Bearer owner-mac')).status).toBe(200);
  });

  it('reads 24 hours by default and at most 336, and refuses a window that is not a whole number of hours', async () => {
    expect([null, '24', '168', '336', '337', '100000', '1', ' 48 '].map(requestedHours)).toEqual([24, 24, 168, 336, 336, 336, 1, 48]);
    for (const invalid of ['0', '-1', '1.5', 'abc', '', '1e3', '1234567']) expect(requestedHours(invalid), invalid).toBeNull();
    const { read } = await route();
    expect((await read()).body.hours).toBe(24);
    expect((await read('?hours=168')).body.hours).toBe(168);
    expect((await read('?hours=999')).body.hours).toBe(336);
    expect(await read('?hours=soon')).toMatchObject({ status: 400, body: { error: 'MOOD_HISTORY_HOURS_INVALID' } });
  });

  it('answers the contract fixture: points oldest first, faces and strengths, never a cause', async () => {
    const path = databasePath();
    const generatedAt = fixtureDay(path);
    const { read } = await route({ path, now: generatedAt });
    const { status, body } = await read('?hours=24');
    expect(status).toBe(200);
    if (process.env.SHANNON_WRITE_FIXTURES === '1') writeFileSync(resolve(import.meta.dirname, 'fixtures/mood-history-v1/response.json'), `${JSON.stringify(body, null, 2)}\n`);
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/mood-history-v1/response.json'), 'utf8'));
    expect(body).toEqual(fixture);
    expect(body.points.map(point => point.at)).toEqual([...body.points.map(point => point.at)].sort());
    expect(JSON.stringify(body)).not.toMatch(/CAUSE|cause|target|ライ氏/u);
    // A window that ends before them is empty.
    const short = await route({ path, now: at(30 * HOUR) });
    expect((await short.read('?hours=1')).body.points).toEqual([]);
  });

  it('thins a long history to at most 300 points and says so', async () => {
    const path = databasePath();
    const { store: shannon, clock } = store({ path });
    for (let index = 0; index < 700; index += 1) {
      clock.at = at(index * 11 * MINUTE);
      shannon.apply(OWNER, { type: 'emotion-adjusted', delta: { valence: index % 2 ? 0.06 : -0.06 } });
    }
    const response = moodHistoryResponse({ reader: new SQLiteMoodHistoryReader(path), now: () => clock.at }, OWNER, 336);
    expect(response.points).toHaveLength(300);
    expect(response.downsampled).toBe(true);
    const few = moodHistoryResponse({ reader: new SQLiteMoodHistoryReader(path), now: () => clock.at }, OWNER, 2);
    expect(few.downsampled).toBe(false);
  });
});

describe('structure', () => {
  const source = (name: string) => readFileSync(resolve(import.meta.dirname, '../src', name), 'utf8');

  it('reads through a connection that cannot write', () => {
    const reader = source('moodHistoryReader.ts');
    expect(reader).toContain('PRAGMA query_only = ON');
    expect(reader).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
    expect(source('serverMoodHistoryRoute.ts')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  });

  it('is written by the recorder alone and read by its route alone: not the kernel, not a prompt, not the activity loop', () => {
    const names = readdirSync(resolve(import.meta.dirname, '../src')).filter(name => name.endsWith('.ts'));
    expect(names.filter(name => source(name).includes('shannon_mood_history')).sort()).toEqual(['moodHistory.ts', 'moodHistoryReader.ts']);
    expect(names.filter(name => source(name).includes("'./moodHistoryReader.js'")).sort()).toEqual(['server.ts', 'serverMoodHistoryRoute.ts']);
    expect(names.filter(name => source(name).includes("'./moodHistory.js'")).sort())
      .toEqual(['autonomyAwakeClock.ts', 'moodHistoryReader.ts', 'sqliteStore.ts']);
    for (const name of names.filter(name => /^autonomyLoop/u.test(name) || ['apiKernel.ts', 'apiPromptProjection.ts', 'worker.ts'].includes(name))) {
      expect(source(name), name).not.toMatch(/moodHistory|MoodHistory|mood-history/u);
    }
    const server = source('server.ts');
    expect(server.indexOf('moodHistoryRoute(request, response, principal)')).toBeGreaterThan(server.indexOf("error: 'PAIRING_REQUIRED'"));
    // The point is made from the state alone: no cause, no target, no conversation.
    expect(source('moodHistory.ts')).not.toMatch(/\.cause|\.target|conversation_|ConversationStore/u);
  });
});
