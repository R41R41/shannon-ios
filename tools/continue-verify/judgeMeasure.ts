/**
 * The measures the judge prints beside the verdict (amendment A-6 17; Codex's final review (5) 2, 3, 4): what a pass/fail cannot show. They are computed from the same joined model
 * and never change the verdict by themselves; the checks of `judgeChecks.ts` that need one of them (the shield, the ledger) call the same functions, so the number printed and the number
 * judged are one.
 *
 *  - `vertical`: for each long vertical move (a `vertical` hand, or a `go` whose target is `LONG_GO_HEIGHT` blocks or more above or below where it started): the choice (go or
 *    vertical), the height it reached, the steps moved (the feet's operations) and the steps valid (`progress.done`), why it stopped, the cells dug twice, and the seconds from the stop
 *    to the next effective operation of anyone.
 *  - `time`: for each command, its hands' time split into waiting (`wait` hands), a `go` that gained nothing, and the rest (the run's time that moved her); the share is told, so a run
 *    that is mostly standing still is not read as a run that was mostly acting.
 *  - `shield`: for each hand-over, what the body's RESULT says of the shield (`Handover.shield`) against what the body's OPERATION RECORD says of it (the shield's state at the
 *    reservation, the stop, the acquire and the first operation, and any `deactivateItem` between). A claim is not a pass.
 *  - `ledger`: the events the receipts and the pages delivered, by id and reason, against the ledger rows; the gaps of the delivery numbers; the commands whose events were told lost.
 *
 * The shield's lines are the body's own `motor_state` rows (see `TraceLine` in `judge.ts`). The blows and her health are NOT a record the body writes for this: they are read from the
 * observation (`state.combat.recentHits` and `state.world.health`), the one place the facts come from.
 */
import type { CommandView, ObservationLine, HandLineLike, Model, OpLine, Row, TraceLine } from './judge.js';
import { bodyTimesOf, cmdKey, linesOf, ms } from './judge.js';

/** A `go` that ends this many blocks above or below where it began is a long vertical move (a first value, a guess). */
export const LONG_GO_HEIGHT = 8;

// ---- vertical ---------------------------------------------------------------------------------------------------------------------------------------
export interface VerticalMeasure {
  command: string; hand: number; choice: 'go' | 'vertical';
  /** The model's own words for the move, when the command's arguments are in the record (`dir`, `shape`). */
  asked?: { dir?: string; shape?: string; toY?: number };
  fromY: number | null; targetY: number | null; reachedY: number | null;
  /** The steps the feet's operations moved (null: the continuous log has no feet for this command) and the steps still valid (`progress.done` of a step progress). */
  movedSteps: number | null; stepsValid: number | null;
  stop: { status: string | null; goal: string | null; end: string | null; code: string | null };
  /** The cells dug more than once in this hand (null: the digs carry no cell). */
  redug: number | null;
  /** From where the hand stopped to the next operation that acted, by anyone (null: none after it, or the stop has no time). */
  secondsToNextEffective: number | null;
}
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const effective = (op: OpLine): boolean => op.refused !== true && op.op !== 'place_held_back';
const allOps = (model: Model): OpLine[] => [...model.commands.values()].flatMap(command => command.ops).sort((left, right) => (ms(left.at) ?? 0) - (ms(right.at) ?? 0));

/** The hands the model asked for in a command (the sent row's `arguments.hands`), or []. */
function askedHands(command: CommandView): Record<string, unknown>[] {
  const args = command.sent[0]?.arguments as { hands?: unknown } | null | undefined;
  return Array.isArray(args?.hands) ? args!.hands as Record<string, unknown>[] : [];
}
/** Where a hand began and where its next one began (the hand starts are the record of it); the last hand ends with the command. */
function handSpan(command: CommandView, hand: number): { from?: { x: number; y: number; z: number }; startMs?: number; endMs?: number } {
  const starts = [...command.handStarts].sort((left, right) => (ms(left.at) ?? 0) - (ms(right.at) ?? 0));
  const index = starts.findIndex(start => start.ids.hand === hand);
  if (index < 0) return {};
  const times = bodyTimesOf(command);
  const endMs = ms(starts[index + 1]?.at) ?? ms(times?.endedAt) ?? ms(times?.failedAt);
  return { from: starts[index].pos, startMs: ms(starts[index].at), ...(endMs !== undefined ? { endMs } : {}) };
}

