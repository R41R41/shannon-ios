import type { TaskSource } from '../taskRuntime/taskRuntimePorts.js';

/** Who asked for a check, for the slow-walk line only: a closed set of words, never task or memory content. */
export type FcaWalkCaller = 'step' | 'tool' | 'body' | 'evidence' | 'memory' | 'conversation' | 'task' | 'progress' | 'skill_read'
  | 'child' | 'child_monitor' | 'gate' | 'other';
type Part = 'epoch' | 'provenance' | 'reads' | 'walk';

/**
 * One check's clock: the whole of `decide` and, apart, the parts that can each hold the API's one thread (the remembered turns of
 * the moment, the fold of the provenance, the re-asked read receipts, the walk itself). `report` names it, content-free, when the
 * whole took `thresholdMilliseconds` or more: counts, the kind of check, the caller and milliseconds only.
 */
export class FcaWalkTiming {
  private readonly started: number;
  private readonly parts: Record<Part, number> = { epoch: 0, provenance: 0, reads: 0, walk: 0 };
  private mode: 'full' | 'partial' | 'reuse' | 'peek' | null = null;
  private walked: readonly TaskSource[] = [];
  constructor(private readonly now: () => number) { this.started = now(); }

  /** Runs `work`, adding its time to `part` (a part may be timed more than once). */
  time<T>(part: Part, work: () => T): T {
    const at = this.now();
    try {
      return work();
    } finally {
      this.parts[part] += this.now() - at;
    }
  }
  /** Adds `milliseconds` to `part` (a part timed across turns of the loop, `FcaSourceGuard.warm`). */
  add(part: Part, milliseconds: number): void { this.parts[part] += milliseconds; }
  /** What kind of check this was, and the rows it walked (none for a reused verdict). */
  note(mode: 'full' | 'partial' | 'reuse' | 'peek', walked: readonly TaskSource[] = []): void {
    this.mode = mode;
    this.walked = walked;
  }

  /**
   * `held`: a check walked in turns of the loop (`FcaSourceGuard.warm`): its total and walk include the turns between, and the line ends
   * with the longest turn it held the thread (`held=`) and how many times it gave it back (`turns=`).
   */
  report(thresholdMilliseconds: number, via: FcaWalkCaller, log: (line: string) => void, held?: { longestMs: number; turns: number }): void {
    try {
      const total = Math.round(this.now() - this.started);
      if (this.mode === null || total < thresholdMilliseconds) return;
      const ids = new Set(this.walked.flatMap(source => source.recalledMemoryIds)).size, ms = (part: Part) => Math.round(this.parts[part]);
      log(`Shannon FCA source walk total=${total} epoch=${ms('epoch')} provenance=${ms('provenance')} reads=${ms('reads')} walk=${ms('walk')}`
        + ` sources=${this.walked.length} ids=${ids} mode=${this.mode} via=${via}${held ? ` held=${held.longestMs} turns=${held.turns}` : ''}`);
    } catch { /* never throws */ }
  }
}
