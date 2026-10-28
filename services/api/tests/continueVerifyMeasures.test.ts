import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InventoryEvent } from '../src/contracts/continueContract.js';
import { readEventsReply, eventsOfReceipt } from '../src/surfaces/minecraft/minecraftControlEvents.js';
import { buildModel, judge, loadFixtures, type HandLineLike, type Input, type ReceiptRecord, type Row, type TraceLine } from '../../../tools/continue-verify/judge.js';
import { eventsReplies, judgeShield, ledgerMeasure, measureAll } from '../../../tools/continue-verify/judgeMeasure.js';

/**
 * The measures beside the verdict (amendment A-6 17, Codex's final review (5) 2 to 4): the long vertical moves, the time split, the shield against the operation record, the events
 * delivered against the ledger. Every record here is hand-made from the contract's fixtures; none is a real run.
 */
const fixtures = loadFixtures();
const RUN = 'm1';
const t = (second: number, milli = 0) => new Date(Date.UTC(2026, 9, 29, 6, 0, second, milli)).toISOString();
const obs = { obsSeq: 1, obsAt: t(0) };
const ids = (n: number, extra: Record<string, unknown> = {}) => ({ run: RUN, command: `skill:q${n}`, item: `q${n}`, life: 1, ...obs, ...extra });

