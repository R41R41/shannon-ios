import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readPlanTree, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { foodLeads, preparationShortage, preparationStage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { nearNeeds } from '../src/surfaces/minecraft/minecraftLlmcReachWords.js';
import { meterLine, roadLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { onceFor } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { prepUnmetFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { nowKinds, planFactsOf } from '../src/surfaces/minecraft/minecraftPlanFacts.js';
import { BenchC, benchC, fixture, iso, produced, until } from './helpers/benchC.js';

/**
 * Bench C of the continue contract (chapter 10): the head is the head's code (the control, the store, the queue, the plan tools, the ledger, the decision record), the model is
 * a script and the body is a stand-in (`helpers/benchC.ts`). Each scene runs, writes the folder the judge reads (`tools/continue-verify/judge.ts`) and is judged on it:
 * the verdict (pass, the commands joined) is asserted, and the scene's own conditions are asserted beside it.
 */
const benches: BenchC[] = [];
const make = (options: ConstructorParameters<typeof BenchC>[0]) => { const bench = benchC(options); benches.push(bench); return bench; };
afterEach(() => { for (const bench of benches.splice(0)) bench.close(); });
const SLOW = { timeout: 60_000 };
const cond = (clause: Record<string, unknown>) => [[clause]] as never;
const mark = (queue: string, item: string) => ({ queue, item });

/** What the judge said of each scene, as a line for the report. */
const SUMMARY: string[] = [];
const noted = (verdict: { text: string; pass: boolean; commands: { judged: number; linked: number }; scene: string }) => {
  SUMMARY.push(`${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.scene} linked ${verdict.commands.linked}/${verdict.commands.judged}`);
  if (!verdict.pass || process.env.BENCH_C_VERBOSE) console.log(verdict.text);
};
afterAll(() => { console.log(['BENCH_C_SUMMARY', ...SUMMARY].join('\n')); });

/**
 * Boundary 1 (fixtures result/r43-reflex-ate-first.json, continue/queue-item-depends.json). `implicit`: q4 says nothing of what it relies on, as the fixture's q14 (the body drops it
 * as before, `depends_failed`); else it writes `dependsOn: ['q2']`.
 */
async function boundary1(scene: string, implicit: boolean, folder = scene) {
    const bench = make({ scene, folder });
    await bench.begin();
    bench.body.inventory = { cobblestone: 8, bread: 2, raw_iron: 2 };
    const sample = fixture('result/r43-reflex-ate-first.json'), queue = fixture('continue/queue-item-depends.json');
    const eat = produced('result--r43-reflex-ate-first').output.result.lines[0];
    // The body's real eat line: already, food_full, no operation.
    expect(eat).toMatchObject({ do: 'eat', goal: 'already', end: 'finished', code: 'food_full', motorOps: 0 });

    // 1. the act of run 43: a pillar and an eat the reflex had made unnecessary.
    await bench.decide('始め', () => bench.add(sample.input.act.hands, { why: sample.input.act.why }));
    expect(await until(() => bench.body.hasBeenHanded('q1'))).toBe(true);
    const q1 = bench.body.idOf('q1');
    bench.body.begin(q1);
    bench.body.finish(q1, { hands: [{ do: 'pillarUp', goal: 'done', line: '柱を 2 段積んだ', events: [{ item: 'cobblestone', count: -2, reason: 'placed' }], progress: { unit: 'block', done: 2, left: 0 } },
      { do: 'eat', goal: 'already', raw: eat }] });
    await bench.settle(80);
    const first = bench.queue.take();
    expect(first[0]!.result.text).toContain('既に済');

    // 2. round A: q2 runs and fails; q3 says it relies on nothing (and its `pre` is true), q4 says nothing. The body starts q3 and drops q4, before the head hears of q2.
    expect(queue.input.waiting.map((item: { item: string }) => item.item)).toEqual(['q13', 'q131', 'q132', 'q14', 'q15']);
    await bench.decide('次', async () => {
      await bench.add([{ do: 'dig', at: [{ x: 1, y: 64, z: 0 }] }], { why: '[p3] 鉄へ（q12）' });
      await bench.add([{ do: 'dig', at: [{ x: 2, y: 64, z: 0 }] }], { why: '[p3] 別の石（q13）', dependsOn: [], pre: cond({ k: 'have', item: 'raw_iron', n: 1 }) });
      await bench.add([{ do: 'dig', at: [{ x: 3, y: 64, z: 0 }] }], { why: '[p3] 続き（q14）', ...(implicit ? {} : { dependsOn: ['q2'] }) });
    });
    expect(await until(() => ['q2', 'q3', 'q4'].every(item => bench.body.hasBeenHanded(item)))).toBe(true);
    const [q2, q3, q4] = ['q2', 'q3', 'q4'].map(item => bench.body.idOf(item));
    const name = bench.body.handed.find(command => command.id === q2)!.queue!.queue;
    bench.body.begin(q2);
    await bench.settle(30);
    // The body: q2 fails, q3 (independent, pre true) starts, q4 (relies on q2 without saying) is dropped. All three in one breath.
    bench.body.paused = true;
    bench.body.finish(q2, { outcome: 'failed', hands: [{ do: 'dig', status: 'stopped', goal: 'failed', end: 'finished', code: 'unreachable', motorOps: 2, line: 'dig 届かない' }], failureType: 'unreachable',
      unit: { goal: 'failed', end: 'finished' } });
    bench.body.drop(q4, 'depends_failed', { item: mark(name, 'q2') });
    bench.body.begin(q3);
    bench.body.paused = false;
    await bench.settle(120);
    // The head cancelled nothing: q3 was started by the body, and no reply asked to cancel it.
    expect(bench.body.replies.flatMap(reply => reply.cancel)).toEqual([]);
    expect(bench.control().store.state(q3)).toBe('sent');
    expect(bench.queue.open()).toBe(true);
    expect(bench.queue.tail()).toBe('q3');
    // The head wakes the model (a failure, with q3 still open): its reason is the queue's own (the failure's settle time, or the little time q3 has left).
    expect(['alert', 'remaining']).toContain(await bench.queue.ready({ signal: new AbortController().signal, drain: false }));
    bench.body.finish(q3, { hands: [{ do: 'dig', goal: 'done', line: 'dig 掘った', events: [{ item: 'cobblestone', count: 1, reason: 'mined' }] }], unit: { goal: 'done', end: 'finished', keptDespite: { item: mark(name, 'q2'), code: 'failed' } } });
    await bench.settle(120);
    await bench.decide('見る', async news => {
      expect(news.map(item => [item.item, item.kind])).toEqual([['q2', 'ran'], ['q3', 'ran'], ['q4', 'dropped']]);
    });

    // 3. round B: q5 fails; q6 (relies on nothing) has a `pre` that is false; q7 relies on q5.
    await bench.decide('次の次', async () => {
      await bench.add([{ do: 'dig', at: [{ x: 4, y: 64, z: 0 }] }], { why: '[p3] 二つ目の失敗（q12）' });
      await bench.add([{ do: 'dig', at: [{ x: 5, y: 64, z: 0 }] }], { why: '[p3] 食料がまだ（q131）', dependsOn: [], pre: cond({ k: 'food', n: 40 }) });
      await bench.add([{ do: 'dig', at: [{ x: 6, y: 64, z: 0 }] }], { why: '[p3] q5 に頼る（q15）', dependsOn: ['q5'] });
    });
    expect(await until(() => ['q5', 'q6', 'q7'].every(item => bench.body.hasBeenHanded(item)))).toBe(true);
    const [q5, q6, q7] = ['q5', 'q6', 'q7'].map(item => bench.body.idOf(item));
    bench.body.begin(q5);
    bench.body.paused = true;
    bench.body.finish(q5, { outcome: 'failed', hands: [{ do: 'dig', status: 'stopped', goal: 'failed', end: 'finished', code: 'unreachable', motorOps: 1, line: 'dig 届かない' }], failureType: 'unreachable', unit: { goal: 'failed', end: 'finished' } });
    bench.body.notStarted(q6, 'precondition', mark(name, 'q5'));
    bench.body.drop(q7, 'depends_failed', { item: mark(name, 'q5') });
    bench.body.paused = false;
    await bench.settle(150);

    // 4. round C: q8 fails; q9's `pre` (a furnace) cannot be told.
    await bench.decide('三つ目', async () => {
      await bench.add([{ do: 'dig', at: [{ x: 7, y: 64, z: 0 }] }], { why: '[p3] 三つ目の失敗' });
      await bench.add([{ do: 'dig', at: [{ x: 8, y: 64, z: 0 }] }], { why: '[p3] かまどの近く（q132）', dependsOn: [], pre: cond({ k: 'furnace', x: 157, y: 23, z: 213 }) });
    });
    expect(await until(() => ['q8', 'q9'].every(item => bench.body.hasBeenHanded(item)))).toBe(true);
    const [q8, q9] = ['q8', 'q9'].map(item => bench.body.idOf(item));
    bench.body.begin(q8);
    bench.body.paused = true;
    bench.body.finish(q8, { outcome: 'failed', hands: [{ do: 'dig', status: 'stopped', goal: 'failed', end: 'finished', code: 'unreachable', motorOps: 1, line: 'dig 届かない' }], failureType: 'unreachable', unit: { goal: 'failed', end: 'finished' } });
    bench.body.notStarted(q9, 'precondition_unknown', mark(name, 'q8'));
    bench.body.paused = false;
    await bench.settle(150);
    await bench.decide('終わり', () => undefined);

    const { verdict } = bench.judged();
    noted({ ...verdict, scene: folder });
    expect(bench.body.replies.flatMap(reply => reply.cancel)).toEqual([]);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    return { verdict, bench };
}

describe('boundary 1 (results and the queue): the reflex ate first; the body decides who starts and who is dropped; the head cancels nothing', () => {
  it('judges pass when the dropped item writes what it relies on', SLOW, async () => {
    const { verdict } = await boundary1('boundary-1', false);
    expect(verdict.pass).toBe(true);
  });
  it('the q14 of the fixture (no dependsOn, dropped depends_failed) passes: chapter 2 says an item that writes no dependsOn is dropped as today; a dependsOn [] item dropped would not', SLOW, async () => {
    const { verdict } = await boundary1('boundary-1', true, 'boundary-1-implicit');
    expect(verdict.checks.filter(check => !check.ok).map(check => check.id)).toEqual([]);
    expect(verdict.checks.find(check => check.id === 'only the dependents are dropped')!.detail).toContain('1 of them wrote no dependsOn');
    expect(verdict.pass, verdict.text).toBe(true);
  });
});

// ---- boundary 3: the promises and what is spent ----------------------------------------------------------------------------------------------------------------
const ledgerOf = (bench: BenchC, id: number) => bench.plan.tree().promises.find(promise => promise.id === id)!;
/** The tool's input that writes the promises of the four fixtures one after the other (each released before the next). */
const promise = (item: string, count: number, use: string, extra: Record<string, unknown> = {}) => ({ op: 'promise', item, count, use, ...extra });

describe('boundary 3 (promises and spending): the receipts, the receipt box, the commit of a step, the ledger; have equals the pack at every receipt; an event id is put once', () => {
  it('judges pass over the four fixtures of the boundary (promise/r43-planks-burned-as-fuel, table-crafted-placed-picked, food-for-underground, make-intermediate-and-reflex)', SLOW, async () => {
    const bench = make({ scene: 'boundary-3' });
    await bench.begin();
    const r43 = fixture('promise/r43-planks-burned-as-fuel.json'), table = fixture('promise/table-crafted-placed-picked.json');
    const food = fixture('promise/food-for-underground.json'), make_ = fixture('promise/make-intermediate-and-reflex.json');
    const act = async (hands: unknown, extra: Record<string, unknown> = {}) => {
      let item = '';
      await bench.decide('act', async () => { item = (await bench.add(hands as never, extra as never)).item; });
      expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
      const id = bench.body.idOf(item);
      bench.body.begin(id);
      return id;
    };
    const finished = (id: string) => until(() => bench.control().store.state(id) === 'settled_known' && bench.control().store.row(id)!.receipt !== null);
    const booked = async (count: number) => { await until(() => bench.events().filter(row => row.ev === 'ledger').length >= count); await bench.settle(20); };

    // 1. the promise of the planks for the table; the planks go into the furnace (the plan said nothing of it).
    const written = await bench.planUpdate('計画', { ops: [promise('planks', 4, '作業台', { instead: 'have:crafting_table>=1' })] });
    expect(written.ok, JSON.stringify(written)).toBe(true);
    bench.body.inventory = { spruce_planks: 4, raw_iron: 15 };
    await bench.spin(3);
    const smelt = await act(r43.input.act.hands);
    bench.body.finish(smelt, { hands: [{ do: 'smelt', goal: 'done', line: '鉄 15 を焼いた', events: r43.input.events.map((event: { item: string; count: number; reason: never }) => ({ item: event.item, count: event.count, reason: event.reason })) }] });
    expect(await finished(smelt)).toBe(true);
    await booked(1);
    const line = ledgerOf(bench, 1).ledger.at(-1)!;
    expect(line).toMatchObject({ kind: 'consumed', count: 2, have: 2, declared: false, reason: 'smelt_fuel', promiseRev: 1 });
    expect(ledgerOf(bench, 1).have).toBe(2);
    bench.commit();

    // 2. a table from the planks, put down, picked up (the promise is kept by what the table does).
    await bench.planUpdate('約束を替える', { ops: [{ op: 'release', id: 1, why: '板は燃やした' }, promise('planks', 4, '作業台', { instead: 'have:crafting_table>=1|near:crafting_table~8' })] });
    bench.body.inventory = { oak_planks: 4 };
    bench.body.looks.utilities = { radius: 8, dim: 'overworld', obsSeq: 0, scanned: true, found: [] };
    await bench.spin(3);
    const snapshot = ledgerOf(bench, 2);
    expect(snapshot).toMatchObject({ id: 2, rev: 1, item: 'planks', count: 4 });
    const steps = table.input.steps as Array<{ act: { hands: unknown[]; uses?: number[] }; events: EventLike[]; observed: { utilities: { found: unknown[] } } }>;
    const done: string[] = [];
    for (const [index, step] of steps.entries()) {
      const id = await act(step.act.hands, step.act.uses ? { uses: [2] } : {});
      bench.body.looks.utilities = { radius: 8, dim: 'overworld', obsSeq: bench.body.nextSeq() + 1, scanned: true, found: step.observed.utilities.found };
      bench.body.finish(id, { hands: [{ do: String((step.act.hands[0] as { do: string }).do), goal: 'done', events: step.events.map(event => ({ item: event.item, count: event.count, reason: event.reason })) }] });
      expect(await finished(id)).toBe(true);
      await booked(2 + index);
      done.push(id);
    }
    expect(ledgerOf(bench, 2).state).toBe('kept_by_instead');
    expect(ledgerOf(bench, 2).ledger.filter(item => item.kind === 'consumed')).toHaveLength(1);
    expect(ledgerOf(bench, 2).ledger.find(item => item.kind === 'consumed')).toMatchObject({ count: 4, have: 0, declared: true, reason: 'craft_ingredient' });
    bench.commit();

    // 3. the food for the underground: an eat the act says is for it, and a reflex's eat outside any act.
    await bench.planUpdate('食料の約束', { ops: [{ op: 'release', id: 2 }, promise('food', 20, '地下で食べる分', { until: { condition: 'dim:nether' } })] });
    bench.body.inventory = { bread: 3 };
    bench.body.looks.utilities = undefined;
    await bench.spin(3);
    // (a promise's `have` is the pack at the first receipt that reaches the ledger; the line below counts back from it: 33 before, 22 after)
    const eat = await act(food.input.steps[0].act.hands, { uses: [3] });
    bench.body.finish(eat, { hands: [{ do: 'eat', goal: 'done', events: food.input.steps[0].events.map((event: EventLike) => ({ item: event.item, count: event.count, reason: event.reason })) }] });
    expect(await finished(eat)).toBe(true);
    await booked(5);
    expect(ledgerOf(bench, 3).ledger.at(-1)).toMatchObject({ kind: 'consumed', count: 11, have: 22, declared: true, reason: 'eat' });
    const reflex = food.input.steps[1].workingEvent.data;
    bench.body.reflexEvent(reflex.item, reflex.count, reflex.reason);
    await bench.spin(3);
    await booked(6);
    expect(ledgerOf(bench, 3).ledger.at(-1)).toMatchObject({ kind: 'consumed', count: 11, have: 11, declared: false, reason: 'reflex_eat' });
    bench.commit();

    // 4. make: the middle materials and a reflex that ate during the hand (one event for it, once).
    await bench.planUpdate('はしごの板', { ops: [{ op: 'release', id: 3 }, promise('planks', 2, 'はしご'), promise('food', 5, '非常食')] });
    bench.body.inventory = { oak_log: 2, bread: 2 };
    await bench.spin(3);
    const makeId = await act(make_.input.act.hands);
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    bench.body.finish(makeId, { hands: [{ do: 'make', goal: 'done', events: make_.input.events.map((event: EventLike) => ({ item: event.item, count: event.count, reason: event.reason, ...(event.intermediate ? { intermediate: true } : {}) })) }] });
    expect(await finished(makeId)).toBe(true);
    await bench.spin(3);
    await booked(8);
    expect(ledgerOf(bench, 4).have).toBe(make_.expected.promiseHave);
    expect(bench.plan.tree().promises.flatMap(item => item.ledger).filter(item => item.kind === 'unexplained')).toEqual([]);
    expect(bench.plan.tree().promises.find(item => item.id === 5)!.ledger.filter(item => item.reason === 'reflex_eat')).toHaveLength(1);
    bench.commit();

    // 5. more than 32 events from one act (twenty in the receipt, the rest by pages), the commit of the step, the head restarts: the receipt box is read again and nothing is put
    //    twice, though the first events have left the ledger's 32 lines (promise/seen-after-32-and-restart, events-split-delivery, receipt-box-then-ack).
    const seen = fixture('promise/seen-after-32-and-restart.json');
    expect(seen.expected).toEqual({ appliedCount: { 'skill:q69:1:1:2': 1 }, displayLedgerHas: false, seenHas: true });
    await bench.planUpdate('石の約束', { ops: [promise('cobblestone', 64, '家')] });
    bench.body.inventory = { cobblestone: 100 };
    await bench.spin(3);
    const big = await act([{ do: 'place', block: 'cobblestone', at: [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }] }]);
    const stones = Array.from({ length: 40 }, () => ({ item: 'cobblestone', count: -1, reason: 'placed' as const }));
    bench.body.finish(big, { hands: [{ do: 'place', goal: 'done', events: stones }], inline: 20 });
    expect(await finished(big)).toBe(true);
    expect(await until(() => ledgerOf(bench, 6).ledger.filter(line => line.kind === 'consumed').length + (ledgerOf(bench, 6).dropped ?? 0) >= 40, 6_000)).toBe(true);
    await bench.settle(60);
    const first = `${big}:1:1:1`;
    expect(bench.body.handed.filter(command => command.skill === 'events')).toHaveLength(1);
    expect(ledgerOf(bench, 6).ledger).toHaveLength(32);
    expect(ledgerOf(bench, 6).dropped).toBeGreaterThan(0);
    expect(ledgerOf(bench, 6).ledger.some(line => line.id === first)).toBe(false);
    expect(bench.plan.ledgerSeen().eventIds.filter(id => id === first)).toHaveLength(1);
    expect(bench.plan.ledgerSeen().eventIds.filter(id => id.startsWith(`${big}:`))).toHaveLength(40);
    expect(ledgerOf(bench, 6).have).toBe(60);
    const lines = ledgerOf(bench, 6).ledger.length, dropped = ledgerOf(bench, 6).dropped;
    bench.setCheckpoint(bench.savedCheckpoint());       // the plan was saved; the process stopped before the receipts were marked (amendment A-6 12)
    const unprocessed = bench.control().store.unprocessed(bench.run).length;
    expect(unprocessed).toBeGreaterThan(0);
    await bench.restartHead();
    // the new head puts the box to the ledger again, and the commit of its first step marks it
    expect(await until(() => { bench.commit(); return bench.control().store.unprocessed(bench.run).length === 0; }, 4_000)).toBe(true);
    await bench.settle(100);
    // The new head read every receipt in the box again; the ledger's memory (in the checkpoint) kept each event from going in twice.
    expect(ledgerOf(bench, 6).ledger).toHaveLength(lines);
    expect(ledgerOf(bench, 6).dropped).toBe(dropped);
    expect(ledgerOf(bench, 6).have).toBe(60);
    expect(bench.plan.ledgerSeen().eventIds.filter(id => id === first)).toHaveLength(1);
    expect(bench.plan.ledgerSeen().eventIds.filter(id => id.startsWith(`${big}:`))).toHaveLength(40);
    expect(new Set(bench.plan.ledgerSeen().eventIds).size).toBe(bench.plan.ledgerSeen().eventIds.length);
    // The same events come once more (a receipt resent, a poll twice): the ledger says it has them.
    expect(bench.plan.applyLedger({ events: [{ id: first, obsSeq: 1, item: 'cobblestone', count: -1, reason: 'placed' }], observation: bench.control().observe('minecraft:world') })).toEqual([]);

    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('a head that stops before it committed puts the receipts of the box to the ledger again, once (promise/receipt-box-then-ack)', SLOW, async () => {
    const bench = make({ scene: 'boundary-3', folder: 'boundary-3-receipt-box' });
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
    expect(await until(() => bench.control().store.state(id) === 'settled_known' && ledgerOf(bench, 1).ledger.some(line => line.kind === 'consumed'), 4_000)).toBe(true);
    // The receipt is in the store (the box) before it was acknowledged; the step did not commit: the old head's ledger is lost with it.
    expect(bench.control().store.row(id)!.receipt?.outcome).toBe('completed');
    expect(bench.control().store.unprocessed(bench.run).map(row => row.id)).toEqual([id]);
    await bench.restartHead();
    expect(await until(() => ledgerOf(bench, 1).ledger.some(line => line.kind === 'consumed'), 4_000)).toBe(true);
    // the box is put to the ledger by the new head and marked only when its plan is saved (amendment A-6 12)
    expect(await until(() => { bench.commit(); return bench.control().store.unprocessed(bench.run).length === 0; }, 4_000)).toBe(true);
    await bench.settle(50);
    expect(ledgerOf(bench, 1).ledger.filter(line => line.kind === 'consumed')).toEqual([expect.objectContaining({ count: 3, id: `${id}:1:1:1` })]);
    expect(bench.plan.ledgerSeen().eventIds).toEqual([`${id}:1:1:1`]);
    // the same boxes are not read twice by the same head
    expect(bench.control().store.row(id)!.ledgerDone).toBe(true);
  });
});
interface EventLike { item: string; count: number; reason: never; intermediate?: boolean }

// ---- boundary 8: the link and the restarts (the scenes of `e2e/boundaries.json` `boundary8Scenes`, all seven) ---------------------------------------------------------
/** A scene of boundary 8: a bench with a promise for the cobblestone (so the ledger has something to count) and the body's pack. */
async function scene8(id: string, options: { folder?: string } = {}) {
  const bench = make({ scene: id, ...(options.folder ? { folder: options.folder } : {}) });
  await bench.begin();
  bench.body.inventory = { cobblestone: 10 };
  const written = await bench.planUpdate('約束', { ops: [promise('cobblestone', 8, '家')] });
  expect(written.ok, JSON.stringify(written)).toBe(true);
  await bench.spin(2);
  return bench;
}
let handsCounter = 0;
/** The next act (a place of one block; every one differs, the queue refuses the same work twice). */
const place = () => [{ do: 'place' as const, block: 'cobblestone', at: [{ x: 100 + ++handsCounter, y: 64, z: 0 }] }];
async function send(bench: BenchC, hands: unknown, maxMs = 20_000) {
  let item = '';
  await bench.decide('act', async () => { item = (await bench.add(hands as never, {}, 'p1', maxMs)).item; });
  expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
  return { item, id: bench.body.idOf(item) };
}
const placed = (count: number) => [{ item: 'cobblestone', count: -count, reason: 'placed' as const }];
const stateOf = (bench: BenchC, id: string) => bench.control().store.state(id);
const rowsOf = (bench: BenchC, ev: string) => bench.events().filter(row => row.ev === ev);
const appliedIds = (bench: BenchC) => rowsOf(bench, 'ledger').flatMap(row => row.applied as string[]);

describe('boundary 8 (the link and the restarts): every scene of the table, judged on the records', () => {
  it('b8-lost-receipt: q1\'s receipt is kept until the head made q1 unknown, then let go: unknown, the stop proves the release within 5 s, one correction', SLOW, async () => {
    const bench = await scene8('b8-lost-receipt');
    const q1 = await send(bench, place(), 1_000);
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hold: true, hands: [{ do: 'place', goal: 'done', events: placed(3) }] });
    // The wait for the receipt runs out (1 s of the item and the margin): the result is unknown, the model is told, the stop is sent at once.
    expect(await until(() => stateOf(bench, q1.id) === 'settled_unknown' || stateOf(bench, q1.id) === 'released', 15_000, 20)).toBe(true);
    expect(await until(() => stateOf(bench, q1.id) === 'released', 6_000, 20)).toBe(true);
    expect(bench.control().store.row(q1.id)!.told).toBe(true);
    expect(bench.body.handed.filter(command => command.kind === 'stop')).toHaveLength(1);
    const before = rowsOf(bench, 'ledger').length;
    bench.body.release(q1.id);
    expect(await until(() => stateOf(bench, q1.id) === 'corrected', 4_000)).toBe(true);
    await bench.settle(100);
    // Nothing was sent again; the correction is one row, one line to the model, and the events are in the ledger once.
    expect(bench.body.handed.filter(command => command.id === q1.id)).toHaveLength(1);
    expect(rowsOf(bench, 'corrected')).toHaveLength(1);
    expect(bench.queue.notes().filter(line => line.includes('訂正'))).toHaveLength(1);
    expect(rowsOf(bench, 'ledger').length).toBeGreaterThan(before);
    expect(appliedIds(bench)).toEqual([`${q1.id}:1:1:1`]);
    expect(bench.plan.tree().promises[0]!.ledger.filter(line => line.kind === 'consumed')).toHaveLength(1);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('b8-dup-poll: the poll that carries q1\'s receipt goes twice and its acknowledgement is lost: applied once, no correction', SLOW, async () => {
    const bench = await scene8('b8-dup-poll');
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.paused = true;
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(3) }] });
    // The same request twice (the head takes a frame once: the second is refused as stale), and the reply that acknowledges it never arrives.
    bench.body.poll({ twice: true, loseAck: true });
    await bench.settle(60);
    expect(bench.body.pollErrors).toContain('FCA_BODY_STALE_FRAME');
    expect(bench.body.outbox.map(out => out.receipt.id)).toContain(q1.id);
    // The next poll carries it again: the head acknowledges it and changes nothing.
    bench.body.poll();
    await bench.settle(60);
    expect(bench.body.outbox.map(out => out.receipt.id)).not.toContain(q1.id);
    bench.body.paused = false;
    expect(rowsOf(bench, 'received')).toHaveLength(1);
    expect(stateOf(bench, q1.id)).toBe('settled_known');
    expect(appliedIds(bench)).toEqual([`${q1.id}:1:1:1`]);
    expect(rowsOf(bench, 'corrected')).toHaveLength(0);
    expect(bench.body.receiptLog.filter(line => line.id === q1.id).length).toBeGreaterThanOrEqual(2);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('b8-reconnect: the body\'s connection is cut while q2 runs and q3 waits: the first poll of the new one releases q2 (result unknown), q3 is connection_changed and never starts', SLOW, async () => {
    const bench = await scene8('b8-reconnect');
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(60);
    const q2 = await send(bench, [{ do: 'wait', seconds: 20 }]);
    bench.body.begin(q2.id);
    const q3 = await send(bench, [{ do: 'wait', seconds: 21 }]);
    const handedBefore = bench.body.handed.length;
    // A decision that read the frame of the first connection and is still being thought (the answer is not made yet).
    const thinking = bench.lifecycle();
    thinking.context();
    const read = thinking.readOf!()!;
    expect(read.connectionId).toBe('connection-1');
    expect(thinking.drifted!(read)).toBeNull();
    bench.body.paused = true;
    bench.marks.injections.push({ kind: 'reconnect', at: iso() });
    bench.body.reconnect();
    bench.body.poll();
    bench.body.poll();
    await bench.settle(120);
    bench.body.paused = false;
    expect(stateOf(bench, q2.id)).toBe('released');
    expect(stateOf(bench, q3.id)).toBe('released');
    expect(bench.control().store.unitOf(q2.id)).toEqual({ goal: 'unknown', end: 'unknown', released: true });
    expect(bench.control().store.row(q2.id)!.releasedBy).toBe('reconnect');
    // Nothing is sent again, by the head or by the queue; q3 never ran.
    expect(bench.body.handed.length).toBe(handedBefore);
    expect(bench.body.trace.filter(line => line.kind === 'hand_start' && (line.ids as { command: string }).command === q3.id)).toHaveLength(0);
    expect(rowsOf(bench, 'corrected')).toHaveLength(0);
    // The answer the model was making is made on the old connection: it is thrown away (connection_changed) and asked again on the new frame.
    expect(thinking.drifted!(read)).toBe('connection_changed');
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  /** The two scenes of a head restart share a start: q1 done, q2 running (and, in the notified scene, q2 unknown to the model before the head stops). */
  it('b8-head-restart-unacked: the head restarts while q2 runs: it registers its boot, the stop proves the release before q2\'s cut receipt, which then settles q2 as an ordinary result', SLOW, async () => {
    const bench = await scene8('b8-head-restart-unacked');
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(60);
    const q2 = await send(bench, [{ do: 'wait', seconds: 20 }]);
    bench.body.begin(q2.id);
    bench.commit();
    // The body takes its time to cut what ran for the head that is gone, so the stop's proof comes first.
    bench.body.cutDelayMs = 80;
    await bench.restartHead();
    expect(bench.head.headBoot).toBe('hb-2');
    // Nothing that moves the body goes before the old head's open command is cleaned up; the cleanup is a stop.
    expect(await until(() => stateOf(bench, q2.id) === 'released' || stateOf(bench, q2.id) === 'settled_known', 4_000)).toBe(true);
    expect(bench.body.handed.filter(command => command.skill === 'act' && command.id !== q1.id && command.id !== q2.id)).toEqual([]);
    expect(await until(() => stateOf(bench, q2.id) === 'settled_known' && bench.control().store.row(q2.id)!.receipt?.outcome === 'cancelled', 4_000)).toBe(true);
    await bench.settle(60);
    expect(bench.control().store.row(q2.id)!.told).toBe(false);
    expect(rowsOf(bench, 'unknown_notified')).toHaveLength(0);
    expect(rowsOf(bench, 'corrected')).toHaveLength(0);
    expect(rowsOf(bench, 'head_boot').map(row => row.headBoot)).toEqual(['hb-1', 'hb-2']);
    expect(bench.body.handed.filter(command => command.id === q2.id)).toHaveLength(1);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('b8-head-restart-unacked, the other order: q2\'s receipt comes before the stop\'s proof (nothing is left to clean up): the head settles it as an ordinary result; only the judge\'s "cleanup released" is not met', SLOW, async () => {
    const bench = await scene8('b8-head-restart-unacked', { folder: 'b8-head-restart-unacked-receipt-first' });
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(60);
    const q2 = await send(bench, [{ do: 'wait', seconds: 20 }]);
    bench.body.begin(q2.id);
    bench.commit();
    bench.body.cutDelayMs = 0;
    await bench.restartHead();
    expect(await until(() => stateOf(bench, q2.id) === 'settled_known', 4_000)).toBe(true);
    await bench.settle(100);
    expect(rowsOf(bench, 'unknown_notified')).toHaveLength(0);
    expect(rowsOf(bench, 'corrected')).toHaveLength(0);
    expect(bench.control().store.row(q2.id)!.releasedBy).toBeNull();
    const { verdict } = bench.judged();
    noted({ ...verdict, scene: 'b8-head-restart-unacked-receipt-first' });
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);   // no cleanup row: nothing was left to clean up, and the judge asks for a cleanup only when there was one
  });

  it('b8-head-restart-notified: q2 is unknown and the model was told; the head stops; after the start the stop proves the release and the real receipt corrects q2, once', SLOW, async () => {
    const bench = await scene8('b8-head-restart-notified');
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(60);
    const q2 = await send(bench, place(), 1_000);
    bench.body.begin(q2.id);
    bench.body.finish(q2.id, { hold: true, hands: [{ do: 'place', goal: 'done', events: placed(3) }] });
    // The stop of the first head gets no answer in the time it has: q2 stays unknown, told, not yet released.
    bench.body.stopMode = 'never';
    expect(await until(() => stateOf(bench, q2.id) === 'settled_unknown', 15_000, 20)).toBe(true);
    expect(bench.control().store.row(q2.id)!.told).toBe(true);
    expect(rowsOf(bench, 'unknown_notified')).toHaveLength(1);
    bench.commit();
    await bench.restartHead(() => { bench.body.stopMode = 'prove'; });
    // After the start: the cleanup finds q2 (unknown), the stop proves the release; then the body lets the real receipt go.
    expect(await until(() => stateOf(bench, q2.id) === 'released', 6_000, 20)).toBe(true);
    bench.body.release(q2.id);
    expect(await until(() => stateOf(bench, q2.id) === 'corrected', 4_000)).toBe(true);
    await bench.settle(100);
    expect(rowsOf(bench, 'corrected')).toHaveLength(1);
    expect(bench.body.handed.filter(command => command.id === q2.id)).toHaveLength(1);
    expect(appliedIds(bench).filter(id => id.startsWith(`${q2.id}:`))).toEqual([`${q2.id}:1:1:1`]);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('b8-head-restart-notified, the order of the table (the real receipt is let go before the head wakes): q2 is corrected by it on the first poll, once; nothing is left to clean up, the judge passes it (no cleanup row, the correction is the release)', SLOW, async () => {
    const bench = await scene8('b8-head-restart-notified', { folder: 'b8-head-restart-notified-receipt-first' });
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(60);
    const q2 = await send(bench, place(), 1_000);
    bench.body.begin(q2.id);
    bench.body.finish(q2.id, { hold: true, hands: [{ do: 'place', goal: 'done', events: placed(3) }] });
    bench.body.stopMode = 'never';
    expect(await until(() => stateOf(bench, q2.id) === 'settled_unknown', 15_000, 20)).toBe(true);
    bench.commit();
    await bench.restartHead(() => { bench.body.stopMode = 'prove'; bench.body.release(q2.id); });
    expect(await until(() => stateOf(bench, q2.id) === 'corrected', 4_000)).toBe(true);
    await bench.settle(100);
    // The real receipt came on the first poll, before this start's queue existed: the correction is said once (to the model and in the record) when the queue starts.
    expect(rowsOf(bench, 'corrected')).toHaveLength(1);
    expect(bench.queue.notes().filter(line => line.includes('訂正'))).toHaveLength(1);
    expect(bench.control().store.row(q2.id)!.correctionSaid).toBe(true);
    expect(bench.body.handed.filter(command => command.id === q2.id)).toHaveLength(1);
    expect(appliedIds(bench).filter(id => id.startsWith(`${q2.id}:`))).toEqual([`${q2.id}:1:1:1`]);
    expect(rowsOf(bench, 'released')).toHaveLength(0);
    const { verdict } = bench.judged();
    noted({ ...verdict, scene: 'b8-head-restart-notified-receipt-first' });
    // Nothing was left to clean up, so q2 has no cleanup row; the real receipt corrected it and released it (the correction's result), which is the evidence of its release.
    expect(verdict.commands.unlinked).toEqual([]);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('events the restarted body lost: a receipt that carried only part of its events, the body restarts before the head asks for the rest: the page is told lost and the difference is unexplained (events_lost)', SLOW, async () => {
    const bench = await scene8('b8-body-restart', { folder: 'b8-body-restart-lost-page' });
    // the ledger knows the pack before the act (a reflex's meal, alone in its poll)
    bench.body.inventory = { ...bench.body.inventory, bread: 2 };
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    await bench.spin(3);
    expect(bench.plan.tree().promises[0]!.have).toBe(10);
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.paused = true;
    bench.body.finish(q1.id, { inline: 2, hands: [{ do: 'place', goal: 'done', events: Array.from({ length: 6 }, () => placed(1)[0]!) }] });
    bench.body.poll();            // the receipt (2 of the 6 events) reaches the head
    bench.body.restart();         // the body goes down and up: no record of its events
    bench.body.poll();            // the first poll of the new connection, before the head's wait has noticed the receipt
    bench.body.paused = false;
    expect(await until(() => rowsOf(bench, 'events').some(row => row.lost === true))).toBe(true);
    await bench.settle(100);
    const lost = rowsOf(bench, 'events').filter(row => row.lost === true);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.ids.command).toBe(q1.id);
    expect(appliedIds(bench)).toHaveLength(3);   // the meal and the two events the receipt carried
    expect(bench.plan.tree().promises[0]!.ledger.filter(line => line.kind === 'unexplained')).toEqual([expect.objectContaining({ count: -4 })]);   // the first look at the pack (the receipt's two events) already shows it; the lost page then explains nothing more
    expect(rowsOf(bench, 'ledger_unexplained')).toHaveLength(1);
    expect(bench.plan.tree().promises[0]!.have).toBe(4);
  });

  it('b8-body-restart: the body restarts while q2 runs: the first poll of the new one releases q2 (result unknown); what q2 had done leaves a difference the ledger calls unexplained', SLOW, async () => {
    const bench = await scene8('b8-body-restart');
    const q1 = await send(bench, place());
    bench.body.begin(q1.id);
    bench.body.finish(q1.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(80);
    expect(bench.plan.tree().promises[0]!.have).toBe(9);
    const q2 = await send(bench, place());
    bench.body.begin(q2.id);
    // q2 placed 4 blocks before the body went down; its events were not delivered (a body that restarts keeps no record).
    bench.body.inventory = { cobblestone: 5 };
    await bench.spin(2);
    bench.body.paused = true;
    bench.marks.injections.push({ kind: 'body_restart', at: iso() });
    bench.body.restart();
    bench.body.poll();
    bench.body.poll();
    await bench.settle(100);
    bench.body.paused = false;
    expect(stateOf(bench, q2.id)).toBe('released');
    expect(bench.control().store.unitOf(q2.id)).toEqual({ goal: 'unknown', end: 'unknown', released: true });
    // A later command with events: the pack differs from what the events explain, and the ledger says so (unexplained), not who did it.
    const q3 = await send(bench, place());
    bench.body.begin(q3.id);
    bench.body.finish(q3.id, { hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    await bench.settle(150);
    const unexplained = bench.plan.tree().promises[0]!.ledger.filter(line => line.kind === 'unexplained');
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ count: -4, reason: 'events_lost' });   // written when the first poll of the new body proved the release, not at the next command
    expect(rowsOf(bench, 'ledger_unexplained')).toHaveLength(1);
    expect(rowsOf(bench, 'corrected')).toHaveLength(0);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    // A5 2: the command the body never answered stays unknown, its events are written lost without asking the restarted body, and the model is told once.
    const lost = rowsOf(bench, 'events').filter(row => row.lost === true && row.ids.command === q2.id);
    expect(lost).toHaveLength(1);
    expect(onceFor(bench.run, 'normal').map(fact => fact.text)).toEqual([expect.stringContaining('体が再起動したため、この命令の結果と出来事は分からない。観測で確かめる')]);
    expect(verdict.checks.filter(check => !check.ok)).toEqual([]);
  });

  it('b8-lease-swap: q2 waits while the lease is renewed: the head cancels what the old lease sent, the body answers lease_expired for q2 and q2 never moved', SLOW, async () => {
    const bench = await scene8('b8-lease-swap');
    const q1 = await send(bench, [{ do: 'wait', seconds: 20 }]);
    bench.body.begin(q1.id);
    const q2 = await send(bench, [{ do: 'wait', seconds: 22 }]);
    bench.body.cancelCode = 'lease_expired';
    bench.swapLease();
    expect(await until(() => bench.body.entries.get(q2.id)!.state === 'ended' && bench.body.entries.get(q1.id)!.state === 'ended', 4_000)).toBe(true);
    await bench.settle(150);
    expect(bench.body.cancelled).toEqual(expect.arrayContaining([q1.id, q2.id]));
    expect(bench.body.trace.filter(line => line.kind === 'op' && (line as { command: string }).command === q2.id)).toHaveLength(0);
    expect(bench.body.handed.filter(command => command.skill === 'act')).toHaveLength(2);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });
});

// ---- boundary 9: the plan (kind and prep) -------------------------------------------------------------------------------------------------------------------
const snapshotOf = (tree: PlanTree) => tree.nodes.map(node => ({ id: node.id, kind: node.kind, prep: node.prep ?? null }));
const frameOf = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, state: { world: world as never }, facts: {} });
const countsOf = (items: Array<[string, number]> = []) => carriedItemCounts({ inventory: items.map(([name, count]) => ({ name, count })) }, {});
/** The values the head decides by for a plan whose current node is `current` (the same as the fixture's `sameDecisions`); the titles are used only by the shown lines. */
function decisionsOf(tree: PlanTree, current: string) {
  const facts = planFactsOf(tree);
  const world = { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'bread', count: 2 }, { name: 'stone_sword', count: 1 }], health: 20, food: 20 };
  const landmarks = ['L 溶岩源 (173,-16,147) 東3・北3・下2 溜まりの源 4', 'O 黒曜石 (253,-55,154) 東83・南4・下41 ×6'];
  const body = { state: { dimension: 'overworld', fullness: 20 }, foodPoints: { total: 60 }, planFacts: facts, landmarks, planNow: `[${current}] ${tree.nodes.find(node => node.id === current)!.title}` };
  const meter = meterLine(tree, frameOf({ ...world, inventory: [] }), 1_900 / 60)!;
  return {
    preparationStage: preparationStage('overworld', countsOf(), nowKinds(facts)),
    preparationShortage: preparationShortage({ dimension: 'overworld', counts: countsOf([['stone_sword', 1]]), food: 20, nowKinds: nowKinds(facts) }),
    stagesFor: stagesFor({ body: { state: { dimension: 'overworld' }, planFacts: facts } }),
    obsidianWays: obsidianWays(body, { x: 170, y: -14, z: 150 }, null),
    nearNeeds: nearNeeds(body),
    gateBack: foodLeads({ position: { x: 150, y: 64, z: 200 } }, 'the_nether', tree.nodes) ?? null,
    'meterLine.next': meter.match(/次の節目 (.+?) 目安/u)?.[1] ?? null,
    'meterLine.lateness': meter.match(/（(あと [\d,]+ 秒|[\d,]+ 秒遅れ)）/u)?.[1] ?? null,
  };
}
/**
 * Every place in the head's source (the API's and the mind package's) that gives a node a `prep` state: a literal state assigned to one, or `node.prep = `. The contract
 * (chapter 7) lets the head write none of its own: the model's `plan.update` (the op's application) and the one move of a v1 tree (which reads the old head's note) are the two.
 */
function prepWriters(): string[] {
  const roots = [fileURLToPath(new URL('../src/', import.meta.url)), fileURLToPath(new URL('../../../packages/mind/src/', import.meta.url))];
  const found: string[] = [];
  const walk = (dir: string, root: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path, root); continue; }
      if (!/\.ts$/u.test(entry.name)) continue;
      fs.readFileSync(path, 'utf8').split('\n').forEach(line => { if (/state: '(?:met|skipped|unmet_now)'|\.prep = |prep: \{ state/u.test(line)) found.push(`${path.slice(root.length)}: ${line.trim().slice(0, 70)}`); });
    }
  };
  for (const root of roots) walk(root.replace(/\/$/u, ''), root.replace(/\/$/u, ''));
  return found.sort();
}

describe('boundary 9 (the plan): kind and prep from the first plan to a restarted head; the same decisions after a rename; the head writes no prep', () => {
  it('judges pass (fixtures plan/first-plan-with-kind, title-renamed-same-decisions, descended-without-prep-fact)', SLOW, async () => {
    const first = fixture('plan/first-plan-with-kind.json'), rename = fixture('plan/title-renamed-same-decisions.json'), descended = fixture('plan/descended-without-prep-fact.json');
    const bench = make({ scene: 'boundary-9', goal: 'ダイヤまで', planner: async () => first.input.firstPlanAnswer });
    bench.body.looks.scan = { at: iso(), text: '周りは草原', rows: [], trigger: 'login' };
    await bench.begin();
    const probe = (line: Record<string, unknown>) => bench.probes.push({ at: iso(), ...line });
    const snapshot = (stage: string, tree: PlanTree) => probe({ kind: 'plan_snapshot', stage, nodes: snapshotOf(tree) });
    // The head's own writes to the plan (the nodes seen done, the node followed) are watched: a node whose `prep` changed by them is a `plan_write` of the head.
    const headWrites = (before: PlanTree, after: PlanTree) => {
      for (const node of after.nodes) {
        const was = before.nodes.find(item => item.id === node.id);
        if (JSON.stringify(was?.prep ?? null) !== JSON.stringify(node.prep ?? null)) probe({ kind: 'plan_write', by: 'head', node: node.id, fields: ['prep'] });
      }
    };

    // 1. the first plan's answer (the strong model's, as the production takes it): kind and the promise are in the tree; the stage is read from the kind.
    expect(await until(() => bench.head.lines.some(line => line.includes('first plan planned')))).toBe(true);
    const before = bench.plan.tree();
    bench.plan.view();
    const planned = bench.plan.tree();
    headWrites(before, planned);
    snapshot('first_plan', planned);
    expect(planned.schema).toBe(first.expected.saved.schema);
    expect(Object.fromEntries(planned.nodes.map(node => [node.id, node.kind]))).toEqual(first.expected.saved.kinds);
    expect(planned.promises[0]).toMatchObject(first.expected.saved.promises[0]);
    for (const [id, stage] of Object.entries(first.expected.preparationStageWhenCurrent as Record<string, string | null>)) {
      const moved = await bench.planUpdate('今の節', { ops: [], current: id });
      expect(moved.ok).toBe(true);
      expect(preparationStage('overworld', countsOf(), nowKinds(planFactsOf(bench.plan.tree())))).toBe(stage);
    }

    // 2. the model's plan.update: it writes a prep and a kind (a word outside the list is other, the word kept and put in the record).
    const written = await bench.planUpdate('準備を省く', { ops: [{ op: 'set', id: 'p3', prep: descended.expected.thenLlmMay.prep }, { op: 'add', title: '畑のとなり', kind: 'farm_of_iron' }] });
    expect(written.ok, JSON.stringify(written)).toBe(true);
    probe({ kind: 'plan_write', by: 'llm', node: 'p3', fields: ['prep'] });
    const updated = bench.plan.tree();
    snapshot('plan_update', updated);
    expect(updated.nodes.find(node => node.id === 'p3')!.prep).toMatchObject({ state: 'skipped', why: '鉄を先に取る' });
    expect(updated.nodes.find(node => node.title === '畑のとなり')).toMatchObject({ kind: 'other', kindRaw: 'farm_of_iron' });
    expect(bench.events().filter(row => row.ev === 'kind_raw').map(row => row.nodes[0].kindRaw)).toEqual(['farm_of_iron']);

    // 3. the model has not written a prep, and she is down at y=16 without the preparation: the head says a fact, once, and writes no prep (the node it did not touch stays as it is).
    await bench.planUpdate('準備の節を足す', { ops: [{ op: 'add', id: 'p0', after: 'p1', title: descended.input.tree.nodes[0].title, kind: 'prep_descent', doneWhen: descended.input.tree.nodes[0].doneWhen }], current: 'p0' });
    bench.body.looks.position = { x: 160, y: descended.input.body.y, z: 200 };
    bench.body.inventory = { raw_iron: 3, bread: 1, apple: 1 };
    await bench.spin(3);
    const down = { counts: new Map(Object.entries(descended.input.body.have as Record<string, number>)), dimension: 'overworld', feet: { x: 160, y: descended.input.body.y as number, z: 200 }, food: descended.input.body.foodPoints as number };
    const treeBefore = bench.plan.tree();
    const facts = prepUnmetFacts(treeBefore, down);
    expect(facts.map(fact => fact.key)).toEqual(['prep_unmet:p0']);
    for (const word of descended.expected.fact.mustContain as string[]) expect(facts[0]!.text.replace('p3', 'p0')).toContain(word.replace('p3', 'p0'));
    // The step's reads of the plan with that observation (the nodes seen done, the node followed) change no prep.
    bench.plan.view();
    bench.plan.view();
    headWrites(treeBefore, bench.plan.tree());
    expect(bench.plan.tree().nodes.find(node => node.id === 'p0')).toMatchObject({ state: 'continue' });
    expect(bench.plan.tree().nodes.find(node => node.id === 'p0')!.prep).toBeUndefined();
    expect(snapshotOf(bench.plan.tree()).filter(node => node.prep && node.id !== 'p3')).toEqual([]);

    // 4. a step ends (the commit), the head restarts, the plan is read back from the saved checkpoint.
    const checkpoint = bench.commit() as { fcaPlanTree: PlanTree };
    const saved = checkpoint.fcaPlanTree;
    snapshot('saved', saved);
    await bench.restartHead();
    const restarted = bench.plan.tree();
    snapshot('head_restart', restarted);
    expect(bench.head.lines.some(line => line.includes('migrated'))).toBe(false);
    const again = bench.commit() as { fcaPlanTree: unknown };
    const readBack = readPlanTree(JSON.parse(JSON.stringify(again.fcaPlanTree)))!;
    snapshot('read_back', readBack);
    expect(readBack).toEqual(restarted);
    // every node the model had written is back with its kind and prep (the node added after the update, p0, is there too)
    for (const node of snapshotOf(updated)) expect(snapshotOf(restarted).find(item => item.id === node.id)).toEqual(node);
    expect(snapshotOf(restarted).map(node => node.id)).toEqual(snapshotOf(bench.plan.tree()).map(node => node.id));

    // 5. the same decisions after the titles are changed: the fixture's plan is read by the plan tool from a checkpoint, and the model renames three nodes with plan.update.
    const side = createFcaPlanTools({ taskId: 'rename-side', checkpoint: { fcaPlanTree: { ...rename.input.tree, nodes: [...rename.input.tree.nodes,
      { id: 'p8', parentId: null, order: 6, title: 'エンドでドラゴン', state: 'wait', kind: 'dragon' }] } }, rules: true, compact: true, log: () => undefined });
    const sideUpdate = (input: unknown) => side.tools.execute({ scopeKey: 'o', taskId: 'rename-side', operationId: 'op', name: 'plan.update', input, signal: new AbortController().signal } as never);
    await sideUpdate({ ops: [], current: 'p5' });
    const originalTree = side.port.tree();
    const original = decisionsOf(originalTree, 'p5');
    const ops = [...Object.entries(rename.input.rename as Record<string, string>).map(([id, title]) => ({ op: 'set', id, title })), { op: 'set', id: 'p8', title: '龍を倒す' }];
    expect(await sideUpdate({ ops })).toMatchObject({ ok: true });
    const renamedTree = side.port.tree();
    const afterRename = decisionsOf(renamedTree, 'p5');
    expect(renamedTree.nodes.map(node => node.title)).not.toEqual(originalTree.nodes.map(node => node.title));
    expect(afterRename).toEqual(original);
    // all the currents of the fixture, and the lines that show the titles do change
    for (const current of ['p3', 'p4', 'p5', 'p6', 'p7']) {
      await sideUpdate({ ops: [], current });
      expect(decisionsOf(side.port.tree(), current), current).toEqual(decisionsOf({ ...originalTree, current }, current));
    }
    expect(roadLine({ ...originalTree, current: 'p5' })).not.toBe(roadLine({ ...renamedTree, current: 'p5' }));
    for (const name of rename.expected.sameDecisions as string[]) expect(original[name as keyof typeof original], name).not.toBeUndefined();
    probe({ kind: 'plan_decisions', variant: 'original', values: original });
    probe({ kind: 'plan_decisions', variant: 'renamed', values: afterRename });

    // 6. the head writes no prep: nothing of its own code does (the files that assign a state to a prep are the plan's tree and the tool that passes the model's), and the run above shows none.
    // the two places: the v1 move (it reads the old head's note) and the op the model's plan.update gives; nothing of the head's own code (`amend`, `seen`, `follow`) writes one
    const writers = prepWriters();
    expect(writers.map(line => line.split(':')[0])).toEqual(['/planTree.ts', '/planTreeMigration.ts', '/planTreeMigration.ts']);
    // 移行の skipped/met の2分岐と、モデル更新の代入だけを許す。
    expect(writers[2]).toContain("/planTreeMigration.ts: ? { state: 'skipped' }");
    expect(writers[1]).toContain("/planTreeMigration.ts: ? { state: 'met' }");
    expect(writers[0]).toContain('/planTree.ts: node.prep = { state: op.prep.state');
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.checks.map(check => check.id)).toEqual(expect.arrayContaining(['every stage of the round trip is recorded', 'kind and prep survive save, head restart and read back',
      'a renamed title leaves the decisions alone', 'the head does not write prep']));
    expect(verdict.pass, verdict.text).toBe(true);
  });
});

// ---- the seams the bench C can show (the head and the body meeting): 1 to 5 ---------------------------------------------------------------------------------------
/** A body's result lines (a `produced/` file's) as the hands a script gives the stand-in: each line is kept as the body wrote it. */
const handsOf = (lines: Array<Record<string, any>>) => lines.map(line => ({ do: String(line.do), goal: line.goal, end: line.end, status: line.status, motorOps: line.motorOps, code: line.code, raw: line }));
const WAIT = (seconds: number) => [{ do: 'wait' as const, seconds }];
/** An item with the fields of the act the model chose (`dependsOn`, `uses`, ...): its mark and its command's id once the body has been handed it. */
async function sendX(bench: BenchC, hands: unknown, extra: Record<string, unknown> = {}, maxMs = 20_000) {
  let item = '';
  await bench.decide('act', async () => { item = (await bench.add(hands as never, extra as never, 'p1', maxMs)).item; });
  expect(await until(() => bench.body.hasBeenHanded(item))).toBe(true);
  return { item, id: bench.body.idOf(item) };
}
const queueNameOf = (bench: BenchC, id: string) => bench.body.handed.find(command => command.id === id)!.queue!.queue;

describe('seams of the head and the body (chapter 10): the cases the bench C can show', () => {
  it('seam-1: the body starts the independent q2 before the head hears that q1 failed; the head cancels nothing', SLOW, async () => {
    const bench = make({ scene: 'seam-1' });
    await bench.begin();
    const q1 = await send(bench, WAIT(20));
    bench.body.begin(q1.id);
    const q2 = await sendX(bench, [{ do: 'dig', at: [{ x: 6, y: 64, z: 0 }] }], { dependsOn: [] });
    bench.body.paused = true;
    // The body: q1 fails and q2, which says it relies on nothing, begins in the same breath; the head has not heard yet.
    bench.body.finish(q1.id, { outcome: 'failed', hands: [{ do: 'wait', status: 'failed', goal: 'failed', code: 'unreachable', motorOps: 1 }], failureType: 'unreachable', unit: { goal: 'failed', end: 'finished' } });
    bench.body.begin(q2.id);
    bench.marks.injections.push({ kind: 'independent_started', at: iso(), started: q2.id, failed: q1.id });
    await delay(30);
    bench.body.paused = false;
    await bench.settle(200);
    // The failure reaches the head with q2 running: it is read, nothing is cancelled, q2 is still the body's.
    expect(bench.body.cancelled).toEqual([]);
    expect(bench.body.replies.flatMap(reply => reply.cancel)).toEqual([]);
    expect(bench.queue.open()).toBe(true);
    expect(stateOf(bench, q2.id)).toBe('sent');
    expect(['alert', 'remaining']).toContain(await bench.queue.ready({ signal: new AbortController().signal, drain: false }));
    bench.body.finish(q2.id, { hands: [{ do: 'dig', goal: 'done', events: [{ item: 'cobblestone', count: 1, reason: 'mined' }] }], unit: { goal: 'done', end: 'finished' } });
    await bench.settle(150);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('seam-2: a failure behind onFail continue that a later hand relies on (the body\'s own lines), and three items that rely on one another', SLOW, async () => {
    const bench = make({ scene: 'seam-2' });
    await bench.begin();
    const onfail = fixture('continue/onfail-continue-does-not-exempt.json'), indirect = fixture('continue/indirect-depends.json');
    const lines = produced('continue--onfail-continue-does-not-exempt').output.result.lines as Array<Record<string, any>>;
    expect(lines.map(line => [line.goal, line.end, line.code ?? null])).toEqual([['not_started', 'finished', 'out_of_reach'], ['not_started', 'not_run', 'depends_failed:1'], ['done', 'finished', null]]);
    // 1. an item that relies on nothing and runs.
    const alone = await sendX(bench, [{ do: 'dig', at: [{ x: 1, y: 64, z: 0 }] }], { dependsOn: [] });
    bench.body.begin(alone.id);
    bench.body.finish(alone.id, { hands: [{ do: 'dig', goal: 'done', events: [{ item: 'cobblestone', count: 1, reason: 'mined' }] }] });
    await bench.settle(60);
    // 2. the act of the fixture: hand 1 fails and goes on (onFail continue), hand 2 relies on it and does not run, hand 3 relies on nothing and runs.
    const act = await sendX(bench, onfail.input.act.hands);
    bench.body.begin(act.id);
    bench.body.finish(act.id, { hands: handsOf(lines), outcome: 'failed' });
    await bench.settle(100);
    await bench.decide('読む', () => undefined);
    const told = bench.told;
    expect(told.map(item => [item.item, item.kind])).toEqual([[alone.item, 'ran'], [act.item, 'ran']]);
    expect(told[1]!.result.text).toContain('頼る手 1 が済まなかったので動かさなかった');
    expect(stateOf(bench, act.id)).toBe('settled_known');
    // 3. a failure with two items that rely on it, one behind the other: the body drops the second for the first and the third for the second.
    expect(indirect.input.queue.waiting).toEqual([{ item: 'q2', dependsOn: ['q1'] }, { item: 'q3', dependsOn: ['q2'] }]);
    const a = await sendX(bench, WAIT(20));
    bench.body.begin(a.id);
    const b = await sendX(bench, WAIT(21), { dependsOn: [a.item] });
    const c = await sendX(bench, WAIT(22), { dependsOn: [b.item] });
    const name = queueNameOf(bench, a.id);
    bench.body.paused = true;
    bench.body.finish(a.id, { outcome: 'failed', hands: [{ do: 'wait', status: 'failed', goal: 'failed', code: 'unreachable', motorOps: 1 }], failureType: 'unreachable', unit: { goal: 'failed', end: 'finished' } });
    bench.body.drop(b.id, 'depends_failed', { item: mark(name, a.item) });
    bench.body.drop(c.id, 'depends_failed', { item: mark(name, b.item) });
    bench.marks.injections.push({ kind: 'chain', at: iso(), items: [a.id, b.id, c.id] });
    bench.body.paused = false;
    await bench.settle(200);
    expect(bench.body.replies.flatMap(reply => reply.cancel)).toEqual([]);
    const news = bench.queue.take();
    expect(news.map(item => [item.item, item.kind])).toEqual([[a.item, 'ran'], [b.item, 'dropped'], [c.item, 'dropped']]);
    expect(news[1]!.result.text).toContain(`頼る項目 ${a.item}`);
    expect(news[2]!.result.text).toContain(`頼る項目 ${b.item}`);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('seam-3: unknown results the model was shown; the cleanup proves the release, then a late result (a success, a failure) and the same result again; a cleanup that fails, then proves late', SLOW, async () => {
    const bench = await scene8('seam-3');
    // Three items whose receipts are kept: the head's waits run out one after another (6, 7 and 8 s), each unknown is shown to the model, the stop of each proves its release.
    const items = [await sendX(bench, place(), {}, 1_000), await sendX(bench, place(), {}, 1_000), await sendX(bench, place(), {}, 1_000)];
    items.forEach(({ id }, index) => { bench.body.begin(id); bench.body.finish(id, { hold: true, outcome: index === 1 ? 'failed' : 'completed', hands: [{ do: 'place', goal: index === 1 ? 'failed' : 'done', status: index === 1 ? 'failed' : 'done', code: index === 1 ? 'unreachable' : undefined, motorOps: 1, events: index === 1 ? [] : placed(1) }], ...(index === 1 ? { failureType: 'unreachable' } : {}) }); });
    expect(await until(() => items.every(({ id }) => stateOf(bench, id) === 'released'), 40_000, 20)).toBe(true);
    expect(rowsOf(bench, 'unknown_notified')).toHaveLength(3);
    expect(items.every(({ id }) => bench.control().store.row(id)!.told)).toBe(true);
    // Late: the first result is a success, the second a failure, the third comes twice (its acknowledgement is lost).
    bench.body.release(items[0]!.id);
    bench.body.release(items[1]!.id);
    expect(await until(() => stateOf(bench, items[0]!.id) === 'corrected' && stateOf(bench, items[1]!.id) === 'corrected', 4_000)).toBe(true);
    bench.body.paused = true;
    bench.body.release(items[2]!.id);
    bench.body.poll({ loseAck: true });
    await bench.settle(60);
    bench.body.poll();
    await bench.settle(60);
    bench.body.paused = false;
    expect(stateOf(bench, items[2]!.id)).toBe('corrected');
    await bench.settle(100);
    expect(rowsOf(bench, 'corrected')).toHaveLength(3);
    const notes = bench.queue.notes().filter(line => line.includes('訂正'));
    expect(notes).toHaveLength(3);
    // A cleanup that fails (no answer in 5 s): the command is held for the operator; the stop's proof, late, still releases it and the hold stays; the result then corrects it.
    const hang = await sendX(bench, place(), {}, 1_000);
    bench.body.stopMode = 'late';
    bench.body.begin(hang.id);
    bench.body.finish(hang.id, { hold: true, hands: [{ do: 'place', goal: 'done', events: placed(1) }] });
    expect(await until(() => bench.control().store.holdOf(hang.id) === 'held', 20_000, 20)).toBe(true);
    expect(stateOf(bench, hang.id)).toBe('settled_unknown');
    expect(bench.control().motorBlocked(bench.run)?.id).toBe(hang.id);
    bench.body.answerStop();
    expect(await until(() => stateOf(bench, hang.id) === 'released', 4_000)).toBe(true);
    expect(bench.control().store.holdOf(hang.id)).toBe('held');
    bench.control().resolveHolds(bench.run, 'resume');
    expect(bench.control().store.holdOf(hang.id)).toBe('resumed');
    bench.body.release(hang.id);
    expect(await until(() => stateOf(bench, hang.id) === 'corrected', 4_000)).toBe(true);
    await bench.settle(100);
    // Nothing was sent again by anyone, the model was told each unknown once, each correction once.
    expect(bench.body.handed.filter(command => command.skill === 'act')).toHaveLength(4);
    expect(rowsOf(bench, 'unknown_notified')).toHaveLength(4);
    expect(rowsOf(bench, 'corrected')).toHaveLength(4);
    expect(new Set(rowsOf(bench, 'corrected').map(row => row.ids.command)).size).toBe(4);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('seam-4: a promise revised and then released while an act sent under its first definition is out; the result is booked on the revision it was sent with', SLOW, async () => {
    const bench = make({ scene: 'seam-4' });
    await bench.begin();
    bench.body.inventory = { oak_planks: 4 };
    await bench.planUpdate('約束', { ops: [promise('planks', 4, '作業台')] });
    await bench.spin(2);
    expect(bench.plan.tree().promises[0]).toMatchObject({ id: 1, rev: 1, item: 'planks' });
    // The act says it is for the promise (rev 1: planks 4); before its result the model writes it again (rev 2, another item and count).
    const craft = await sendX(bench, [{ do: 'craft', item: 'crafting_table' }], { uses: [1] });
    expect(bench.control().store.row(craft.id)!.uses).toEqual([{ id: 1, rev: 1, item: 'planks', count: 4, use: '作業台' }]);
    bench.body.begin(craft.id);
    expect((await bench.planUpdate('約束を直す', { ops: [promise('cobblestone', 8, '家', { id: 1 })] })).ok).toBe(true);
    expect(bench.plan.tree().promises[0]).toMatchObject({ id: 1, rev: 2, item: 'cobblestone', count: 8 });
    bench.marks.injections.push({ kind: 'old_rev_result', at: iso(), command: craft.id, rev: 1 });
    bench.body.finish(craft.id, { hands: [{ do: 'craft', goal: 'done', events: [{ item: 'oak_planks', count: -4, reason: 'ingredient' }, { item: 'crafting_table', count: 1, reason: 'crafted' }] }] });
    expect(await until(() => rowsOf(bench, 'ledger').some(row => row.ids.command === craft.id))).toBe(true);
    await bench.settle(60);
    const lines = bench.plan.tree().promises[0]!.ledger;
    expect(lines.filter(line => line.kind === 'consumed')).toEqual([expect.objectContaining({ count: 4, declared: true, promiseRev: 1, item: 'planks', reason: 'craft_ingredient' })]);
    expect(bench.plan.tree().promises[0]!.rev).toBe(2);
    // The promise is released, and an act sent before that comes back after: nothing is put to a promise that is closed, and nothing breaks.
    bench.body.inventory = { cobblestone: 10, crafting_table: 1 };
    const later = await sendX(bench, place(), { uses: [1] });
    bench.body.begin(later.id);
    expect((await bench.planUpdate('約束を外す', { ops: [{ op: 'release', id: 1, why: '要らない' }] })).ok).toBe(true);
    bench.body.finish(later.id, { hands: [{ do: 'place', goal: 'done', events: placed(2) }] });
    await bench.settle(200);
    expect(stateOf(bench, later.id)).toBe('settled_known');
    expect(bench.plan.tree().promises[0]).toMatchObject({ state: 'closed', closedBy: 'released' });
    expect(bench.plan.tree().promises[0]!.ledger.filter(line => line.kind === 'consumed')).toHaveLength(1);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('seam-5: a reflex\'s meal outside any act, a hand cut by the reflex that ate, the passes of a repeat, the middle materials of a make: every event once, the pack and the ledger agree', SLOW, async () => {
    const bench = make({ scene: 'seam-5' });
    await bench.begin();
    bench.body.inventory = { oak_log: 3, bread: 4, cobblestone: 20 };
    await bench.planUpdate('約束', { ops: [promise('planks', 2, 'はしご'), promise('food', 10, '非常食'), promise('cobblestone', 8, '家')] });
    await bench.spin(2);
    // 1. a reflex eats while no act runs (its own event, by its own id).
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    await bench.spin(3);
    expect(await until(() => rowsOf(bench, 'ledger').length >= 1)).toBe(true);
    // 2. an act whose hand is cut by the reflex that ate (the meal is the reflex's event, once; the hand's own line says it was cut).
    const cut = await sendX(bench, place());
    bench.body.begin(cut.id);
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    await bench.spin(3);
    bench.body.finish(cut.id, { outcome: 'cancelled', hands: [{ do: 'place', status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'reflex', motorOps: 2, events: placed(1) }], unit: { goal: 'partial', end: 'cut' } });
    expect(await until(() => stateOf(bench, cut.id) === 'settled_known')).toBe(true);
    // 3. a repeat of three passes: each pass has its events under its own number.
    const repeat = await sendX(bench, [{ do: 'place', block: 'cobblestone', at: [{ x: 50, y: 64, z: 0 }] }], { repeat: 3 });
    bench.body.begin(repeat.id);
    bench.body.finish(repeat.id, { hands: [1, 2, 3].map(pass => ({ do: 'place', i: 1, goal: 'done' as const, pass, events: placed(1) })) });
    expect(await until(() => stateOf(bench, repeat.id) === 'settled_known')).toBe(true);
    // 4. a make: the planks and the sticks it made and used within the hand are the net of it.
    const make_ = fixture('promise/make-intermediate-and-reflex.json');
    const made = await sendX(bench, make_.input.act.hands);
    bench.body.begin(made.id);
    bench.body.finish(made.id, { hands: [{ do: 'make', goal: 'done', events: make_.input.events.map((event: { item: string; count: number; reason: never; intermediate?: boolean }) => ({ item: event.item, count: event.count, reason: event.reason, ...(event.intermediate ? { intermediate: true } : {}) })) }] });
    expect(await until(() => stateOf(bench, made.id) === 'settled_known')).toBe(true);
    await bench.settle(150);
    const ids = appliedIds(bench);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id.startsWith('reflex:'))).toHaveLength(2);
    expect(ids.filter(id => id.startsWith(`${repeat.id}:`))).toEqual([1, 2, 3].map(pass => `${repeat.id}:${pass}:1:1`));
    expect(bench.plan.tree().promises.find(item => item.item === 'planks')!.have).toBe(3);
    expect(bench.plan.tree().promises.flatMap(item => item.ledger).filter(line => line.kind === 'unexplained')).toEqual([]);
    const { verdict } = bench.judged();
    noted(verdict);
    expect(verdict.commands.linked).toBe(verdict.commands.judged);
    expect(verdict.pass, verdict.text).toBe(true);
  });
});

describe('what the bench C also shows (outside the judge\'s scenes)', () => {
  it('plan/migrate-v1-to-v2: a saved v1 tree is read by the head that starts and moved to v2 once; the next start reads it as it is', SLOW, async () => {
    const sample = fixture('plan/migrate-v1-to-v2.json');
    const bench = make({ scene: 'boundary-9', folder: 'boundary-9-migrate', goal: 'ダイヤまで', checkpoint: { fcaPlanTree: sample.input.v1 } });
    await bench.begin();
    const moved = bench.plan.tree();
    expect(moved.schema).toBe(sample.expected.v2.schema);
    expect(moved.revision).toBe(sample.expected.v2.revision);
    expect(Object.fromEntries(moved.nodes.map(node => [node.id, node.kind]))).toEqual(sample.expected.v2.kinds);
    expect(moved.nodes.find(node => node.id === 'p1')!.prep?.state).toBe(sample.expected.v2.prep.p1);
    expect(moved.promises).toEqual([]);
    expect(bench.head.lines.filter(line => line.includes('migrated'))).toHaveLength(1);
    bench.commit();
    await bench.restartHead();
    expect(bench.head.lines.filter(line => line.includes('migrated'))).toHaveLength(0);
    expect(bench.plan.tree()).toEqual(moved);
  });

  it('seam-5, one poll: a reflex\'s meal and the receipt of the act it cut arrive in one poll: every event is put once and `have` is the pack (what the head shows of the loss is printed)', SLOW, async () => {
    const bench = make({ scene: 'seam-5', folder: 'seam-5-one-poll' });
    await bench.begin();
    bench.body.inventory = { bread: 4, cobblestone: 20 };
    await bench.planUpdate('約束', { ops: [promise('cobblestone', 8, '家')] });
    await bench.spin(2);
    // a first meal, alone in its poll: the ledger knows the pack (cobblestone 20)
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    await bench.spin(3);
    expect(bench.plan.tree().promises[0]!.have).toBe(20);
    const cut = await send(bench, place());
    bench.body.begin(cut.id);
    bench.body.paused = true;
    bench.body.reflexEvent('bread', -1, 'reflex_eat');
    bench.body.finish(cut.id, { outcome: 'cancelled', hands: [{ do: 'place', status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'reflex', motorOps: 2, events: placed(1) }], unit: { goal: 'partial', end: 'cut' } });
    bench.body.poll();
    bench.body.paused = false;
    expect(await until(() => stateOf(bench, cut.id) === 'settled_known')).toBe(true);
    await bench.settle(100);
    const ids = appliedIds(bench);
    expect(new Set(ids).size).toBe(ids.length);
    expect(bench.plan.tree().promises[0]!.have).toBe(19);
    console.log('BENCH_C_NOTE seam-5-one-poll ledger kinds:', bench.plan.tree().promises[0]!.ledger.map(line => `${line.kind}:${line.count}:${line.reason ?? ''}`).join(' | '));
  });
});

describe('A-8 2 through the real tool: an act that would spend the promised says so once after the line of the queue (nothing refused)', () => {
  it('a smelt of 6 planks as fuel with 7 in the pack and a promise of 4: the answer of mc.act names the promise, the act is in the queue', SLOW, async () => {
    const bench = make({ scene: 'a8-breaking' });
    await bench.begin();
    expect((await bench.planUpdate('promise', { ops: [{ op: 'promise', item: 'planks', count: 4, use: '地下の作業台' }] })).ok).toBe(true);
    bench.body.inventory = { spruce_planks: 7, raw_iron: 6 };
    await bench.spin(3);
    const answer = await bench.actThroughTools({ hands: [{ do: 'smelt', items: [{ item: 'raw_iron', count: 6 }], fuel: 'spruce_planks', fuelCount: 6 }], why: '[p1] 鉄を焼く' });
    expect(answer.ok).toBe(true);
    const lines = answer.text.split(/\r?\n/u);
    expect(lines[0]).toMatch(/^列に入れた q[0-9]+/u);
    expect(lines).toContain('この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）');
    // the act went on: the line comes after the queue's, once, and the body was handed the command
    expect(lines.filter(line => line.startsWith('この act は約束'))).toHaveLength(1);
    expect(await until(() => bench.body.handed.length > 0)).toBe(true);
    // an act that spends only what is free says nothing
    const quiet = await bench.actThroughTools({ hands: [{ do: 'smelt', items: [{ item: 'raw_iron', count: 6 }], fuel: 'spruce_planks', fuelCount: 3 }], why: '[p1] もう一度' });
    expect(quiet.text).not.toContain('割る見込み');
  });
});
