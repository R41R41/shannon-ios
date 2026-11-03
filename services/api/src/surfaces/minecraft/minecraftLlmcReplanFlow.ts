import type { PlanUpdate } from '@shannon/mind';
import { offer } from './minecraftLlmcOnceFacts.js';
import {
  putReplan,
  readReplanLedger,
  REPLAN,
  REPLAN_STALLS,
  REPLAN_SYSTEM,
  replanOf,
  replanVerdict,
  settledAttempt,
  withAttempt,
  type ReplanLedger,
  type ReplanRecord,
} from './minecraftLlmcReplan.js';
import { replanBrief, type BriefInput } from './minecraftLlmcReplanBrief.js';
import { stallEscapedLine, stallRecordLine, type StallVitals } from './minecraftLlmcStallRecord.js';
import { resumeStalls, type Stall } from './minecraftLlmcStalls.js';

/**
 * The flow of one task: a stall is noted when the head's look finds it (`note`), and the strong model is asked at the next decision's
 * start (`run`, inside the step, so that its cost is the step's), if the bounds allow (`minecraftLlmcReplan.ts`). The answer's ops are
 * checked against the plan as it is now and put in the task's inbox; the plan takes them at its next read. Nothing here waits for a
 * person, holds the task or changes the plan by itself.
 */
