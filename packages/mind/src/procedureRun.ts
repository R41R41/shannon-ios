/**
 * Procedures run through by an executor (session mb-arch, owner 2026-10-20: 「30分でスムーズにネザーに行く」). The planner (the FCA
 * model) chooses which procedure to start and how far to go; the executor then runs it item by item with the body's own tools, reading
 * the world again before each item, until the procedure is done or something only the planner can settle comes up:
 *
 * - a reason from outside the procedure (`stopWhy`: danger, the night, a new message, a step that is late),
 * - nothing the rules can do (`stuck`: nothing in sight to take), or the same work failing again (`failed`),
 * - the run's own bounds (`limit`), or a stop (`cancelled`).
 *
 * Small upkeep the moment wants (eating, sleeping) comes before the procedure's own next item (`upkeep`). What ran is kept as items, so
 * the planner is told in fixed words what was done and why the turn came back. Like the rest of this package it holds no timer and no
 * store: the service hands the facts, the clock and the runner in.
 */
export const PROCEDURE_RUN_V1 = 'procedure.run.v1';
export interface ProcedureLimits { items: number; ms: number; failuresPerKey: number; failures: number; repeatsPerKey: number }
export const PROCEDURE_LIMITS: Readonly<ProcedureLimits> = Object.freeze({
  /** Items in one run at most. */
  items: 60,
  /** One run's time at most; the planner then sees how it went and goes on. */
  ms: 600_000,
  /** The same work (by key) failing this often ends the run. */
  failuresPerKey: 2,
  /** Failures in one run at most. */
  failures: 6,
  /** The same work done this often without the procedure moving on: the rules are going round. */
  repeatsPerKey: 6,
});

export type ProcedureMove<Item> =
  | { kind: 'do'; item: Item; key: string; why: string }
  | { kind: 'done' }
  | { kind: 'stuck'; why: string };

/** What one run remembers of its items: by key, how often each worked or failed, and how it last failed; notes the procedure keeps. */
export class ProcedureMemory {
  private readonly worked = new Map<string, number>();
  private readonly broke = new Map<string, number>();
  private readonly how = new Map<string, string>();
  readonly notes = new Map<string, unknown>();

  succeeded(key: string): number { return this.worked.get(key) ?? 0; }
  failed(key: string): number { return this.broke.get(key) ?? 0; }
  lastFailure(key: string): string | null { return this.how.get(key) ?? null; }

  record(key: string, ok: boolean, failure: string | null): void {
    const counts = ok ? this.worked : this.broke;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!ok) this.how.set(key, failure ?? 'failed');
  }

  /** A failure kept as how the work last went, without counting it (a passing one, `ProcedureRunPorts.passing`). */
  note(key: string, failure: string): void {
    this.how.set(key, failure);
  }
}

export interface Procedure<Facts, Item> {
  id: string;
  done(facts: Facts): boolean;
  next(facts: Facts, memory: ProcedureMemory): ProcedureMove<Item>;
}

export interface ProcedureItemResult { ok: boolean; text: string; failure?: string | null }
export interface ProcedureStepInfo { procedure: string; key: string; why: string; index: number }

export interface ProcedureRunPorts<Facts, Item> {
  facts(): Facts;
  /** Why the turn goes back to the planner before the next item, or null. Asked before every item. */
  stopWhy(facts: Facts, at: { procedure: string; elapsedMs: number }): string | null;
  /** The moment's upkeep, done before the procedure's own next item (eat, sleep), or null. */
  upkeep?(facts: Facts, memory: ProcedureMemory): Extract<ProcedureMove<Item>, { kind: 'do' }> | null;
  /** A failure kind that ends the run at once (the planner must see it), whatever the counts. */
  final?(failure: string): boolean;
  /** A failure kind that passes (a reflex of the body that cut in): not counted the first time in a row for its work. */
  passing?(failure: string): boolean;
  run(item: Item, step: ProcedureStepInfo): Promise<ProcedureItemResult>;
  /**
   * About how long an item takes (ms), when known. An item that would carry the run past its time bound is not begun: the run is
   * cut between items, never in the middle of a dig (mb-r21, run 21: the last iron dig began at 525 s of 600 and ran 180 s).
   */
  expectMs?(item: Item): number;
  now(): number;
  signal: AbortSignal;
}

export type ProcedureOutcome = 'done' | 'stopped' | 'stuck' | 'failed' | 'limit' | 'cancelled';
export interface ProcedureRunItem { procedure: string; key: string; why: string; ok: boolean; failure: string | null; ms: number }
export interface ProcedureRunResult {
  outcome: ProcedureOutcome;
  /** The procedure the run ended in; null when every one was done. */
  at: string | null;
  /** The procedures done in this run, in order. */
  passed: string[];
  /** Fixed words: why the run ended. */
  why: string;
  items: ProcedureRunItem[];
  elapsedMs: number;
}

interface RunState<Facts, Item> {
  ports: ProcedureRunPorts<Facts, Item>;
  limits: ProcedureLimits;
  memory: ProcedureMemory;
  started: number;
  passed: string[];
  items: ProcedureRunItem[];
  failures: number;
}

function ended<Facts, Item>(state: RunState<Facts, Item>, outcome: ProcedureOutcome, at: string | null, why: string): ProcedureRunResult {
  return { outcome, at, passed: [...state.passed], why, items: [...state.items], elapsedMs: state.ports.now() - state.started };
}

