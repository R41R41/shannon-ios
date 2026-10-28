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
    const a = act(1, { at: 10, hands: [{ do: 'fight', target: '#2601' }], endSecond: 20, starts: [{ second: 11 }], lines: lines ?? [{ i: 1, do: 'fight', status: 'done', goal: 'done', end: 'finished' }],
      handover: { from: 'floor-melee', target: 2601, waitedMs: 80, reflexSettledAt: t(10, 300), confirmed: true, shield: claim },
      ops: [{ kind: 'op', at: t(12), hand: 1, op: 'attack' }, { kind: 'op', at: t(16), hand: 1, op: 'consume' }] });
    const input = folder('boundary-4', [a], { injections: [{ kind: 'handover_case', case: 'same_target', command: 'q1', at: t(10), shieldUp: true, ...mark }] }, { trace: states });
    // the blows and her health come from the observation only (state.combat.recentHits, state.world.health): the same two blows are in two frames and are two; one is after the act
    const blow = (second: number, damage: number) => ({ at: t(second), attackerId: 2601, attackerType: 'zombie', damage, life: 1 });
    input.observations = [{ sequence: 1, stateAt: t(9), state: { world: { health: 11.3 }, life: { life: 1 }, combat: { recentHits: [] } } },
      { sequence: 2, stateAt: t(13), state: { world: { health: 9.1 }, life: { life: 1 }, combat: { recentHits: [blow(12, 2.2)] } } },
      { sequence: 3, stateAt: t(15), state: { world: { health: 7 }, life: { life: 1 }, combat: { recentHits: [blow(12, 2.2), blow(14, 2.1)] } } },
      { sequence: 4, stateAt: t(41), state: { world: { health: 3 }, life: { life: 1 }, combat: { recentHits: [blow(40, 4)] } } }];
    return input;
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
  it('A-6 9 CLOSED: the produced split delivery of the body holds the events (eventCount is a separate field): the pages go through the judge and the readers of the head, and with the first 120 of the receipt every id is booked', () => {
    const made = JSON.parse(readFileSync(join(fixtures.dir, 'produced', 'promise--events-split-delivery.json'), 'utf8')) as { output: { replies: ({ events: InventoryEvent[]; eventCount: number } & Record<string, unknown>)[] } };
    expect(made.output.replies.map(reply => Array.isArray(reply.events))).toEqual([true, true, true]);
    const rows = made.output.replies.map((reply, index): Row => ({ ev: 'events', at: t(index), ids: ids(70), ...reply }));
    const model = buildModel({ meta: { run: 'p', scene: 'seam-5', benches: ['A'], headRev: 'h', bodyRev: 'b' }, rows, receipts: [], trace: [], probes: [] }, fixtures);
    const replies = eventsReplies(model);
    expect(replies.map(reply => reply.events.length)).toEqual([120, 100, 120]);
    for (const reply of made.output.replies) {
      const { eventCount: _count, ...plain } = reply;
      expect(readEventsReply(JSON.stringify(plain))?.events.map(item => item.id)).toEqual(reply.events.map(item => item.id));   // the head reads the page as it is
    }
    // the receipt carries deliverySeq 0 to 119 (not in the file: made as the fixture says), the pages 120 to 339: every id once, in order, with a reason that fits
    const first = made.output.replies[0].events[0];
    const inline = range(0, nextSeq).map(item => ({ ...item, id: item.id.replace('1:1', '1:0') }));
    const a = act(70, { at: 10, hands: [], endSecond: 12, starts: [{ second: 11 }], lines: [{ i: 1, do: 'repeat', status: 'done', goal: 'done', end: 'finished', delta: inline } as never] });
    a.receipts[0].eventsMore = { command: 'skill:q70', nextSeq, total };
    const booked = [...inline, ...made.output.replies[0].events, ...made.output.replies[1].events].map(item => item.id);
    const whole = folder('seam-5', [a], {}, { rows: [...rows, { ev: 'ledger', at: t(20), ids: ids(70), applied: booked, have: {}, observed: {} }] });
    const verdict = judge(whole, fixtures);
    expect(verdict.measures.ledger).toMatchObject({ delivered: total, byVia: { receipt: nextSeq, page: 220 }, booked: total, notBooked: [], seqProblems: [], reasonProblems: [], silentLoss: [] });
    expect(first.id).toMatch(/^skill:q70:\d+:\d+:\d+$/u);
    // one id of the second page left unbooked is told
    const unbooked = folder('seam-5', [a], {}, { rows: [...rows, { ev: 'ledger', at: t(20), ids: ids(70), applied: booked.slice(0, -1), have: {}, observed: {} }] });
    expect(judge(unbooked, fixtures).measures.ledger.notBooked).toEqual([booked[booked.length - 1]]);
  });
});