export type Replanner = (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
/** What the brief needs from the task now, besides the stall and the earlier plans (which the flow knows). */
export type ReplanSources = Omit<BriefInput, 'stall' | 'earlier' | 'sameNode'> & { node: string | null };

export interface ReplanDeps {
  taskId: string;
  /** The ledger the checkpoint held (`minecraftReplans`). */
  saved: unknown;
  /** The stall the checkpoint held (`minecraftReplanPending`): one found at the end of a step waits for the next. */
  savedPending?: unknown;
  replanner: Replanner | undefined;
  /** The task's running clock in ms. */
  clock(): number;
  sources(stall: Stall): ReplanSources | null;
  /** The problem the plan would have with an update, or null when it would take it. */
  check(update: PlanUpdate): string | null;
  /**
   * Keeps the checkpoint's keys at once, before a new plan is asked for (not at the step's commit): a step that ends with its result unknown, or
   * dies, after the ask does not give the ask back to the limits. False or a throw: it could not be kept, and the ask is not made.
   */
  persist?(checkpoint: { minecraftReplans: ReplanLedger; minecraftReplanPending: Waiting | null }): boolean;
  /** The nodes an update names, as the plan it was checked against has them (`boundTo`): the update is taken only by a plan that still has them so. */
  bind?(update: PlanUpdate): Record<string, string>;
  /** What the body is in now, for the stall record (`minecraftLlmcStallRecord.ts`). */
  vitals?(): StallVitals;
  log(line: string): void;
}

/** A stall waiting for a slot, and the task's clock when it was found. */
export interface Waiting {
  stall: Stall;
  at: number;
}

/** The waiting stall a checkpoint held, read with care (only the kinds a new plan answers; null for anything else). */
export function readWaiting(raw: unknown): Waiting | null {
  const item = raw && typeof raw === 'object' ? raw as { stall?: Record<string, unknown> | null; at?: unknown } : null;
  const stall = item?.stall;
  if (!stall || typeof item.at !== 'number' || !Number.isFinite(item.at)) return null;
  if (typeof stall.kind !== 'string' || !REPLAN_STALLS.has(stall.kind) || typeof stall.key !== 'string' || typeof stall.why !== 'string') return null;
  return { stall: { kind: stall.kind as Stall['kind'], key: stall.key.slice(0, 40), why: stall.why.slice(0, 240) }, at: item.at };
}

export function createReplanFlow(deps: ReplanDeps) {
  let ledger = readReplanLedger(deps.saved);
  let pending: Waiting | null = readWaiting(deps.savedPending);
  /** The waiting stall the skipped line was said for (said once, not at every decision). */
  let told: Stall | null = null;
  /** The newest stall record, kept until the body has got out of its node (`escaped`). */
  let lastRecord: { node: string; outcome: string; at: number } | null = null;
  const say = (line: string): void => {
    try {
      deps.log(line);
    } catch {
      /* a log never fails a step */
    }
  };
  const record = (node: string, stall: Stall, outcome: ReplanRecord['outcome'], why: string): ReplanRecord =>
    ({ at: deps.clock(), node, kind: stall.kind, outcome, why });
  const written = (stall: Stall, node: string, outcome: string, askMs: number, waitedMs: number): void => {
    lastRecord = { node, outcome, at: deps.clock() };
    say(stallRecordLine(deps.taskId, { kind: stall.kind, node, idleSeconds: stall.idleMs === undefined ? null : Math.round(stall.idleMs / 1000), outcome,
      askMs, gapWaitMs: Math.max(0, waitedMs), nodeAsks: ledger.nodes[node] ?? 0, nodeCap: REPLAN.perNode,
      vitals: deps.vitals?.() ?? { hp: null, hunger: null, dimension: null, enemies16: 0 } }));
  };
  /** The ledger with the ask counted, kept at once when the deps keep it; false: it could not be kept, and nothing is asked (the stall waits). */
  const keep = (asked: ReplanLedger, stall: Stall): boolean => {
    if (!deps.persist) return true;
    try {
      if (deps.persist({ minecraftReplans: asked, minecraftReplanPending: null })) return true;
    } catch {
      /* said below */
    }
    if (told !== stall) say(`Shannon Minecraft replan not asked task=${deps.taskId} why=not_kept`);
    told = stall;
    return false;
  };
  /** `earlier`: the ledger before this attempt (what the brief tells of the plans made before). */
  async function answer(stall: Stall, parts: ReplanSources, signal: AbortSignal, earlier: ReplanLedger): Promise<ReplanRecord> {
    const node = parts.node ?? '-';
    const { node: _node, ...rest } = parts;
    const brief = replanBrief({ ...rest, stall: { kind: stall.kind, why: stall.why, node: parts.node }, earlier: earlier.last,
      sameNode: earlier.nodes[node] ?? 0 });
    const began = Date.now();
    let reply: unknown;
    try {
      reply = await deps.replanner!(REPLAN_SYSTEM, brief, AbortSignal.any([signal, AbortSignal.timeout(REPLAN.giveUpMs)]));
    } catch (error) {
      say(`Shannon Minecraft replan failed task=${deps.taskId} node=${node} ms=${Date.now() - began} ${String(error).slice(0, 100)}`);
      return record(node, stall, 'failed', '答えが来なかった');
    }
    const made = replanOf(reply);
    if (!made) return record(node, stall, 'refused', '答えが読めなかった');
    const unchanged = !made.update.ops?.length && !made.update.current;
    const problem = unchanged ? null : deps.check(made.update);
    const outcome = unchanged ? 'unchanged' : problem ? 'refused' : 'changed';
    if (outcome === 'changed') putReplan(deps.taskId, made.update, made.why, deps.bind?.(made.update));
    const why = problem ? ` problem=${problem.slice(0, 100)}` : '';
    say(`Shannon Minecraft replan task=${deps.taskId} node=${node} kind=${stall.kind} outcome=${outcome} ops=${made.update.ops?.length ?? 0}`
      + ` ms=${Date.now() - began}${why}`);
    return record(node, stall, outcome, problem ? `通らなかった: ${problem.slice(0, 80)}` : made.why);
  }
  return {
    /** The look found a stall: the count starts again from nothing, and a stall a new plan answers waits for the next decision. */
    note(stall: Stall): void {
      resumeStalls(deps.taskId);
      if (REPLAN_STALLS.has(stall.kind)) pending = { stall, at: deps.clock() };
    },
    /**
     * At a decision's start: the strong model is asked when a stall waits and the bounds allow. A stall that the gap or the hour's count holds
     * back stays (it is asked at a later decision, for `pendingMs`); one that a count of the run or of the node stops is told and dropped.
     */
    async run(signal: AbortSignal): Promise<void> {
      // A step that is being stopped asks for nothing and keeps the stall for the next one.
      if (signal.aborted || !pending) return;
      const { stall, at } = pending;
      const parts = deps.replanner && deps.clock() - at <= REPLAN.pendingMs ? deps.sources(stall) : null;
      if (!parts) {
        pending = null;
        return;
      }
      const node = parts.node ?? '-';
      const verdict = replanVerdict(ledger, node, deps.clock());
      if (!verdict.ok) {
        if (told !== stall) {
          say(`Shannon Minecraft replan skipped task=${deps.taskId} node=${node} kind=${stall.kind} why=${verdict.why}`);
          written(stall, node, `skipped:${verdict.why}`, 0, deps.clock() - at);
        }
        told = stall;
        if (verdict.why === 'run' || verdict.why === 'node') pending = null;
        if (verdict.why === 'node') offer(deps.taskId, `replan_node:${node}`, `節 ${node} は、計画を ${REPLAN.perNode} 回立て直しても進まなかった。続けるか、blocked にして別の道を計画するかを決める`);
        return;
      }
      const earlier = ledger, asked = withAttempt(ledger, record(node, stall, 'failed', '頼んだ（答えを待っている）'));
      // The ask is counted before it is sent: a step that ends unknown, or dies, after it is recovered with the count (Codex, 2026-11-03).
      if (!keep(asked, stall)) return;
      pending = null;
      const began = Date.now(), waitedMs = deps.clock() - at;
      const settled = await answer(stall, parts, signal, earlier);
      ledger = settledAttempt(asked, settled);
      written(stall, node, settled.outcome, Date.now() - began, waitedMs);
    },
    /** At a decision's start: the node now current. The body got out of the node the last record was for (said once). */
    escaped(current: string | null): void {
      if (!lastRecord || current === lastRecord.node) return;
      say(stallEscapedLine(deps.taskId, lastRecord, deps.clock()));
      lastRecord = null;
    },
    ledger: (): typeof ledger => ledger,
    checkpoint: () => ({ minecraftReplans: ledger, minecraftReplanPending: pending }),
  };
}
export type ReplanFlow = ReturnType<typeof createReplanFlow>;
