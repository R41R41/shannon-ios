import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot } from '@shannon/cognition';
import { isForgottenCommitmentEvidence } from '../memory/memoryVisibilityPorts.js';
import type { SleepConsolidationOutcome } from './sleepConsolidation.js';

export interface CommitmentSleepReview {
  pending: number;
  completed: number;
  dismissed: number;
  needsDateClarification: number;
  overdue: number;
}

export function reviewCommitments(state: CompanionStateSnapshot, at: string): CommitmentSleepReview {
  const visible = state.prospectiveMemories.filter(memory => visibleMemoryText(state, memory.id, memory.summary)
    && (!memory.sourceExperienceId || visibleMemoryText(state, memory.sourceExperienceId, memory.summary)));
  return {
    pending: visible.filter(memory => memory.status === 'pending').length,
    completed: visible.filter(memory => memory.status === 'completed').length,
    dismissed: visible.filter(memory => memory.status === 'dismissed').length,
    needsDateClarification: visible.filter(memory => memory.status === 'pending' && !memory.dueAt && !memory.dueDate).length,
    overdue: visible.filter(memory => {
      if (memory.status !== 'pending') return false;
      if (memory.dueAt) return Date.parse(memory.dueAt) < Date.parse(at);
      if (!memory.dueDate) return false;
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: memory.timeZone ?? 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
        // A date-only promise is not overdue until its entire local day has passed.
        return memory.dueDate < `${parts.year}-${parts.month}-${parts.day}`;
      } catch { return false; }
    }).length,
  };
}

/** Recheck user boundaries inside the commit transaction: the user may have
 * forgotten/corrected evidence while the sleep analyzer was awaiting its model. */
export function reconcileSleepOutcome(outcome: SleepConsolidationOutcome, current: CompanionStateSnapshot, at: string): SleepConsolidationOutcome {
  const allowed = (id: string, evidence?: string) => Boolean(visibleMemoryText(current, id, 'visible'))
    && (!evidence || !isForgottenCommitmentEvidence(current, evidence));
  const facts = outcome.facts.filter(fact => allowed(fact.id, fact.evidence));
  const relationships = outcome.relationships.filter(item => allowed(item.id, item.evidence));
  const interests = outcome.interests.filter(interest => allowed(memoryIdentifier('interest', interest),
    outcome.report.interestChanges.find(change => change.text === interest)?.evidence));
  const ids = new Set([...facts.map(fact => fact.id), ...relationships.map(item => item.id), ...interests.map(item => memoryIdentifier('interest', item))]);
  return { facts, relationships, interests, report: {
    ...outcome.report,
    learned: outcome.report.learned.filter(change => ids.has(change.memoryId)),
    updated: outcome.report.updated.filter(change => ids.has(change.memoryId)),
    interestChanges: outcome.report.interestChanges.filter(change => ids.has(change.memoryId)),
    commitmentReview: reviewCommitments(current, at),
  } };
}
