import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, emptyPlanTree, PLAN_KINDS, readPlanTree, type PlanPromise, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { InventoryEvent } from '../src/contracts/continueContract.js';
import { createFcaPlanTools, PLAN_UPDATE_DEFINITION, PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { conditionHolds } from '../src/surfaces/minecraft/minecraftConditions.js';
import { applyLedger, emptyLedgerSeen, promiseLines, readLedgerSeen, snapshotUses, type LedgerBy, type LedgerSeen, type UsesSnapshot } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { forgetOnceFacts, pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';

/**
 * The continue contract, chapter 3 (the promises' ledger, the head's half) and boundary 3: the eleven cases of `fixtures/continue/promise/` the head owns, each
 * through `applyLedger` and `promiseLines` (the fixture's `input` becomes observations and events; its `expected` is what is checked), and `plan.update`'s
 * `promise` / `release` / `kind` / `prep` through the real tool and the checkpoint. `events-split-delivery` and `receipt-box-then-ack` are the store's and the
 * control's (the receipt box, the pages); here only that an event of the same id is never put twice.
 */
const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/continue/promise/${name}.json`, import.meta.url), 'utf8')) as Record<string, any>;
afterEach(() => forgetOnceFacts());

const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
interface Shot { seq: number; items?: Record<string, number>; run?: { bodyBoot: string; connectionId: string }; life?: { deathEpoch: string; deathSeq: number };
  utilities?: { scanned: boolean; found: Array<{ block: string; distance: number }>; radius?: number; dim?: string }; dimension?: string }
const frame = (shot: Shot): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: shot.seq, stateAt: iso(shot.seq), receivedAt: iso(shot.seq), connected: true,
  state: { world: { inventory: shot.items ?? {}, dimension: shot.dimension ?? 'overworld', position: { x: 0, y: 64, z: 0 },
    ...(shot.utilities ? { utilities: { radius: shot.utilities.radius ?? 8, dim: shot.utilities.dim ?? shot.dimension ?? 'overworld', obsSeq: shot.seq,
      scanned: shot.utilities.scanned, found: shot.utilities.found.map(item => ({ ...item, at: { x: 0, y: 64, z: 0 } })) } } : {}) },
    bodyRun: shot.run ?? { bodyBoot: 'bb-1', connectionId: 'c-1' }, ...(shot.life ? { life: { life: 1, alive: true, ...shot.life } } : {}) } as never,
  facts: {} });
const event = (id: string, item: string, count: number, reason: InventoryEvent['reason'], seq: number, extra: Partial<InventoryEvent> = {}): InventoryEvent => ({ id, obsSeq: seq, item, count, reason, ...extra });

/** A small driver: the promises and the memory kept between calls, as the plan tool's owner keeps them. */
function driver(promises: PlanPromise[]) {
  let held = promises, seen: LedgerSeen = emptyLedgerSeen();
  return {
    promises: () => held, seen: () => seen,
    apply(at: number, shot: Shot | null, events: InventoryEvent[] = [], options: { by?: LedgerBy; uses?: readonly UsesSnapshot[]; lost?: boolean; from?: { bodyBoot: string; connectionId: string } } = {}) {
      const result = applyLedger(held, seen, { events, observation: shot ? frame(shot) : null, at: iso(at), ...options });
      held = result.promises;
      seen = result.ledgerSeen;
      return result;
    },
    set(next: PlanPromise[]) { held = next; },
  };
}
const promiseOf = (value: unknown): PlanPromise => JSON.parse(JSON.stringify(value)) as PlanPromise;
const lineOf = (promises: readonly PlanPromise[], at: number, shot: Shot, since: number) => promiseLines(promises, { since: iso(since), observation: frame(shot) });

describe('promise/r43-planks-burned-as-fuel.json: planks promised for the table were put in the furnace', () => {
  const sample = fixture('r43-planks-burned-as-fuel');
  it('is a consumed line (smelt_fuel, not declared), have counted from the pack, and the live line says what happened and what is short', () => {
    const d = driver([promiseOf(sample.input.promises[0])]);
    d.apply(0, { seq: 1, items: { spruce_planks: 4, raw_iron: 15 } });
    expect(d.promises()[0]!.have).toBe(4);
    const result = d.apply(10, { seq: 2, items: { spruce_planks: 2 } }, sample.input.events.map((e: any, i: number) => event(e.id, e.item, e.count, e.reason, 2)),
      { by: { command: 'skill:q69', do: sample.input.act.hands[0].do } });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ ...sample.expected.ledgerAdded[0], promise: 3, item: 'planks', by: { command: 'skill:q69', pass: 1, hand: 1 } });
    expect(result.added.some(item => item.kind === 'unexplained')).toBe(false);
    expect(lineOf(d.promises(), 10, { seq: 2, items: { spruce_planks: 2 } }, 5)).toEqual([sample.expected.liveLine]);
  });
});

describe('promise/table-crafted-placed-picked.json: the table is crafted from the promised planks, placed, picked; the instead is a pack count or the body\'s scan', () => {
  const sample = fixture('table-crafted-placed-picked');
  const open = (): ReturnType<typeof driver> => driver([promiseOf(sample.input.promises[0])]);
  const scan = (_seq: number, found: Array<{ block: string; distance: number }>) => ({ scanned: true, found });
  it('keeps the promise by the instead after each step, the lines in the contract\'s words, and puts only the planks to the ledger', () => {
    const d = open();
    const uses = snapshotUses(d.promises(), sample.input.steps[0].act.uses);
    expect(uses).toEqual([{ id: 3, rev: 1, item: 'planks', count: 4, use: '作業台' }]);
    d.apply(0, { seq: 699, items: { oak_planks: 4 }, utilities: scan(699, []) });
    expect(d.promises()[0]!.state).toBe('open');
    const steps: Array<[Shot, InventoryEvent[], UsesSnapshot[] | undefined]> = [
      [{ seq: 700, items: { crafting_table: 1 }, utilities: scan(700, []) }, [event('skill:q70:1:1:1', 'oak_planks', -4, 'ingredient', 700), event('skill:q70:1:1:2', 'crafting_table', 1, 'crafted', 700)], uses],
      [{ seq: 701, items: {}, utilities: scan(701, [{ block: 'crafting_table', distance: 2 }]) }, [event('skill:q71:1:1:1', 'crafting_table', -1, 'placed', 701)], undefined],
      [{ seq: 702, items: { crafting_table: 1 }, utilities: scan(702, []) }, [event('skill:q72:1:1:1', 'crafting_table', 1, 'picked', 702)], undefined],
    ];
    steps.forEach(([shot, events, snapshot], index) => {
      const result = d.apply(10 * (index + 1), shot, events, { ...(snapshot ? { uses: snapshot } : {}), by: { command: `skill:q${70 + index}` } });
      const expected = sample.expected.afterEach[index];
      expect(result.added).toHaveLength(expected.ledgerAdded.length);
      expected.ledgerAdded.forEach((line: object, at: number) => expect(result.added[at]).toMatchObject(line));
      expect(d.promises()[0]!.state).toBe(expected.state);
      expect(lineOf(d.promises(), 0, shot, 10 * index + 5)).toEqual([expected.liveLine]);
    });
    expect(d.promises()[0]!.ledger.filter(line => line.kind === 'consumed')).toHaveLength(1);
  });
  it('near is told from the scan only when it looked, as far as the clause asks, in the dimension she is in', () => {
    const near = [[{ k: 'near' as const, block: 'crafting_table', r: 8 }]];
    const found = [{ block: 'crafting_table', distance: 2 }];
    expect(conditionHolds(near, frame({ seq: 1, utilities: { scanned: true, found } }))).toBe(true);
    expect(conditionHolds(near, frame({ seq: 1, utilities: { scanned: true, found: [] } }))).toBe(false);
    expect(conditionHolds(near, frame({ seq: 1, utilities: { scanned: false, found: [] } }))).toBeNull();
    expect(conditionHolds([[{ k: 'near', block: 'crafting_table', r: 8 }]], frame({ seq: 1 }))).toBeNull();
    expect(conditionHolds([[{ k: 'near', block: 'crafting_table', r: 8 }]], frame({ seq: 1, utilities: { scanned: true, found, radius: 4 } }))).toBeNull();
    expect(conditionHolds(near, frame({ seq: 1, utilities: { scanned: true, found, dim: 'the_nether' } }))).toBeNull();
    expect(conditionHolds([[{ k: 'near', block: 'crafting_table', r: 1 }]], frame({ seq: 1, utilities: { scanned: true, found } }))).toBe(false);
    expect(conditionHolds([[{ k: 'furnace', x: 0, y: 0, z: 0 }]], frame({ seq: 1, utilities: { scanned: true, found } }))).toBeNull();
  });
});

describe('promise/food-for-underground.json: 20 food points for the underground; bread is 11 points; a reflex that eats outside an act is its own event', () => {
  const sample = fixture('food-for-underground');
  it('counts the points as the live state does, tells the act\'s eating (declared) from the reflex\'s, and is not unexplained', () => {
    const d = driver([promiseOf(sample.input.promises[0])]);
    d.apply(0, { seq: 1, items: { bread: sample.input.observedBefore.bread } });
    expect(d.promises()[0]!.have).toBe(sample.input.observedBefore.foodPoints);
    const uses = snapshotUses(d.promises(), sample.input.steps[0].act.uses);
    const first = d.apply(10, { seq: 2, items: { bread: 2 } }, [event('skill:q80:1:1:1', 'bread', -1, 'food', 2)], { uses });
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject(sample.expected.afterEach[0].ledgerAdded[0]);
    expect(lineOf(d.promises(), 10, { seq: 2, items: { bread: 2 } }, 5)).toEqual([sample.expected.afterEach[0].liveLine]);
    const data = sample.input.steps[1].workingEvent.data;
    const second = d.apply(20, { seq: 3, items: { bread: 1 } }, [{ id: data.id, item: data.item, count: data.count, reason: data.reason } as InventoryEvent]);
    expect(second.added).toHaveLength(1);
    expect(second.added[0]).toMatchObject(sample.expected.afterEach[1].ledgerAdded[0]);
    expect(lineOf(d.promises(), 20, { seq: 3, items: { bread: 1 } }, 15)).toEqual([sample.expected.afterEach[1].liveLine]);
    expect(d.promises()[0]!.ledger.some(line => line.kind === 'unexplained')).toBe(false);
  });
});

describe('promise/make-intermediate-and-reflex.json: make\'s middle planks, and a reflex\'s bread counted once', () => {
  const sample = fixture('make-intermediate-and-reflex');
  it('puts the middle materials to the ledger as their net, and the pack\'s count is the promise\'s have, with nothing unexplained', () => {
    const d = driver([promiseOf(sample.input.promises[0]), { id: 6, rev: 1, item: 'food', count: 5, use: '非常食', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { oak_log: 2, bread: 2 } });
    const events = [...sample.input.events.map((e: any, i: number) => event(e.id, e.item, e.count, e.reason, 2, { ...(e.intermediate ? { intermediate: true } : {}), deliverySeq: i })),
      event(sample.input.reflexDuringHand.id, 'bread', -1, 'reflex_eat', 2)];
    const result = d.apply(10, { seq: 2, items: { oak_planks: 3, wooden_pickaxe: 1, bread: 1 } }, events, { by: { command: 'skill:q91', do: 'make' } });
    const planks = result.added.filter(line => line.promise === 5);
    expect(planks).toEqual([expect.objectContaining({ kind: 'gained', count: 3, have: 3, reason: 'crafted' })]);
    expect(d.promises()[0]!.have).toBe(sample.expected.promiseHave);
    expect(result.added.filter(line => line.kind === 'unexplained')).toEqual([]);
    // The reflex's bread is one line of the food promise, however often the same event comes.
    const again = d.apply(11, { seq: 2, items: { oak_planks: 3, wooden_pickaxe: 1, bread: 1 } }, events);
    expect(again.added).toEqual([]);
    expect(d.promises()[1]!.ledger.filter(line => line.reason === 'reflex_eat')).toHaveLength(sample.expected.breadCountedOnce ? 1 : 0);
  });
});

describe('promise/death-loses-promised.json: a death takes the pack; the promise stays open', () => {
  const sample = fixture('death-loses-promised');
  it('is a lost_death line only when the death counter rose within one epoch, and the line says it', () => {
    const d = driver([promiseOf(sample.input.promises[0])]);
    d.apply(0, { seq: 1, items: { oak_planks: 1 }, life: { deathEpoch: 'e-1', deathSeq: 0 } });
    expect(d.seen().death).toEqual({ deathEpoch: 'e-1', deathSeq: 0 });
    const result = d.apply(10, { seq: 2, items: {}, life: { deathEpoch: 'e-1', deathSeq: 1 } });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ ...sample.expected.ledgerAdded[0], id: 'death:e-1:1' });
    expect(d.promises()[0]!.state).toBe(sample.expected.state);
    expect(lineOf(d.promises(), 10, { seq: 2, items: {} }, 5)).toEqual([sample.expected.liveLine]);
    // the same observation again, or the next one, adds nothing
    expect(d.apply(11, { seq: 2, items: {}, life: { deathEpoch: 'e-1', deathSeq: 1 } }).added).toEqual([]);
    expect(d.apply(12, { seq: 3, items: {}, life: { deathEpoch: 'e-1', deathSeq: 1 } }).added).toEqual([]);
  });
});

describe('promise/revised-after-send.json: the definition the command was sent with decides whose the events are', () => {
  const sample = fixture('revised-after-send');
  it('puts the planks taken to promise #3 at rev 1 (planks, 4) after the promise was revised to logs', () => {
    const tree: PlanTree = { ...emptyPlanTree(), promises: [promiseOf(sample.input.promises[0])] };
    const d = driver([...tree.promises]);
    d.apply(0, { seq: 500, items: { oak_planks: 4 } });
    const snapshot = snapshotUses(d.promises(), sample.input.sequence[0].uses);
    expect(snapshot).toEqual(sample.input.sequence[0].snapshot);
    const revised = applyPlanUpdate({ ...tree, promises: d.promises() }, { ops: [{ op: 'promise', id: 3, item: 'oak_log', count: 2, use: '作業台（原木で）' }] }, { at: iso(5) });
    expect(revised.problem).toBeNull();
    d.set([...revised.tree.promises]);
    expect(d.promises()[0]).toMatchObject(sample.expected.promise);
    expect(d.promises()[0]!.have).toBeUndefined();
    const ev = sample.input.sequence[2].events[0];
    const result = d.apply(10, { seq: 501, items: {} }, [event(ev.id, ev.item, ev.count, ev.reason, ev.obsSeq)], { uses: snapshot });
    expect(result.added[0]).toMatchObject(sample.expected.ledgerAdded[1]);
    expect(d.promises()[0]!.ledger.map(line => line.kind)).toEqual(['revised', 'consumed']);
    expect(d.promises()[0]!.ledger[0]).toMatchObject(sample.expected.ledgerAdded[0]);
    // Without the snapshot the planks are not the revised promise's (logs): no line.
    const other = driver([...revised.tree.promises]);
    other.apply(0, { seq: 500, items: { oak_planks: 4 } });
    expect(other.apply(10, { seq: 501, items: {} }, [event('skill:q90:1:1:2', 'oak_planks', -4, 'ingredient', 501)]).added).toEqual([]);
  });
});

describe('promise/instead-lost-after-descent.json: the table left on the surface', () => {
  const sample = fixture('instead-lost-after-descent');
  it('keeps the promise while a table is near, and when it is not any more opens it again and offers the fact once (not before the scan looked)', () => {
    const d = driver([promiseOf(sample.input.promises[0])]);
    const near = d.apply(0, { seq: 1, items: { oak_planks: 7 }, utilities: { scanned: true, found: [{ block: 'crafting_table', distance: 2 }] } });
    expect(d.promises()[0]!.state).toBe(sample.expected.afterEach[0].state);
    expect(near.facts).toEqual([]);
    const unscanned = d.apply(5, { seq: 2, items: { oak_planks: 7 }, dimension: 'the_nether', utilities: { scanned: false, found: [] } });
    expect(d.promises()[0]!.state).toBe('kept_by_instead');
    expect(unscanned.facts).toEqual([]);
    const lost = d.apply(10, { seq: 3, items: { oak_planks: 7 }, utilities: { scanned: true, found: [] } });
    expect(d.promises()[0]!.state).toBe(sample.expected.afterEach[1].state);
    expect(lost.facts).toHaveLength(1);
    for (const word of sample.expected.afterEach[1].oneTimeLine.mustContain) expect(lost.facts[0]!.text).toContain(word);
    expect(lost.facts[0]!.text).toContain('約束 #3');
    // opened again, it is not said again by the next looks
    expect(d.apply(15, { seq: 4, items: { oak_planks: 7 }, utilities: { scanned: true, found: [] } }).facts).toEqual([]);
    expect(lineOf(d.promises(), 15, { seq: 4, items: { oak_planks: 7 }, utilities: { scanned: true, found: [] } }, 0)).toEqual(['約束 #3 作業台用の板 4: 今 7']);
  });
});

describe('promise/same-receipt-twice.json, seen-after-32-and-restart.json, late-old-observation.json, life-file-reset-is-not-death.json', () => {
  it('same-receipt-twice: an event of one id is put once however many times the receipt comes', () => {
    const sample = fixture('same-receipt-twice');
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { spruce_planks: 4 } });
    const events = sample.input.events.map((e: any) => event(e.id, e.item, e.count, e.reason, 2));
    let total = 0;
    for (const receipt of sample.input.receipts as string[]) { void receipt; total += d.apply(10, { seq: 2, items: { spruce_planks: 2 } }, events).added.length; }
    expect(total).toBe(sample.expected.ledgerAddedCount);
  });

  it('seen-after-32-and-restart: the event falls out of the 32 lines and out of a restart, and is still put only once', () => {
    const sample = fixture('seen-after-32-and-restart');
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { spruce_planks: 100 } });
    const first = event(sample.input.applied[0], 'spruce_planks', -2, 'fuel', 2);
    expect(d.apply(1, { seq: 2, items: { spruce_planks: 98 } }, [first]).added).toHaveLength(1);
    const more = Array.from({ length: 33 }, (_, index) => event(`skill:q70:1:1:${index + 1}`, 'spruce_planks', -1, 'ingredient', 3));
    d.apply(2, { seq: 3, items: { spruce_planks: 65 } }, more);
    const ledger = d.promises()[0]!.ledger;
    expect(ledger).toHaveLength(32);
    expect(ledger.some(line => line.id === first.id)).toBe(sample.expected.displayLedgerHas);
    expect(d.promises()[0]!.dropped).toBeGreaterThan(0);
    // the head restarts: the tree and the memory come back from the checkpoint's JSON
    const reread = readLedgerSeen(JSON.parse(JSON.stringify(d.seen())));
    expect(reread).toEqual(d.seen());
    expect(reread.eventIds.includes(first.id)).toBe(sample.expected.seenHas);
    let again = applyLedger(JSON.parse(JSON.stringify(d.promises())), reread, { events: [first], observation: frame({ seq: 4, items: { spruce_planks: 65 } }), at: iso(4) });
    expect(again.added).toEqual([]);
    expect(again.ledgerSeen.eventIds.filter(id => id === first.id)).toHaveLength(sample.expected.appliedCount[first.id]);
    again = applyLedger(again.promises, again.ledgerSeen, { events: [first], observation: null, at: iso(5) });
    expect(again.added).toEqual([]);
  });

  it('late-old-observation: an older observation put after a newer one does not rewrite have, and its event is still put', () => {
    const sample = fixture('late-old-observation');
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: sample.input.lastObs.obsSeq, items: { oak_planks: sample.input.lastObs.planks } });
    const late = sample.input.lateReceipt;
    const result = d.apply(5, { seq: 850, items: { oak_planks: late.observedPlanks } }, late.events.map((e: any) => event(e.id, e.item, e.count, e.reason, e.obsSeq)));
    expect(d.promises()[0]!.have).toBe(sample.expected.have);
    expect(result.added).toHaveLength(sample.expected.eventApplied ? 1 : 0);
    expect(result.added[0]).toMatchObject({ kind: 'gained', count: 3, have: 2 });
    expect(d.seen().lastObs).toEqual({ bodyBoot: 'bb-1', connectionId: 'c-1', obsSeq: 900 });
    // a new connection is a newer observation; a late one of the connection it replaced is not
    d.apply(6, { seq: 1, items: { oak_planks: 5 }, run: { bodyBoot: 'bb-1', connectionId: 'c-2' } });
    expect(d.promises()[0]!.have).toBe(5);
    d.apply(7, { seq: 950, items: { oak_planks: 9 } });
    expect(d.promises()[0]!.have).toBe(5);
    // a receipt of the replaced connection that comes after the reconnect: its event is put, and does not wait for an observation that will not come
    const afterReconnect = d.apply(8, { seq: 2, items: { oak_planks: 5 }, run: { bodyBoot: 'bb-1', connectionId: 'c-2' } },
      [event('skill:q61:1:1:1', 'oak_planks', 1, 'picked', 999)], { from: { bodyBoot: 'bb-1', connectionId: 'c-1' } });
    expect(afterReconnect.added).toEqual([expect.objectContaining({ kind: 'gained', count: 1 })]);
    expect(d.seen().ahead).toBeUndefined();
  });

  it('life-file-reset-is-not-death: the death epoch changed, the counter did not rise within one: no lost_death, have follows the pack', () => {
    const sample = fixture('life-file-reset-is-not-death');
    const d = driver([promiseOf(sample.input.promises[0])]);
    d.apply(0, { seq: 1, items: { oak_planks: 5 }, life: { deathEpoch: 'e-old', deathSeq: 3 } });
    const result = d.apply(5, { seq: 2, items: { oak_planks: sample.input.event.observedPlanks }, life: { deathEpoch: 'e-new', deathSeq: 0 } });
    expect(result.added).toEqual(sample.expected.ledgerAdded);
    expect(d.promises()[0]!.have).toBe(sample.expected.have);
    // within the new epoch a rise is a death, even the first reading above 0
    const died = d.apply(8, { seq: 3, items: {}, life: { deathEpoch: 'e-new', deathSeq: 1 } });
    expect(died.added).toEqual([expect.objectContaining({ kind: 'lost_death', count: 5, have: 0 })]);
  });

  it('events-split-delivery / receipt-box-then-ack: the pages of one command (a page asked twice) are put once each', () => {
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { oak_planks: 400 } });
    const page = (from: number, to: number, seq: number) => Array.from({ length: to - from }, (_, index) => event(`skill:q70:1:1:${from + index}`, 'oak_planks', -1, 'placed', seq, { deliverySeq: from + index }));
    let total = 0;
    total += d.apply(1, { seq: 2, items: { oak_planks: 280 } }, page(0, 120, 2)).added.length;
    total += d.apply(2, { seq: 3, items: { oak_planks: 160 } }, page(120, 240, 3)).added.length;
    total += d.apply(3, { seq: 4, items: { oak_planks: 160 } }, page(120, 240, 3)).added.length;
    total += d.apply(4, { seq: 5, items: { oak_planks: 60 } }, page(240, 340, 5)).added.length;
    expect(total).toBe(340);
    expect(d.seen().eventIds).toHaveLength(340);
    // the body lost its record in a restart: the difference is said as it is
    const lost = d.apply(5, { seq: 6, items: { oak_planks: 40 } }, [], { lost: true });
    expect(lost.added).toEqual([expect.objectContaining({ kind: 'unexplained', count: -20, reason: 'events_lost' })]);
  });
});

describe('the rest of chapter 3: stored is not consumed, an event ahead of the observation, until, the live lines', () => {
  it('stored in a chest is a moved line (the hand\'s pack is less, the promise says it moved), retrieved the other way', () => {
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { oak_planks: 6 } });
    const stored = d.apply(5, { seq: 2, items: { oak_planks: 2 } }, [event('skill:q5:1:1:1', 'oak_planks', -4, 'stored', 2)]);
    expect(stored.added).toEqual([expect.objectContaining({ kind: 'moved', count: 4, reason: 'stored', have: 2 })]);
    expect(lineOf(d.promises(), 5, { seq: 2, items: { oak_planks: 2 } }, 1)).toEqual(['約束 #1 作業台用の板 4: 今 2・直前に 4 減った（理由: 箱へ入れた。置き場所が変わっただけ）（足りない 2）']);
    const back = d.apply(9, { seq: 3, items: { oak_planks: 6 } }, [event('skill:q6:1:1:1', 'oak_planks', 4, 'retrieved', 3)]);
    expect(back.added).toEqual([expect.objectContaining({ kind: 'moved', count: 4, reason: 'retrieved', have: 6 })]);
  });

  it('an event ahead of the observation is not an unexplained difference when its observation comes', () => {
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 10, items: { oak_planks: 6 } });
    const ahead = d.apply(1, { seq: 10, items: { oak_planks: 6 } }, [event('skill:q7:1:1:1', 'oak_planks', -3, 'ingredient', 12)]);
    expect(ahead.added).toEqual([expect.objectContaining({ kind: 'consumed', count: 3, have: 3 })]);
    expect(d.promises()[0]!.have).toBe(6);
    expect(d.seen().ahead).toHaveLength(1);
    const arrived = d.apply(2, { seq: 12, items: { oak_planks: 3 } });
    expect(arrived.added).toEqual([]);
    expect(d.promises()[0]!.have).toBe(3);
    expect(d.seen().ahead).toBeUndefined();
    // an observation that shows more than the events say: the difference is said, not shared out
    const odd = d.apply(3, { seq: 13, items: { oak_planks: 1 } });
    expect(odd.added).toEqual([expect.objectContaining({ kind: 'unexplained', count: -2, have: 1, reason: 'unexplained' })]);
  });

  it('closes the promise when its node is done or its condition holds, and not before', () => {
    const base = { id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open' as const, ledger: [] };
    const byNode = driver([{ ...base, until: { node: 'p2' } }]);
    byNode.apply(0, { seq: 1, items: {} });
    expect(byNode.apply(1, { seq: 2, items: {} }).added).toEqual([]);
    const closed = applyLedger(byNode.promises(), byNode.seen(), { events: [], observation: frame({ seq: 3 }), at: iso(2), nodes: [{ id: 'p2', state: 'done' }] });
    expect(closed.promises[0]).toMatchObject({ state: 'closed', closedBy: 'until' });
    expect(closed.added).toEqual([expect.objectContaining({ kind: 'closed', promise: 1 })]);
    expect(promiseLines(closed.promises)).toEqual([]);
    const byCondition = driver([{ ...base, until: { condition: [[{ k: 'dim', dim: 'the_nether' }]] } }]);
    byCondition.apply(0, { seq: 1, items: {} });
    expect(byCondition.promises()[0]!.state).toBe('open');
    byCondition.apply(1, { seq: 2, items: {}, dimension: 'the_nether' });
    expect(byCondition.promises()[0]).toMatchObject({ state: 'closed', closedBy: 'until' });
  });

  it('lines: by number, open ones only, four at most; facts only', () => {
    const promises = [5, 2, 9, 1, 7, 3].map(id => ({ id, rev: 1, item: 'coal', count: 3, use: '燃料', state: id === 9 ? 'closed' as const : 'open' as const, ledger: [] }));
    const lines = promiseLines(promises, { observation: frame({ seq: 1, items: { coal: 1 } }) });
    expect(lines).toEqual([1, 2, 3, 5].map(id => `約束 #${id} 燃料用の石炭 3: 今 1（足りない 2）`));
    for (const line of lines) expect(line).not.toMatch(/べき|しろ|こと$|ください/u);
  });

  it('keeps the ledger to 32 lines and says how many went', () => {
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { oak_planks: 100 } });
    for (let index = 0; index < 40; index += 1) d.apply(index + 1, { seq: index + 2, items: { oak_planks: 99 - index } }, [event(`skill:q1:1:1:${index}`, 'oak_planks', -1, 'ingredient', index + 2)]);
    expect(d.promises()[0]!.ledger).toHaveLength(32);
    expect(d.promises()[0]!.dropped).toBe(8);
  });

  it('a revised item starts the count again; the same item keeps it', () => {
    const d = driver([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }]);
    d.apply(0, { seq: 1, items: { oak_planks: 6 } });
    const tree = { ...emptyPlanTree(), promises: d.promises() };
    expect(applyPlanUpdate(tree, { ops: [{ op: 'promise', id: 1, item: 'planks', count: 8, use: '作業台' }] }).tree.promises[0]!.have).toBe(6);
    expect(applyPlanUpdate(tree, { ops: [{ op: 'promise', id: 1, item: 'oak_log', count: 8, use: '作業台' }] }).tree.promises[0]!.have).toBeUndefined();
  });
});

