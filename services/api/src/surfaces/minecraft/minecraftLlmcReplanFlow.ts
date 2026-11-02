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
  replanner: Replanner | undefined;
  /** The task's running clock in ms. */
  clock(): number;
  sources(stall: Stall): ReplanSources | null;
  /** The problem the plan would have with an update, or null when it would take it. */
  check(update: PlanUpdate): string | null;
  log(line: string): void;
}

export function createReplanFlow(deps: ReplanDeps) {
  let ledger = readReplanLedger(deps.saved);
  let pending: Stall | null = null;
  const say = (line: string): void => {
    try {
      deps.log(line);
    } catch {
      /* a log never fails a step */
    }
  };
  const record = (node: string, stall: Stall, outcome: ReplanRecord['outcome'], why: string): ReplanRecord =>
    ({ at: deps.clock(), node, kind: stall.kind, outcome, why });
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
    if (outcome === 'changed') putReplan(deps.taskId, made.update, made.why);
    const why = problem ? ` problem=${problem.slice(0, 100)}` : '';
    say(`Shannon Minecraft replan task=${deps.taskId} node=${node} kind=${stall.kind} outcome=${outcome} ops=${made.update.ops?.length ?? 0}`
      + ` ms=${Date.now() - began}${why}`);
    return record(node, stall, outcome, problem ? `通らなかった: ${problem.slice(0, 80)}` : made.why);
  }
  return {
    /** The look found a stall: the count starts again from nothing, and a stall a new plan answers waits for the next decision. */
    note(stall: Stall): void {
      resumeStalls(deps.taskId);
      if (REPLAN_STALLS.has(stall.kind)) pending = stall;
    },
    /** At a decision's start: the strong model is asked when a stall waits and the bounds allow. */
    async run(signal: AbortSignal): Promise<void> {
      // A step that is being stopped asks for nothing (and counts nothing: the look finds a stall again in the next one).
      if (signal.aborted) return;
      const stall = pending;
      pending = null;
      const parts = stall && deps.replanner ? deps.sources(stall) : null;
      if (!stall || !parts) return;
      const node = parts.node ?? '-';
      const verdict = replanVerdict(ledger, node, deps.clock());
      if (!verdict.ok) {
        say(`Shannon Minecraft replan skipped task=${deps.taskId} node=${node} kind=${stall.kind} why=${verdict.why}`);
        if (verdict.why === 'node') offer(deps.taskId, `replan_node:${node}`, `節 ${node} は、計画を ${REPLAN.perNode} 回立て直しても進まなかった。続けるか、blocked にして別の道を計画するかを決める`);
        return;
      }
      const earlier = ledger;
      ledger = withAttempt(ledger, record(node, stall, 'failed', '頼んだ（答えを待っている）'));
      ledger = settledAttempt(ledger, await answer(stall, parts, signal, earlier));
    },
    ledger: (): typeof ledger => ledger,
    checkpoint: () => ({ minecraftReplans: ledger }),
  };
}
export type ReplanFlow = ReturnType<typeof createReplanFlow>;
