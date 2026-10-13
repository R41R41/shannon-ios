import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groundedLifecycleOutcomeLine, lifecycleOutcomeRequest, neutralLifecycleOutcomeLine, type LifecycleOutcomeFacts, type LifecycleOutcomeKind,
} from '../src/mind/action/respond/lifecycleOutcomeLine.js';
import { lifecycleOutcomeTeller, type LifecycleOutcomeReport } from '../src/wiring/lifecycleOutcomeTellingWiring.js';
import { SQLiteLifecycleOutcomeSpeaker } from '../src/surfaces/outreach/store/lifecycleOutcomeSpeaker.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { initiativeDelivery } from '../src/surfaces/outreach/initiativeFreshness.js';
import { MINECRAFT_LIFECYCLE_ACTIONS, LIFECYCLE_OUTCOME_SOURCE_PREFIX } from '../src/contracts/minecraftLifecycleContract.js';
import { settledOutcome } from '../src/wiring/minecraftLifecycleWiring.js';

/**
 * Owner decision 2026-10-14: when a Minecraft lifecycle operation he asked for in a conversation ends, she tells him herself, in
 * her own words, from its facts, once, into the Talk it was asked in and to her body; the neutral factual line when her line
 * cannot be written or trusted; the private-safe wording while anyone else may see or hear her.
 */
const close: Array<() => void> = [];
afterEach(() => { for (const finish of close.splice(0).reverse()) finish(); });
const OPERATION = `lifecycle:${'a'.repeat(64)}`;
const at = '2026-10-14T05:00:00.000Z';

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-lifecycle-telling-')), path = join(directory, 'store.sqlite');
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SQLiteShannonStore({ path, now: () => at }); close.push(() => store.close());
  const initiatives = new SQLiteInitiativeStore(path, () => at); close.push(() => initiatives.close());
  const speaker = new SQLiteLifecycleOutcomeSpeaker(path); close.push(() => speaker.close());
  const db = new DatabaseSync(path); close.push(() => db.close());
  db.prepare(`INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at) VALUES (?, 'owner', 'Talk', ?, ?)`).run('asked', at, at);
  db.prepare(`INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at) VALUES (?, 'owner', 'Later', ?, ?)`)
    .run('later', at, '2026-10-14T05:00:01.000Z');
  const messages = () => db.prepare(`SELECT cm.thread_id, cm.content, im.source_item_id, im.day_key FROM conversation_messages cm
    JOIN initiative_messages im ON cm.turn_id = 'initiative:' || im.initiative_id WHERE cm.scope_key = 'owner'`).all() as Array<Record<string, string>>;
  return { path, speaker, messages };
}

const report = (patch: Partial<LifecycleOutcomeReport> = {}): LifecycleOutcomeReport => ({
  scopeKey: 'owner', threadId: 'asked', operationId: OPERATION, action: 'login', outcome: 'completed', ...patch,
});

