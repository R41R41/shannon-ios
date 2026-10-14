import type { TaskSource } from '../../taskRuntime/taskRuntimePorts.js';

/** How many recent outcomes one decision is shown (`SQLiteFcaEvidenceStore.prepare`). */
export const FCA_RECENT_OUTCOMES = 8;

/** The columns of an evidence row the choice of visible rows reads. */
export interface FcaEvidenceCandidate { scope_key: string; task_id: string; sources_json: string }

/** How one prepare judges a row's stored sources. */
export interface FcaEvidenceJudge {
  /** The current step's task: only its own rows can be covered by its verdict. */
  taskId: string;
  /** The source guard's walk of one row's sources (`FcaEvidenceOptions.sourcesVisible`). */
  walk(row: FcaEvidenceCandidate, sources: readonly TaskSource[]): boolean;
  /** Whether the step's verified sources imply these (`FcaEvidenceOptions.sourcesCovered`); absent, every row is walked. */
  covered?(sources: readonly TaskSource[]): boolean;
  /** What a walk of these still checks after the step's verified sources (`FcaEvidenceOptions.sourcesResidual`); null: walk them whole. */
  residual?(sources: readonly TaskSource[]): readonly TaskSource[] | null;
}

/** The rows chosen, and those a walk admitted (each source set once), which a prepare that yielded checks again at its end. */
export interface FcaVisibleRows<R> { rows: R[]; walked: Array<{ rows: R[]; sources: readonly TaskSource[] }>; yielded: boolean }

/**
 * The newest rows whose sources are visible, at most `FCA_RECENT_OUTCOMES`, in the order given (Minecraft run 7, 2026-10-14: every
 * row of the newest 24 was parsed and walked, ~313 KB of sources and a full walk each, 1.8–5.8 s of the API's one thread per step):
 * - it stops at the eighth visible row;
 * - a row's sources are parsed only when they are judged, and an identical stored set of the same task is judged once;
 * - a row of the step's own task whose sources the step's verified sources cover (`foldedProvenanceCovers`) is not walked, and one
 *   they cover in part is walked only over the rest (`foldedProvenanceResidual`; Minecraft run 9: 1–6 of ~125 ids);
 * - before each walk the event loop is let through once (`setImmediate`): pending I/O runs between walks, not after all of them.
 * A row is shown only on a visible verdict, as before: covered rows by the step's own verdict, which the guard's AND implies.
 */
export async function visibleEvidenceRows<R extends FcaEvidenceCandidate>(rows: readonly R[], judge: FcaEvidenceJudge,
  trace: FcaPrepareTrace): Promise<FcaVisibleRows<R>> {
  const verdicts = new Map<string, boolean>(), walkedByKey = new Map<string, { rows: R[]; sources: readonly TaskSource[] }>();
  const chosen: R[] = [];
  let yielded = false;
  for (const row of rows) {
    if (chosen.length >= FCA_RECENT_OUTCOMES) break;
    trace.rows += 1;
    const key = `${row.task_id}\u0000${row.sources_json}`;
    let visible = verdicts.get(key);
    if (visible === undefined) {
      const sources = JSON.parse(row.sources_json) as TaskSource[];
      trace.parsedBytes += row.sources_json.length;
      const walked = row.task_id === judge.taskId ? ownTaskRest(sources, judge) : sources;
      if (walked === null) {
        trace.covered += 1;
        visible = true;
      } else {
        await new Promise<void>(resolve => setImmediate(resolve));
        yielded = true;
        trace.yields += 1;
        if (walked !== sources) trace.reduced += 1;
        visible = trace.rowCheck(() => judge.walk(row, walked));
        if (visible) walkedByKey.set(key, { rows: [], sources: walked });
      }
      verdicts.set(key, visible);
    } else trace.deduped += 1;
    if (!visible) continue;
    chosen.push(row);
    walkedByKey.get(key)?.rows.push(row);
  }
  return { rows: chosen, walked: [...walkedByKey.values()], yielded };
}

/** A row of the step's own task: null when the verified sources cover it, else what a walk still checks (all of it without a residual). */
function ownTaskRest(sources: readonly TaskSource[], judge: FcaEvidenceJudge): readonly TaskSource[] | null {
  if (judge.covered?.(sources) === true) return null;
  const rest = judge.residual?.(sources);
  if (!rest) return sources;
  return rest.length ? rest : null;
}

/**
 * Content-free measures of one prepare, logged as one line in the form of the slow-context line (`turnCognitiveContext.ts`): times
 * in milliseconds and counts, never a source, an id or a text.
 */
export class FcaPrepareTrace {
  private readonly started = performance.now();
  private readonly spent: Array<[string, number]> = [];
  rows = 0;
  rowChecks = 0;
  covered = 0;
  reduced = 0;
  deduped = 0;
  parsedBytes = 0;
  yields = 0;
  walked = 0;
  partial = 0;
  reused = 0;
  constructor(private readonly walks?: () => { walked: number; reused: number; partial?: number }) {}
  time<T>(name: string, work: () => T): T {
    const at = performance.now();
    try { return work(); } finally { this.spent.push([name, performance.now() - at]); }
  }
  /** One synchronous question to the source guard, with the walks and reuses it made (nothing else runs meanwhile). */
  check(work: () => boolean): boolean {
    const before = this.walks?.();
    try { return work(); } finally {
      const after = this.walks?.();
      if (before && after) {
        this.walked += after.walked - before.walked;
        this.partial += (after.partial ?? 0) - (before.partial ?? 0);
        this.reused += after.reused - before.reused;
      }
    }
  }
  rowCheck(work: () => boolean): boolean {
    this.rowChecks += 1;
    return this.check(work);
  }
  report(outcome: string): void {
    const total = performance.now() - this.started;
    const parts = this.spent.map(([name, ms]) => `${name}=${Math.round(ms)}ms`).join(' ');
    console.info(`Shannon FCA evidence prepare outcome=${outcome} total=${Math.round(total)}ms ${parts} rows=${this.rows} `
      + `rowChecks=${this.rowChecks} covered=${this.covered} reduced=${this.reduced} deduped=${this.deduped} `
      + `walks=${this.walked} partial=${this.partial} reused=${this.reused} `
      + `parsedBytes=${this.parsedBytes} yields=${this.yields}`);
  }
}
