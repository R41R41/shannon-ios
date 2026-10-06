import type { ShannonConversationItem } from '../../chatModel.js';
import type { StoredConversationMessage } from '../../mind/memory/store/conversationStore.js';
import type {
  OrganizeItem,
  OrganizeOperation,
  OrganizeSession,
  OrganizeTaskDraft,
  OrganizeUpdateField,
  VoyagerProjectProjection,
  VoyagerTaskProjection,
} from './organize.js';

export function isOrganizeCommand(value: string): boolean {
  return value.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '').trim() === '整理して';
}

export function isExplicitVoyagerUpdateRequest(value: string): boolean {
  return explicitVoyagerUpdateDraft([{ role: 'user', content: value }]) !== undefined;
}

export function explicitVoyagerUpdateDraft(messages: readonly ShannonConversationItem[]): OrganizeTaskDraft | undefined {
  const last = [...messages].reverse().find(message => message.role === 'user' && !isOrganizeCommand(message.content));
  if (!last) return undefined;
  const text = last.content.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = text.match(/^Voyagerにある[「"](.{1,160}?)[」"]の詳細を[「"]([\s\S]{1,1000}?)[」"]に更新して(?:、|,|して|、?\s*)?(.*)$/u);
  if (!match) return undefined;
  const targetQuery = requiredBounded(match[1] ?? '', 160, 'targetQuery');
  const details = bounded(match[2] ?? '', 1_000);
  if (!details) return undefined;
  const remainder = match[3] ?? '';
  const projectSelectionRequired = /(?:Project|プロジェクト).{0,40}(?:選|割り当て)/iu.test(remainder);
  return {
    operation: 'update',
    targetQuery,
    title: targetQuery,
    details,
    updateFields: projectSelectionRequired ? ['details', 'projectIds'] : ['details'],
    projectSelectionRequired,
  };
}

export function messagesAfterCursor(messages: readonly StoredConversationMessage[], cursor?: string): StoredConversationMessage[] {
  if (!cursor) return [...messages];
  const index = messages.findIndex(message => message.id === cursor);
  return index < 0 ? [...messages] : messages.slice(index + 1);
}

export class OrganizeError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryable = false) { super(code); }
}

export function bounded(value: string, limit: number): string { return value.normalize('NFC').trim().slice(0, limit); }
export function requiredBounded(value: string, limit: number, field: string): string {
  const result = bounded(value, limit); if (!result) throw new OrganizeError(`${field.toUpperCase()}_INVALID`, 400); return result;
}
export function cloneSession(session: OrganizeSession): OrganizeSession { return structuredClone(session); }
export function normalizedOperation(operation: OrganizeOperation | undefined, target: VoyagerTaskProjection | undefined): OrganizeOperation {
  return operation ?? (target ? 'update' : 'create');
}
export function operationEdit(item: OrganizeItem, edit: Partial<OrganizeTaskDraft>): Pick<OrganizeItem, 'operation' | 'target'> {
  const operation = edit.operation ?? (edit.target ? 'update' : item.operation);
  if (operation === 'create') return { operation, target: undefined };
  const target = edit.target ?? item.target;
  if (!target) throw new OrganizeError('TARGET_REQUIRED', 400);
  return { operation, target: normalizedTaskProjection(target) };
}
export function normalizedIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 12 || values.some(value => typeof value !== 'string')) {
    throw new OrganizeError('PROJECT_IDS_INVALID', 400);
  }
  return [...new Set(values.map(value => requiredBounded(value, 160, 'projectId')))];
}
export function normalizedUpdateFields(
  values: readonly OrganizeUpdateField[] | undefined,
  operation: OrganizeOperation,
  legacyDefault = true,
): OrganizeUpdateField[] {
  if (operation === 'create') return [];
  if (values === undefined || (legacyDefault && values.length === 0)) return ['title', 'details', 'projectIds'];
  if (!Array.isArray(values) || values.length > 3 || values.some(value => !['title', 'details', 'projectIds'].includes(value))) {
    throw new OrganizeError('UPDATE_FIELDS_INVALID', 400);
  }
  return [...new Set(values)];
}
export function storedUpdateFields(operation: OrganizeOperation, value: unknown): OrganizeUpdateField[] {
  if (operation === 'create') return [];
  if (typeof value !== 'string' || !value.trim()) return ['title', 'details', 'projectIds'];
  try {
    return normalizedUpdateFields(JSON.parse(value) as OrganizeUpdateField[], operation);
  } catch {
    return ['title', 'details', 'projectIds'];
  }
}
export function normalizedTaskProjection(value: VoyagerTaskProjection): VoyagerTaskProjection {
  if (!value || typeof value !== 'object') throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.details !== 'string'
    || !Array.isArray(value.projectIds) || !Number.isInteger(value.revision) || value.revision < 1
    || typeof value.status !== 'string' || typeof value.updatedAt !== 'string') {
    throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  }
  return {
    id: requiredBounded(value.id, 160, 'taskId'), title: requiredBounded(value.title, 500, 'title'),
    details: bounded(value.details ?? '', 1_000), status: requiredBounded(value.status, 80, 'status'),
    projectIds: normalizedIds(value.projectIds ?? []), revision: value.revision, updatedAt: requiredBounded(value.updatedAt, 80, 'updatedAt'),
  };
}
export function normalizedProjectProjection(value: VoyagerProjectProjection): VoyagerProjectProjection {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.title !== 'string'
    || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string') {
    throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  }
  return {
    id: requiredBounded(value.id, 160, 'projectId'), title: requiredBounded(value.title, 500, 'title'),
    revision: value.revision, updatedAt: requiredBounded(value.updatedAt, 80, 'updatedAt'),
  };
}
export function projectionItems(value: Record<string, unknown>): unknown[] {
  if (!Array.isArray(value.items)) throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  return value.items;
}
export function normalizedLimit(value: number, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
export function extractResponseText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => {
    if (!item || typeof item !== 'object' || !Array.isArray((item as { content?: unknown }).content)) return [];
    return ((item as { content: unknown[] }).content).flatMap(entry => entry && typeof entry === 'object'
      && (entry as { type?: unknown }).type === 'output_text' && typeof (entry as { text?: unknown }).text === 'string'
      ? [(entry as { text: string }).text] : []);
  }).join('');
}
