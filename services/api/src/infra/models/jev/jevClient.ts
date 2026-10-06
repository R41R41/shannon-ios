import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Counting Jev's calls (Syzygy ADR-0008 stage 1: 「Jev の費用を記録する」). Core: response path.
 *
 * Jev is called by `JevVoiceDecisionGateway` (`voiceDecision.ts`) through the fetch it is given. With decision traces on, the
 * gateway is given `countedJevFetch`, which passes every request through unchanged and, while a decision is being traced
 * (`withJevProbe`), notes on that decision's probe what the call was: that it was made, how many questions it asked, how many
 * characters its state had, how long it took and how it ended. It reads the request body only to count; nothing of it is
 * kept. Outside a probe it only passes the request through.
 */
export interface JevCallProbe {
  calls: number;
  /** How the last call ended: an answer (any HTTP status), the timeout, or another failure. */
  outcome: 'ok' | 'timeout' | 'error' | null;
  status: number | null;
  questions: number | null;
  stateChars: number | null;
  latencyMs: number | null;
}

const probes = new AsyncLocalStorage<JevCallProbe>();

export function emptyJevProbe(): JevCallProbe {
  return { calls: 0, outcome: null, status: null, questions: null, stateChars: null, latencyMs: null };
}

/** Runs `operation` with `probe` as the probe of the Jev calls it makes. */
export function withJevProbe<T>(probe: JevCallProbe, operation: () => Promise<T>): Promise<T> {
  return probes.run(probe, operation);
}

/** How large a Jev request is, counted from its body: never the words themselves. */
export function jevRequestSize(body: unknown): { questions: number | null; stateChars: number | null } {
  if (typeof body !== 'string') return { questions: null, stateChars: null };
  try {
    const parsed = JSON.parse(body) as { questions?: unknown; state?: unknown };
    const questions = parsed.questions && typeof parsed.questions === 'object' ? Object.keys(parsed.questions).length : null;
    const stateChars = parsed.state === undefined ? null : JSON.stringify(parsed.state).length;
    return { questions, stateChars };
  } catch { return { questions: null, stateChars: null }; }
}

/** A fetch for the Jev client that counts its calls on the current probe. The request and the response are untouched. */
export function countedJevFetch(given?: typeof fetch, now: () => number = () => performance.now()): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // The global fetch is read at each call, as the gateway's own default would be at its construction.
    const fetcher = given ?? fetch;
    const probe = probes.getStore();
    if (!probe) return fetcher(input, init);
    const started = now();
    probe.calls += 1;
    const size = jevRequestSize(init?.body);
    probe.questions = size.questions;
    probe.stateChars = size.stateChars;
    try {
      const response = await fetcher(input, init);
      probe.outcome = 'ok';
      probe.status = response.status;
      return response;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      probe.outcome = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
      throw error;
    } finally {
      probe.latencyMs = Math.max(0, now() - started);
    }
  }) as typeof fetch;
}