export function verticalMeasures(model: Model): VerticalMeasure[] {
  const out: VerticalMeasure[] = [], ops = allOps(model);
  for (const command of model.commands.values()) {
    const asked = askedHands(command), lines = linesOf(command);
    for (const line of lines) {
      if (line.do !== 'go' && line.do !== 'vertical') continue;
      const hand = asked[line.i - 1] ?? {}, span = handSpan(command, line.i);
      const toY = line.do === 'vertical' ? num(hand.toY) : num((hand.to as { y?: unknown } | undefined)?.y) ?? num((hand.goals as { y?: unknown }[] | undefined)?.[0]?.y);
      const fromY = span.from?.y ?? null;
      const reachedY = line.progress?.at?.y ?? (line === lines[lines.length - 1] ? resultAt(command)?.y ?? null : null);
      const long = line.do === 'vertical' || (toY !== undefined && fromY !== null && Math.abs(toY - fromY) >= LONG_GO_HEIGHT);
      if (!long) continue;
      const mine = command.ops.filter(op => op.hand === line.i || op.hand === undefined);
      const feet = mine.filter(op => op.op === 'foot' && op.from && op.to && Math.abs(op.to[1] - op.from[1]) === 1);
      const digs = mine.filter(op => op.op === 'dig');
      const cells = digs.map(op => (op.pos ? op.pos.join(',') : null));
      const stoppedAt = line.status === 'stopped' || line.goal === 'partial' || line.goal === 'failed' ? span.endMs : undefined;
      const next = stoppedAt === undefined ? undefined : ops.find(op => effective(op) && (ms(op.at) ?? 0) > stoppedAt);
      out.push({ command: command.id, hand: line.i, choice: line.do,
        asked: { ...(typeof hand.dir === 'string' ? { dir: hand.dir } : {}), ...(typeof hand.shape === 'string' ? { shape: hand.shape } : {}), ...(toY !== undefined ? { toY } : {}) },
        fromY, targetY: toY ?? null, reachedY,
        movedSteps: command.ops.some(op => op.op === 'foot') ? feet.length : null,
        stepsValid: line.progress && 'unit' in line.progress && (line.progress as { unit?: string }).unit === 'step' ? num(line.progress.done) ?? null : null,
        stop: { status: line.status ?? null, goal: line.goal ?? null, end: line.end ?? null, code: line.code ?? null },
        redug: digs.length === 0 ? 0 : cells.includes(null) ? null : cells.length - new Set(cells).size,
        secondsToNextEffective: next && stoppedAt !== undefined ? Math.round(((ms(next.at) ?? 0) - stoppedAt) / 100) / 10 : null });
    }
  }
  return out;
}
function resultAt(command: CommandView): { x: number; y: number; z: number } | undefined {
  const last = command.receipts[command.receipts.length - 1];
  try { return (JSON.parse(last?.result ?? 'null') as { at?: { x: number; y: number; z: number } } | null)?.at; } catch { return undefined; }
}

// ---- time ------------------------------------------------------------------------------------------------------------------------------------------
export interface TimeSplit { command: string; totalMs: number; waitMs: number; idleGoMs: number; effectiveMs: number; effectiveShare: number }
/** A go that gained nothing: it did not finish its goal and moved no metre (`progress.done` 0 or none). */
const idleGo = (line: HandLineLike): boolean => line.do === 'go' && line.goal !== 'done' && line.goal !== 'already' && (num(line.progress?.done) ?? 0) === 0;

