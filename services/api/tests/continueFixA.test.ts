import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, emptyPlanTree, type PlanPromise, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { InventoryEvent } from '../src/contracts/continueContract.js';
import { readActResult } from '../src/contracts/minecraftActContract.js';
import { ledgerInputFor } from '../src/surfaces/minecraft/minecraftControlEvents.js';
import { applyLedger, emptyLedgerSeen, promiseLines, snapshotUses, type LedgerBy, type LedgerSeen, type UsesSnapshot } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { actFacts } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { forgetOnceFacts } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { BenchC, benchC, RUN_BODY, until } from './helpers/benchC.js';

/**
 * Codex's final review (amendment A-6, the head's 11 to 15 and the body's new values): each case first reproduces what the review pointed at on this code, then holds the fix.
 */
const benches: BenchC[] = [];
const make = (options: ConstructorParameters<typeof BenchC>[0]) => { const bench = benchC(options); benches.push(bench); return bench; };
afterEach(() => { for (const bench of benches.splice(0)) bench.close(); forgetOnceFacts(); });
const SLOW = { timeout: 60_000 };
const promise = (item: string, count: number, use: string, extra: Record<string, unknown> = {}) => ({ op: 'promise', item, count, use, ...extra });
const ledgerOf = (bench: BenchC, id: number) => bench.plan.tree().promises.find(item => item.id === id)!;
const consumedOf = (bench: BenchC, id: number) => ledgerOf(bench, id).ledger.filter(line => line.kind === 'consumed');

// ---- 11. earlierPasses is the body's list of passes --------------------------------------------------------------------------------------------------
describe('A-6 11: ActResult.earlierPasses is {pass, lines, done, stopped}[] (the body\'s form)', () => {
  const passes = [{ pass: 1, lines: 4, done: 3, stopped: 1 }, { pass: 2, lines: 4, done: 4, stopped: 0 }, { pass: 3, lines: 3, done: 3, stopped: 0 }];
  it('says how many older passes were folded and the sums, never "undefined"', () => {
    const result = readActResult(JSON.stringify({ v: 1, ok: true, done: 4, of: 4, ms: 10, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, lines: [], earlierPasses: passes }))!;
    const words = actFacts(result).join('\n');
    expect(words).not.toContain('undefined');
    expect(words).toContain('古い周回 3 回分（手の行 11、済 10、止 1）');
  });
  it('says nothing of a list it cannot read (no garbage in the words)', () => {
    const words = actFacts({ lines: [], earlierPasses: { passes: 2 } } as never).join('\n');
    expect(words).toBe('');
  });
});

// ---- 6. the body's new values ------------------------------------------------------------------------------------------------------------------------
describe('A-6 (the body\'s new values): Handover.shield "dropped", and lost events of a command whose receipt came', () => {
  it('says a shield that broke off as a fact (not an order), and a shield value it does not know without garbage', () => {
    const handover = { from: 'floor-melee', target: 7, waitedMs: 120, reflexSettledAt: '2026-10-29T00:00:00.000Z', confirmed: true };
    const dropped = actFacts({ lines: [], handover: { ...handover, shield: 'dropped' } } as never).join('\n');
    expect(dropped).toContain('盾が途切れた');
    expect(dropped).not.toContain('undefined');
    const odd = actFacts({ lines: [], handover: { ...handover, shield: 'later_value' } } as never).join('\n');
    expect(odd).not.toContain('undefined');
  });

  it('a receipt that came and events the body dropped at its cap (the events reply is lost: true, no restart): the difference is unexplained (events_lost), once', SLOW, async () => {
    const bench = make({ scene: 'a6-lost-by-cap' });
    await bench.begin();
    bench.body.inventory = { cobblestone: 10, bread: 2 };
    await bench.planUpdate('約束', { ops: [promise('cobblestone', 8, '家')] });
    await bench.spin(2);
    bench.body.reflexEvent('bread', -1, 'reflex_eat');      // the ledger knows the pack before the act
    await bench.spin(3);
    expect(bench.plan.tree().promises[0]!.have).toBe(10);
    let item = '';
    await bench.decide('act', async () => { item = (await bench.add([{ do: 'place', block: 'cobblestone', at: [{ x: 1, y: 64, z: 0 }] }])).item; });
    expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
    const id = bench.body.idOf(item);
    bench.body.begin(id);
    bench.body.paused = true;
    const events = Array.from({ length: 6 }, () => ({ item: 'cobblestone', count: -1, reason: 'placed' as const }));
    bench.body.finish(id, { inline: 2, hands: [{ do: 'place', goal: 'done', events }] });
    bench.body.forgetEvents(id);          // the body dropped the unacknowledged events at its cap; it did not restart
    bench.body.paused = false;
    bench.body.poll();
    expect(await until(() => bench.events().some(row => row.ev === 'events' && row.lost === true))).toBe(true);
    await bench.settle(120);
    expect(bench.events().filter(row => row.ev === 'events' && row.lost === true)).toHaveLength(1);
    // The receipt's two events are put in; the rest are the body's lost record. The pack says 4 are gone: the difference is the loss, said as that.
    expect(bench.plan.tree().promises[0]!.have).toBe(4);
    expect(consumedOf(bench, 1).map(line => line.count)).toEqual([1, 1]);
    expect(ledgerOf(bench, 1).ledger.filter(line => line.kind === 'unexplained')).toEqual([expect.objectContaining({ count: -4 })]);
    expect(bench.control().store.row(id)!.receipt?.eventsMore).toMatchObject({ command: id, total: 6 });
  });
});

