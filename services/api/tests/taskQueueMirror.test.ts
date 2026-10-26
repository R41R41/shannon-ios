import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { createLlmcQueue, forgetLlmcQueues, queueWakeMs, QUEUE_MAX, QUEUE_T } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';

/**
 * The head's mirror of the body's item queue (design minebot-task-queue, 2026-10-26) against the real control, with the body played by hand: the items
 * in their order and `after`, the commands handed over, the results as news, when the next decision is due, and what a bad end drops.
 */
const at = '2026-10-26T00:00:00.000Z';
const lease = { id: 'lease-1', generation: 1, holder: 'test' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); forgetLlmcQueues(); forgetActNodes(); });

function setup() {
  const db = new DatabaseSync(':memory:'), store = new MinecraftControlStore(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.now(), ownerAlone: () => true, leaseValid: () => true, pollMilliseconds: 1,
    cancelWaitMilliseconds: 50, frameMilliseconds: 60_000 });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  let sequence = 0;
  const running: string[] = [], queued: string[] = [], receipts: MinecraftControlReceipt[] = [];
  let progress: MinecraftControlPoll['queue'];
  const handed: MinecraftControlCommand[] = [];
  /** One poll of the body: what it runs, what it holds waiting, the receipts it has; returns what the head handed over. */
  const poll = () => {
    const reply = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
      schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true,
        state: { world: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20 } }, facts: {} },
      skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [],
      receipts: [...receipts], activeOperationIds: [...running], queuedOperationIds: [...queued], ...(progress ? { queue: progress } : {}),
    } satisfies MinecraftControlPoll);
    for (const id of reply.acknowledged) { const index = receipts.findIndex(item => item.id === id); if (index >= 0) receipts.splice(index, 1); }
    handed.push(...reply.commands);
    return reply;
  };
  poll();
  const lines: string[] = [];
  const queue = createLlmcQueue({ control, taskId: 't1', lease, bodyId: () => 'minecraft:world', observe: () => control.observe('minecraft:world'), log: line => lines.push(line),
    context: () => ({ scopeKey: 'owner', taskId: 't1', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session-1', generation: 1, goal: 'g', completionCondition: 'c' }) });
  cleanups.push(() => { queue.stop(); db.close(); });
  let counter = 0;
  const spec = (hands: ActInput['hands'], extra: Partial<ActInput> = {}, node: string | null = 'p1') => {
    counter += 1;
    const input: ActInput = { hands, why: `[${node ?? 'p0'}] 項目${counter}`, ...extra };
    return { call: { id: `c${counter}`, name: 'mc.act', input }, operationId: `step:c${counter}`, input, arguments: input as unknown as Record<string, unknown>, skill: 'act', node,
      why: input.why ?? '', fixes: [] as string[], maxMs: 20_000 };
  };
  /** The body takes the first command it was handed as running, the others as waiting (it has them all after one poll). */
  const take = () => {
    poll();
    const ids = handed.map(command => command.id);
    running.splice(0, running.length, ...ids.slice(0, 1));
    queued.splice(0, queued.length, ...ids.slice(1));
    poll();
  };
  /** The body ends the running item with this receipt; the next waiting one starts. */
  const end = (outcome: MinecraftControlReceipt['outcome'], result: string, extra: Partial<MinecraftControlReceipt> = {}) => {
    const id = running.shift()!;
    receipts.push({ id, connectionId: 'connection', outcome, inputsReleased: true, observedAt: at, result, ...extra });
    if (outcome === 'completed') { const next = queued.shift(); if (next) running.push(next); }
    return id;
  };
  /** The body drops the ones that wait (a bad end), each with its receipt. */
  const dropRest = (why: string) => {
    for (const id of queued.splice(0)) receipts.push({ id, connectionId: 'connection', outcome: 'cancelled', inputsReleased: true, observedAt: at, result: why,
      failureType: 'queue_dropped' });
  };
  return { control, queue, poll, take, end, dropRest, spec, handed, lines, running, queued, receipts, setProgress: (value: MinecraftControlPoll['queue']) => { progress = value; } };
}
const actResult = (done = 1) => JSON.stringify({ v: 1, ok: true, done, of: done, ms: 1000, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20,
  lines: Array.from({ length: done }, (_, i) => ({ i: i + 1, do: 'wait', status: 'done', line: '待った' })) });
const settle = async () => { await delay(60); };
const wait1 = [{ do: 'wait' as const, seconds: 1 }];
const dig = (x: number) => [{ do: 'dig' as const, at: [{ x, y: 64, z: 0 }] }];

describe('the items in their order', () => {
  it('chains each item to the one before, hands them over together, and says where each stands', async () => {
    const f = setup();
    const first = await f.queue.add(f.spec(wait1)), second = await f.queue.add(f.spec(dig(1)));
    expect(first).toMatchObject({ ok: true, item: 'q1', after: null });
    expect(second).toMatchObject({ ok: true, item: 'q2', after: 'q1' });
    f.poll();
    expect(f.handed.map(command => command.queue?.item)).toEqual(['q1', 'q2']);
    expect(f.handed.map(command => command.queue?.after)).toEqual([null, 'q1']);
    expect(f.handed[0]!.queue).toMatchObject({ node: 'p1', maxMs: 20_000 });
    expect(f.handed[0]!.arguments).toMatchObject({ hands: wait1 });
    expect(f.queue.tail()).toBe('q2');
    expect(f.queue.ahead()).toHaveLength(2);
    expect(f.queue.openIds().size).toBe(2);
  });

  it('refuses a fourth item, and the same hands twice, saying what to do', async () => {
    const f = setup();
    for (let index = 0; index < QUEUE_MAX; index++) expect((await f.queue.add(f.spec(dig(index)))).ok).toBe(true);
    const full = await f.queue.add(f.spec(dig(9)));
    expect(full).toMatchObject({ ok: false });
    expect((full as { text: string }).text).toContain('列がいっぱい');
    const g = setup();
    await g.queue.add(f.spec(dig(5)));
    const same = await g.queue.add({ ...f.spec(dig(5)) });
    expect(same.ok).toBe(false);
    expect((same as { text: string }).text).toContain('と同じ手が列にある');
  });

  it('carries pre and the node to the body, and a start-by after the items ahead', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    await f.queue.add({ ...f.spec(dig(1), {}, 'p7'), pre: [[{ k: 'have', item: 'iron_ore', n: 3 }]] });
    f.poll();
    expect(f.handed[1]!.queue).toMatchObject({ node: 'p7', pre: [[{ k: 'have', item: 'iron_ore', n: 3 }]] });
    expect(Date.parse(f.handed[1]!.queue!.startBy)).toBeGreaterThan(Date.parse(f.handed[0]!.queue!.startBy));
  });
});

describe('the results as news, and the version', () => {
  it('an item that ended well is news of the kind it ran, with its lines; the queue empties', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    f.take();
    f.end('completed', actResult(1));
    f.poll();
    await settle();
    expect(f.queue.open()).toBe(false);
    const news = f.queue.take();
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ kind: 'ran', item: 'q1', label: 'q1 [p1] 項目1' });
    expect(news[0]!.result.ok).toBe(true);
    expect(news[0]!.result.text).toContain('act 全部済み（1/1');
    expect(f.queue.take()).toEqual([]);
    expect(f.queue.version()).toBe(0);
  });

  it('a bad end drops the ones behind it: the bad one is news that ran, the others are told dropped, and the version changes once or more', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    await f.queue.add(f.spec(dig(1)));
    f.take();
    f.queue.mark();
    f.end('failed', JSON.stringify({ v: 1, ok: false, done: 0, of: 1, stoppedBy: 'failure', stoppedWhy: '掘れない', ms: 500, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'wait', status: 'stopped', line: '失敗' }] }));
    f.dropRest('捨てた: 前の項目 q1 が止まった（failure）。手は動いていない');
    f.poll();
    await settle();
    const news = f.queue.take();
    expect(news.map(item => [item.item, item.kind, item.result.ok])).toEqual([['q1', 'ran', false], ['q2', 'dropped', false]]);
    expect(news[1]!.result.text).toContain('捨てた: 前の項目 q1 が止まった');
    expect(f.queue.stale()).toBe(true);
    expect(f.queue.open()).toBe(false);
    expect(await f.queue.ready({ signal: new AbortController().signal, drain: false })).toBe('dropped');
  });

  it('the body refusing an item (the item before it is gone) is a drop that never ran, with the body\'s sentence', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    f.take();
    f.running.length = 0;
    f.receipts.push({ id: f.handed[0]!.id, connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: at, failureType: 'queue_after_gone',
      result: '断られた: 前の項目 q0 が見つからない' });
    f.poll();
    await settle();
    const [news] = f.queue.take();
    expect(news).toMatchObject({ kind: 'dropped', item: 'q1' });
    expect(news!.result.text).toContain('断られた');
  });
});

