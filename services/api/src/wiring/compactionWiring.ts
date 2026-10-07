import { mindSwitches, type SwitchValues } from '@shannon/mind';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import type { ReplayToolPairs } from '../mind/memory/conversationReplaySummary.js';
import { maskedTraceCalls, type ToolTraceCall } from '../mind/tools/shannonToolTrace.js';
import { conversationSecrets } from '../mind/inhibition/conversationSecrets.js';

/**
 * Structured compaction, wired (Syzygy ADR-0008 stage 3, step F7, `docs/mind-workspace-contract.md`). `SHANNON_STRUCTURED_COMPACTION`
 * (and `SHANNON_ADR8_STAGE3`) off: no store adds the template's columns and the summarizer writes the 600-character summary as it
 * does. On: the summary is the template of `packages/mind`, and what her tools did in the summarized turns goes to the summarizer
 * as call and result pairs, masked as the replayed trace is (`maskedTraceCalls` with the conversation's secrets).
 */
export function structuredCompactionOn(environment: SwitchValues): boolean {
  return mindSwitches(environment).structuredCompaction;
}

/** The summarizer's `compaction` option for a store, or null while it is switched off. */
export function replayCompaction(environment: SwitchValues, store: SQLiteShannonStore): { toolPairs: ReplayToolPairs } | null {
  if (!structuredCompactionOn(environment)) return null;
  return {
    toolPairs: (scopeKey, threadId, turnIds) => {
      if (!turnIds.length) return [];
      try {
        const records = store.toolTraces(scopeKey, threadId, { turnIds });
        if (!records.length) return [];
        let secrets: ReturnType<typeof conversationSecrets> | null;
        try { secrets = conversationSecrets(store.snapshot(scopeKey), store, scopeKey); } catch { secrets = null; }
        return records.flatMap(record => maskedTraceCalls(record.calls, secrets).map(call => ({ turnId: record.turnId, call: callText(call), result: resultText(call) })));
      } catch { return []; }
    },
  };
}

const callText = (call: ToolTraceCall) => `${call.tool}${call.target ? `「${call.target}」` : ''}`;

function resultText(call: ToolTraceCall): string {
  if (!call.ok) return `できなかった（${call.failure ?? 'failed'}）`;
  const found = call.names ? (call.names.length ? `あったもの: ${call.names.join('、')}${call.more ? '、ほかにもある' : ''}` : '何もなかった') : 'できた';
  return `${found}${call.note ? `（${call.note}）` : ''}`;
}