// ---- 12. the receipt box and the plan's commit ---------------------------------------------------------------------------------------------------------
describe('A-6 12: a receipt is marked processed only after the plan that holds its events was saved', () => {
  /** A plan with a promise, saved; an act that took 3 stones, its receipt booked by the live queue. */
  async function booked(scene: string) {
    const bench = make({ scene });
    await bench.begin();
    await bench.planUpdate('約束', { ops: [promise('cobblestone', 8, '家')] });
    bench.commit();
    bench.body.inventory = { cobblestone: 10 };
    await bench.spin(3);
    let item = '';
    await bench.decide('act', async () => { item = (await bench.add([{ do: 'place', block: 'cobblestone', at: [{ x: 1, y: 64, z: 0 }] }])).item; });
    expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
    const id = bench.body.idOf(item);
    bench.body.begin(id);
    bench.body.finish(id, { hands: [{ do: 'place', goal: 'done', events: [{ item: 'cobblestone', count: -3, reason: 'placed' }] }] });
    expect(await until(() => bench.control().store.state(id) === 'settled_known' && consumedOf(bench, 1).length === 1, 4_000)).toBe(true);
    return { bench, id };
  }
  const unprocessed = (bench: BenchC) => bench.control().store.unprocessed(bench.run).map(row => row.id);
  const holds = (bench: BenchC, id: string) => bench.plan.ledgerSeen().eventIds.filter(event => event.startsWith(`${id}:`));

  it('stops before the commit twice in a row: the second head still gets the receipt (the first head marked nothing)', SLOW, async () => {
    const { bench, id } = await booked('a6-12-before-commit');
    await bench.restartHead();
    expect(await until(() => consumedOf(bench, 1).length === 1, 4_000)).toBe(true);
    await bench.settle(60);
    // The first restarted head put the receipt to its plan, which it did not save: the receipt is not processed yet.
    expect(unprocessed(bench)).toEqual([id]);
    await bench.restartHead();      // the head stops again before it saved
    expect(await until(() => consumedOf(bench, 1).length === 1, 4_000)).toBe(true);
    await bench.settle(60);
    expect(consumedOf(bench, 1)).toEqual([expect.objectContaining({ count: 3, id: `${id}:1:1:1` })]);
    expect(ledgerOf(bench, 1).have).toBe(7);
    expect(holds(bench, id)).toEqual([`${id}:1:1:1`]);
    expect(unprocessed(bench)).toEqual([id]);
    bench.commit();
    expect(unprocessed(bench)).toEqual([]);
  });

  it('stops after the commit and before the mark: the receipt is put again and the ledger takes each event once (have and the count of events agree)', SLOW, async () => {
    const { bench, id } = await booked('a6-12-between');
    bench.setCheckpoint(bench.savedCheckpoint());     // the plan was saved; the mark was not (the process stopped between)
    expect(unprocessed(bench)).toEqual([id]);
    await bench.restartHead();
    expect(await until(() => bench.control().store.state(id) === 'settled_known' && bench.events().some(row => row.ev === 'ledger' || true), 4_000)).toBe(true);
    await bench.settle(120);
    expect(consumedOf(bench, 1)).toHaveLength(1);
    expect(ledgerOf(bench, 1).ledger.filter(line => line.kind === 'unexplained')).toEqual([]);
    expect(ledgerOf(bench, 1).have).toBe(7);
    expect(holds(bench, id)).toEqual([`${id}:1:1:1`]);
    expect(new Set(bench.plan.ledgerSeen().eventIds).size).toBe(bench.plan.ledgerSeen().eventIds.length);
    bench.commit();
    expect(unprocessed(bench)).toEqual([]);
  });

  it('stops after the mark: nothing is put again, and the counts are the same', SLOW, async () => {
    const { bench, id } = await booked('a6-12-after-mark');
    bench.commit();
    expect(unprocessed(bench)).toEqual([]);
    expect(bench.control().store.row(id)!.ledgerDone).toBe(true);
    const before = JSON.stringify([consumedOf(bench, 1), bench.plan.ledgerSeen().eventIds]);
    await bench.restartHead();
    await bench.settle(150);
    expect(JSON.stringify([consumedOf(bench, 1), bench.plan.ledgerSeen().eventIds])).toBe(before);
    expect(ledgerOf(bench, 1).have).toBe(7);
    expect(unprocessed(bench)).toEqual([]);
  });

  it('a commit that came before the receipt was booked does not mark it (the plan saved did not hold it)', SLOW, async () => {
    const bench = make({ scene: 'a6-12-commit-first' });
    await bench.begin();
    await bench.planUpdate('約束', { ops: [promise('cobblestone', 8, '家')] });
    bench.body.inventory = { cobblestone: 10 };
    await bench.spin(3);
    let item = '';
    await bench.decide('act', async () => { item = (await bench.add([{ do: 'place', block: 'cobblestone', at: [{ x: 1, y: 64, z: 0 }] }])).item; });
    expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
    const id = bench.body.idOf(item);
    bench.body.begin(id);
    bench.commit();                                    // the step saved its plan while the act ran
    bench.body.finish(id, { hands: [{ do: 'place', goal: 'done', events: [{ item: 'cobblestone', count: -3, reason: 'placed' }] }] });
    expect(await until(() => bench.control().store.state(id) === 'settled_known' && consumedOf(bench, 1).length === 1, 4_000)).toBe(true);
    expect(bench.control().store.unprocessed(bench.run).map(row => row.id)).toEqual([id]);     // the commit before it did not hold it
    bench.commit();                                    // the next commit holds it
    expect(bench.control().store.unprocessed(bench.run)).toEqual([]);
  });
});