export function timeSplits(model: Model): TimeSplit[] {
  const out: TimeSplit[] = [];
  for (const command of model.commands.values()) {
    const lines = linesOf(command);
    let wait = 0, idle = 0, total = 0, any = false;
    for (const line of lines) {
      const span = handSpan(command, line.i);
      if (span.startMs === undefined || span.endMs === undefined || span.endMs < span.startMs) continue;
      any = true;
      const length = span.endMs - span.startMs;
      total += length;
      if (line.do === 'wait') wait += length; else if (idleGo(line)) idle += length;
    }
    if (any) out.push({ command: command.id, totalMs: total, waitMs: wait, idleGoMs: idle, effectiveMs: total - wait - idle, effectiveShare: total > 0 ? Math.round((total - wait - idle) / total * 100) / 100 : 0 });
  }
  return out;
}

// ---- the shield ------------------------------------------------------------------------------------------------------------------------------------
export interface ShieldPoint { point: string; at: string; up: boolean | null; deactivateItem: boolean | null; /** The shield was lowered, or deactivateItem was called, since the reservation (the body's counters). */ lowered: boolean }
export type ShieldRecord = 'absent' | 'up' | 'interrupted' | 'down';
export type ShieldVerdict = 'kept_verified' | 'none_consistent' | 'dropped_fact' | 'claim_mismatch' | 'not_judgeable';
export interface ShieldMeasure {
  command: string; case: string;
  /** melee | last_stand (from the mark, else from the reflex's name), the plain act or one that began with a hand already done, a shield up at the start or not. */
  stance: string | null; preface: 'already' | null; shieldUpAtStart: boolean | null;
  claim: string | null; record: ShieldRecord; points: ShieldPoint[]; verdict: ShieldVerdict; why: string;
  hits: number | null; hpAtStart: number | null; firstEatAt: string | null; secondsToEat: number | null;
  /** melee/last_stand + preface + shield, the way the measures are grouped. */
  group: string;
}
const POINTS = ['reservation', 'stop', 'acquire', 'first_op'];
type MotorState = Extract<TraceLine, { kind: 'motor_state' }>;

/**
 * What the operation record says of the shield between the reservation and the first operation of a command: `absent` (no line says), `up` (it was up at every point that says,
 * and nothing let it go), `interrupted` (it was up and was let go: a `deactivateItem`, or a point where it was down after one where it was up), `down` (never up).
 */
export function shieldRecord(model: Model, command: CommandView): { record: ShieldRecord; points: ShieldPoint[] } {
  const times = bodyTimesOf(command), from = ms(times?.acceptedAt) ?? ms(times?.startedAt) ?? -Infinity;
  const to = (ms(times?.firstMotorAt) ?? ms(times?.lockAt) ?? ms(times?.endedAt) ?? Infinity) + 500;
  const lines = model.trace.filter((line): line is MotorState => line.kind === 'motor_state' && cmdKey(line.command) === command.id && (line.shield !== undefined || line.deactivateItem !== undefined)
    && (ms(line.at) ?? 0) >= from - 1_000 && (ms(line.at) ?? 0) <= to)
    .sort((left, right) => (ms(left.at) ?? 0) - (ms(right.at) ?? 0));
  const points = lines.map((line): ShieldPoint => ({ point: line.point ?? 'state', at: line.at, up: typeof line.shield === 'boolean' ? line.shield : null, deactivateItem: typeof line.deactivateItem === 'boolean' ? line.deactivateItem : null,
    lowered: (num(line.loweredSince) ?? 0) > 0 || (num(line.deactivatedSince) ?? 0) > 0 }));
  if (points.length === 0) return { record: 'absent', points };
  let seenUp = false, let_go = false;
  for (const point of points) {
    if (point.up === true) seenUp = true;
    if (seenUp && (point.up === false || point.deactivateItem === true || point.lowered)) let_go = true;
  }
  return { record: !seenUp ? 'down' : let_go ? 'interrupted' : 'up', points };
}

