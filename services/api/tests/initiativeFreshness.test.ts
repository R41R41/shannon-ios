import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchDataRequest, type ApiDataRouteDependencies } from '../src/infra/http/apiDataRoutes.js';
import { freshInitiativeInbox, initiativeVoicing } from '../src/surfaces/outreach/initiativeFreshness.js';
import { SQLiteInitiativeReadState } from '../src/surfaces/outreach/store/initiativeReadState.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { MORNING_BRIEF_HOURS } from '../src/wiring/dailyReadWiring.js';

/**
 * Freshness at delivery (owner decision 2026-10-14): a body of hers says an initiative aloud only while it is fresh, by the proactive
 * gate's own intent expiry applied again at the moment of saying; a morning brief only on its own morning. What is past that is not
 * handed to the body, and the body's read leaves it unread, so the apps still show it as unread text.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-freshness-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const MINUTE = 60_000;
const SCOPE = 'owner';
const NOON = '2026-10-02T03:00:00.000Z'; // 12:00 in Tokyo
const OPTIONS = { timeZone: 'Asia/Tokyo', morningHours: MORNING_BRIEF_HOURS };
const ago = (minutes: number, at = NOON) => new Date(Date.parse(at) - minutes * MINUTE).toISOString();

describe('the freshness rule', () => {
  it('says a morning brief only on its own morning, inside the brief\'s hours', () => {
    const morning = '2026-10-01T23:30:00.000Z'; // 08:30 in Tokyo on 10-02
    expect(initiativeVoicing('morning-brief:2026-10-02', ago(60, morning), morning, OPTIONS)).toBe('fresh');
    // Written at 07:00, first seen at noon: not said aloud.
    expect(initiativeVoicing('morning-brief:2026-10-02', '2026-10-01T22:00:00.000Z', NOON, OPTIONS)).toBe('stale');
    expect(initiativeVoicing('morning-brief:2026-10-01', ago(5, morning), morning, OPTIONS)).toBe('stale');
  });

  it('says a topic only within the gate\'s intent expiry: a story 75 minutes, a goal 75, the world 150', () => {
    expect(initiativeVoicing('study:p1:v2', ago(74), NOON, OPTIONS)).toBe('fresh');
    expect(initiativeVoicing('study:p1:v2', ago(76), NOON, OPTIONS)).toBe('stale');
    expect(initiativeVoicing('intent:i1:none:1', ago(76), NOON, OPTIONS)).toBe('stale');
    expect(initiativeVoicing('https://example.org/item', ago(149), NOON, OPTIONS)).toBe('fresh');
    expect(initiativeVoicing('https://example.org/item', ago(151), NOON, OPTIONS)).toBe('stale');
  });

  it('leaves what is not hers to judge as it was: her own messages, a look\'s answer, a due promise, a budget request', () => {
    for (const source of ['reach-out:wonder:x', 'reach-out-call:2026-10-02:x', 'body-look:l1', 'commitment:m1:t', 'autonomy-budget:r1']) {
      expect(initiativeVoicing(source, ago(600), NOON, OPTIONS)).toBe('unjudged');
    }
  });
});

let databases = 0;

function world(enabled = true) {
  const path = join(directory, `fresh-${databases += 1}.sqlite`);
  const store = new SQLiteInitiativeStore(path, () => NOON);
  const readState = new SQLiteInitiativeReadState(path);
  const inbox = freshInitiativeInbox(store, { enabled, isBody: (_scope, deviceId) => deviceId === 'body-1', readState, options: OPTIONS });
  const database = new DatabaseSync(path);
  const insert = (id: string, source: string, createdAt: string) => database.prepare(`
    INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at)
    VALUES (?, ?, 't1', ?, '', '', ?, 'thinking', ?, ?)
  `).run(id, SCOPE, source, `本文 ${id}`, `day:${id}`, createdAt);
  insert('brief', 'morning-brief:2026-10-02', '2026-10-01T22:00:00.000Z');
  insert('story', 'study:p1:v1', ago(20));
  insert('world', 'https://example.org/old', ago(300));
  insert('promise', 'commitment:m1:t', ago(300));
  const dependencies = { initiativeInbox: inbox, now: () => NOON } as unknown as ApiDataRouteDependencies;
  const get = async (deviceId?: string) => {
    const query = new URLSearchParams({ scopeKey: SCOPE });
    const result = await dispatchDataRequest({ method: 'GET', path: '/v1/initiatives', query, ...(deviceId ? { deviceId } : {}) }, dependencies);
    return (result!.body as { messages: Array<{ id: string }> }).messages.map(message => message.id).sort();
  };
  const read = async (deviceId: string) => dispatchDataRequest({
    method: 'POST', path: '/v1/initiatives/read', query: new URLSearchParams(), body: { scopeKey: SCOPE, threadId: 't1' }, deviceId,
  }, dependencies);
  const close = () => { database.close(); readState.close(); store.close(); };
  return { get, read, close };
}

describe('at delivery', () => {
  it('hands a body only what is fresh to say aloud, and an app everything unread', async () => {
    const w = world();
    expect(await w.get('body-1')).toEqual(['promise', 'story']);
    expect(await w.get('iphone-1')).toEqual(['brief', 'promise', 'story', 'world']);
    expect(await w.get()).toEqual(['brief', 'promise', 'story', 'world']);
    w.close();
  });

  it('lets a body\'s read leave unread what it was not handed, so the apps show it as unread text', async () => {
    const w = world();
    expect((await w.read('body-1'))!.body).toEqual({ markedRead: 2 });
    expect(await w.get('iphone-1')).toEqual(['brief', 'world']);
    expect(await w.get('body-1')).toEqual([]);
    w.close();
  });

  it('is as before with SHANNON_BODY_INITIATIVE_FRESHNESS off', async () => {
    const w = world(false);
    expect(await w.get('body-1')).toEqual(['brief', 'promise', 'story', 'world']);
    expect((await w.read('body-1'))!.body).toEqual({ markedRead: 4 });
    w.close();
  });
});