describe('plan.update: promise, release, kind and prep through the tool, the checkpoint and a read back', () => {
  const signal = new AbortController().signal;
  const make = (checkpoint: unknown = null, rules = true) => {
    const lines: string[] = [];
    const tools = createFcaPlanTools({ taskId: 'ledger-t', checkpoint, rules, log: line => lines.push(line), now: () => iso(100) });
    const call = (input: unknown) => tools.tools.execute({ scopeKey: 'o', taskId: 'ledger-t', operationId: 'op', name: 'plan.update', input, signal } as never);
    return { ...tools, call, lines };
  };

  /** A small check of an input against the part of JSON schema the tool uses (type, enum, required, properties, items, bounds). */
  function violations(value: unknown, schema: Record<string, any>, path = '$'): string[] {
    const types = ([] as string[]).concat(schema.type ?? []);
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    if (types.length && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return [`${path}: ${kind} is not ${types.join('|')}`];
    const out: string[] = [];
    if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${String(value)} not in enum`);
    if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: too long`);
    if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) out.push(`${path}: out of range`);
    if (kind === 'array') (value as unknown[]).forEach((item, index) => out.push(...violations(item, schema.items ?? {}, `${path}[${index}]`)));
    if (kind === 'object') {
      const properties = schema.properties ?? {}, record = value as Record<string, unknown>;
      for (const required of schema.required ?? []) if (!(required in record)) out.push(`${path}.${required}: missing`);
      for (const [name, item] of Object.entries(record)) {
        if (!(name in properties)) { if (schema.additionalProperties === false) out.push(`${path}.${name}: not allowed`); continue; }
        out.push(...violations(item, properties[name], `${path}.${name}`));
      }
    }
    return out;
  }

  const writes = { ops: [
    { op: 'add', id: 'p1', title: '下りる準備', kind: 'prep_descent', prep: { state: 'unmet_now', why: '食料が足りない' } },
    { op: 'add', id: 'p2', title: '鉄', kind: 'iron' },
    { op: 'split', id: 'p2', into: [{ id: 'p2.1', title: '掘る', kind: 'iron', prep: { state: 'met' } }] },
    { op: 'promise', item: 'planks', count: 4, use: '作業台', until: { node: 'p2.1', condition: 'dim:nether' }, instead: 'have:crafting_table>=1|near:crafting_table~8' },
    { op: 'promise', item: 'food', count: 20, use: '地下で食べる分' },
    { op: 'set', id: 'p1', kind: 'food', prep: { state: 'skipped', why: '承知で省く' } },
  ] };

  it('the input goes through both definitions\' schema, the tool reads the condition texts and gives the tree the kinds, the prep and the promises', async () => {
    for (const definition of [PLAN_UPDATE_DEFINITION, PLAN_UPDATE_RULES_DEFINITION]) {
      expect(violations(writes, definition.nativeInputSchema as never)).toEqual([]);
      expect(violations({ ops: [{ op: 'release', id: 2, why: '要らない' }, { op: 'release', id: '#2' }] }, definition.nativeInputSchema as never)).toEqual([]);
      expect(definition.description).toContain('promise');
    }
    const kinds = (PLAN_UPDATE_RULES_DEFINITION.nativeInputSchema as any).properties.ops.items.properties.kind.enum;
    expect(kinds).toEqual([...PLAN_KINDS]);
    const f = make();
    // a kind outside the list reaches the tool only if the provider let it pass; it is other, the word kept
    const wild = JSON.parse(JSON.stringify(writes));
    wild.ops[2].into[0].kind = 'farm_of_iron';
    const result = await f.call(wild);
    expect(result).toMatchObject({ ok: true });
    const tree = f.port.tree();
    expect(Object.fromEntries(tree.nodes.map(node => [node.id, [node.kind, node.kindRaw, node.prep?.state]]))).toEqual({
      p1: ['food', undefined, 'skipped'], p2: ['iron', undefined, undefined], 'p2.1': ['other', 'farm_of_iron', 'met'] });
    expect(tree.nodes.find(node => node.id === 'p1')!.prep).toMatchObject({ state: 'skipped', why: '承知で省く', at: iso(100) });
    expect(tree.promises).toHaveLength(2);
    expect(tree.promises[0]).toMatchObject({ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open',
      until: { node: 'p2.1', condition: [[{ k: 'dim', dim: 'the_nether' }]] },
      instead: [[{ k: 'have', item: 'crafting_table', n: 1 }], [{ k: 'near', block: 'crafting_table', r: 8 }]] });
    expect(tree.promises[0]!.ledger).toEqual([{ id: 'plan:1', at: iso(100), kind: 'made', count: 4, have: 0 }]);
    // the checkpoint holds the tree; a new owner reads it back as it is
    const saved = JSON.parse(JSON.stringify(f.tools.checkpoint!()));
    expect(readPlanTree(saved.fcaPlanTree)).toEqual(tree);
    const again = make(saved);
    expect(again.port.tree()).toEqual(tree);
    expect(again.lines.some(line => line.includes('migrated'))).toBe(false);
    // release, the number written either way
    expect(await again.call({ ops: [{ op: 'release', id: '#2', why: '食べた' }] })).toMatchObject({ ok: true });
    expect(again.port.tree().promises[1]).toMatchObject({ state: 'closed', closedBy: 'released' });
    expect(await again.call({ ops: [{ op: 'release', id: 9 }] })).toMatchObject({ ok: false });
  });

  it('a condition that does not read is said with what could not be read; nothing is changed', async () => {
    const f = make();
    await f.call({ ops: [{ op: 'add', id: 'p1', title: '木' }] });
    const before = f.port.tree();
    const result = await f.call({ ops: [{ op: 'promise', item: 'planks', count: 4, use: '作業台', instead: '作業台が近くにある' }] }) as { ok: boolean; text?: string; message?: string };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('instead');
    expect(JSON.stringify(result)).toContain('作業台が近くにある');
    expect(JSON.stringify(result)).toContain('have:');
    const bad = await f.call({ ops: [{ op: 'promise', item: 'planks', count: 4, use: '作業台', until: { condition: 'いつか' } }] });
    expect(JSON.stringify(bad)).toContain('until.condition');
    expect(f.port.tree()).toBe(before);
  });

  it('a v1 tree read back is moved to v2 once and the log says so', () => {
    const v1 = { schema: 'shannon.plan-tree.v1', revision: 4, current: 'p1', nodes: [{ id: 'p1', parentId: null, order: 0, title: '食料', state: 'continue' }] };
    const f = make({ fcaPlanTree: v1 });
    expect(f.port.tree().schema).toBe('shannon.plan-tree.v2');
    expect(f.lines).toEqual(['Shannon FCA plan migrated task=ledger-t from=v1 revision=5']);
  });

  it('the one way in: applyLedger puts to the tree\'s promises, leaves the revision and the flat copy, saves the memory in the checkpoint, and offers the fact once', async () => {
    const f = make(null, true);
    await f.call({ ops: [{ op: 'add', id: 'p1', title: '木' }, { op: 'promise', item: 'planks', count: 4, use: '作業台', instead: 'near:crafting_table~8' }] });
    const revision = f.port.tree().revision;
    expect(f.port.committed()).not.toBeNull();
    const fresh = make(JSON.parse(JSON.stringify(f.tools.checkpoint!())));
    expect(fresh.port.committed()).toBeNull();
    const shot = (seq: number, planks: number, found: Array<{ block: string; distance: number }>, scanned = true) =>
      frame({ seq, items: { oak_planks: planks }, utilities: { scanned, found } });
    expect(fresh.port.applyLedger({ events: [], observation: shot(1, 4, [{ block: 'crafting_table', distance: 3 }]) })).toEqual([]);
    expect(fresh.port.tree().promises[0]).toMatchObject({ state: 'kept_by_instead', have: 4 });
    const added = fresh.port.applyLedger({ events: [event('skill:q2:1:1:1', 'oak_planks', -2, 'fuel', 2)], observation: shot(2, 2, []), by: { command: 'skill:q2' }, at: iso(7) });
    expect(added).toEqual([expect.objectContaining({ kind: 'consumed', count: 2, reason: 'smelt_fuel', declared: false })]);
    expect(fresh.port.tree().promises[0]!.state).toBe('open');
    expect(pending('ledger-t').map(item => item.text)).toEqual([expect.stringContaining('代わりの条件が成り立たなくなった')]);
    expect(fresh.port.tree().revision).toBe(revision);
    expect(fresh.port.committed()).toBeNull();
    // the memory is in the checkpoint and a new owner reads it back, so the same event is not put again
    const saved = JSON.parse(JSON.stringify(fresh.tools.checkpoint!()));
    expect(saved.fcaPlanLedgerSeen.eventIds).toEqual(['skill:q2:1:1:1']);
    const restarted = make(saved);
    expect(restarted.port.ledgerSeen()).toEqual(fresh.port.ledgerSeen());
    expect(restarted.port.applyLedger({ events: [event('skill:q2:1:1:1', 'oak_planks', -2, 'fuel', 2)], observation: shot(2, 2, []) })).toEqual([]);
    expect(fresh.lines.some(line => line.startsWith('Shannon FCA plan ledger task=ledger-t added=1 kinds=consumed'))).toBe(true);
  });
});