export function shieldMeasures(model: Model): ShieldMeasure[] {
  const out: ShieldMeasure[] = [];
  for (const mark of (model.meta.injections ?? []).filter(item => item.kind === 'handover_case' && item.case === 'same_target')) {
    const command = commandOf(model, String(mark.command)), receipt = command?.receipts[command.receipts.length - 1];
    if (!command || !receipt) continue;
    const handover = receipt.handover, claim = handover?.shield ?? null;
    const { record, points } = shieldRecord(model, command);
    const reflexName = String(handover?.from ?? '');
    const stance = typeof mark.stance === 'string' ? mark.stance : /last/u.test(reflexName) ? 'last_stand' : reflexName ? 'melee' : null;
    const lines = linesOf(command), preface = lines.length > 1 && lines[0].goal === 'already' ? 'already' as const : null;
    const reserved = points.find(point => point.point === 'reservation')?.up;
    const shieldUpAtStart = typeof mark.shieldUp === 'boolean' ? mark.shieldUp : typeof reserved === 'boolean' ? reserved : null;
    const times = bodyTimesOf(command), accepted = ms(times?.acceptedAt) ?? -Infinity, ended = ms(times?.endedAt) ?? Infinity;
    const seen = blowsAndHealth(model.observations ?? [], accepted, ended, command.handStarts[0]?.ids.life ?? command.ops[0]?.life);
    const eat = command.ops.find(op => (op.op === 'consume' || op.op === 'eat') && effective(op));
    const verdict = judgeShield(claim, record, shieldUpAtStart, handover?.confirmed === true);
    out.push({ command: command.id, case: String(mark.case), stance, preface, shieldUpAtStart, claim, record, points, ...verdict,
      hits: seen.hits, hpAtStart: seen.hpAtStart, firstEatAt: eat?.at ?? null,
      secondsToEat: eat ? Math.round(((ms(eat.at) ?? 0) - accepted) / 100) / 10 : null,
      group: `${stance ?? 'unknown'}/${preface ? 'already-first' : 'plain'}/${shieldUpAtStart === true ? 'shield' : shieldUpAtStart === false ? 'no-shield' : 'shield?'}` });
  }
  return out;
}
const commandOf = (model: Model, name: string): CommandView | undefined => model.commands.get(cmdKey(name)) ?? [...model.commands.values()].find(command => command.item === name.replace(/^skill:/u, ''));

/**
 * The blows taken while the hand-over's command ran and her health when it was accepted, both from the observation the head read: `state.combat.recentHits`
 * ({at, attackerId, attackerType, damage, life}; the same blow is in many frames, so it is counted once) and `state.world.health` of the last frame at or before the acceptance.
 * Null when the folder has no observations: they are never taken from another record.
 */
export function blowsAndHealth(frames: readonly ObservationLine[], accepted: number, ended: number, life?: number): { hits: number | null; hpAtStart: number | null } {
  if (frames.length === 0) return { hits: null, hpAtStart: null };
  const seen = new Set<string>();
  for (const frame of frames) {
    const hits = (frame.state?.combat as { recentHits?: unknown[] } | undefined)?.recentHits;
    if (!Array.isArray(hits)) continue;
    for (const hit of hits as { at?: unknown; attackerId?: unknown; attackerType?: unknown; damage?: unknown; life?: unknown }[]) {
      const at = typeof hit.at === 'string' ? Date.parse(hit.at) : num(hit.at);
      if (at === undefined || Number.isNaN(at) || at < accepted || at > ended) continue;
      if (life !== undefined && typeof hit.life === 'number' && hit.life !== life) continue;
      seen.add(`${at}|${String(hit.attackerId)}|${String(hit.attackerType)}|${String(hit.damage)}`);
    }
  }
  const before = [...frames].filter(frame => (ms(frame.stateAt) ?? Infinity) <= accepted).sort((left, right) => (ms(left.stateAt) ?? 0) - (ms(right.stateAt) ?? 0)).pop();
  const health = num((before?.state?.world as { health?: unknown } | undefined)?.health);
  return { hits: frames.some(frame => Array.isArray((frame.state?.combat as { recentHits?: unknown } | undefined)?.recentHits)) ? seen.size : null, hpAtStart: health ?? null };
}