describe('when the next decision is due', () => {
  it('T is the median of the last decisions, within 2 and 8 s; 5 s with none', () => {
    const f = setup();
    expect(queueWakeMs('t1')).toBe(QUEUE_T.defaultMs);
    for (const ms of [3000, 4000, 9000]) f.queue.noteDecision(ms);
    expect(queueWakeMs('t1')).toBe(4000);
    for (const ms of [20_000, 20_000, 20_000, 20_000]) f.queue.noteDecision(ms);
    expect(queueWakeMs('t1')).toBe(QUEUE_T.maxMs);
    for (let index = 0; index < 10; index++) f.queue.noteDecision(100);
    expect(queueWakeMs('t1')).toBe(QUEUE_T.minMs);
  });

  it('with one item left and 5 s or less of it to run, now; with a long one, not yet; with another waiting, not yet', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    f.take();
    expect(await f.queue.ready({ signal: new AbortController().signal, drain: false })).toBe('remaining');
    const long = setup();
    await long.queue.add(long.spec([{ do: 'wait', seconds: 30 }]));
    long.take();
    const stop = new AbortController();
    const pending = long.queue.ready({ signal: stop.signal, drain: false });
    let woke = false;
    void pending.then(() => { woke = true; }, () => undefined);
    await delay(250);
    expect(woke).toBe(false);
    stop.abort();
    await expect(pending).rejects.toThrow();
    const two = setup();
    await two.queue.add(two.spec(wait1));
    await two.queue.add(two.spec(dig(2)));
    two.take();
    const hold = new AbortController();
    const waiting = two.queue.ready({ signal: hold.signal, drain: false });
    let two_woke = false;
    void waiting.then(() => { two_woke = true; }, () => undefined);
    await delay(250);
    expect(two_woke).toBe(false);
    // The first ends well: the second runs alone and is short.
    two.end('completed', actResult(1));
    two.poll();
    expect(await waiting).toBe('remaining');
  });

  it('the progress of the body counts: the hands left of a long repeat are time left', async () => {
    const f = setup();
    const walk = { do: 'walk' as const, to: { x: 40, y: 64, z: 0 } };
    await f.queue.add(f.spec([walk, walk, walk, walk], { repeat: 8 }));
    f.take();
    f.setProgress({ id: f.handed[0]!.id, hand: 1, of: 4, iteration: 1, repeat: 8 });
    f.poll();
    const stop = new AbortController();
    let woke = false;
    void f.queue.ready({ signal: stop.signal, drain: false }).then(() => { woke = true; }, () => undefined);
    await delay(250);
    expect(woke).toBe(false);
    f.setProgress({ id: f.handed[0]!.id, hand: 4, of: 4, iteration: 8, repeat: 8 });
    f.poll();
    await delay(250);
    expect(woke).toBe(true);
    stop.abort();
  });

  it('a message makes it drop what waits (the running one goes on) and say message; a surprise says alert', async () => {
    const f = setup();
    await f.queue.add(f.spec([{ do: 'wait', seconds: 30 }]));
    await f.queue.add(f.spec(dig(1)));
    f.take();
    expect(await f.queue.ready({ signal: new AbortController().signal, drain: false, messages: () => true })).toBe('message');
    expect(f.queue.dropWaiting()).toBe(1);
    const g = setup();
    await g.queue.add(g.spec([{ do: 'wait', seconds: 30 }]));
    g.take();
    expect(await g.queue.ready({ signal: new AbortController().signal, drain: false, alert: () => true })).toBe('alert');
  });

  it('drain waits only for nothing to be open', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    f.take();
    const drained = f.queue.ready({ signal: new AbortController().signal, drain: true });
    await delay(150);
    f.end('completed', actResult(1));
    f.poll();
    expect(await drained).toBe('empty');
  });
});

