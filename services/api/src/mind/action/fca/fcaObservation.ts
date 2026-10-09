/** Domains supply observations; this common monitor owns only bounded polling and generation fencing. */
export interface FcaObservation {
  generation: string; data: Readonly<Record<string, unknown>>; sourceIds: readonly string[];
}
export interface FcaObservationLifecycle {
  start(signal: AbortSignal): void;
  revision(): number;
  context(): { revision: number; observation: FcaObservation | null };
  guard(revision: number): Promise<boolean>;
  toolSignal(name: string, parent: AbortSignal): AbortSignal;
  close(): Promise<void>;
}
export function createFcaObservationMonitor(parts: {
  read(signal: AbortSignal): Promise<FcaObservation>;
  /** Persist canonical sources under this segment before returning data to the model. */
  observeSources(ids: readonly string[]): boolean;
  /** Only domain operations with known cancellation semantics may be locally interrupted. */
  interruptible(name: string): boolean;
  intervalMilliseconds?: number;
}): FcaObservationLifecycle {
  const interval = parts.intervalMilliseconds ?? 1000;
  if (!Number.isInteger(interval) || interval < 250 || interval > 30_000) throw new Error('FCA_OBSERVATION_INTERVAL_INVALID');
  let revision = 0, observation: FcaObservation | null = null, generation: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> = Promise.resolve();
  let started = false, closed = false, error: unknown;
  const monitor = new AbortController();
  let operations = new AbortController();
  const refresh = () => {
    pending = (async () => {
      const next = await parts.read(monitor.signal);
      if (closed || monitor.signal.aborted) return;
      if (!next || typeof next.generation !== 'string' || !next.generation || next.generation.length > 240
        || !next.data || typeof next.data !== 'object' || Array.isArray(next.data) || JSON.stringify(next.data).length > 32_000
        || !Array.isArray(next.sourceIds) || next.sourceIds.length > 5000 || next.sourceIds.some(id => typeof id !== 'string' || !id || id.length > 240)) throw new Error('FCA_OBSERVATION_INVALID');
      if (!parts.observeSources(next.sourceIds)) throw new Error('FCA_SOURCE_WITHHELD');
      if (next.generation !== generation) { generation = next.generation; revision++; operations.abort(); operations = new AbortController(); }
      observation = JSON.parse(JSON.stringify(next)) as FcaObservation;
    })().catch(cause => { if (!closed && !monitor.signal.aborted) { error = cause; revision++; operations.abort(); } })
      .finally(() => { if (!closed && !monitor.signal.aborted && !error) { timer = setTimeout(refresh, interval); timer.unref(); } });
  };
  return {
    start(signal) {
      if (started) return; started = true;
      if (signal.aborted) { closed = true; monitor.abort(); return; }
      signal.addEventListener('abort', () => { monitor.abort(); operations.abort(); if (timer) clearTimeout(timer); }, { once: true });
      refresh();
    },
    revision: () => revision,
    context: () => ({ revision, observation: observation ? JSON.parse(JSON.stringify(observation)) as FcaObservation : null }),
    async guard(expected) { await pending; if (error) throw error; return revision === expected; },
    toolSignal(name, parent) { return parts.interruptible(name) ? AbortSignal.any([parent, operations.signal]) : parent; },
    async close() { closed = true; monitor.abort(); operations.abort(); if (timer) clearTimeout(timer); await pending; },
  };
}
