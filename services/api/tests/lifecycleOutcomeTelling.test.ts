import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lifecycleOutcomeMessage, lifecycleOutcomeRequest, lifecyclePhrase, neutralLifecycleOutcomeLine, type LifecycleOutcomeFacts, type LifecycleOutcomeKind,
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

describe('the message: the fact word for word, and her phrase', () => {
  const facts = (patch: Partial<LifecycleOutcomeFacts> = {}): LifecycleOutcomeFacts => ({ action: 'login', outcome: 'completed', others: false, ...patch });
  const OUTCOMES: LifecycleOutcomeKind[] = ['completed', 'refused', 'cancelled', 'not_started', 'unknown'];

  /**
   * The re-review of 2dc889ff: free sentences that state the end wrongly (14 that make a failure read as success, 11 that make a
   * success read as failure) by negation, attempt, concession, or words no list held. Whatever the model writes now, the message is
   * the fact sentence of the actual end word for word, and these never stand beside it.
   */
  const FAILURE_AS_SUCCESS: Array<[Partial<LifecycleOutcomeFacts>, string]> = [
    [{ outcome: 'refused' }, '入ったよ！ダメかと思った'],
    [{ outcome: 'refused' }, 'ログインしたよ。断られるかと思ったけど'],
    [{ action: 'start', outcome: 'cancelled' }, '起動しておいたよ。中止にはならなかった'],
    [{ outcome: 'refused' }, 'サーバーは起動したけど、ログインはできなかった'],
    [{ outcome: 'refused' }, '弾かれなかったよ！'],
    [{ outcome: 'refused' }, '駄目じゃなかった！'],
    [{ outcome: 'not_started' }, 'エラーは出なかったよ'],
    [{ outcome: 'unknown' }, 'もう入ってるよ'],
    [{ outcome: 'unknown' }, '大丈夫だったはず'],
    [{ outcome: 'cancelled' }, 'オッケー、いけたよ'],
    [{ outcome: 'refused' }, '断られるなんてことはなかった'],
    [{ outcome: 'not_started' }, '始められないかと思ったけど、平気'],
    [{ outcome: 'unknown' }, 'たぶん入れたかも'],
    [{ action: 'stop', outcome: 'refused' }, '止まらないなんてことはないよ'],
  ];
  const SUCCESS_AS_FAILURE: Array<[Partial<LifecycleOutcomeFacts>, string]> = [
    [{}, 'ログインしようとしたけど、うまくいかなかった'],
    [{}, 'マイクラに入れなかったみたい'],
    [{}, '入れないままだった'],
    [{}, '入れずじまいでした'],
    [{}, 'しくじっちゃった'],
    [{}, 'エラーが出ちゃった'],
    [{ action: 'start' }, '起動しようとしたのに'],
    [{ action: 'set_day' }, '昼にするつもりだったけど'],
    [{}, '弾かれちゃったみたい'],
    [{ action: 'logout' }, 'まだ抜けてないっぽい'],
    [{}, '…ごめんね、駄目だった'],
  ];

  it('never lets the 25 misstated sentences of the review stand beside the fact, in either place', () => {
    expect(FAILURE_AS_SUCCESS).toHaveLength(14);
    expect(SUCCESS_AS_FAILURE).toHaveLength(11);
    for (const [patch, phrase] of [...FAILURE_AS_SUCCESS, ...SUCCESS_AS_FAILURE]) for (const position of ['before', 'after']) {
      const given = facts(patch);
      expect(lifecyclePhrase(phrase, given), phrase).toBeNull();
      expect(lifecycleOutcomeMessage({ phrase, position }, given), phrase).toBe(neutralLifecycleOutcomeLine(given));
    }
  });

  it('keeps a short feeling or address that fits the end, before or after the fact', () => {
    expect(lifecycleOutcomeMessage({ phrase: 'ふふん、', position: 'before' }, facts())).toBe('ふふん、マイクラにログインしました。');
    expect(lifecycleOutcomeMessage({ phrase: 'やったね！', position: 'after' }, facts())).toBe('マイクラにログインしました。やったね！');
    expect(lifecycleOutcomeMessage({ phrase: 'ライ氏', position: 'before' }, facts())).toBe('ライ氏、マイクラにログインしました。');
    expect(lifecycleOutcomeMessage({ phrase: '…ごめんね', position: 'after' }, facts({ outcome: 'refused' })))
      .toBe('マイクラのログインは、体に断られてできませんでした。…ごめんね');
    expect(lifecycleOutcomeMessage({ phrase: 'ちょっと待ってて', position: 'after' }, facts({ outcome: 'unknown' })))
      .toBe('マイクラのログインは、結果を確かめられませんでした。ちょっと待ってて');
  });

  it('drops a phrase that names what, says how, hedges, carries a number, or whose feeling does not fit the end', () => {
    const dropped: Array<[Partial<LifecycleOutcomeFacts>, unknown]> = [
      [{}, 'マイクラ楽しみ！'], [{}, 'ログインばっちり'], [{}, 'サーバー元気'], [{}, '体が軽い！'], [{}, '完了！'], [{}, '無事に！'],
      [{}, '大丈夫！'], [{}, 'オッケー！'], [{}, 'あと3分'], [{}, 'ちゃんとね'], [{}, 'たぶんね？'], [{}, 'もう平気'],
      [{}, 'できたよ'], [{}, '済んだよ'], [{}, 'しておいたよ'], [{}, 'だけど、ね'], [{}, '「やったね」'], [{}, 'ふふん、'.repeat(6)],
      [{}, '…ごめんね'], [{}, 'うう、悔しい'], // regret for a done one
      [{ outcome: 'refused' }, 'やったね！'], [{ outcome: 'cancelled' }, 'よかった！'], [{ outcome: 'unknown' }, 'ふふん、'],
      [{ outcome: 'not_started' }, 'わーい'], [{ outcome: 'refused' }, '任せてね'],
      [{}, 42], [{}, ''], [{}, null],
    ];
    for (const [patch, phrase] of dropped) {
      const given = facts(patch);
      expect(lifecyclePhrase(phrase, given), String(phrase)).toBeNull();
      expect(lifecycleOutcomeMessage({ phrase, position: 'after' }, given)).toBe(neutralLifecycleOutcomeLine(given));
    }
    // An answer that is not one, and anyone else there: the fact (the private-safe one) alone.
    expect(lifecycleOutcomeMessage(null, facts())).toBe('マイクラにログインしました。');
    expect(lifecycleOutcomeMessage({ phrase: 'やったね！', position: 'after' }, facts({ others: true })))
      .toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
  });

  it('says the fact of every operation and end word for word, whatever phrase stands beside it', () => {
    for (const action of MINECRAFT_LIFECYCLE_ACTIONS) for (const outcome of OUTCOMES) for (const phrase of ['やったね！', '…ごめんね', 'ねえ', 'ログインできなかった']) {
      const given = facts({ action, outcome }), fact = neutralLifecycleOutcomeLine(given);
      const message = lifecycleOutcomeMessage({ phrase, position: 'after' }, given);
      expect(message.startsWith(fact), `${action} ${outcome} ${phrase}`).toBe(true);
      const added = message.slice(fact.length);
      if (added) expect(lifecyclePhrase(added, given)).toBe(added);
      expect(neutralLifecycleOutcomeLine({ action, outcome, others: true })).toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
    }
    expect(neutralLifecycleOutcomeLine(facts())).toBe('マイクラにログインしました。');
    // The writer is given the end only, for the feeling: nothing of an audience or an operation to restate.
    expect(JSON.parse(lifecycleOutcomeRequest(facts()))).toEqual({ ended: 'done' });
  });
});

describe('telling him how it ended', () => {
  it('says her line once, into the Talk it was asked in, as an initiative the body says like a due promise', async () => {
    const d = database();
    const written: LifecycleOutcomeFacts[] = [];
    const tell = lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at,
      writer: { write: async (_scope, facts) => { written.push(facts); return lifecycleOutcomeMessage({ phrase: 'やったね！', position: 'after' }, facts); } } });
    await Promise.all([tell(report()), tell(report())]);
    await tell(report());
    expect(written).toEqual([{ action: 'login', outcome: 'completed', others: false }]);
    expect(d.messages()).toEqual([{ thread_id: 'asked', content: 'マイクラにログインしました。やったね！',
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

  it('never says a message of the writer that does not carry the fact word for word', async () => {
    const d = database();
    await lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at,
      writer: { write: async () => 'ログインできなかったみたい…ごめんね' } })(report());
    expect(d.messages().map(row => row.content)).toEqual(['マイクラにログインしました。']);
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