describe('measures: the shield judged on the body\'s own rows (produced measure--handover-shield-up and measure--handover-last-stand)', () => {
  type Note = Record<string, unknown> & { command: string; at: string; point: string };
  const load = (name: string) => JSON.parse(readFileSync(join(fixtures.dir, 'produced', name), 'utf8')) as { output: Record<string, any> };
  /** One trial of the body's lab as the judge reads it: the act's receipt with its handover, the four rows of the shield, and the mark of the case. */
  function trial(notes: Note[], handover: Record<string, unknown>, outcome: string, unit: Record<string, unknown>, mark: Record<string, unknown>): Input {
    const command = notes[0].command, first = Date.parse(notes[0].at), last = Date.parse(notes[notes.length - 1].at);
    const at = (ms: number) => new Date(ms).toISOString();
    const receipt: ReceiptRecord = { id: command, outcome: outcome as never, unit: unit as never, handover: handover as never, lines: [{ i: 1, do: 'fight', status: 'done', goal: 'done', end: 'finished' }],
      bodyTimes: { acceptedAt: at(first - 30), startedAt: at(first - 2), lockAt: at(first), firstMotorAt: at(last), motorOps: 2, endedAt: at(last + 500) } };
    return { meta: { run: 'lab', scene: 'boundary-4', benches: ['B'], headRev: 'h', bodyRev: 'b', requireSent: false, requireDecision: false,
      injections: [{ kind: 'handover_case', case: 'same_target', command, at: at(first), ...mark }] }, rows: [], receipts: [receipt], probes: [],
    trace: [{ kind: 'trace_open', at: at(first - 100), source: 'continuous' } as TraceLine, ...notes.map(note => note as unknown as TraceLine)] };
  }
  const checkOf = (input: Input) => judge(input, fixtures).checks.find(item => item.id.startsWith('same_target'))!;

  it('the six hand-overs of the lab with the shield up: kept, and the body\'s rows show the shield up at all four points with no deactivateItem: every one a pass', () => {
    const { trials } = load('measure--handover-shield-up.json').output as { trials: { reflex: { shieldUp: boolean }; handover: Record<string, unknown>; notes: Record<string, Note>; outcome: string; unit: Record<string, unknown> }[] };
    expect(trials).toHaveLength(6);
    for (const [index, one] of trials.entries()) {
      const rows = [one.notes.reserve, one.notes.stop, one.notes.claim, one.notes.first_op];
      expect(rows.map(row => row.point), `trial ${index + 1}`).toEqual(['reservation', 'stop', 'acquire', 'first_op']);
      const input = trial(rows, one.handover, one.outcome, one.unit, { shieldUp: one.reflex.shieldUp });
      const verdict = judge(input, fixtures);
      const check = verdict.checks.find(item => item.id.startsWith('same_target'))!;
      expect(check.ok, `trial ${index + 1}: ${check.detail}`).toBe(true);
      expect(verdict.measures.shield[0]).toMatchObject({ claim: 'kept', record: 'up', verdict: 'kept_verified', stance: 'melee', shieldUpAtStart: true });
    }
  });
  it('the same rows with a deactivateItem counted since the reservation: the claim kept is not a pass', () => {
    const { trials } = load('measure--handover-shield-up.json').output as { trials: { reflex: { shieldUp: boolean }; handover: Record<string, unknown>; notes: Record<string, Note>; outcome: string; unit: Record<string, unknown> }[] };
    const one = trials[0], rows = [one.notes.reserve, one.notes.stop, { ...one.notes.claim, deactivatedSince: 1 }, { ...one.notes.first_op, deactivatedSince: 1 }];
    const check = checkOf(trial(rows, one.handover, one.outcome, one.unit, { shieldUp: true }));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('claim_mismatch');
    const lowered = [one.notes.reserve, { ...one.notes.stop, loweredSince: 1, shield: false }, { ...one.notes.claim, shield: false }, { ...one.notes.first_op, shield: false }];
    expect(checkOf(trial(lowered, { ...one.handover, shield: 'dropped' }, one.outcome, one.unit, { shieldUp: true })).detail).toContain('dropped_fact');
  });
  it('the last-stand hand-over: no shield in play, none and the rows agree; it is told as last stand', () => {
    const made = load('measure--handover-last-stand.json').output as { handover: Record<string, unknown>; notes: Note[]; outcome: string; unit: Record<string, unknown> };
    const input = trial(made.notes, made.handover, made.outcome, made.unit, { shieldUp: false });
    const verdict = judge(input, fixtures);
    expect(verdict.checks.find(item => item.id.startsWith('same_target'))?.ok).toBe(true);
    expect(verdict.measures.shield[0]).toMatchObject({ stance: 'last_stand', claim: 'none', record: 'down', verdict: 'none_consistent', group: 'last_stand/plain/no-shield' });
  });
  it('the blows and her health come from the observation only: no observation, no number (a hurt line is not read, and the hand start\'s hp is not borrowed)', () => {
    const made = load('measure--handover-last-stand.json').output as { handover: Record<string, unknown>; notes: Note[]; outcome: string; unit: Record<string, unknown> };
    const input = trial(made.notes, made.handover, made.outcome, made.unit, { shieldUp: false });
    input.trace.push({ kind: 'hurt', at: made.notes[0].at, hp: 3 } as unknown as TraceLine);
    expect(judge(input, fixtures).measures.shield[0]).toMatchObject({ hits: null, hpAtStart: null });
    input.observations = [{ sequence: 1, stateAt: new Date(Date.parse(made.notes[0].at) - 200).toISOString(), state: { world: { health: 14 }, combat: { recentHits: [] } } }];
    expect(judge(input, fixtures).measures.shield[0]).toMatchObject({ hits: 0, hpAtStart: 14 });
  });
});
