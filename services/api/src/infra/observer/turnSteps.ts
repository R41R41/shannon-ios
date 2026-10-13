/**
 * One content-free line per observed conversation turn with the milliseconds of its synchronous steps before the model call
 * (2026-10-13: a text turn spent ~9 s before its model call in gaps no span covered, and the event loop was blocked 2-4 s at a
 * time). Each step is a closed name; the line has a short id and numbers, never words, prompts or memory ids. A step measured
 * twice in one turn is summed. The line is written when the observer run of the turn ends (`withObserverRun`), and only
 * when the turn measured a step, so other runs (her own time, background work) write nothing.
 */
export const TURN_STEPS = [
  // `beginTextTurn`.
  'orchestration', 'command', 'snapshot', 'people', 'deterministic',
  // After semantic recall, before the model request is built.
  'identity', 'threadSummary', 'provenance', 'toolOffer', 'replay', 'fcaContext',
] as const;
export type TurnStep = typeof TURN_STEPS[number];

interface Steps { started: number; values: Map<TurnStep, number>; model: number | null }
const runs = new Map<string, Steps>();
const KEPT = 64;

/** The turn's run began: its steps and its model start are measured from here. */
export function beginTurnSteps(runId: string, clock: () => number = () => performance.now()): void { stepsOf(runId, clock()); }

/** Times `work` as `step` of the turn whose observer run is `runId`; without a run it only runs `work`. */
export function timedStep<T>(runId: string | null, step: TurnStep, work: () => T, clock: () => number = () => performance.now()): T {
  if (!runId) return work();
  const started = clock();
  try { return work(); } finally {
    const steps = stepsOf(runId, started);
    steps.values.set(step, (steps.values.get(step) ?? 0) + Math.max(0, clock() - started));
  }
}

/** The first moment the turn hands its request to the model, as milliseconds since its run began. */
export function markModelStart(runId: string | null, clock: () => number = () => performance.now()): void {
  if (!runId) return;
  const steps = runs.get(runId);
  if (steps && steps.model === null) steps.model = Math.max(0, clock() - steps.started);
}

/**
 * The same closed step names and rounded milliseconds for the turn's terminal observer event, so the owner's observer can
 * show them (Syzygy TI-REQ 2026-10-13). Read before the line is flushed; null when the turn measured no step.
 */
export function turnStepsSnapshot(runId: string): { steps: { [step: string]: number }; modelStartMs: number | null } | null {
  const steps = runs.get(runId);
  if (!steps || !steps.values.size) return null;
  const values: { [step: string]: number } = {};
  for (const step of TURN_STEPS) if (steps.values.has(step)) values[step] = Math.round(steps.values.get(step)!);
  return { steps: values, modelStartMs: steps.model === null ? null : Math.round(steps.model) };
}

/** Writes the turn's line once and forgets it; nothing when the turn measured no step. */
export function flushTurnSteps(runId: string, surface: string, totalMs: number, log: (line: string) => void = line => console.info(line)): void {
  const steps = runs.get(runId);
  runs.delete(runId);
  if (!steps || !steps.values.size) return;
  try {
    const kind = /^[a-z]{1,16}$/u.test(surface) ? surface : 'other';
    const parts = TURN_STEPS.flatMap(step => steps.values.has(step) ? [`${step}=${Math.round(steps.values.get(step)!)}ms`] : []);
    log(`Shannon turn steps surface=${kind} id=${runId.replace(/[^0-9a-f]/giu, '').slice(0, 8).toLowerCase()} ${parts.join(' ')}`
      + ` model=${steps.model === null ? '-' : `${Math.round(steps.model)}ms`} total=${Math.round(Math.max(0, totalMs))}ms`);
  } catch { /* a timing line never fails a turn */ }
}

function stepsOf(runId: string, started: number): Steps {
  let steps = runs.get(runId);
  if (!steps) {
    steps = { started, values: new Map(), model: null };
    runs.set(runId, steps);
    while (runs.size > KEPT) runs.delete(runs.keys().next().value!);
  }
  return steps;
}
