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

  it('refuses every line the review of 1cffa192 found misstating the end (and any line of hers with anyone else there)', () => {
    const misstated: Array<[LifecycleOutcomeFacts, string]> = [
      [facts({ outcome: 'refused' }), '入ったよ！ダメかと思った'],
      [facts({ outcome: 'refused' }), 'ログインしたよ。断られるかと思ったけど'],
      [facts({ action: 'start', outcome: 'cancelled' }), '起動しておいたよ。中止にはならなかった'],
      [facts({ outcome: 'refused' }), 'サーバーは起動したけど、ログインはできなかった'],
      [facts(), 'ログインしようとしたけど、うまくいかなかった'],
      [facts(), 'マイクラに入れなかったみたい'],
      // More of the same kinds: a plain past tense or a success word for an end that is not done, a failure word for a done one.
      [facts({ outcome: 'not_started' }), 'ログイン、ばっちりです。始められないかと思いました'],
      [facts({ outcome: 'unknown' }), 'ログインは無事に済んだはず。わからないけど'],
      [facts({ action: 'stop', outcome: 'refused' }), 'サーバー止めたよ、断られなかった'],
      [facts({ action: 'set_day', outcome: 'cancelled' }), '昼にしたよ。キャンセルはされなかった'],
      [facts({ action: 'stop' }), 'サーバーの停止、残念ながらしくじりました'],
      [facts(), 'ログインはいけなかったです'],
      [facts(), 'ログイン、だめでした'],
      [facts(), 'ログインのこと、伝えますね'], // no cue of its end at all
      [facts({ action: 'logout' }), 'ログインし直してからログアウトしました'], // another operation
    ];
    for (const [given, line] of misstated) expect(groundedLifecycleOutcomeLine(line, given), `${given.outcome}: ${line}`).toBeNull();
    // With anyone else there no line of hers is used, whatever it says.
    for (const line of ['頼まれていたこと、結果が出ましたよ。', 'マイクラにログインできました。', '終わりました！', '頼まれていた作業の結果が出ました（内容はアプリで確認できます）。']) {
      expect(groundedLifecycleOutcomeLine(line, facts({ others: true })), line).toBeNull();
    }
    // The writer is only ever asked while he is alone: its request names the operation and the end, nothing of an audience.
    expect(JSON.parse(lifecycleOutcomeRequest(facts()))).toEqual({ operation: expect.stringContaining('ログイン'), ended: expect.any(String) });
  });

  it('keeps her words when they state the end as it is', () => {
    expect(groundedLifecycleOutcomeLine('マイクラにログインしたよ、ライ氏。', facts())).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('サーバー、起動しておきました！', facts({ action: 'start' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('サーバーを起動しました！', facts({ action: 'start' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('マイクラの時刻、昼にしました。', facts({ action: 'set_day' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('ログインは取りやめになりました。', facts({ outcome: 'cancelled' }))).not.toBeNull();
    expect(groundedLifecycleOutcomeLine('ログイン、始められませんでした。', facts({ outcome: 'not_started' }))).not.toBeNull();
  });

  it('has a neutral factual line for every operation and end: for him alone its own check accepts it, with others it names nothing', () => {
    const outcomes: LifecycleOutcomeKind[] = ['completed', 'refused', 'cancelled', 'not_started', 'unknown'];
    for (const action of MINECRAFT_LIFECYCLE_ACTIONS) for (const outcome of outcomes) {
      const line = neutralLifecycleOutcomeLine({ action, outcome, others: false });
      expect(groundedLifecycleOutcomeLine(line, { action, outcome, others: false }), `${action} ${outcome}`).toBe(line);
      expect(neutralLifecycleOutcomeLine({ action, outcome, others: true })).toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
    }
    expect(neutralLifecycleOutcomeLine(facts())).toBe('マイクラにログインしました。');
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

  it('never asks the model with anyone else there, and says nothing once a shutdown began (the one message is kept)', async () => {
    const d = database();
    let asked = 0;
    const writer = { write: async () => { asked += 1; return 'マイクラにログインしたよ。'; } };
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => true, now: () => at, writer })(report());
    expect(asked).toBe(0);
    expect(d.messages().map(row => row.content)).toEqual(['頼まれていた作業の結果が出ました（内容はアプリで確認できます）。']);

    const stopping = new AbortController();
    const second = `lifecycle:${'f'.repeat(64)}`;
    stopping.abort();
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at, writer, signal: stopping.signal })(report({ operationId: second }));
    // Aborted while her line was written: not said either.
    const during = new AbortController();
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at, signal: during.signal,
      writer: { write: async () => { during.abort(); return null; } } })(report({ operationId: second, outcome: 'unknown' }));
    expect(d.messages()).toHaveLength(1);
    expect(d.speaker.told('owner', second)).toBe(false);
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