interface Act { rows: Row[]; receipts: ReceiptRecord[]; trace: TraceLine[] }
/** An act the head sent and the body ran: its hands (`arguments`), the lines of the result, the hand starts (one per hand, at the offsets given), the times of the receipt. */
function act(n: number, opts: { at: number; hands: Record<string, unknown>[]; lines: HandLineLike[]; starts: { second: number; y?: number; hp?: number }[]; endSecond: number; handover?: ReceiptRecord['handover']; ops?: Record<string, unknown>[] }): Act {
  const id = `skill:q${n}`;
  return {
    rows: [{ ev: 'sent', at: t(opts.at), ids: ids(n), arguments: { hands: opts.hands }, queue: { item: `q${n}` } }],
    receipts: [{ id, outcome: 'completed', ids: ids(n), unit: { goal: 'done', end: 'finished', released: true, startedAt: t(opts.at, 100) }, lines: opts.lines, ...(opts.handover ? { handover: opts.handover } : {}),
      bodyTimes: { acceptedAt: t(opts.at), startedAt: t(opts.at, 100), lockAt: t(opts.at, 120), firstMotorAt: t(opts.at, 200), motorOps: 3, endedAt: t(opts.endSecond) } }],
    trace: [...opts.starts.map((start, index): TraceLine => ({ kind: 'hand_start', ids: ids(n, { hand: index + 1 }), at: t(start.second), pos: { x: 0, y: start.y ?? 64, z: 0 }, hp: start.hp ?? 20, food: 20, saturation: 5,
      inventory: '', holder: { kind: 'idle' }, lastOps: [] })), ...(opts.ops ?? []).map(op => ({ kind: 'op', command: id, life: 1, ...op }) as TraceLine)],
  };
}
const folder = (scene: string, parts: Act[], extra: Partial<Input['meta']> = {}, more: { trace?: TraceLine[]; rows?: Row[] } = {}): Input => ({
  meta: { run: RUN, scene, benches: ['A'], headRev: 'h', bodyRev: 'b', ...extra },
  rows: [...parts.flatMap(part => part.rows), ...(more.rows ?? [])], receipts: parts.flatMap(part => part.receipts),
  trace: [{ kind: 'trace_open', at: t(0), source: 'continuous' } as TraceLine, ...parts.flatMap(part => part.trace), ...(more.trace ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), probes: [] });

describe('measures: the long vertical moves', () => {
  const foot = (second: number, fromY: number) => ({ kind: 'op', at: t(second), hand: 1, op: 'foot', from: [0, fromY, 0], to: [0, fromY - 1, 0] });
  const dig = (second: number, y: number) => ({ kind: 'op', at: t(second), hand: 1, op: 'dig', pos: [0, y, 0] });
  const down = act(1, { at: 10, hands: [{ do: 'vertical', dir: 'down', shape: 'shaft', toY: 20 }, { do: 'go', to: { x: 3, y: 66, z: 0 } }], endSecond: 30,
    lines: [{ i: 1, do: 'vertical', status: 'stopped', goal: 'partial', end: 'finished', code: 'no_floor', progress: { done: 4, at: { x: 0, y: 60, z: 0 }, unit: 'step' } as never }, { i: 2, do: 'go', status: 'skipped', goal: 'not_started' }],
    starts: [{ second: 11, y: 64 }],                         // the skipped hand 2 never began, so the hand 1 ends with the command (30 s)
    ops: [foot(12, 64), foot(13, 63), foot(14, 62), foot(15, 61), dig(12, 63), dig(13, 62), dig(14, 62), dig(15, 61)] });
  const next = act(2, { at: 40, hands: [{ do: 'go', to: { x: 9, y: 60, z: 0 } }], endSecond: 45, lines: [{ i: 1, do: 'go', status: 'done', goal: 'done', end: 'finished', progress: { done: 9, unit: 'meter' } as never }],
    starts: [{ second: 41, y: 60 }], ops: [{ kind: 'op', at: t(42), hand: 1, op: 'setControlState' }] });

  it('tells the choice, the height reached, the steps moved and valid, why it stopped, the cells dug twice and the seconds to the next effective operation', () => {
    const verdict = judge(folder('boundary-2', [down, next]), fixtures);
    const move = verdict.measures.vertical.find(item => item.command === 'skill:q1')!;
    expect(move).toMatchObject({ hand: 1, choice: 'vertical', asked: { dir: 'down', shape: 'shaft', toY: 20 }, fromY: 64, targetY: 20, reachedY: 60, movedSteps: 4, stepsValid: 4,
      stop: { status: 'stopped', goal: 'partial', end: 'finished', code: 'no_floor' }, redug: 1 });
    expect(move.secondsToNextEffective).toBe(12);                         // it stopped when the command ended (30 s); the next operation that acted, anyone's, was at 42 s
    expect(verdict.text).toContain('測り 縦 skill:q1 手1 vertical shaft down');
    expect(verdict.text).toContain('同じ所の掘り直し 1');
    expect(JSON.parse(JSON.stringify(verdict)).measures.vertical[0].choice).toBe('vertical');
  });
  it('a short go is not a long vertical move; a go that climbs 8 blocks or more is, and its choice is told as go', () => {
    const short = act(3, { at: 10, hands: [{ do: 'go', to: { x: 5, y: 66, z: 0 } }], endSecond: 12, lines: [{ i: 1, do: 'go', status: 'done', goal: 'done', end: 'finished' }], starts: [{ second: 11, y: 64 }] });
    const climb = act(4, { at: 20, hands: [{ do: 'go', to: { x: 5, y: 80, z: 0 } }], endSecond: 24, lines: [{ i: 1, do: 'go', status: 'stopped', goal: 'partial', end: 'finished', code: 'search_timeout', progress: { done: 3, at: { x: 1, y: 66, z: 0 }, unit: 'meter' } as never }], starts: [{ second: 21, y: 64 }] });
    const moves = measureAll(buildModel(folder('boundary-2', [short, climb]), fixtures)).vertical;
    expect(moves.map(item => [item.command, item.choice, item.reachedY])).toEqual([['skill:q4', 'go', 66]]);
    expect(moves[0].movedSteps).toBeNull();                               // no foot operations in this log: not claimed
  });
  it('reads the body\'s produced result of a vertical shaft (its choice, why it stopped or that it did not) without any invented number', () => {
    const made = JSON.parse(readFileSync(join(fixtures.dir, 'produced', 'vertical--r45-hold5-shaft-down.json'), 'utf8')) as { output: { result: { lines: HandLineLike[] } } };
    const receipt: ReceiptRecord = { id: 'lab:q17', outcome: 'completed', lines: made.output.result.lines, unit: { goal: 'done', end: 'finished', released: true } };
    const [move] = measureAll(buildModel({ meta: { run: 'p', scene: 'boundary-2', benches: ['A'], headRev: 'h', bodyRev: 'b' }, rows: [], receipts: [receipt], trace: [], probes: [] }, fixtures)).vertical;
    expect(move).toMatchObject({ choice: 'vertical', reachedY: 84, stepsValid: 16, movedSteps: null, fromY: null, secondsToNextEffective: null });
    expect(move.stop.goal).toBe('done');
  });
});

describe('measures: the time of an act split into waiting, a go that gained nothing, and the rest', () => {
  it('separates a wait and a go that moved no metre from the time that moved her', () => {
    const slow = act(1, { at: 10, hands: [], endSecond: 40, starts: [{ second: 11 }, { second: 21 }, { second: 26 }, { second: 30 }],
      lines: [{ i: 1, do: 'wait', status: 'done', goal: 'done', end: 'finished' }, { i: 2, do: 'go', status: 'stopped', goal: 'failed', end: 'finished', code: 'no_path', progress: { done: 0, unit: 'meter' } as never },
        { i: 3, do: 'go', status: 'stopped', goal: 'partial', end: 'finished', progress: { done: 12, unit: 'meter' } as never }, { i: 4, do: 'dig', status: 'done', goal: 'done', end: 'finished' }] });
    const [split] = measureAll(buildModel(folder('boundary-2', [slow]), fixtures)).time;
    expect(split).toMatchObject({ command: 'skill:q1', totalMs: 29_000, waitMs: 10_000, idleGoMs: 5_000, effectiveMs: 14_000, effectiveShare: 0.48 });
    expect(judge(folder('boundary-2', [slow]), fixtures).text).toContain('wait 10000・成果の無い go 5000・動けた 14000（48%）');
  });
});

describe('measures: the shield against the operation record (a claim is not a pass)', () => {
  const state = (command: string, point: string, second: number, up: boolean, extra: Record<string, unknown> = {}): TraceLine => ({ kind: 'motor_state', at: t(second, 400), command, point, shield: up, ...extra }) as TraceLine;
  /** A hand-over onto the same target: the result's claim, the shield's states the body recorded, and the case's marks. */
  function handover(claim: 'kept' | 'dropped' | 'none' | 'lowered', states: TraceLine[], mark: Record<string, unknown> = {}, lines?: HandLineLike[]): Input {
    const a = act(1, { at: 10, hands: [{ do: 'fight', target: '#2601' }], endSecond: 20, starts: [{ second: 11, hp: 11.3 }], lines: lines ?? [{ i: 1, do: 'fight', status: 'done', goal: 'done', end: 'finished' }],
      handover: { from: 'floor-melee', target: 2601, waitedMs: 80, reflexSettledAt: t(10, 300), confirmed: true, shield: claim },
      ops: [{ kind: 'op', at: t(12), hand: 1, op: 'attack' }, { kind: 'op', at: t(16), hand: 1, op: 'consume' }] });
    return folder('boundary-4', [a], { injections: [{ kind: 'handover_case', case: 'same_target', command: 'q1', at: t(10), shieldUp: true, ...mark }] },
      { trace: [...states, { kind: 'hurt', at: t(12), hp: 9.1 }, { kind: 'hurt', at: t(14), hp: 7 }, { kind: 'hurt', at: t(40), hp: 3 }] });
  }
  const upAt = (): TraceLine[] => [state('skill:q1', 'reservation', 10, true), state('skill:q1', 'stop', 10, true), state('skill:q1', 'acquire', 10, true), state('skill:q1', 'first_op', 10, true)];
  const check = (input: Input) => judge(input, fixtures).checks.find(item => item.id === 'same_target q1')!;

  it('kept, and the record shows the shield up at the reservation, the stop, the acquire and the first operation with no deactivateItem: a pass, with the blows, the HP and the start of the meal', () => {
    const verdict = judge(handover('kept', upAt()), fixtures);
    expect(verdict.checks.find(item => item.id === 'same_target q1')?.ok, verdict.text).toBe(true);
    expect(verdict.measures.shield[0]).toMatchObject({ command: 'skill:q1', stance: 'melee', preface: null, shieldUpAtStart: true, claim: 'kept', record: 'up', verdict: 'kept_verified',
      hits: 2, hpAtStart: 11.3, group: 'melee/plain/shield' });
    expect(verdict.measures.shield[0].secondsToEat).toBe(6);
    expect(verdict.text).toContain('測り 盾 skill:q1 [melee/plain/shield]: 申告 kept・操作の記録 up');
    expect(verdict.text).toContain('被弾 2・HP 11.3・食事の始まり 6s');
  });
  it('kept said by the result and nothing in the operation record: not a pass (not judgeable)', () => {
    const case1 = check(handover('kept', []));
    expect(case1.ok).toBe(false);
    expect(case1.detail).toContain('not_judgeable');
  });
  it('kept said by the result and the record shows a deactivateItem, or a shield down, between the reservation and the first operation: not a pass', () => {
    const letGo = [...upAt().slice(0, 1), state('skill:q1', 'stop', 10, true, { deactivateItem: true }), ...upAt().slice(2)];
    expect(check(handover('kept', letGo)).detail).toContain('claim_mismatch');
    const down = [...upAt().slice(0, 2), state('skill:q1', 'acquire', 10, false), state('skill:q1', 'first_op', 10, false)];
    expect(check(handover('kept', down)).ok).toBe(false);
  });
  it('dropped (the new value) is told as a fact when the record shows it, and fails a hand-over that began with the shield up', () => {
    const letGo = [state('skill:q1', 'reservation', 10, true), state('skill:q1', 'stop', 10, true, { deactivateItem: true }), state('skill:q1', 'acquire', 10, false), state('skill:q1', 'first_op', 10, false)];
    const verdict = judge(handover('dropped', letGo), fixtures);
    expect(verdict.measures.shield[0]).toMatchObject({ claim: 'dropped', record: 'interrupted', verdict: 'dropped_fact' });
    expect(verdict.checks.find(item => item.id === 'same_target q1')?.ok).toBe(false);
    expect(verdict.text).toContain('dropped_fact');
    // dropped said while the record says the shield never let go: the claim is wrong
    expect(judgeShield('dropped', 'up', true, true).verdict).toBe('claim_mismatch');
  });
  it('no shield in play: none and no record is consistent; none while the record has a shield up is a mismatch', () => {
    expect(check(handover('none', [], { shieldUp: false })).ok).toBe(true);
    expect(check(handover('none', upAt(), { shieldUp: false })).ok).toBe(false);
  });
  it('last stand, a first hand already done, and a shield are told apart in the group', () => {
    const lines: HandLineLike[] = [{ i: 1, do: 'equip', status: 'done', goal: 'already', end: 'finished' }, { i: 2, do: 'fight', status: 'done', goal: 'done', end: 'finished' }];
    const input = handover('kept', upAt(), { stance: 'last_stand' }, lines);
    expect(judge(input, fixtures).measures.shield[0]).toMatchObject({ stance: 'last_stand', preface: 'already', group: 'last_stand/already-first/shield' });
  });
  it('the table of claims against records', () => {
    expect(judgeShield('kept', 'up', true, true).verdict).toBe('kept_verified');
    expect(judgeShield('kept', 'absent', true, true).verdict).toBe('not_judgeable');
    expect(judgeShield('kept', 'interrupted', true, true).verdict).toBe('claim_mismatch');
    expect(judgeShield('lowered', 'interrupted', true, true).verdict).toBe('dropped_fact');
    expect(judgeShield('none', 'absent', false, true).verdict).toBe('none_consistent');
    expect(judgeShield('kept', 'up', true, false).verdict).toBe('claim_mismatch');
  });
});

describe('measures: the events delivered against the ledger (a non-empty page, by id and reason)', () => {
  const split = JSON.parse(readFileSync(join(fixtures.dir, 'promise/events-split-delivery.json'), 'utf8')) as { input: { receipt: { eventsMore: { nextSeq: number; total: number } } } };
  const { nextSeq, total } = split.input.receipt.eventsMore;
  const event = (seq: number, over: Partial<InventoryEvent> = {}): InventoryEvent => ({ id: `skill:q70:1:1:${seq}`, obsSeq: 1, item: 'cobblestone', count: seq % 2 ? -1 : 1, reason: seq % 2 ? 'placed' : 'picked', deliverySeq: seq, ...over });
  const range = (from: number, to: number, over: (seq: number) => Partial<InventoryEvent> = () => ({})) => Array.from({ length: to - from }, (_, index) => event(from + index, over(from + index)));
  const page = (from: number, to: number, extra: Record<string, unknown> = {}) => ({ command: 'skill:q70', from, to, total, nextSeq: to, done: to === total, lost: false, events: range(from, to), ...extra });

  /** The act q70 (340 events: 120 in its receipt, the rest on pages), the ledger rows that booked `booked`, and the replies of the body's events command. */
  function delivery(opts: { pages?: unknown[]; booked?: number[]; eventsMore?: Record<string, unknown>; inline?: InventoryEvent[] } = {}): Input {
    const inline = opts.inline ?? range(0, nextSeq);
    const a = act(70, { at: 10, hands: [], endSecond: 12, starts: [{ second: 11 }], lines: [{ i: 1, do: 'craft', status: 'done', goal: 'done', end: 'finished', delta: inline } as never] });
    a.receipts[0].eventsMore = (opts.eventsMore ?? { command: 'skill:q70', nextSeq, total }) as never;
    const booked = opts.booked ?? Array.from({ length: total }, (_, seq) => seq);
    const rows: Row[] = [...(opts.pages ?? [page(nextSeq, 240), page(240, total)]).map((reply): Row => ({ ev: 'events', at: t(13), ids: ids(70), ...(reply as object) } as Row)),
      { ev: 'ledger', at: t(14), ids: ids(70), applied: booked.map(seq => event(seq).id), have: {}, observed: {} }];
    return folder('seam-5', [a], {}, { rows });
  }
  const check = (input: Input) => judge(input, fixtures).checks.find(item => item.id.startsWith('the events delivered are booked'))!;

  it('the 340 events of the fixture: 120 on the receipt, 220 on two non-empty pages, every id booked once, the delivery numbers 0 to 339', () => {
    const verdict = judge(delivery(), fixtures);
    expect(check(delivery()).ok, check(delivery()).detail).toBe(true);
    expect(verdict.measures.ledger).toMatchObject({ delivered: total, byVia: { receipt: nextSeq, page: total - nextSeq }, booked: total, notBooked: [], seqProblems: [], reasonProblems: [], lost: [], silentLoss: [] });
    expect(verdict.text).toContain('測り 帳簿: 届いた出来事 340');
  });
  it('the head\'s own readers take the same pages and the receipt\'s events', () => {
    const input = delivery(), model = buildModel(input, fixtures);
    for (const reply of eventsReplies(model)) {
      const read = readEventsReply(JSON.stringify(reply.command === 'skill:q70' ? page(reply.from ?? 0, (reply.from ?? 0) + reply.events.length) : {}));
      expect(read?.events.map(item => item.id)).toEqual((reply.events as InventoryEvent[]).map(item => item.id));
    }
    const carried = eventsOfReceipt({ result: JSON.stringify({ v: 1, ok: true, done: 1, of: 1, lines: [{ i: 1, do: 'craft', status: 'done', line: '', delta: range(0, nextSeq) }], at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20 }), eventsMore: { command: 'skill:q70', nextSeq, total } });
    expect(carried.events.map(item => item.id)).toEqual(range(0, nextSeq).map(item => item.id));
    expect(carried.more).toEqual({ command: 'skill:q70', nextSeq, total });
  });
  it('an event delivered and never booked, a page that never came and no loss told, and a hole in the delivery numbers each fail', () => {
    expect(check(delivery({ booked: Array.from({ length: total - 1 }, (_, seq) => seq) })).detail).toContain('skill:q70:1:1:339 was delivered and never booked');
    const missing = check(delivery({ pages: [page(nextSeq, 240)], booked: Array.from({ length: 240 }, (_, seq) => seq) }));
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('240 of 340 events arrived and no loss was told');
    const hole = check(delivery({ pages: [{ ...page(nextSeq, 240), events: range(nextSeq, 240).filter(item => item.deliverySeq !== 150) }, page(240, total)], booked: Array.from({ length: total }, (_, seq) => seq).filter(seq => seq !== 150) }));
    expect(hole.detail).toContain('delivery numbers');
  });
  it('a reason that cannot fit the count (a pick-up that took items away) fails; a reason the ledger row books differently fails', () => {
    const wrong = delivery({ pages: [page(nextSeq, 240), { ...page(240, total), events: range(240, total, seq => (seq === 300 ? { reason: 'picked', count: -4 } : {})) }] });
    expect(check(wrong).detail).toContain('skill:q70:1:1:300: picked -4');
    const input = delivery();
    (input.rows.find(row => row.ev === 'ledger') as unknown as { events: { id: string; reason: string }[] }).events = [{ id: event(5).id, reason: 'ingredient' }];
    expect(check(input).detail).toContain('delivered placed, booked ingredient');
  });
  it('the body told them lost: an events reply with lost, or an eventsMore that says lost on a receipt that came (A-6 6) - what cannot be delivered is not an unbooked event', () => {
    const lostReply = delivery({ pages: [{ command: 'skill:q70', from: 0, to: 0, total, nextSeq: 0, done: false, lost: true, events: [] }], booked: Array.from({ length: nextSeq }, (_, seq) => seq) });
    expect(check(lostReply).ok, check(lostReply).detail).toBe(true);
    expect(judge(lostReply, fixtures).measures.ledger.lost).toEqual(['skill:q70']);
    const explicit = delivery({ pages: [], eventsMore: { command: 'skill:q70', nextSeq, total, lost: true }, booked: Array.from({ length: nextSeq }, (_, seq) => seq) });
    expect(check(explicit).ok, check(explicit).detail).toBe(true);
    expect(ledgerMeasure(buildModel(explicit, fixtures), []).measure.lost).toEqual(['skill:q70']);
  });
  it('a lost reply is read as lost by b8-body-restart too, and a lost eventsMore on a receipt that did arrive', () => {
    const base = delivery({ pages: [], eventsMore: { command: 'skill:q70', nextSeq, total, lost: true }, booked: [] });
    const model = buildModel({ ...base, meta: { ...base.meta, scene: 'b8-body-restart' } }, fixtures);
    expect(ledgerMeasure(model, []).measure.lost).toContain('skill:q70');
  });
  it('KNOWN GAP OF THE BODY (A-6 9): the produced split delivery still puts a number where the events were, so there is no non-empty page to read; the pages above are made from the fixture', () => {
    const made = JSON.parse(readFileSync(join(fixtures.dir, 'produced', 'promise--events-split-delivery.json'), 'utf8')) as { output: { replies: { events: unknown }[] } };
    expect(made.output.replies.map(reply => typeof reply.events)).toEqual(['number', 'number', 'number']);   // when the body keeps the arrays this becomes 'object' and the line below is the test to write
    expect(eventsReplies(buildModel({ meta: { run: 'p', scene: 'seam-5', benches: ['A'], headRev: 'h', bodyRev: 'b' }, rows: made.output.replies.map((reply, index) => ({ ev: 'events', at: t(index), command: 'skill:q70', ...reply }) as Row), receipts: [], trace: [], probes: [] }, fixtures))).toEqual([]);
  });
});
