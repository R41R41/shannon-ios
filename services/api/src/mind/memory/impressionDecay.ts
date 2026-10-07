/** Evidence decay of her impressions (Syzygy ADR-0008 §10 F6, `SHANNON_EVIDENCE_DECAY`): split out of `personFacts.ts` in the stage 3 closure review, so that recall reads it without loading the facts module and its model helpers. */
import { impressionMemoryId, OWNER_PERSON_KEY, type PersonImpression } from './impressions.js';
import { type CompanionStateSnapshot, memoryControlFor } from '@shannon/cognition';
import { type DecayDryRunItem, type DecayTransition, decayTransitions, type Evidence, evidenceState } from '@shannon/mind';

// --- evidence decay -------------------------------------------------------------------------------------------------

/**
 * An impression's evidence as the two clocks read it: a supporting turn +0.5, a turn that went against it is `ignored` (0.2
 * contra, the accepted reading of the plan); the owner pinning it (a correction he kept) +1, his rejecting it 1 contra.
 */
export function impressionEvidence(row: PersonImpression, state: Pick<CompanionStateSnapshot, 'memoryControls'>): Evidence[] {
  const evidence: Evidence[] = row.evidence.map(item => ({ kind: item.stance === 'support' ? 'turn_support' as const : 'ignored' as const, at: item.at }));
  const control = memoryControlFor(state as CompanionStateSnapshot, impressionMemoryId(row.id));
  if (control?.pinned) evidence.push({ kind: 'owner_confirmed', at: control.updatedAt });
  if (control?.status === 'rejected') evidence.push({ kind: 'owner_denied', at: control.updatedAt });
  return evidence;
}

/** What today's rule says of an impression, for the dry-run: in use (active, fading), not in use (candidate), or retired. */
export function currentHandling(row: Pick<PersonImpression, 'status'>): DecayDryRunItem['current'] {
  return row.status === 'retired' ? 'retired' : row.status === 'candidate' ? 'faded' : 'active';
}

/** Whether the two clocks let an impression of someone other than the owner be used (the owner's own keep today's rule). */
export function decayedUsable(row: PersonImpression, state: Pick<CompanionStateSnapshot, 'memoryControls'>, at: string): boolean {
  if (row.personKey === OWNER_PERSON_KEY) return row.status === 'active' || row.status === 'fading';
  const status = evidenceState(impressionEvidence(row, state), at).status;
  return status === 'usable' || status === 'promoted';
}

export interface DecayDryRunPerson { personKey: string; transitions: Array<DecayTransition & { pattern: string }> }

/** The dry-run (owner answer 4): per person, every impression whose handling would change with the switch on. Changes nothing. */
export function decayDryRun(rows: readonly PersonImpression[], state: Pick<CompanionStateSnapshot, 'memoryControls'>, at: string): DecayDryRunPerson[] {
  const byPerson = new Map<string, PersonImpression[]>();
  for (const row of rows) byPerson.set(row.personKey, [...(byPerson.get(row.personKey) ?? []), row]);
  return [...byPerson].sort(([left], [right]) => left.localeCompare(right)).flatMap(([personKey, own]) => {
    const transitions = decayTransitions(own.map(row => ({ id: row.id, evidence: impressionEvidence(row, state), current: currentHandling(row),
      ownerFact: personKey === OWNER_PERSON_KEY })), at);
    return transitions.length ? [{ personKey, transitions: transitions.map(item => ({ ...item, pattern: own.find(row => row.id === item.id)?.pattern ?? '' })) }] : [];
  });
}