describe('her line about how an operation he asked for ended', () => {
  const facts = (patch: Partial<LifecycleOutcomeFacts> = {}): LifecycleOutcomeFacts => ({ action: 'login', outcome: 'completed', others: false, ...patch });

  it('is used when it names the operation and states its end, and refused otherwise', () => {
    expect(groundedLifecycleOutcomeLine('ライ氏、マイクラにログインできましたよ。', facts())).toBe('ライ氏、マイクラにログインできましたよ。');
    expect(groundedLifecycleOutcomeLine('終わりました！', facts())).toBeNull(); // which one?
    expect(groundedLifecycleOutcomeLine('ログインしようとしたけど、できませんでした。', facts())).toBeNull(); // done, said as failed
    expect(groundedLifecycleOutcomeLine('ログインできました。', facts({ outcome: 'refused' }))).toBeNull(); // refused, said as done
    expect(groundedLifecycleOutcomeLine('ログイン、体に断られちゃいました。', facts({ outcome: 'refused' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('ログインはできませんでした。', facts({ outcome: 'unknown' }))).toBeNull(); // unknown, said as failed
    expect(groundedLifecycleOutcomeLine('ログインがどうなったか、わからないままです。', facts({ outcome: 'unknown' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('2分でログインできました。', facts())).toBeNull(); // a number the facts do not hold
    expect(groundedLifecycleOutcomeLine('ログインできました。'.repeat(20), facts())).toBeNull();
    expect(groundedLifecycleOutcomeLine(42, facts())).toBeNull();
  });

  it('with anyone else there names neither the operation nor Minecraft, and the request does not give them', () => {
    expect(groundedLifecycleOutcomeLine('マイクラにログインできました。', facts({ others: true }))).toBeNull();
    expect(groundedLifecycleOutcomeLine('頼まれていたこと、結果が出ましたよ。', facts({ others: true }))).not.toBeNull();
    expect(JSON.parse(lifecycleOutcomeRequest(facts({ others: true })))).toEqual({ others_present: true, ended: expect.any(String) });
    expect(JSON.parse(lifecycleOutcomeRequest(facts()))).toMatchObject({ others_present: false, operation: expect.stringContaining('ログイン') });
  });

  it('has a neutral factual line for every operation and end, which its own check accepts', () => {
    const outcomes: LifecycleOutcomeKind[] = ['completed', 'refused', 'cancelled', 'not_started', 'unknown'];
    for (const action of MINECRAFT_LIFECYCLE_ACTIONS) for (const outcome of outcomes) for (const others of [false, true]) {
      const line = neutralLifecycleOutcomeLine({ action, outcome, others });
      expect(groundedLifecycleOutcomeLine(line, { action, outcome, others }), `${action} ${outcome} ${others}`).toBe(line);
    }
    expect(neutralLifecycleOutcomeLine(facts())).toBe('マイクラにログインしました。');
    expect(neutralLifecycleOutcomeLine(facts({ others: true }))).not.toMatch(/マイクラ|ログイン/u);
  });
});

describe('telling him how it ended', () => {
  it('says her line once, into the Talk it was asked in, as an initiative the body says like a due promise', async () => {
    const d = database();
    const written: LifecycleOutcomeFacts[] = [];
    const tell = lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at,
      writer: { write: async (_scope, facts) => { written.push(facts); return 'ライ氏、マイクラにログインできましたよ。'; } } });
    await Promise.all([tell(report()), tell(report())]);
    await tell(report());
    expect(written).toEqual([{ action: 'login', outcome: 'completed', others: false }]);
    expect(d.messages()).toEqual([{ thread_id: 'asked', content: 'ライ氏、マイクラにログインできましたよ。',
      source_item_id: `${LIFECYCLE_OUTCOME_SOURCE_PREFIX}${OPERATION}`, day_key: `${LIFECYCLE_OUTCOME_SOURCE_PREFIX}${OPERATION}` }]);
    expect(initiativeDelivery({ sourceItemId: `${LIFECYCLE_OUTCOME_SOURCE_PREFIX}${OPERATION}`, createdAt: '2026-10-13T00:00:00.000Z', authored: false },
      at, { timeZone: 'Asia/Tokyo', morningHours: { start: 6, end: 10 } })).toBe('unjudged');
  });

  it('says the neutral line when no line can be written, and the private-safe one with anyone else there', async () => {
    const d = database();
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at, writer: null })(report({ outcome: 'unknown', action: 'stop' }));
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at, writer: { write: async () => null } })(
      report({ operationId: `lifecycle:${'b'.repeat(64)}`, outcome: 'refused' }));
    let present = false;
    // Someone came while her line was written: it is not said in front of them.
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => present, now: () => at,
      writer: { write: async () => { present = true; return 'マイクラにログインできました。'; } } })(report({ operationId: `lifecycle:${'c'.repeat(64)}` }));
    // The audience cannot be read: as if someone were there.
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => { throw new Error('unreadable'); }, now: () => at, writer: null })(
      report({ operationId: `lifecycle:${'d'.repeat(64)}` }));
    expect(d.messages().map(row => row.content)).toEqual([
      'マイクラのサーバーの停止は、結果を確かめられませんでした。', 'マイクラのログインは、体に断られてできませんでした。',
      '頼まれていた作業の結果が出ました（内容はアプリで確認できます）。', '頼まれていた作業の結果が出ました（内容はアプリで確認できます）。',
    ]);
  });

  it('falls back to the most recent open Talk when the one it was asked in is gone, and never throws', async () => {
    const d = database();
    const tell = lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at, writer: null });
    await tell(report({ threadId: 'gone' }));
    expect(d.messages()[0]).toMatchObject({ thread_id: 'later' });
    const broken = lifecycleOutcomeTeller({ speaker: { told: () => false, say: () => { throw new Error('locked'); } }, others: () => false, now: () => at, writer: null });
    await expect(broken(report())).resolves.toBeUndefined();
  });

  it('reads the end from the runner settlement: a receipt outcome, else unknown once issued, else never started', () => {
    const receipt = (outcome: 'completed' | 'refused' | 'cancelled' | 'unknown') => ({ outcome }) as never;
    expect(settledOutcome({ receipt: receipt('completed'), issued: true })).toBe('completed');
    expect(settledOutcome({ receipt: receipt('refused'), issued: true })).toBe('refused');
    expect(settledOutcome({ receipt: receipt('cancelled'), issued: true })).toBe('cancelled');
    expect(settledOutcome({ receipt: receipt('unknown'), issued: true })).toBe('unknown');
    expect(settledOutcome({ receipt: null, issued: true })).toBe('unknown');
    expect(settledOutcome({ receipt: null, issued: false })).toBe('not_started');
  });
});