/** The claim of the result against the record of the operations. A `kept` that the record cannot show, or that the record contradicts, is no pass. */
export function judgeShield(claim: string | null, record: ShieldRecord, shieldUpAtStart: boolean | null, confirmed: boolean): { verdict: ShieldVerdict; why: string } {
  if (!confirmed) return { verdict: 'claim_mismatch', why: 'the hand-over was not confirmed' };
  if (claim === 'kept') {
    if (record === 'absent') return { verdict: 'not_judgeable', why: 'the result says kept; the operation record has no shield state for this command (a claim is not a pass)' };
    return record === 'up' ? { verdict: 'kept_verified', why: 'kept, and the record shows the shield up at every point with no deactivateItem' }
      : { verdict: 'claim_mismatch', why: `the result says kept; the record says ${record}` };
  }
  if (claim === 'dropped' || claim === 'lowered') {
    if (record === 'absent') return { verdict: 'not_judgeable', why: `the result says ${claim}; the record has no shield state to show it` };
    return record === 'interrupted' || record === 'down' ? { verdict: 'dropped_fact', why: `the result says ${claim} and the record shows it (${record}): told as a fact; the shield did not stay up` }
      : { verdict: 'claim_mismatch', why: `the result says ${claim}; the record says the shield stayed up` };
  }
  if (claim === 'none') {
    if (shieldUpAtStart === true) return { verdict: 'claim_mismatch', why: 'the result says none; the shield was up at the reservation' };
    return record === 'up' || record === 'interrupted' ? { verdict: 'claim_mismatch', why: `the result says none; the record has the shield ${record}` }
      : { verdict: 'none_consistent', why: 'no shield was in play, and the record shows none' };
  }
  return { verdict: 'not_judgeable', why: 'the result carries no handover.shield' };
}

// ---- the ledger: events delivered, by id and reason -------------------------------------------------------------------------------------------------
export interface DeliveredEvent { id: string; command: string; item: string; count: number; reason: string; deliverySeq?: number; via: 'receipt' | 'earlier' | 'page' }
export interface LedgerMeasure {
  delivered: number; byVia: Record<string, number>; booked: number; notBooked: string[];
  /** Commands whose delivery numbers are not 0..n-1 (a gap or a repeat), with what was found, unless the events were told lost. */
  seqProblems: { command: string; got: number[]; total: number | null }[];
  /** Events whose reason cannot have the sign of their count (a pick-up that took items away). */
  reasonProblems: string[];
  /** Commands whose events the body told lost (an `events` reply with `lost`, or `eventsMore.lost`). */
  lost: string[];
  /** Commands whose receipt said some events were fetched separately and for which not all arrived and no loss was told. */
  silentLoss: { command: string; arrived: number; total: number }[];
  /** A reason the ledger row carries that is not the delivered one. */
  reasonMismatch: string[];
}
const GAINS = new Set(['crafted', 'picked', 'mined', 'smelted', 'retrieved']);
const LOSSES = new Set(['ingredient', 'fuel', 'food', 'placed', 'thrown', 'tool_broke', 'reflex_eat', 'reflex_armor', 'stored']);
const isEvent = (value: unknown): value is { id: string; item: string; count: number; reason: string; deliverySeq?: number } =>
  !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { count?: unknown }).count === 'number' && typeof (value as { reason?: unknown }).reason === 'string';

/** The replies of the body's `events` command in the folder: from the head's `events` rows, and from the receipts of events commands (their `result` is the reply's JSON). */
export function eventsReplies(model: Model): { command: string; lost: boolean; total: number | null; events: unknown[]; from: number | null }[] {
  const out: { command: string; lost: boolean; total: number | null; events: unknown[]; from: number | null }[] = [];
  const push = (reply: { command?: unknown; lost?: unknown; total?: unknown; events?: unknown; from?: unknown } | null) => {
    if (reply && typeof reply.command === 'string' && Array.isArray(reply.events)) out.push({ command: cmdKey(reply.command), lost: reply.lost === true, total: num(reply.total) ?? null, events: reply.events, from: num(reply.from) ?? null });
  };
  for (const row of model.rows) {
    if (row.ev === 'events' && typeof row.command === 'string') push(row as unknown as { command: string; events: unknown[] });
    else if (row.ev === 'events' && row.ids?.command && Array.isArray(row.events)) push({ ...row, command: row.ids.command });
    if (row.ev === 'received') {
      try { push(JSON.parse(String((row.receipt as { result?: unknown } | undefined)?.result ?? 'null')) as never); } catch { /* not a reply */ }
    }
    if (row.ev === 'events' && row.lost === true && row.ids?.command && !Array.isArray(row.events)) out.push({ command: cmdKey(row.ids.command), lost: true, total: null, events: [], from: null });
  }
  return out;
}

