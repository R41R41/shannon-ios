import { createHash } from 'node:crypto';
import { memoryIdentifier, memoryControlFor, type SelfInterestOwnerCommand, type SelfInterestProposal } from '@shannon/cognition';
import type { MemoryOpHandler, MemoryTargets } from './memoryOps.js';

export const selfInterestHandlers = {
  'self.interest.propose': {
    revision: (targets, op) => targets.selfInterests?.revision(op.scopeKey) ?? 'off',
    blocked: targets => targets.selfInterests ? null : 'no_store',
    apply: (targets, op) => {
      const code = targets.selfInterests!.proposeWithin(op.scopeKey,
        { ...op.payload, candidateId: op.opId, evidenceRefs: op.episodeIds, disclosure: op.disclosure } as unknown as SelfInterestProposal, targets.now());
      return code === 'proposed' ? code : { status: 'rejected' as const, code };
    },
  },
  'self.interest.night': {
    revision: (targets, op) => targets.selfInterests?.revision(op.scopeKey) ?? 'off',
    blocked: targets => targets.selfInterests ? null : 'no_store',
    apply: (targets, op) => targets.selfInterests!.nightWithin(op.scopeKey, targets.now()),
  },
  'self.interest.owner': {
    revision: (targets, op) => targets.selfInterests?.revision(op.scopeKey) ?? 'off',
    blocked: (targets, op) => !targets.selfInterests ? 'no_store' : op.origin !== 'owner' ? 'owner_only' : null,
    apply: (targets, op) => {
      const code = targets.selfInterests!.ownerWithin(op.scopeKey, op.payload as unknown as SelfInterestOwnerCommand, targets.now());
      if (code === 'changed' && op.payload.action === 'forget') {
        const item = targets.selfInterests!.ownerResultWithin(op.scopeKey, String(op.payload.operationId));
        if (item) targets.state.apply(op.scopeKey, { type: 'memory-control-upserted', control: { memoryId: item.id, kind: 'interest',
          status: 'forgotten', pinned: item.pinned, updatedAt: targets.now(), changeReason: 'self_interest_forget',
          contextInvalidatedAt: targets.now(), withheldText: `${item.title}\n${item.description}\n${item.reason}` } });
      }
      return code === 'changed' ? code : { status: 'rejected' as const, code };
    },
  },
} satisfies Record<string, MemoryOpHandler>;

const SELF_INTEREST_KINDS = Object.freeze(Object.keys(selfInterestHandlers));

/** OFF suspends durable self operations; a missing port is not a permanent refusal of their original intent. */
export function deferredSelfInterestKinds(targets: Pick<MemoryTargets, 'selfInterests'>): readonly string[] {
  return targets.selfInterests ? [] : SELF_INTEREST_KINDS;
}

/** ON never treats an unverified old op as an owner observation. OFF keeps the original path. */
export const interestChangeHandler: MemoryOpHandler = {
  revision: (targets, op) => {
    const title = String(op.payload.interest);
    const state = targets.state.snapshot(op.scopeKey);
    const original = [state.interests.includes(title), memoryControlFor(state, memoryIdentifier('interest', title)) ?? null];
    return createHash('sha256').update(JSON.stringify(targets.selfInterests ? [...original, targets.selfInterests.revision(op.scopeKey)] : original)).digest('hex').slice(0, 24);
  },
  blocked: (targets, op, state) => {
    const title = String(op.payload.interest);
    const control = memoryControlFor(state, memoryIdentifier('interest', title));
    if (control && control.status !== 'active') return 'forgotten';
    return null;
  },
  apply: (targets, op) => {
    const { interest, source } = op.payload as { interest: string; source?: 'conversation' | 'sleep' };
    if (targets.selfInterests && !targets.selfInterests.ownerObservationAllowed(op.scopeKey, interest, op.episodeIds)) {
      const code = targets.selfInterests.holdUnverifiedWithin(op.scopeKey, { candidateId: op.opId, kind: 'add', title: interest,
        description: '', reason: '由来を確認できない旧関心候補', evidenceRefs: op.episodeIds, disclosure: op.disclosure }, targets.now());
      return { status: 'superseded', code };
    }
    targets.state.apply(op.scopeKey, { type: 'interest-observed', interest, ...(source ? { source } : {}) });
    if (source === 'sleep') targets.refreshProfile?.(op.scopeKey);
    return 'written';
  },
};
