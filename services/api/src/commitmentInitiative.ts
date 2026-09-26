import { restoreCompanionState, visibleMemoryText } from '@shannon/cognition';
import type { CandidateRow } from './initiativeSelection.js';

/** A reminder is a proposal to resume a promise, never evidence of its completion. */
export function dueCommitmentCandidate(scopeKey: string, raw: unknown, at: string): (CandidateRow & { score: number })[] {
  const state = restoreCompanionState(scopeKey, raw, at);
  return state.prospectiveMemories.flatMap(memory => {
    if (memory.status !== 'pending' || !visibleMemoryText(state, memory.id, memory.summary)
      || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) return [];
    let due = false;
    if (memory.dueAt) due = Date.parse(memory.dueAt) <= Date.parse(at);
    else if (memory.dueDate) {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: memory.timeZone ?? 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
        due = `${parts.year}-${parts.month}-${parts.day}` >= memory.dueDate && Number(parts.hour) >= 9;
      } catch { return []; }
    }
    if (!due) return [];
    return [{ item_id: `commitment:${memory.id}:${memory.updatedAt}`, source_id: 'commitment',
      source_title: 'ふたりの約束', title: visibleMemoryText(state, memory.id, memory.summary)!, url: '',
      summary: memory.id, published_at: memory.dueAt ?? null, discovered_at: memory.updatedAt, score: 0.8 }];
  }).sort((a, b) => (a.published_at ?? a.discovered_at).localeCompare(b.published_at ?? b.discovered_at));
}