/** The parts of an act's result the ledger measure reads (null when the receipt has none or it is not JSON). */
function resultOf(text: string | undefined): { earlierEvents?: unknown[]; eventsMore?: { total?: number; lost?: boolean } } | null {
  try { return JSON.parse(text ?? 'null') as { earlierEvents?: unknown[]; eventsMore?: { total?: number; lost?: boolean } } | null; } catch { return null; }
}

export function ledgerMeasure(model: Model, ledger: { applied?: string[]; events?: { id: string; reason?: string }[] }[]): { measure: LedgerMeasure; events: DeliveredEvent[] } {
  const events: DeliveredEvent[] = [];
  const seen = new Set<string>();
  const add = (event: DeliveredEvent) => { const key = `${event.command}|${event.id}`; if (!seen.has(key)) { seen.add(key); events.push(event); } };
  const moreOf = new Map<string, number>();
  for (const command of model.commands.values()) {
    const last = command.receipts[command.receipts.length - 1];
    const result = resultOf(last?.result);
    for (const line of linesOf(command)) for (const event of (line as { delta?: unknown[] }).delta ?? []) if (isEvent(event)) add({ ...event, command: command.id, via: 'receipt' });
    for (const event of result?.earlierEvents ?? []) if (isEvent(event)) add({ ...event, command: command.id, via: 'earlier' });
    const more = (last as { eventsMore?: { total?: number } } | undefined)?.eventsMore ?? result?.eventsMore;
    if (more && typeof more.total === 'number') moreOf.set(command.id, more.total);
  }
  const lost = new Set<string>();
  for (const command of model.commands.values()) {
    const last = command.receipts[command.receipts.length - 1], more = (last as { eventsMore?: { lost?: boolean } } | undefined)?.eventsMore;
    const result = resultOf(last?.result);
    if (more?.lost === true || result?.eventsMore?.lost === true) lost.add(command.id);
  }
  for (const reply of eventsReplies(model)) {
    if (reply.lost) lost.add(reply.command);
    for (const event of reply.events) if (isEvent(event)) add({ ...event, command: reply.command, via: 'page' });
  }
  const applied = new Set(ledger.flatMap(row => row.applied ?? []));
  const byVia: Record<string, number> = {};
  for (const event of events) byVia[event.via] = (byVia[event.via] ?? 0) + 1;
  const seqProblems: LedgerMeasure['seqProblems'] = [], silentLoss: LedgerMeasure['silentLoss'] = [];
  for (const command of new Set(events.map(event => event.command))) {
    const got = events.filter(event => event.command === command).flatMap(event => (event.deliverySeq === undefined ? [] : [event.deliverySeq])).sort((a, b) => a - b);
    const total = moreOf.get(command) ?? null;
    if (!lost.has(command) && got.length && got.some((seq, index) => seq !== index)) seqProblems.push({ command, got: got.slice(0, 12), total });
  }
  for (const [command, total] of moreOf) {
    // an event the ledger booked arrived, whether or not the folder holds the page it came on (the ids are `<command>:<pass>:<hand>:<n>`)
    const arrived = new Set([...events.filter(event => event.command === command).map(event => event.id), ...[...applied].filter(id => id.startsWith(`${command}:`))]).size;
    if (!lost.has(command) && arrived < total) silentLoss.push({ command, arrived, total });
  }
  const reasonProblems = events.filter(event => (GAINS.has(event.reason) && event.count < 0) || (LOSSES.has(event.reason) && event.count > 0)).map(event => `${event.id}: ${event.reason} ${event.count > 0 ? '+' : ''}${event.count}`);
  const booked = new Map(ledger.flatMap(row => row.events ?? []).map(entry => [entry.id, entry.reason] as const));
  const reasonMismatch = events.filter(event => booked.has(event.id) && booked.get(event.id) !== undefined && booked.get(event.id) !== event.reason).map(event => `${event.id}: delivered ${event.reason}, booked ${booked.get(event.id)}`);
  return { events, measure: { delivered: events.length, byVia, booked: events.filter(event => applied.has(event.id)).length, notBooked: events.filter(event => !applied.has(event.id)).map(event => event.id).slice(0, 12),
    seqProblems, reasonProblems, lost: [...lost], silentLoss, reasonMismatch } };
}
export const ledgerRowsOf = (model: Model) => model.rows.filter((row: Row) => row.ev === 'ledger') as unknown as { applied?: string[]; events?: { id: string; reason?: string }[] }[];

