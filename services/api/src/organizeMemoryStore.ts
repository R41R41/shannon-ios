import { randomUUID, createHash } from 'node:crypto';
import type { OrganizeStore } from './organize.js';
import type {
  OrganizeDecision,
  OrganizeSession,
  OrganizeSessionState,
  OrganizeTaskDraft,
  VoyagerTaskReference,
} from './organize.js';
import {
  OrganizeError,
  bounded,
  cloneSession,
  normalizedIds,
  normalizedOperation,
  normalizedTaskProjection,
  normalizedUpdateFields,
  operationEdit,
  requiredBounded,
} from './organizeSupport.js';

export class InMemoryOrganizeStore implements OrganizeStore {
  private readonly sessions = new Map<string, OrganizeSession>();
  private readonly cursors = new Map<string, string>();

  cursor(scopeKey: string, threadId: string): string | undefined { return this.cursors.get(`${scopeKey}\u0000${threadId}`); }
  list(scopeKey: string, threadId: string): OrganizeSession[] {
    return [...this.sessions.values()].filter(session => session.scopeKey === scopeKey && session.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(cloneSession);
  }

  create(input: Pick<OrganizeSession, 'scopeKey' | 'threadId' | 'sourceMessageIds'> & { drafts: OrganizeTaskDraft[]; requestKey?: string }, now: string): OrganizeSession {
    const id = input.requestKey ? createHash('sha256').update(JSON.stringify([input.scopeKey, input.threadId, input.requestKey])).digest('hex') : randomUUID();
    const existing = this.sessions.get(id);
    if (existing) return cloneSession(existing);
    const session: OrganizeSession = {
      id, scopeKey: input.scopeKey, threadId: input.threadId,
      state: 'ready_for_review', revision: 1, sourceMessageIds: [...new Set(input.sourceMessageIds)],
      items: input.drafts.slice(0, 12).map(draft => {
        const operation = normalizedOperation(draft.operation, draft.target);
        const updateFields = normalizedUpdateFields(draft.updateFields, operation);
        return {
          id: randomUUID(), title: bounded(draft.title, 500), details: bounded(draft.details, 1_000),
          operation,
          ...(draft.target ? { target: normalizedTaskProjection(draft.target) } : {}),
          projectIds: normalizedIds(draft.projectIds ?? []),
          targetQuery: bounded(draft.targetQuery ?? draft.target?.title ?? (operation === 'update' ? draft.title : ''), 160),
          updateFields,
          projectSelectionRequired: operation === 'update' && updateFields.includes('projectIds') && draft.projectSelectionRequired === true,
          decision: 'proposed', destinationStatus: 'pending', requestId: randomUUID(), idempotencyKey: randomUUID(),
        };
      }),
      createdAt: now, updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  get(scopeKey: string, sessionId: string): OrganizeSession | undefined {
    const value = this.sessions.get(sessionId);
    return value?.scopeKey === scopeKey ? cloneSession(value) : undefined;
  }

  setCommandThrough(scopeKey: string, sessionId: string, messageId: string, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => ({ ...session, commandThroughMessageId: messageId, updatedAt: now }));
  }

  decide(scopeKey: string, sessionId: string, itemId: string, expectedRevision: number, decision: OrganizeDecision, edit: Partial<OrganizeTaskDraft>, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => {
      if (session.revision !== expectedRevision) throw new OrganizeError('REVISION_CONFLICT', 409);
      if (session.state === 'applied') throw new OrganizeError('SESSION_FINALIZED', 409);
      const index = session.items.findIndex(item => item.id === itemId);
      if (index < 0) throw new OrganizeError('ITEM_NOT_FOUND', 404);
      if (session.items[index]?.destinationStatus !== 'pending') throw new OrganizeError('ITEM_ALREADY_ATTEMPTED', 409);
      const items = session.items.map((item, position) => position === index ? {
        ...item,
        decision,
        ...(edit.title !== undefined ? { title: requiredBounded(edit.title, 500, 'title') } : {}),
        ...(edit.details !== undefined ? { details: bounded(edit.details, 1_000) } : {}),
        ...(edit.operation !== undefined || edit.target !== undefined ? operationEdit(item, edit) : {}),
        ...(edit.projectIds !== undefined ? { projectIds: normalizedIds(edit.projectIds) } : {}),
      } : item);
      const changed = items[index]!;
      if (decision === 'accepted' && changed.operation === 'update' && !changed.target) {
        throw new OrganizeError('TARGET_REQUIRED', 400);
      }
      if (decision === 'accepted' && changed.projectSelectionRequired && changed.projectIds.length === 0) {
        throw new OrganizeError('PROJECT_SELECTION_REQUIRED', 400);
      }
      return { ...session, items, revision: session.revision + 1, updatedAt: now };
    });
  }

  recordAttempt(scopeKey: string, sessionId: string, itemId: string, result: VoyagerTaskReference | undefined, errorCode: string | undefined, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => ({
      ...session, updatedAt: now,
      items: session.items.map(item => {
        if (item.id !== itemId) return item;
        const { result: _priorResult, errorCode: _priorError, ...unchanged } = item;
        return { ...unchanged, destinationStatus: result ? 'applied' : 'failed',
          ...(result ? { result } : {}), ...(errorCode ? { errorCode } : {}) };
      }),
    }));
  }

  finishApply(scopeKey: string, sessionId: string, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => {
      const failed = session.items.some(item => item.decision === 'accepted' && item.destinationStatus !== 'applied');
      const state: OrganizeSessionState = failed ? 'partially_applied' : 'applied';
      const next = { ...session, state, revision: session.revision + 1, updatedAt: now, ...(state === 'applied' ? { appliedAt: now } : {}) };
      if (state === 'applied' && session.commandThroughMessageId) {
        this.cursors.set(`${scopeKey}\u0000${session.threadId}`, session.commandThroughMessageId);
      }
      return next;
    });
  }

  private update(scopeKey: string, sessionId: string, change: (session: OrganizeSession) => OrganizeSession): OrganizeSession {
    const current = this.sessions.get(sessionId);
    if (!current || current.scopeKey !== scopeKey) throw new OrganizeError('SESSION_NOT_FOUND', 404);
    const next = change(cloneSession(current));
    this.sessions.set(sessionId, next);
    return cloneSession(next);
  }
}