/** Why the run may not take another item now (its bounds, a stop, a reason from outside), or null. */
function heldBack<Facts, Item>(state: RunState<Facts, Item>, procedure: string, facts: Facts): ProcedureRunResult | null {
  if (state.ports.signal.aborted) return ended(state, 'cancelled', procedure, '止められた');
  const elapsedMs = state.ports.now() - state.started;
  if (state.items.length >= state.limits.items || elapsedMs >= state.limits.ms) {
    return ended(state, 'limit', procedure, `一度に流す上限（${state.limits.items}手・${Math.round(state.limits.ms / 1000)}秒）`);
  }
  const stop = state.ports.stopWhy(facts, { procedure, elapsedMs });
  return stop ? ended(state, 'stopped', procedure, stop) : null;
}

/** Whether a move may run: not one that failed or went round too often already. */
function refused<Facts, Item>(state: RunState<Facts, Item>, procedure: string, move: { key: string; why: string }): ProcedureRunResult | null {
  const failed = state.memory.failed(move.key);
  if (failed >= state.limits.failuresPerKey) {
    return ended(state, 'failed', procedure, `${move.why}が${failed}回できなかった（${state.memory.lastFailure(move.key)}）`);
  }
  const worked = state.memory.succeeded(move.key);
  return worked >= state.limits.repeatsPerKey ? ended(state, 'stuck', procedure, `${move.why}を${worked}回しても先へ進まない`) : null;
}

/** One item run and remembered; a result when it ends the run. */
async function runOne<Facts, Item>(state: RunState<Facts, Item>, procedure: string,
  move: Extract<ProcedureMove<Item>, { kind: 'do' }>): Promise<ProcedureRunResult | null> {
  const at = state.ports.now();
  const result = await state.ports.run(move.item, { procedure, key: move.key, why: move.why, index: state.items.length });
  const failure = result.failure ?? 'failed';
  state.items.push({ procedure, key: move.key, why: move.why, ok: result.ok, failure: result.ok ? null : failure, ms: state.ports.now() - at });
  if (!result.ok && state.ports.passing?.(failure) && state.memory.lastFailure(move.key) !== failure) {
    state.memory.note(move.key, failure);
    return null;
  }
  state.memory.record(move.key, result.ok, result.ok ? null : failure);
  if (result.ok) return null;
  state.failures += 1;
  if (state.ports.final?.(failure)) return ended(state, 'failed', procedure, `${move.why}ができなかった（${failure}）`);
  return state.failures >= state.limits.failures ? ended(state, 'failed', procedure, `失敗が${state.failures}回になった（最後は${failure}）`) : null;
}

/** One procedure to its end: null when it is done, else the run's result. */
async function throughOne<Facts, Item>(state: RunState<Facts, Item>, procedure: Procedure<Facts, Item>): Promise<ProcedureRunResult | null> {
  for (;;) {
    const facts = state.ports.facts();
    // Upkeep first, even when the procedure is done: the armour made last is still put on.
    const upkeep = state.ports.upkeep?.(facts, state.memory) ?? null;
    if (!upkeep && procedure.done(facts)) return null;
    const held = heldBack(state, procedure.id, facts);
    if (held) return held;
    const move = upkeep ?? procedure.next(facts, state.memory);
    if (move.kind === 'done') return null;
    if (move.kind === 'stuck') return ended(state, 'stuck', procedure.id, move.why);
    const blocked = refused(state, procedure.id, move);
    if (blocked) return blocked;
    // Cut between items: one that would not end inside the time bound waits for the next run (the first item of a run always goes).
    const expected = move === upkeep ? 0 : state.ports.expectMs?.(move.item) ?? 0;
    const elapsedMs = state.ports.now() - state.started;
    if (state.items.length > 0 && expected > 0 && elapsedMs + expected > state.limits.ms) {
      return ended(state, 'limit', procedure.id, `一度に流す上限（${state.limits.items}手・${Math.round(state.limits.ms / 1000)}秒）の手前で、`
        + `次の手（約${Math.round(expected / 1000)}秒）を始めずに区切った`);
    }
    const end = await runOne(state, procedure.id, move);
    if (end) return end;
  }
}

/** Runs the procedures in order, each until it is done, and says how the run ended. A runner that throws ends it with that error. */
export async function runProcedures<Facts, Item>(chain: readonly Procedure<Facts, Item>[], ports: ProcedureRunPorts<Facts, Item>,
  limits: ProcedureLimits = PROCEDURE_LIMITS): Promise<ProcedureRunResult> {
  const state: RunState<Facts, Item> = { ports, limits, memory: new ProcedureMemory(), started: ports.now(), passed: [], items: [], failures: 0 };
  for (const procedure of chain) {
    const end = await throughOne(state, procedure);
    if (end) return end;
    state.passed.push(procedure.id);
  }
  return ended(state, 'done', null, 'すべて着いた');
}

const OUTCOME: Readonly<Record<ProcedureOutcome, string>> = {
  done: '最後まで着いた', stopped: '途中で返した', stuck: '手が無くなった', failed: 'できなかった', limit: '上限で区切った', cancelled: '止められた',
};

/** The run in fixed words: how it ended and why, what was passed, and its last items (`limit` of them). */
export function procedureRunLines(result: ProcedureRunResult, limit = 10): string[] {
  const head = `${OUTCOME[result.outcome]}: ${result.why}（${result.items.length}手・${Math.round(result.elapsedMs / 1000)}秒）`;
  const passed = result.passed.length ? [`着いた: ${result.passed.join('・')}`] : [];
  const items = result.items.slice(-limit).map(item => `${item.procedure}: ${item.why}${item.ok ? '' : `（できなかった: ${item.failure}）`}`);
  return [head, ...passed, ...items];
}