// ---- all of it, and how it reads --------------------------------------------------------------------------------------------------------------------
export interface Measures { vertical: VerticalMeasure[]; time: TimeSplit[]; shield: ShieldMeasure[]; ledger: LedgerMeasure }
export const measureAll = (model: Model): Measures => ({ vertical: verticalMeasures(model), time: timeSplits(model), shield: shieldMeasures(model), ledger: ledgerMeasure(model, ledgerRowsOf(model)).measure });

export function measureText(measures: Measures): string[] {
  const lines: string[] = [];
  const secs = (value: number | null) => (value === null ? '-' : `${value}s`);
  for (const move of measures.vertical) {
    lines.push(`  測り 縦 ${move.command} 手${move.hand} ${move.choice}${move.asked?.shape ? ` ${move.asked.shape}` : ''}${move.asked?.dir ? ` ${move.asked.dir}` : ''}: y ${move.fromY ?? '?'} -> 目標 ${move.targetY ?? '?'} 届いた ${move.reachedY ?? '?'}`
      + `・動いた段 ${move.movedSteps ?? '-'}・有効な段 ${move.stepsValid ?? '-'}・止まり ${move.stop.status ?? '-'}/${move.stop.code ?? '-'}・同じ所の掘り直し ${move.redug ?? '-'}・次の有効な操作まで ${secs(move.secondsToNextEffective)}`);
  }
  for (const split of measures.time) {
    lines.push(`  測り 時間 ${split.command}: 計 ${split.totalMs} ms・wait ${split.waitMs}・成果の無い go ${split.idleGoMs}・動けた ${split.effectiveMs}（${Math.round(split.effectiveShare * 100)}%）`);
  }
  for (const shield of measures.shield) {
    lines.push(`  測り 盾 ${shield.command} [${shield.group}]: 申告 ${shield.claim ?? '-'}・操作の記録 ${shield.record}（${shield.points.map(point => `${point.point}:${point.up === null ? '?' : point.up ? '上' : '下'}${point.deactivateItem || point.lowered ? '+deactivate' : ''}`).join(' ') || '行なし'}）`
      + `→ ${shield.verdict}（${shield.why}）・被弾 ${shield.hits ?? '-'}・HP ${shield.hpAtStart ?? '-'}・食事の始まり ${secs(shield.secondsToEat)}`);
  }
  const ledger = measures.ledger;
  if (ledger.delivered > 0 || ledger.lost.length > 0) {
    lines.push(`  測り 帳簿: 届いた出来事 ${ledger.delivered}（${Object.entries(ledger.byVia).map(([via, count]) => `${via} ${count}`).join('・') || '-'}）・帳簿に入った ${ledger.booked}・入らない ${ledger.notBooked.length}・番号の欠け ${ledger.seqProblems.length}・理由の符号の誤り ${ledger.reasonProblems.length}・lost ${ledger.lost.length}・黙って足りない ${ledger.silentLoss.length}`);
  }
  return lines;
}