// ---- 13. a promise revised to another item ----------------------------------------------------------------------------------------------------------
const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const frame = (seq: number, items: Record<string, number>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: seq, stateAt: iso(seq), receivedAt: iso(seq), connected: true,
  state: { world: { inventory: items, dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }, bodyRun: { bodyBoot: 'bb-1', connectionId: 'c-1' } } as never, facts: {} });
const event = (id: string, item: string, count: number, reason: InventoryEvent['reason'], seq: number): InventoryEvent => ({ id, obsSeq: seq, item, count, reason });

describe('A-6 13: the difference is counted by item (an event of the item a promise was revised away from is not the new item\'s)', () => {
  const planks: PlanPromise = { id: 3, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] };
  function revisedAfterSend() {
    let held: PlanPromise[] = [planks], seen: LedgerSeen = emptyLedgerSeen();
    const apply = (at: number, shot: BodyObservation, events: InventoryEvent[] = [], options: { uses?: readonly UsesSnapshot[]; by?: LedgerBy } = {}) => {
      const result = applyLedger(held, seen, { events, observation: shot, at: iso(at), ...options });
      held = result.promises; seen = result.ledgerSeen;
      return result;
    };
    apply(0, frame(500, { oak_planks: 4 }));
    const uses = snapshotUses(held, [3]);
    const revised = applyPlanUpdate({ ...emptyPlanTree(), promises: held } as PlanTree, { ops: [{ op: 'promise', id: 3, item: 'oak_log', count: 2, use: '作業台（原木で）' }] }, { at: iso(5) });
    expect(revised.problem).toBeNull();
    held = [...revised.tree.promises];
    return { apply, uses, promises: () => held };
  }
  it('a new look at the pack between the revision and the receipt: the planks the old definition took are not the logs\' difference', () => {
    const d = revisedAfterSend();
    d.apply(6, frame(501, { oak_log: 2 }));                         // a new observation after the revision: logs 2
    expect(d.promises()[0]!.have).toBe(2);
    const result = d.apply(10, frame(502, { oak_log: 2 }), [event('skill:q90:1:1:1', 'oak_planks', -4, 'ingredient', 502)], { uses: d.uses });
    expect(result.added.filter(line => line.kind === 'unexplained')).toEqual([]);
    expect(d.promises()[0]!.have).toBe(2);
    // The planks line is the old definition's: its item and its rev, and the count of logs it carries is the logs' (unchanged).
    expect(result.added).toEqual([expect.objectContaining({ kind: 'consumed', count: 4, item: 'planks', promiseRev: 1, declared: true, have: 2 })]);
    expect(d.promises()[0]!.ledger.filter(line => line.kind === 'unexplained')).toEqual([]);
  });
  it('the live line says whose item the change was (the planks, not the logs) and does not add it to the logs\' own changes', () => {
    const d = revisedAfterSend();
    d.apply(6, frame(501, { oak_log: 2 }));
    d.apply(10, frame(502, { oak_log: 2 }), [event('skill:q90:1:1:1', 'oak_planks', -4, 'ingredient', 502)], { uses: d.uses });
    const [line] = promiseLines(d.promises(), { since: iso(8), observation: frame(502, { oak_log: 2 }) });
    expect(line).toContain('今 2');
    expect(line).toContain('板');
    expect(line).toContain('改訂前');
    expect(line).not.toMatch(/直前に 4 減った（理由: 作る材料。申告/);
    expect(line).not.toContain('足りない');
  });
  it('an event of the new item itself still counts, beside the old item\'s (the logs she used and the planks the old definition took)', () => {
    const d = revisedAfterSend();
    d.apply(6, frame(501, { oak_log: 2 }));
    const result = d.apply(10, frame(502, { oak_log: 1 }), [event('skill:q90:1:1:1', 'oak_planks', -4, 'ingredient', 502), event('skill:q90:1:1:2', 'oak_log', -1, 'ingredient', 502)], { uses: d.uses });
    expect(result.added.filter(line => line.kind === 'unexplained')).toEqual([]);
    expect(result.added.map(line => [line.item, line.count, line.have])).toEqual([['planks', 4, 2], ['oak_log', 1, 1]]);
    expect(d.promises()[0]!.have).toBe(1);
  });
});