describe('replace', () => {
  it('takes the named item and the ones behind it off, waits for the body\'s answer, and a new item then follows the one before', async () => {
    const f = setup();
    await f.queue.add(f.spec(wait1));
    await f.queue.add(f.spec(dig(1)));
    await f.queue.add(f.spec(dig(2)));
    f.take();
    f.queue.mark();
    const replacing = f.queue.replace(['q2']);
    await delay(100);
    f.poll();
    // The body is told to cancel the two waiting items and answers for them.
    f.dropRest('捨てた: 取り消された。手は動いていない');
    f.poll();
    expect(await replacing).toContain('消した: q2・q3');
    expect(f.queue.stale()).toBe(false);
    expect(f.queue.tail()).toBe('q1');
    const next = await f.queue.add(f.spec(dig(3)));
    expect(next).toMatchObject({ ok: true, item: 'q4', after: 'q1' });
  });

  it('says what is not in the queue any more', async () => {
    const f = setup();
    expect(await f.queue.replace(['q9'])).toContain('もう列に無い: q9');
  });
});

describe('the lines of the live state', () => {
  it('say the running item with its left time, the waiting one with its pre, how many may be added, and an empty queue as stopped', async () => {
    const f = setup();
    expect(f.queue.lines(null)).toEqual(['空（体は止まっている）。mc.act を足すと体が動く']);
    await f.queue.add(f.spec(wait1, { done: [[{ k: 'have', item: 'log', n: 10 }]] }));
    await f.queue.add({ ...f.spec(dig(1), {}, 'p7'), pre: [[{ k: 'near', block: 'furnace', r: 5 }]] });
    f.take();
    const lines = f.queue.lines(null);
    expect(lines[0]).toMatch(/^▶ q1 \[p1\] 項目1 実行中: 済む: have:log>=10・残り約 \d+ 秒$/u);
    expect(lines[1]).toBe('・ q2 [p7] 項目2 待ち: 前提 near:furnace~5（前の項目の後で体が確かめる）');
    expect(lines[2]).toBe('足せるのは あと 1 つ（q2 の後）。差し替えは replace');
  });
});
