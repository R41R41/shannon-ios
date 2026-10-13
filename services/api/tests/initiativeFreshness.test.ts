import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchDataRequest, type ApiDataRouteDependencies } from '../src/infra/http/apiDataRoutes.js';
import { freshInitiativeInbox, initiativeDelivery } from '../src/surfaces/outreach/initiativeFreshness.js';
import { SQLiteInitiativeSources } from '../src/surfaces/outreach/store/initiativeSources.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { MORNING_BRIEF_HOURS } from '../src/wiring/dailyReadWiring.js';

/**
 * A body's spoken delivery of her initiatives (owner decision 2026-10-14). Only the body's own poll (`for=body`) is judged: what is
 * past its time is left out, a budget request, a goal's state and a topic without her own words are text only (`spoken: false`).
 * Without the marker every client (the Windows desk shares the body's device id) gets the list as it was, and reads mark read as
 * they always did.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-freshness-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const MINUTE = 60_000;
const SCOPE = 'owner';
const NOON = '2026-10-02T03:00:00.000Z'; // 12:00 in Tokyo
const OPTIONS = { timeZone: 'Asia/Tokyo', morningHours: MORNING_BRIEF_HOURS };
const ago = (minutes: number, at = NOON) => new Date(Date.parse(at) - minutes * MINUTE).toISOString();
const judge = (sourceItemId: string, createdAt: string, at = NOON, authored = false) => initiativeDelivery({ sourceItemId, createdAt, authored }, at, OPTIONS);

describe('the rule', () => {
  it('says a morning brief only on its own morning, inside the brief\'s hours', () => {
    const morning = '2026-10-01T23:30:00.000Z'; // 08:30 in Tokyo on 10-02
    expect(judge('morning-brief:2026-10-02', ago(60, morning), morning)).toBe('voice');
    // Written at 07:00, first seen at noon: not said aloud.
    expect(judge('morning-brief:2026-10-02', '2026-10-01T22:00:00.000Z')).toBe('stale');
    expect(judge('morning-brief:2026-10-01', ago(5, morning), morning)).toBe('stale');
  });

  it('keeps the gate\'s intent expiry at the moment of saying: a story 75 minutes, a goal 75, the world 150', () => {
    expect(judge('study:p1:v2', ago(74))).toBe('voice');
    expect(judge('study:p1:v2', ago(76))).toBe('stale');
    expect(judge('intent:i1:none:1', ago(76))).toBe('stale');
    expect(judge('https://example.org/item', ago(149), NOON, true)).toBe('voice');
    expect(judge('https://example.org/item', ago(151), NOON, true)).toBe('stale');
  });

  it('gives as text only what is not her own speech: a budget request, a goal\'s state, a topic without her words', () => {
    expect(judge('autonomy-budget:r1', ago(600))).toBe('text');
    expect(judge('intent:i1:none:1', ago(5))).toBe('text');
    expect(judge('https://example.org/item', ago(5), NOON, false)).toBe('text');
  });

  it('leaves her own messages, a look\'s answer and a due promise as they were', () => {
    for (const source of ['reach-out:wonder:x', 'reach-out-call:2026-10-02:x', 'body-look:l1', 'commitment:m1:t']) {
      expect(judge(source, ago(600))).toBe('unjudged');
    }
  });
});

let databases = 0;

function world(enabled = true) {
  const path = join(directory, `fresh-${databases += 1}.sqlite`);
  const persistent = new SQLiteShannonStore({ path, now: () => NOON });
  const store = new SQLiteInitiativeStore(path, () => NOON);
  const sources = new SQLiteInitiativeSources(path);
  const inbox = freshInitiativeInbox(store, { enabled, sources: (scopeKey, ids) => sources.sources(scopeKey, ids), options: OPTIONS });
  const database = new DatabaseSync(path);
  const insert = (id: string, source: string, createdAt: string, metadata: Record<string, unknown> = {}) => {
    database.prepare(`
      INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at)
      VALUES (?, ?, 't1', ?, '', '', ?, 'thinking', ?, ?)
    `).run(id, SCOPE, source, `本文 ${id}`, `day:${id}`, createdAt);
    database.prepare(`
      INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
      VALUES (?, ?, 't1', ?, 1, 'assistant', ?, ?, ?)
    `).run(randomUUID(), SCOPE, `initiative:${id}`, `本文 ${id}`, createdAt, JSON.stringify({ initiativeId: id, ...metadata }));
  };
  insert('brief', 'morning-brief:2026-10-02', '2026-10-01T22:00:00.000Z');
  insert('story', 'study:p1:v1', ago(20));
  insert('old-world', 'https://example.org/old', ago(300), { authoredOpening: true });
  insert('her-world', 'https://example.org/hers', ago(10), { authoredOpening: true });
  insert('bare-world', 'https://example.org/bare', ago(10));
  insert('budget', 'autonomy-budget:r1', ago(10));
  insert('promise', 'commitment:m1:t', ago(300));
  const dependencies = { initiativeInbox: inbox, now: () => NOON } as unknown as ApiDataRouteDependencies;
  const get = async (marker?: 'body') => {
    const query = new URLSearchParams({ scopeKey: SCOPE, ...(marker ? { for: marker } : {}) });
    const result = await dispatchDataRequest({ method: 'GET', path: '/v1/initiatives', query, deviceId: 'windows-1' }, dependencies);
    return (result!.body as { messages: Array<{ id: string; spoken?: boolean }> }).messages
      .map(message => (message.spoken === false ? `${message.id}(text)` : message.id)).sort();
  };
  const read = async () => dispatchDataRequest({
    method: 'POST', path: '/v1/initiatives/read', query: new URLSearchParams(), body: { scopeKey: SCOPE, threadId: 't1' }, deviceId: 'windows-1',
  }, dependencies);
  const close = () => { database.close(); sources.close(); store.close(); persistent.close(); };
  return { get, read, close };
}

const ALL = ['brief', 'budget', 'bare-world', 'her-world', 'old-world', 'promise', 'story'].sort();

describe('at delivery', () => {
  it('judges only the body\'s own poll: the desk on the same device gets the whole list as it was', async () => {
    const w = world();
    expect(await w.get('body')).toEqual(['bare-world(text)', 'budget(text)', 'her-world', 'promise', 'story']);
    expect(await w.get()).toEqual(ALL);
    w.close();
  });

  it('reads mark read as they always did, for every client', async () => {
    const w = world();
    expect((await w.read())!.body).toEqual({ markedRead: 7 });
    expect(await w.get()).toEqual([]);
    w.close();
  });

  it('is the list as it was with SHANNON_BODY_INITIATIVE_FRESHNESS off', async () => {
    const w = world(false);
    expect(await w.get('body')).toEqual(ALL);
    w.close();
  });
});