// ---- 14. the smelt's ingredient --------------------------------------------------------------------------------------------------------------------
describe('A-6 14: the hand\'s kind reaches the ledger from the receipt (a smelt\'s ingredient is smelt_ingredient)', () => {
  it('ledgerInputFor tells each event\'s hand: the receipt\'s line, else the act as it was sent', () => {
    const lines = [{ i: 1, do: 'craft', status: 'done', line: 'x' }, { i: 2, do: 'smelt', status: 'done', line: 'y' }];
    const result = JSON.stringify({ v: 1, ok: true, done: 2, of: 2, ms: 1, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, lines });
    const events = [event('skill:q9:1:1:1', 'oak_planks', -2, 'ingredient', 5), event('skill:q9:1:2:1', 'raw_iron', -15, 'ingredient', 5), event('skill:q9:2:2:1', 'raw_iron', -1, 'ingredient', 5)];
    const input = ledgerInputFor({ id: 'skill:q9', events, uses: [], observation: null, connectionId: 'c-1', result, sent: [{ do: 'craft' }, { do: 'smelt' }] });
    const kinds = (input as { hands?: Record<string, string> }).hands;
    expect(kinds).toEqual({ 'skill:q9:1:1:1': 'craft', 'skill:q9:1:2:1': 'smelt', 'skill:q9:2:2:1': 'smelt' });
  });
  it('through the queue: the iron put in the furnace is smelt_ingredient and the planks a craft used are craft_ingredient, in one act (live path, and the receipt box after a restart)', SLOW, async () => {
    const bench = make({ scene: 'a6-14-smelt' });
    await bench.begin();
    bench.body.inventory = { raw_iron: 15, oak_planks: 6, coal: 3 };
    await bench.planUpdate('約束', { ops: [promise('raw_iron', 15, '焼く'), promise('planks', 4, '棒')] });
    bench.commit();
    await bench.spin(3);
    let item = '';
    await bench.decide('act', async () => {
      item = (await bench.add([{ do: 'craft', item: 'stick', count: 1 }, { do: 'smelt', items: [{ item: 'raw_iron', count: 15 }], fuel: 'coal', fuelCount: 2 }] as never)).item;
    });
    expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
    const id = bench.body.idOf(item);
    bench.body.begin(id);
    bench.body.finish(id, { hands: [
      { do: 'craft', goal: 'done', events: [{ item: 'oak_planks', count: -2, reason: 'ingredient' }, { item: 'stick', count: 4, reason: 'crafted' }] },
      { do: 'smelt', goal: 'done', events: [{ item: 'raw_iron', count: -15, reason: 'ingredient' }, { item: 'coal', count: -2, reason: 'fuel' }] }] });
    expect(await until(() => consumedOf(bench, 1).length === 1 && consumedOf(bench, 2).length === 1, 4_000)).toBe(true);
    expect(consumedOf(bench, 1)).toEqual([expect.objectContaining({ reason: 'smelt_ingredient', count: 15 })]);
    expect(consumedOf(bench, 2)).toEqual([expect.objectContaining({ reason: 'craft_ingredient', count: 2 })]);
    // The head stops before it saved: the receipt box makes the same reasons.
    await bench.restartHead();
    expect(await until(() => consumedOf(bench, 1).length === 1, 4_000)).toBe(true);
    await bench.settle(60);
    expect(consumedOf(bench, 1)).toEqual([expect.objectContaining({ reason: 'smelt_ingredient' })]);
    expect(consumedOf(bench, 2)).toEqual([expect.objectContaining({ reason: 'craft_ingredient' })]);
  });
});

