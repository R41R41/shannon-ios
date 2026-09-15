import type { CompanionStateEvent } from '@shannon/cognition';
import type { AgentCommandType, AgentPlanItem, HostAgentEvent } from './agentTaskStore.js';
import type { ShannonChatAttachment, ShannonWebSource } from './chatModel.js';
import type { ApiResponse } from './contracts.js';
import type { MemoryAction } from './memoryService.js';
import type { VoyagerTaskProjection } from './organize.js';

export function objectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validScopeKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

export function validEvent(value: unknown): value is CompanionStateEvent {
  if (!objectBody(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'emotion-adjusted':
      return objectBody(value.delta)
        && optionalFiniteNumber(value.delta.valence)
        && optionalFiniteNumber(value.delta.arousal)
        && optionalFiniteNumber(value.delta.openness);
    case 'interest-observed':
      return typeof value.interest === 'string' && value.interest.trim().length > 0;
    case 'user-fact-upserted':
      return objectBody(value.fact)
        && typeof value.fact.id === 'string'
        && typeof value.fact.statement === 'string'
        && typeof value.fact.observedAt === 'string'
        && typeof value.fact.confidence === 'number'
        && Number.isFinite(value.fact.confidence);
    case 'relationship-upserted':
      return objectBody(value.relationship)
        && typeof value.relationship.id === 'string'
        && typeof value.relationship.statement === 'string'
        && typeof value.relationship.observedAt === 'string'
        && typeof value.relationship.confidence === 'number'
        && Number.isFinite(value.relationship.confidence);
    case 'memory-control-upserted':
      return objectBody(value.control)
        && typeof value.control.memoryId === 'string'
        && validMemoryKind(value.control.kind)
        && validMemoryStatus(value.control.status)
        && typeof value.control.pinned === 'boolean'
        && typeof value.control.updatedAt === 'string'
        && typeof value.control.changeReason === 'string';
    case 'memory-activated':
      return validActiveMemory(value.memory);
    case 'active-memories-replaced':
      return Array.isArray(value.memories) && value.memories.every(validActiveMemory);
    case 'memory-deactivated':
      return typeof value.memoryId === 'string' && value.memoryId.length > 0;
    default:
      return false;
  }
}

export function validActiveMemory(value: unknown): boolean {
  return objectBody(value)
    && typeof value.id === 'string'
    && typeof value.summary === 'string'
    && typeof value.observedAt === 'string'
    && typeof value.relevance === 'number'
    && Number.isFinite(value.relevance);
}

export function validThreadTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
}

export function validAgentHostHint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/u.test(value.trim());
}

export function validVoyagerTaskProjection(value: unknown): value is VoyagerTaskProjection {
  return objectBody(value)
    && validBoundedString(value.id, 160)
    && validBoundedString(value.title, 500)
    && typeof value.details === 'string'
    && value.details.length <= 1_000
    && validBoundedString(value.status, 80)
    && Array.isArray(value.projectIds)
    && value.projectIds.length <= 12
    && value.projectIds.every(id => validBoundedString(id, 160))
    && Number.isInteger(value.revision)
    && Number(value.revision) >= 1
    && validBoundedString(value.updatedAt, 80);
}

export function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export function validMemoryKind(value: unknown): boolean {
  return value === 'user-fact' || value === 'interest' || value === 'experience' || value === 'relationship';
}

export function validMemoryStatus(value: unknown): boolean {
  return value === 'active' || value === 'forgotten' || value === 'rejected';
}

export function validMemoryAction(value: unknown): value is MemoryAction {
  return value === 'correct' || value === 'forget' || value === 'pin'
    || value === 'unpin' || value === 'reject' || value === 'restore';
}

export function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', message } };
}

export function appendWebSources(reply: string, sources: readonly ShannonWebSource[]): string {
  if (!sources.length) return reply;
  const links = sources.map(source => `- [${source.title}](${source.url})`);
  return `${reply.trim()}\n\n### 参照した情報源\n${links.join('\n')}`;
}

export function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

const allowedChatAttachmentMimeTypes = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
  'text/x-swift', 'text/javascript', 'text/typescript', 'text/jsx',
  'text/x-python', 'text/x-ruby', 'text/x-shellscript',
  'application/json', 'application/xml', 'application/yaml', 'application/sql',
]);

export function validatedChatAttachments(value: unknown): ShannonChatAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) return null;
  let total = 0;
  const names = new Set<string>();
  const result: ShannonChatAttachment[] = [];
  for (const item of value) {
    if (!objectBody(item)
      || !validBoundedString(item.name, 180)
      || names.has(item.name)
      || typeof item.mimeType !== 'string'
      || !allowedChatAttachmentMimeTypes.has(item.mimeType)
      || typeof item.text !== 'string'
      || !item.text.trim()
      || item.text.length > 24_000
      || item.text.includes('\0')) return null;
    total += item.text.length;
    if (total > 48_000) return null;
    names.add(item.name);
    result.push({ name: item.name, mimeType: item.mimeType, text: item.text });
  }
  return result;
}

export function validPlan(value: unknown): value is AgentPlanItem[] {
  return Array.isArray(value) && value.length <= 50 && value.every(item => objectBody(item)
    && validBoundedString(item.id, 160)
    && validBoundedString(item.title, 500)
    && ['pending', 'running', 'completed'].includes(String(item.status)));
}

export function validAgentCommandType(value: unknown): value is AgentCommandType {
  return ['steer', 'interrupt', 'resume', 'resolve_approval'].includes(String(value));
}

export function validHostEvents(value: unknown): value is HostAgentEvent[] {
  const types = ['started', 'progress', 'output', 'approval_requested', 'paused', 'completed', 'failed', 'command_completed'];
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(event => objectBody(event)
    && validBoundedString(event.eventId, 160)
    && validBoundedString(event.taskId, 160)
    && types.includes(String(event.type))
    && validBoundedString(event.title, 500)
    && validBoundedString(event.occurredAt, 80)
    && (event.detail === undefined || (typeof event.detail === 'string' && event.detail.length <= 4_000))
    && (event.payload === undefined || objectBody(event.payload)));
}
