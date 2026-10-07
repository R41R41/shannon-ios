import { createHash } from 'node:crypto';
import {
  disclosureFor, isMemoryEvidenceVisible, memoryControlFor, memoryIdentifier, visibleMemoryText,
  type CompanionStateSnapshot, type CompanionStateStore, type KnowledgeDraft, type MemoryAudience, type MemoryDisclosure,
  type MemoryLearningSource, type ProspectiveMemory, type RelationshipInsight, type UserFact,
} from '@shannon/cognition';
import type { MemoryOp, MemoryOpKind } from './memoryOpCodec.js';
import type { ConversationStore, ReplaySummaryRecord } from './store/conversationStore.js';
import type { ShannonKnowledgeStore } from './store/sqliteShannonKnowledge.js';
import type { PeopleMemoryStore, PersonCall, PersonMemoryItem } from './store/peopleMemoryStore.js';
import type { TurnCaptureRecord } from './store/turnCaptures.js';
import type { ImpressionStore } from './impressions.js';
import { impressionMemoryId } from './impressions.js';
import type { ReplaySummaryCall, ReplaySummaryOutcome } from './conversationReplaySummary.js';
import { MemoryWithholding } from './memoryVisibility.js';
import { periodSummaryText, personMemoryId } from './peopleMemory.js';

/**
 * What one memory op does (Syzygy ADR-0008 stage 3, step F5, `docs/mind-workspace-contract.md`): for each closed kind, the
 * revision of its subject (for the writer's compare-and-set), what it computes outside the lock (with a model call through the
 * writer's cache, where it needs one), what of the owner's controls stops it now, and the write itself. `applyMemoryOp` is the
 * one write path: the writer calls it under its lock, and so do the owner's commands, synchronously.
 */
export interface MemoryTargets {
  state: CompanionStateStore;
  conversations: ConversationStore;
  knowledge?: ShannonKnowledgeStore | null;
  impressions?: ImpressionStore | null;
  people?: PeopleMemoryStore | null;
  /** After a fact the sleep batch learned: the owner's profile and its prompt are written again, as the sleep batch did. */
  refreshProfile?: (scopeKey: string) => void;
  /** The replay summary's reading and model calls (`ConversationReplaySummarizer.planned`), through the writer's cache. */
  replaySummaries?: {
    planned(scopeKey: string, threadId: string, call: ReplaySummaryCall): Promise<{ outcome: ReplaySummaryOutcome; record?: ReplaySummaryRecord }>;
  } | null;
  /** Her impressions' rules re-applied to the person's rows as they are now (`impressionUpdater.ts`). */
  impressionChange?: ((op: MemoryOp, state: CompanionStateSnapshot) => { upserts: readonly unknown[]; deleteIds: readonly string[] } | null) | null;
  /** The clock of the writes. */
  now: () => string;
}

/** A model call through the writer's cache: the same request is answered from the cache, a failure throws. */
export type MemoryModelCall = <T>(purpose: string, request: unknown, call: () => Promise<T | null>) => Promise<T>;

/** What `prepare` answers: a plan to write, or an outcome that ends the op without a write. */
export type MemoryPlan = { write: unknown } | { done: 'applied' | 'superseded' | 'rejected'; code: string };

