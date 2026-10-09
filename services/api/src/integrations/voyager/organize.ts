export type OrganizeDecision = 'proposed' | 'accepted' | 'rejected' | 'deferred';
export type OrganizeDestinationStatus = 'pending' | 'applied' | 'failed';
export type OrganizeSessionState = 'ready_for_review' | 'partially_applied' | 'applied';
export type OrganizeOperation = 'create' | 'update';
export type OrganizeUpdateField = 'title' | 'details' | 'projectIds';

export interface VoyagerTaskProjection {
  id: string;
  title: string;
  details: string;
  status: string;
  projectIds: string[];
  revision: number;
  updatedAt: string;
}

export interface VoyagerOpenTaskProjection extends VoyagerTaskProjection {
  dueAt: string | null;
  priority: number;
}
export interface VoyagerOpenTaskList {
  items: VoyagerOpenTaskProjection[];
  hasMore: boolean;
}

export interface VoyagerProjectProjection {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
}

export interface OrganizeTaskDraft {
  title: string;
  details: string;
  operation?: OrganizeOperation;
  target?: VoyagerTaskProjection;
  projectIds?: string[];
  targetQuery?: string;
  updateFields?: OrganizeUpdateField[];
  projectSelectionRequired?: boolean;
}

export interface VoyagerTaskReference {
  system: 'voyager';
  resourceType: 'task';
  resourceId: string;
  title: string;
  summary: string | null;
  updatedAt: string;
  href: null;
}

export interface OrganizeItem extends OrganizeTaskDraft {
  id: string;
  operation: OrganizeOperation;
  projectIds: string[];
  targetQuery: string;
  updateFields: OrganizeUpdateField[];
  projectSelectionRequired: boolean;
  decision: OrganizeDecision;
  destinationStatus: OrganizeDestinationStatus;
  requestId: string;
  idempotencyKey: string;
  result?: VoyagerTaskReference;
  errorCode?: string;
}

export interface OrganizeSession {
  id: string;
  scopeKey: string;
  threadId: string;
  state: OrganizeSessionState;
  revision: number;
  sourceMessageIds: string[];
  commandThroughMessageId?: string;
  items: OrganizeItem[];
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface OrganizeStore {
  cursor(scopeKey: string, threadId: string): string | undefined;
  list(scopeKey: string, threadId: string): OrganizeSession[];
  create(input: Pick<OrganizeSession, 'scopeKey' | 'threadId' | 'sourceMessageIds'> & { drafts: OrganizeTaskDraft[]; requestKey?: string }, now: string): OrganizeSession;
  get(scopeKey: string, sessionId: string): OrganizeSession | undefined;
  setCommandThrough(scopeKey: string, sessionId: string, messageId: string, now: string): OrganizeSession;
  decide(scopeKey: string, sessionId: string, itemId: string, expectedRevision: number, decision: OrganizeDecision, edit: Partial<OrganizeTaskDraft>, now: string): OrganizeSession;
  recordAttempt(scopeKey: string, sessionId: string, itemId: string, result: VoyagerTaskReference | undefined, errorCode: string | undefined, now: string): OrganizeSession;
  finishApply(scopeKey: string, sessionId: string, now: string): OrganizeSession;
}

export { InMemoryOrganizeStore } from './store/organizeMemoryStore.js';
export { SQLiteOrganizeStore } from './store/organizePersistence.js';
export {
  DisabledVoyagerCatalog,
  DisabledVoyagerTaskDestination,
  HttpVoyagerCatalog,
  HttpVoyagerTaskDestination,
  LocalOrganizeExtractor,
  OpenAIOrganizeExtractor,
  createConfiguredOrganizeExtractor,
  createConfiguredVoyagerCatalog,
  createConfiguredVoyagerDestination,
  type OrganizeExtractor,
  type VoyagerCatalog,
  type VoyagerTaskDestination,
} from './organizeIntegrations.js';
export {
  OrganizeError,
  explicitVoyagerUpdateDraft,
  isExplicitVoyagerUpdateRequest,
  isOrganizeCommand,
  messagesAfterCursor,
} from './organizeSupport.js';
