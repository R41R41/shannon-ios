import { isMemoryEvidenceVisible, type CompanionStateSnapshot } from '@shannon/cognition';
import { conversationSecrets } from '../inhibition/disclosurePorts.js';
import type { ConversationStore, ShannonExperience } from '../memory/memoryPorts.js';
import { MemoryWithholding } from '../memory/memoryPorts.js';
import { saidKey } from '../../surfaces/body/bodyLookTurnWait.js';
import { UNLINKED_TURN, maskedTraceCalls, saidDigest, type ToolTraceCall, type ToolTraceRecord } from './shannonToolTrace.js';
import { TOOL_FOLLOW_UP_MILLISECONDS, TOOL_TRACE_RETENTION_MILLISECONDS, type ToolTraceStore } from './shannonToolTurns.js';

/** How often the API process sweeps the traces of what her tools did. */
export const TOOL_TRACE_SWEEP_MILLISECONDS = 10 * 60_000;

type SweepStore = ToolTraceStore & ConversationStore & { snapshot(scopeKey: string): CompanionStateSnapshot };

/**
 * What the owner asked her to forget, or to keep to herself, reaches the traces already stored (`shannonToolTrace.ts`).
 * In every scope: a trace older than the retention goes; the trace of a turn that is now withheld goes (forgotten,
 * rejected or corrected away, or whose user message no longer passes the evidence check), as does one whose turn is
 * gone; and every name or target that now repeats what must reach nobody but him is rewritten as （伏せた）. The replay
 * masks again at the moment it reads (`conversationWindow.ts`), so a turn between two sweeps is never said. A Talk-only
 * trace whose turn was stored while nothing held it (the API restarted) is linked to that turn here, or dropped with it.
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
  const experiences = new Map<string, ShannonExperience>();
  // experiencesById reads at most 200 ids at a time (as memoryVisibility.ts does).
  for (let index = 0; index < linked.length && store.experiencesById; index += 200) {
    for (const item of store.experiencesById(scopeKey, linked.slice(index, index + 200))) experiences.set(item.id, item);
  }
  const withheld = (turn: ShannonExperience | undefined): boolean => !turn || withholding.withholdsExperience(turn)
    || !isMemoryEvidenceVisible(state, turn.userMessage) || !isMemoryEvidenceVisible(state, turn.shannonReply);
  const gone: string[] = [];
  const linkedTurns = new Set(linked);
  for (const record of records) {
    let kept = record;
    if (!record.turnId.startsWith(UNLINKED_TURN)) {
      if (withheld(experiences.get(record.turnId))) { gone.push(record.turnId); continue; }
    } else {
      // A trace left Talk-only by a restart between the reply and the stored turn: the turn of the same Talk and words,
      // stored in the ten minutes after it, takes it. A turn now withheld, or one heard by others, drops it.
      const turnId = storedTurnOf(store, scopeKey, record);
      if (turnId) {
        gone.push(record.turnId);
        const turn = store.experiencesById?.(scopeKey, [turnId])[0];
        if (withheld(turn) || turn!.disclosure?.speaker === 'unknown' || linkedTurns.has(turnId)) continue;
        linkedTurns.add(turnId);
        const { saidDigest: _digest, ...rest } = record;
        kept = { ...rest, turnId };
        store.saveToolTrace(scopeKey, { ...kept, calls: maskedTraceCalls(kept.calls, secrets) });
        continue;
      }
    }
    const masked = maskedTraceCalls(kept.calls, secrets);
    if (!sameCalls(masked, kept.calls)) store.saveToolTrace(scopeKey, { ...kept, calls: masked });
  }
  if (gone.length) store.deleteToolTraces(scopeKey, gone);
}

/** The stored turn a Talk-only trace belongs to: his words of the same digest, stored in the ten minutes after the trace began. */
function storedTurnOf(store: SweepStore, scopeKey: string, record: ToolTraceRecord): string | undefined {
  if (!record.saidDigest) return undefined;
  const from = Date.parse(record.recordedAt);
  return store.conversationHistory(scopeKey, record.threadId).find(message => {
    const at = Date.parse(message.observedAt);
    return message.role === 'user' && message.sourceExperienceId && !message.sourceExperienceId.includes(':')
      && at >= from && at - from < TOOL_FOLLOW_UP_MILLISECONDS && saidDigest(saidKey(message.content)) === record.saidDigest;
  })?.sourceExperienceId;
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
