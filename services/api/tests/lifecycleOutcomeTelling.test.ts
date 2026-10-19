import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIFECYCLE_PHRASES_V1, lifecycleOutcomeMessage, lifecycleOutcomeRequest, lifecyclePhraseChoices, lifecyclePhraseSchema, neutralLifecycleOutcomeLine,
  type LifecycleOutcomeFacts, type LifecycleOutcomeKind,
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

describe('the message: the fact word for word, and a phrase of hers from the list', () => {
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

  /** The re-review of 0ac5d742: free phrases that undercut the fact passed a filter (negating it, emoji, the wrong feeling). */
  const UNDERCUTTING = ['嘘だよ', 'なーんて', '冗談', '今のなし', '🎉', '😭', '次は頑張る', 'おめでとう', 'やったね！🎉', 'ふふん', 'ふふん、 ', ' ライ氏、'];

  it('says, for every operation and end, every listed phrase in every place it takes, around the fact word for word', () => {
    for (const action of MINECRAFT_LIFECYCLE_ACTIONS) for (const outcome of OUTCOMES) {
      const given = facts({ action, outcome }), fact = neutralLifecycleOutcomeLine(given);
      const family = LIFECYCLE_PHRASES_V1[outcome === 'completed' ? 'done' : 'not_done'];
      expect(lifecyclePhraseChoices(outcome)).toEqual(family.map(entry => entry.text));
      for (const entry of family) for (const position of ['before', 'after'] as const) {
        const message = lifecycleOutcomeMessage({ phrase: entry.text, position }, given);
        // A place the phrase does not take is its first place instead.
        const place = entry.positions.includes(position) ? position : entry.positions[0];
        expect(message, `${action} ${outcome} ${entry.text} ${position}`).toBe(place === 'before' ? `${entry.text}${fact}` : `${fact}${entry.text}`);
      }
      expect(lifecycleOutcomeMessage({ phrase: '', position: 'before' }, given)).toBe(fact);
    }
    // Where each phrase reads well: an address and an opening go before, a trailing apology after.
    expect(lifecycleOutcomeMessage({ phrase: 'ライ氏、', position: 'after' }, facts())).toBe('ライ氏、マイクラにログインしました。');
    expect(lifecycleOutcomeMessage({ phrase: '…ごめんね', position: 'before' }, facts({ outcome: 'refused' })))
      .toBe('マイクラのログインは、体に断られてできませんでした。…ごめんね');
  });

  it('drops every phrase not on the list for the end, the reviews\' examples among them, and says the fact alone', () => {
    const notListed: Array<[Partial<LifecycleOutcomeFacts>, unknown]> = [
      ...UNDERCUTTING.flatMap(phrase => OUTCOMES.map(outcome => [{ outcome }, phrase] as [Partial<LifecycleOutcomeFacts>, unknown])),
      ...[...FAILURE_AS_SUCCESS, ...SUCCESS_AS_FAILURE].map(([patch, phrase]) => [patch, phrase] as [Partial<LifecycleOutcomeFacts>, unknown]),
      // A phrase of the other family: no celebration for an end that is not done, no apology for a done one.
      ...['やったね！', 'ふふん、', 'えへへ、', 'じゃーん、', 'お待たせ！'].map(phrase => [{ outcome: 'refused' }, phrase] as [Partial<LifecycleOutcomeFacts>, unknown]),
      ...['…ごめんね', 'ごめんね、', 'えっと、', 'お待たせ。'].map(phrase => [{}, phrase] as [Partial<LifecycleOutcomeFacts>, unknown]),
      [{}, 42], [{}, null], [{}, { text: 'ふふ、' }],
    ];
    expect(FAILURE_AS_SUCCESS.length + SUCCESS_AS_FAILURE.length).toBe(25);
    for (const [patch, phrase] of notListed) for (const position of ['before', 'after']) {
      const given = facts(patch);
      expect(lifecycleOutcomeMessage({ phrase, position }, given), `${given.outcome} ${String(phrase)}`).toBe(neutralLifecycleOutcomeLine(given));
    }
    // No answer, and anyone else there: the fact (the private-safe one) alone.
    expect(lifecycleOutcomeMessage(null, facts())).toBe('マイクラにログインしました。');
    expect(lifecycleOutcomeMessage({ phrase: 'やったね！', position: 'after' }, facts({ others: true })))
      .toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
  });

  it('holds the model to the list in its schema, and gives it the end and the list only', () => {
    for (const outcome of OUTCOMES) {
      const schema = lifecyclePhraseSchema({ outcome }) as { properties: { phrase: { enum: string[] }; position: { enum: string[] } } };
      expect(schema.properties.phrase.enum).toEqual(['', ...lifecyclePhraseChoices(outcome)]);
      expect(schema.properties.position.enum).toEqual(['before', 'after']);
    }
    expect(JSON.parse(lifecycleOutcomeRequest(facts()))).toEqual({ ended: 'done', phrases: lifecyclePhraseChoices('completed') });
    for (const outcome of OUTCOMES) expect(neutralLifecycleOutcomeLine(facts({ outcome, others: true })))
      .toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
    expect(neutralLifecycleOutcomeLine(facts())).toBe('マイクラにログインしました。');
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

  it('says a new world was made, and where the old one is kept, when the start\'s receipt named one', async () => {
    const d = database();
    const written: LifecycleOutcomeFacts[] = [];
    const tell = lifecycleOutcomeTeller({ speaker: d.speaker, others: () => false, now: () => at,
      writer: { write: async (_scope, facts) => { written.push(facts); return lifecycleOutcomeMessage({ phrase: 'やったね！', position: 'after' }, facts); } } });
    await tell(report({ action: 'start', freshWorld: { movedTo: 'shannon_home.before-regen-20261019T1204' } }));
    expect(written).toEqual([{ action: 'start', outcome: 'completed', others: false, freshWorld: { movedTo: 'shannon_home.before-regen-20261019T1204' } }]);
    expect(d.messages().map(row => row.content)).toEqual([
      'マイクラのサーバーを起動しました。新しいワールドで始めました（前のワールドは shannon_home.before-regen-20261019T1204 として残しています）。やったね！']);
    // With nothing named, and with anyone else there, nothing about a new world is said.
    const plain = database();
    await lifecycleOutcomeTeller({ speaker: plain.speaker, others: () => false, now: () => at, writer: null })(report({ action: 'start' }));
    await lifecycleOutcomeTeller({ speaker: plain.speaker, others: () => true, now: () => at, writer: null })(
      report({ action: 'start', operationId: `lifecycle:${'e'.repeat(64)}`, freshWorld: { movedTo: 'x' } }));
    expect(plain.messages().map(row => row.content)).toEqual(['マイクラのサーバーを起動しました。', '頼まれていた作業の結果が出ました（内容はアプリで確認できます）。']);
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