export interface MemoryOpHandler {
  revision(targets: MemoryTargets, op: MemoryOp): string;
  prepare?(targets: MemoryTargets, op: MemoryOp, model: MemoryModelCall, state: CompanionStateSnapshot): Promise<MemoryPlan>;
  /** A closed code when the owner's controls stop the op now (under the lock), or null. */
  blocked?(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot, plan: unknown): string | null;
  /** The write (under the lock). Answers the outcome code, or a final status other than applied. */
  apply(targets: MemoryTargets, op: MemoryOp, plan: unknown): string | { status: 'superseded' | 'rejected'; code: string };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
const controlOf = (state: CompanionStateSnapshot, id: string) => memoryControlFor(state, id) ?? null;

const statementControls = (state: CompanionStateSnapshot, item: { id: string; evidence?: string }) => {
  const control = controlOf(state, item.id);
  if (control && control.status !== 'active') return 'forgotten';
  if (item.evidence && !isMemoryEvidenceVisible(state, item.evidence)) return 'forgotten';
  return null;
};

function payloadOf<T>(op: MemoryOp): T { return op.payload as unknown as T; }

const factHandler = (field: 'fact' | 'relationship', list: 'userFacts' | 'relationships', type: 'user-fact-upserted' | 'relationship-upserted'): MemoryOpHandler => ({
  revision: (targets, op) => {
    const item = payloadOf<Record<string, UserFact>>(op)[field]!;
    const state = targets.state.snapshot(op.scopeKey);
    return digest([state[list].find(entry => entry.id === item.id), controlOf(state, item.id)]);
  },
  blocked: (_targets, op, state) => statementControls(state, payloadOf<Record<string, UserFact>>(op)[field]!),
  apply: (targets, op) => {
    const payload = payloadOf<{ fact?: UserFact; relationship?: RelationshipInsight; source: MemoryLearningSource }>(op);
    if (type === 'user-fact-upserted') targets.state.apply(op.scopeKey, { type, fact: payload.fact!, source: payload.source });
    else targets.state.apply(op.scopeKey, { type, relationship: payload.relationship!, source: payload.source });
    if (payload.source === 'sleep') targets.refreshProfile?.(op.scopeKey);
    return 'written';
  },
});

const captureRevision = (targets: MemoryTargets, op: MemoryOp, captures: readonly TurnCaptureRecord[]) => {
  const turnIds = [...new Set(captures.map(capture => capture.turnId))];
  const ids = new Set(captures.map(capture => capture.id));
  return digest(targets.conversations.turnCaptures?.(op.scopeKey, turnIds).filter(capture => ids.has(capture.id)) ?? []);
};

const capturesOf = (op: MemoryOp): readonly TurnCaptureRecord[] =>
  op.kind === 'intent.capture' ? [payloadOf<{ capture: TurnCaptureRecord }>(op).capture] : payloadOf<{ captures: TurnCaptureRecord[] }>(op).captures;

const captureHandler: MemoryOpHandler = {
  revision: (targets, op) => captureRevision(targets, op, capturesOf(op)),
  apply: (targets, op) => {
    const captures = capturesOf(op);
    if (!targets.conversations.recordTurnCaptures) return { status: 'rejected', code: 'no_store' };
    targets.conversations.recordTurnCaptures(op.scopeKey, captures);
    return 'written';
  },
};

interface PersonPayload {
  callId: string; mode: 'replace' | 'upsert'; items: Array<Omit<PersonMemoryItem, 'callId'> & { validAt?: string; episodeIds?: string[] }>;
  call?: PersonCall; summary?: { label: string; audience: MemoryAudience; at: string; text?: string };
}

const personRevision = (targets: MemoryTargets, op: MemoryOp) => {
  const people = targets.people;
  if (!people) return 'none';
  const payload = payloadOf<PersonPayload>(op);
  const call = people.call(op.scopeKey, payload.callId);
  const items = people.items(op.scopeKey).filter(item => item.callId === payload.callId).map(item => [item.id, item.text, item.disclosure.decidedBy ?? null]);
  const personIds = [...new Set([...(call?.personIds ?? []), ...(payload.call?.personIds ?? []), ...payload.items.flatMap(item => item.personId ?? [])])];
  return digest([call?.status ?? null, call?.personIds ?? null, items, personIds.map(id => people.person(op.scopeKey, id)?.forgottenAt ?? null)]);
};

/** The items that may still be written: their person is known and not forgotten, and the owner did not forget the item. */
function writableItems(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot): PersonPayload['items'] {
  const people = targets.people!;
  const payload = payloadOf<PersonPayload>(op);
  return payload.items.filter(item => {
    const ids = [...(item.personId ? [item.personId] : []), ...(item.disclosure.audience?.kind === 'people' ? item.disclosure.audience.personIds : [])];
    if (ids.some(id => { const person = people.person(op.scopeKey, id); return !person || Boolean(person.forgottenAt); })) return false;
    return visibleMemoryText(state, personMemoryId(item.id), item.text) !== null;
  });
}

const personHandler: MemoryOpHandler = {
  revision: personRevision,
  blocked: (targets, op) => {
    if (!targets.people) return 'no_store';
    // 「今回は残さない」 wins over anything proposed of that period.
    return targets.people.call(op.scopeKey, payloadOf<PersonPayload>(op).callId)?.status === 'discarded' ? 'discarded' : null;
  },
  apply: (targets, op) => {
    const people = targets.people!;
    const payload = payloadOf<PersonPayload>(op);
    const state = targets.state.snapshot(op.scopeKey);
    if (payload.call) people.saveCall(op.scopeKey, payload.call);
    const items = writableItems(targets, op, state).map(({ validAt: _valid, episodeIds: _episodes, ...item }) => item);
    if (payload.mode === 'replace') people.replaceCallItems(op.scopeKey, payload.callId, items);
    else if (items.length) people.upsertCallItems(op.scopeKey, payload.callId, items);
    if (payload.summary) {
      const text = periodSummaryText(people, op.scopeKey, payload.callId, payload.summary.label, payload.summary.text);
      if (text !== null) {
        people.upsertCallItems(op.scopeKey, payload.callId, [{ id: text.id, kind: 'summary', text: text.text, observedAt: payload.summary.at,
          disclosure: disclosureFor(text.text, payload.summary.audience) }]);
      }
    }
    return items.length === payload.items.length ? 'written' : 'written_partly';
  },
};

type LinkPayload = { action: 'merge'; personId: string; intoPersonId: string } | { action: 'rename'; personId: string; displayName: string };

const linkHandler: MemoryOpHandler = {
  revision: (targets, op) => {
    const payload = payloadOf<LinkPayload>(op);
    const ids = payload.action === 'merge' ? [payload.personId, payload.intoPersonId] : [payload.personId];
    return digest(ids.map(id => targets.people?.person(op.scopeKey, id) ?? null));
  },
  apply: (targets, op) => {
    const people = targets.people;
    if (!people) return { status: 'rejected', code: 'no_store' };
    const payload = payloadOf<LinkPayload>(op);
    const at = targets.now();
    if (payload.action === 'merge') return people.mergePeople(op.scopeKey, payload.intoPersonId, payload.personId, at) ? 'merged' : { status: 'superseded', code: 'not_found' };
    const person = people.person(op.scopeKey, payload.personId);
    if (!person) return { status: 'superseded', code: 'not_found' };
    return people.updatePerson(op.scopeKey, payload.personId, { displayName: payload.displayName, aliases: [...person.aliases, person.displayName] }, at)
      ? 'renamed' : { status: 'superseded', code: 'not_found' };
  },
};

const knowledgeRevision = (targets: MemoryTargets, op: MemoryOp) => {
  const id = (op.payload as { knowledgeId?: string }).knowledgeId;
  if (!id) return 'new';
  const document = targets.knowledge?.listShannonKnowledge(op.scopeKey, { includeRetired: true }).find(item => item.id === id);
  return document ? `${document.version}:${document.status}` : 'absent';
};

const knowledgeSourcesForgotten = (state: CompanionStateSnapshot, ids: readonly string[]) =>
  ids.some(id => visibleMemoryText(state, id, 'visible') === null) ? 'forgotten' : null;

const knowledgeHandler: MemoryOpHandler = {
  revision: knowledgeRevision,
  blocked: (_targets, op, state) => {
    const payload = op.payload as { draft?: KnowledgeDraft; evidence?: string[] };
    return knowledgeSourcesForgotten(state, payload.draft?.sourceExperienceIds ?? payload.evidence ?? []);
  },
  apply: (targets, op) => {
    const knowledge = targets.knowledge;
    if (!knowledge) return { status: 'rejected', code: 'no_store' };
    if (op.kind === 'knowledge.create') {
      const payload = payloadOf<{ draft: KnowledgeDraft; reason: string; at: string }>(op);
      knowledge.createShannonKnowledge(op.scopeKey, payload.draft, payload.at, payload.reason);
      return 'created';
    }
    if (op.kind === 'knowledge.update') {
      const payload = payloadOf<{ knowledgeId: string; expectedVersion: number; draft: KnowledgeDraft; reason: string; at: string }>(op);
      return knowledge.updateShannonKnowledge(op.scopeKey, payload.knowledgeId, payload.expectedVersion, payload.draft, payload.at, payload.reason)
        ? 'updated' : { status: 'superseded', code: 'version_changed' };
    }
    const payload = payloadOf<{ knowledgeId: string; reason: string; at: string; evidence: string[] }>(op);
    return knowledge.retireShannonKnowledge(op.scopeKey, payload.knowledgeId, payload.reason, payload.at, payload.evidence)
      ? 'retired' : { status: 'superseded', code: 'not_found' };
  },
};

const replayHandler: MemoryOpHandler = {
  revision: (targets, op) => {
    const { threadId } = payloadOf<{ threadId: string }>(op);
    const stored = targets.conversations.replaySummary?.(op.scopeKey, threadId);
    return digest(stored ? [stored.coveredThroughMessageId, stored.updatedAt, stored.chainStartedAt] : null);
  },
  prepare: async (targets, op, model) => {
    const summaries = targets.replaySummaries;
    if (!summaries) return { done: 'rejected', code: 'disabled' };
    const { threadId } = payloadOf<{ threadId: string }>(op);
    const planned = await summaries.planned(op.scopeKey, threadId, model);
    if (planned.record) return { write: planned.record };
    // Nothing to write: the summary is current, or the budget is spent (the next turn proposes again), or there is no model.
    return planned.outcome === 'current' ? { done: 'applied', code: 'current' } : { done: 'superseded', code: planned.outcome };
  },
  blocked: (targets, op, state, plan) => {
    const { threadId } = payloadOf<{ threadId: string }>(op);
    // A forget that came while the model ran: the summary it would write is not written.
    return new MemoryWithholding(state, targets.conversations, op.scopeKey).withholdsReplaySummary(threadId, plan as ReplaySummaryRecord) ? 'forgotten' : null;
  },
  apply: (targets, op, plan) => {
    const { threadId } = payloadOf<{ threadId: string }>(op);
    if (!targets.conversations.saveReplaySummary) return { status: 'rejected', code: 'no_store' };
    targets.conversations.saveReplaySummary(op.scopeKey, threadId, plan as ReplaySummaryRecord);
    return 'updated';
  },
};

const impressionRevision = (targets: MemoryTargets, op: MemoryOp) => {
  const personKey = (op.payload as { personKey: string }).personKey;
  const rows = targets.impressions?.impressions(op.scopeKey, { personKey }) ?? [];
  const state = targets.state.snapshot(op.scopeKey);
  // The owner's controls on her impressions of this person decide what may be learned: they are part of the revision.
  return digest(rows.map(row => [row.id, row.updatedAt, controlOf(state, impressionMemoryId(row.id))]));
};

const impressionHandler: MemoryOpHandler = {
  revision: impressionRevision,
  prepare: async (targets, op, _model, state) => {
    if (!targets.impressions || !targets.impressionChange) return { done: 'rejected', code: 'disabled' };
    const change = targets.impressionChange(op, state);
    return change ? { write: change } : { done: 'superseded', code: 'unusable' };
  },
  blocked: (targets, op) => {
    const { lane, personKey } = payloadOf<{ lane: 'owner' | 'platform'; personKey: string }>(op);
    if (lane === 'platform') {
      const person = targets.people?.person(op.scopeKey, personKey);
      if (!person || person.forgottenAt) return 'forgotten';
    }
    return null;
  },
  apply: (targets, op, plan) => {
    const change = plan as { upserts: Parameters<ImpressionStore['saveImpressions']>[1]; deleteIds: readonly string[] };
    targets.impressions!.saveImpressions(op.scopeKey, change.upserts, change.deleteIds);
    return change.upserts.length || change.deleteIds.length ? 'updated' : 'unchanged';
  },
};

const impressionMergeHandler: MemoryOpHandler = {
  revision: impressionRevision,
  blocked: (targets, op, state) => {
    const { keepId } = payloadOf<{ keepId: string }>(op);
    return (controlOf(state, impressionMemoryId(keepId))?.status ?? 'active') !== 'active' ? 'forgotten' : null;
  },
  apply: (targets, op) => {
    const { personKey, keepId, mergedIds } = payloadOf<{ personKey: string; keepId: string; mergedIds: string[] }>(op);
    const impressions = targets.impressions;
    if (!impressions?.impression(op.scopeKey, keepId)) return { status: 'superseded', code: 'not_found' };
    const merged = mergedIds.filter(id => id !== keepId && impressions.impression(op.scopeKey, id)?.personKey === personKey);
    impressions.saveImpressions(op.scopeKey, [], merged);
    return merged.length ? 'merged' : 'unchanged';
  },
};

const HANDLERS: Readonly<Record<MemoryOpKind, MemoryOpHandler>> = Object.freeze({
  'fact.upsert': factHandler('fact', 'userFacts', 'user-fact-upserted'),
  'relationship.upsert': factHandler('relationship', 'relationships', 'relationship-upserted'),
  'interest.change': {
    revision: (targets, op) => {
      const { interest } = payloadOf<{ interest: string }>(op);
      const state = targets.state.snapshot(op.scopeKey);
      return digest([state.interests.includes(interest), controlOf(state, memoryIdentifier('interest', interest))]);
    },
    blocked: (_targets, op, state) => {
      const { interest } = payloadOf<{ interest: string }>(op);
      const control = controlOf(state, memoryIdentifier('interest', interest));
      return control && control.status !== 'active' ? 'forgotten' : null;
    },
    apply: (targets, op) => {
      const { interest, source } = payloadOf<{ interest: string; source?: MemoryLearningSource }>(op);
      targets.state.apply(op.scopeKey, { type: 'interest-observed', interest, ...(source ? { source } : {}) });
      if (source === 'sleep') targets.refreshProfile?.(op.scopeKey);
      return 'written';
    },
  },
  'promise.capture': {
    revision: (targets, op) => {
      const { memory } = payloadOf<{ memory: ProspectiveMemory }>(op);
      const state = targets.state.snapshot(op.scopeKey);
      return digest([state.prospectiveMemories.find(item => item.id === memory.id), controlOf(state, memory.id)]);
    },
    blocked: (_targets, op, state) => statementControls(state, payloadOf<{ memory: ProspectiveMemory }>(op).memory),
    apply: (targets, op) => {
      targets.state.apply(op.scopeKey, { type: 'prospective-memory-upserted', memory: payloadOf<{ memory: ProspectiveMemory }>(op).memory });
      return 'written';
    },
  },
  turn_capture: captureHandler,
  'intent.capture': captureHandler,
  'impression.observe': impressionHandler,
  'impression.merge': impressionMergeHandler,
  'person.summary': personHandler,
  'person.fact': personHandler,
  'person.promise': personHandler,
  'person.topic': personHandler,
  'person.link': linkHandler,
  'knowledge.create': knowledgeHandler,
  'knowledge.update': knowledgeHandler,
  'knowledge.retire': knowledgeHandler,
  'replay_summary.update': replayHandler,
});

export function memoryOpHandler(kind: MemoryOpKind): MemoryOpHandler { return HANDLERS[kind]; }

/** The revision of the op's subject now (a short digest of what the op would change and the owner's controls on it). */
export function subjectRevision(targets: MemoryTargets, op: MemoryOp): string { return HANDLERS[op.kind].revision(targets, op); }

/**
 * Whether the owner's controls stop the op now: an episode it came from that he forgot (a turn, a person memory) stops every
 * kind; then the kind's own check.
 */
export function memoryOpBlocked(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot, plan: unknown): string | null {
  for (const episode of op.episodeIds) if (visibleMemoryText(state, episode, 'visible') === null) return 'forgotten';
  return HANDLERS[op.kind].blocked?.(targets, op, state, plan) ?? null;
}

/**
 * The one write of an op: the owner's controls checked again, then the kind's write. Called under the writer's lock (and by the
 * owner's synchronous commands under the same lock). Answers the final status and its code.
 */
export function applyMemoryOp(targets: MemoryTargets, op: MemoryOp, plan: unknown): { status: 'applied' | 'superseded' | 'rejected'; code: string } {
  const blocked = memoryOpBlocked(targets, op, targets.state.snapshot(op.scopeKey), plan);
  if (blocked) return { status: blocked === 'no_store' ? 'rejected' : 'superseded', code: blocked };
  const outcome = HANDLERS[op.kind].apply(targets, op, plan);
  return typeof outcome === 'string' ? { status: 'applied', code: outcome } : outcome;
}

/** The label a proposer gives a person item it builds (kept here so the writer and the proposers agree). */
export function personItemDisclosure(text: string, audience: MemoryAudience | undefined, force?: 'third_party'): MemoryDisclosure {
  return disclosureFor(text, audience, force ? { force } : {});
}
