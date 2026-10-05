import { isMemoryEvidenceVisible, type CompanionStateSnapshot } from '@shannon/cognition';
import { conversationSecrets } from './conversationSecrets.js';
import type { ConversationStore } from './conversationStore.js';
import { MemoryWithholding } from './memoryVisibility.js';
import { UNLINKED_TURN, maskedTraceCalls, type ToolTraceCall } from './shannonToolTrace.js';
import { TOOL_TRACE_RETENTION_MILLISECONDS, type ToolTraceStore } from './shannonToolTurns.js';

/** How often the API process sweeps the traces of what her tools did. */
export const TOOL_TRACE_SWEEP_MILLISECONDS = 10 * 60_000;

type SweepStore = ToolTraceStore & ConversationStore & { snapshot(scopeKey: string): CompanionStateSnapshot };

/**
 * What the owner asked her to forget, or to keep to herself, reaches the traces already stored (`shannonToolTrace.ts`).
 * In every scope: a trace older than the retention goes; the trace of a turn that is now withheld goes (forgotten,
 * rejected or corrected away, or whose user message no longer passes the evidence check), as does one whose turn is
 * gone; and every name or target that now repeats what must reach nobody but him is rewritten as （伏せた）. The replay
 * masks again at the moment it reads (`conversationWindow.ts`), so a turn between two sweeps is never said.
 */
export function sweepToolTraces(store: SweepStore, now: string): void {
  const at = Date.parse(now);
  if (Number.isFinite(at)) store.pruneToolTraces(new Date(at - TOOL_TRACE_RETENTION_MILLISECONDS).toISOString());
  for (const scopeKey of store.toolTraceScopes()) {
    try { sweepScope(store, scopeKey); } catch { /* the next sweep tries again; the replay masks either way */ }
  }
}

function sweepScope(store: SweepStore, scopeKey: string): void {
  const records = store.toolTraces(scopeKey, null, { since: '' });
  if (!records.length) return;
  const state = store.snapshot(scopeKey);
  const withholding = new MemoryWithholding(state, store, scopeKey);
  const secrets = (() => { try { return conversationSecrets(state, store, scopeKey); } catch { return null; } })();
  const linked = records.filter(record => !record.turnId.startsWith(UNLINKED_TURN)).map(record => record.turnId);
  const experiences = new Map((linked.length && store.experiencesById ? store.experiencesById(scopeKey, linked) : []).map(item => [item.id, item]));
  const gone: string[] = [];
  for (const record of records) {
    if (!record.turnId.startsWith(UNLINKED_TURN)) {
      const turn = experiences.get(record.turnId);
      if (!turn || withholding.withholdsExperience(turn) || !isMemoryEvidenceVisible(state, turn.userMessage) || !isMemoryEvidenceVisible(state, turn.shannonReply)) {
        gone.push(record.turnId);
        continue;
      }
    }
    const masked = maskedTraceCalls(record.calls, secrets);
    if (!sameCalls(masked, record.calls)) store.saveToolTrace(scopeKey, { ...record, calls: masked });
  }
  if (gone.length) store.deleteToolTraces(scopeKey, gone);
}

function sameCalls(left: readonly ToolTraceCall[], right: readonly ToolTraceCall[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Sweeps now and every ten minutes in the API process; returns the stop. */
export function startToolTraceSweep(store: SweepStore, now: () => string): () => void {
  const run = () => { try { sweepToolTraces(store, now()); } catch (error) { console.warn('Shannon tool trace sweep failed', error instanceof Error ? error.message : 'unknown'); } };
  run();
  const timer = setInterval(run, TOOL_TRACE_SWEEP_MILLISECONDS);
  timer.unref();
  return () => clearInterval(timer);
}