describe('the size of the memory (chapter 13: measured, not decided)', () => {
  it('measures the checkpoint JSON and the time of applyLedger with 3000 ids (printed; the bound is generous)', () => {
    const promises: PlanPromise[] = [{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] }, { id: 2, rev: 1, item: 'food', count: 20, use: '食料', state: 'open', ledger: [] }];
    const ids = Array.from({ length: 3000 }, (_, index) => `skill:q${Math.floor(index / 6)}:${1 + (index % 3)}:${1 + (index % 2)}:${index % 6}`);
    const seen: LedgerSeen = { eventIds: ids, lastObs: { bodyBoot: 'bb-20261028-1', connectionId: 'c-12', obsSeq: 5000 } };
    const bytes = JSON.stringify({ fcaPlanLedgerSeen: seen }).length;
    const observation = frame({ seq: 5001, items: { oak_planks: 4, bread: 3 } });
    const start = performance.now();
    let held = promises, memory = seen;
    for (let call = 0; call < 200; call += 1) {
      const events = [event(`skill:q9999:1:1:${call}`, 'oak_planks', -1, 'ingredient', 5001)];
      const result = applyLedger(held, memory, { events, observation, at: iso(call) });
      held = result.promises;
      memory = result.ledgerSeen;
    }
    const perCall = (performance.now() - start) / 200;
    const parseStart = performance.now();
    for (let index = 0; index < 20; index += 1) readLedgerSeen(JSON.parse(JSON.stringify(memory)));
    const roundTrip = (performance.now() - parseStart) / 20;
    console.error(`LEDGER-SIZE ids=3000 json=${bytes}B applyLedger=${perCall.toFixed(3)}ms/call roundtrip=${roundTrip.toFixed(3)}ms`);
    expect(bytes).toBeLessThan(200_000);
    expect(perCall).toBeLessThan(50);
  });
});
