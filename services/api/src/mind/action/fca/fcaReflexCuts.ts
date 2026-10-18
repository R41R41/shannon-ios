/**
 * Commands the body's own reflex cut off (`interrupted_by_reflex`, P8): nobody's fault, so one is not a failed step. But a reflex that
 * keeps cutting the same thing off is a situation the model has to leave, not wait out. So the run of cuts is counted, and past a
 * bound each further cut counts as an ordinary failed step (`consecutiveToolFailures`, which stops the task at 5).
 *
 * What ends a run: a step with an outcome of its own (a write that worked, any failure, another tool); the run is not counted again.
 * What does not: a step with nothing to say about the body (a wait, a completion, the goal/replan tools) and a step whose only other
 * outcomes are reads that worked (`minecraft.observe`, a query): looking around between two cuts is not getting past the reflex,
 * and the cut call is counted whatever read succeeded beside it or between (P8 second review, M2).
 */
export const REFLEX_CUT_SAME_TOOL_LIMIT = 3;
export const REFLEX_CUT_TOTAL_LIMIT = 6;
/** The stop reason when the failures that stopped the task were cuts, so that it can be told from a tool that really failed. */
export const REPEATED_REFLEX_INTERRUPTION = 'repeated_reflex_interruption';

/** The cuts in a row: all of them, and the latest tool's own run (`tool` is empty when one step was cut off in several tools). */
export interface ReflexCutRun { total: number; tool: string; toolRun: number }
export const NO_REFLEX_CUTS: ReflexCutRun = { total: 0, tool: '', toolRun: 0 };

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** The run a task's checkpoint carries (a missing or damaged one is no run; a checkpoint from before this had none of its keys). */
export function reflexCutRunOf(checkpoint: Readonly<Record<string, unknown>>): ReflexCutRun {
  const total = count(checkpoint.consecutiveReflexCuts);
  if (!total) return NO_REFLEX_CUTS;
  return { total, tool: typeof checkpoint.reflexCutTool === 'string' ? checkpoint.reflexCutTool : '', toolRun: count(checkpoint.reflexCutToolRun) };
}

/** One more step whose commands were all cut off by a reflex; `counted` is whether it counts as a failed step. */
export function nextReflexCutRun(run: ReflexCutRun, tools: readonly string[]): { run: ReflexCutRun; counted: boolean } {
  const tool = new Set(tools).size === 1 ? tools[0]! : '';
  const toolRun = tool !== '' && tool === run.tool ? run.toolRun + 1 : 1;
  const next = { total: run.total + 1, tool, toolRun };
  return { run: next, counted: next.toolRun >= REFLEX_CUT_SAME_TOOL_LIMIT || next.total >= REFLEX_CUT_TOTAL_LIMIT };
}

/** What one call of a step came to: cut off by a reflex, or an outcome of its own (`read`: the tool only looks). */
export interface StepCall { name: string; ok: boolean; read: boolean; cut: boolean }

/**
 * The failure count and the run of cuts after one step's calls (the goal/replan tools already left out).
 * A call that was cut is counted among the run whatever else the step held; a read that worked beside or between cuts changes neither.
 */
export function settleReflexStep(failures: number, run: ReflexCutRun, calls: readonly StepCall[]): { failures: number; run: ReflexCutRun; byCuts: boolean } {
  const cut = calls.filter(call => call.cut), rest = calls.filter(call => !call.cut);
  if (rest.some(call => !(call.read && call.ok))) {
    // An outcome of its own: every call but the cut ones decides the count, and the run is over.
    return { failures: rest.every(call => !call.ok) ? failures + 1 : 0, run: NO_REFLEX_CUTS, byCuts: false };
  }
  if (cut.length) {
    const next = nextReflexCutRun(run, cut.map(call => call.name));
    return { failures: next.counted ? failures + 1 : failures, run: next.run, byCuts: next.counted };
  }
  // Only reads that worked: with no run going they are a success as before; with one going they leave it, and what it counted, as they found it.
  return { ...(rest.length && !run.total ? { failures: 0, run } : { failures, run }), byCuts: false };
}

/**
 * The stop reason for a task that has reached the failure limit: the cuts' own only when the cuts are what pushed it over, that is, the
 * step that reached the limit counted a cut as its failure (`byCuts` of `settleReflexStep`). A run of cuts still going when an ordinary
 * failure reached the limit is not the reason it stopped (P8 third review): that is `repeated_tool_failure`, as it always was.
 */
export function repeatedFailureReason(pushedOverByCuts: boolean): string {
  return pushedOverByCuts ? REPEATED_REFLEX_INTERRUPTION : 'repeated_tool_failure';
}

/** What to commit; explicit zeros only when the stored run has to be cleared (the stored checkpoint is spread under this one). */
export function reflexCutCheckpoint(run: ReflexCutRun, prior: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!run.total && !count(prior.consecutiveReflexCuts)) return {};
  return { consecutiveReflexCuts: run.total, reflexCutTool: run.tool, reflexCutToolRun: run.toolRun };
}