// ---- 15. the body's msPerUnit of a vertical hand ----------------------------------------------------------------------------------------------------
describe('A-6 15: the msPerUnit the body returned goes into the next estimate of the queue', () => {
  const vertical = (extra: Record<string, unknown> = {}) => [{ do: 'vertical', dir: 'up', shape: 'pillar', toY: 94, ...extra }] as never;
  const leftOf = (bench: BenchC): number => {
    const line = bench.queue.lines(bench.control().observe(RUN_BODY)).find(text => text.includes('残り約'))!;
    return Number(/残り約 (\d+) 秒/u.exec(line)![1]);
  };
  it('a first guess for a form, then what the body measured for that form (and only that form)', SLOW, async () => {
    const bench = make({ scene: 'a6-15-ms-per-unit', autoPoll: false });
    await bench.begin();
    await bench.spin(2);
    // 30 steps of a pillar at the first guess (0.9 s): 1 s + 30 × 0.9 s.
    let first = '';
    await bench.decide('一度目', async () => { first = (await bench.add(vertical(), {}, 'p1', 120_000)).item; });
    expect(leftOf(bench)).toBe(28);
    await bench.spin(3);
    expect(await until(() => bench.body.hasBeenHanded(first))).toBe(true);
    const id = bench.body.idOf(first);
    bench.body.begin(id);
    bench.body.finish(id, { outcome: 'failed', hands: [{ do: 'vertical', goal: 'partial', end: 'finished', code: 'budget_dig', motorOps: 9,
      progress: { unit: 'step', done: 12, left: 18, msPerUnit: 400 } }] });
    await bench.spin(3);
    expect(await until(() => bench.control().store.state(id) === 'settled_known')).toBe(true);
    await bench.settle(30);
    let second = '';
    await bench.decide('二度目', async () => { second = (await bench.add(vertical({ toY: 95 }), {}, 'p1', 120_000)).item; });
    // The same form: 1 s + 31 steps × 0.4 s (not the first guess).
    expect(leftOf(bench)).toBe(13);
    await bench.spin(3);
    expect(await until(() => bench.body.hasBeenHanded(second))).toBe(true);
    bench.body.begin(bench.body.idOf(second));
    bench.body.finish(bench.body.idOf(second), { hands: [{ do: 'vertical', goal: 'done', progress: { unit: 'step', done: 31, left: 0, msPerUnit: 400 } }] });
    await bench.spin(3);
    await bench.settle(30);
    // Another form is still at its first guess: a shaft is 1.0 s a step.
    let third = '';
    await bench.decide('三度目', async () => { third = (await bench.add([{ do: 'vertical', dir: 'down', shape: 'shaft', toY: 34 }] as never, {}, 'p1', 120_000)).item; });
    expect(third).not.toBe('');
    expect(leftOf(bench)).toBeGreaterThanOrEqual(30);
  });
});
