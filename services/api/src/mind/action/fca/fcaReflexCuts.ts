/**
 * Commands the body's own reflex cut off (`interrupted_by_reflex`, P8): nobody's fault, so one is not a failed step. But a reflex that
 * keeps cutting the same thing off is a situation the model has to leave, not wait out. So the run of cuts is counted, and past a
 * bound each further cut counts as an ordinary failed step (`consecutiveToolFailures`, which stops the task at 5).
 */
export const REFLEX_CUT_SAME_TOOL_LIMIT = 3;
export const REFLEX_CUT_TOTAL_LIMIT = 6;

/** The cuts in a row: all of them, and the latest tool's own run (`tool` is empty when one step was cut off in several tools). */
export interface ReflexCutRun { total: number; tool: string; toolRun: number }
export const NO_REFLEX_CUTS: ReflexCutRun = { total: 0, tool: '', toolRun: 0 };

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** The run a task's checkpoint carries (a missing or damaged one is no run). */
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

/** What to commit; explicit zeros only when the stored run has to be cleared (the stored checkpoint is spread under this one). */
export function reflexCutCheckpoint(run: ReflexCutRun, prior: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!run.total && !count(prior.consecutiveReflexCuts)) return {};
  return { consecutiveReflexCuts: run.total, reflexCutTool: run.tool, reflexCutToolRun: run.toolRun };
}
