import { isShannonEmotionKind, restoreCompanionState, type CompanionStateSnapshot, type MemoryDisclosure, type ShannonMessageEmotion } from '@shannon/cognition';
import type { BackgroundJobPayload } from '../../mind/sleep/store/backgroundJobStore.js';
import type { ShannonGeneratedArtifact, ShannonTaskDecision } from '../models/chatModel.js';
import { boundedRecalledMemoryIds, type ShannonSourceAttribution, type StoredConversationMessage } from '../../mind/memory/store/conversationStore.js';
import { reminderReference, type ReminderReference } from '../../mind/memory/store/turnCaptures.js';

export interface MessageRow { message_id: string; thread_id: string; turn_id: string; role: string; content: string; observed_at: string; metadata_json: string | null; }
export interface TurnPayload { source?: string; readSourceIds?: readonly string[]; userMessage: string; shannonReply: string; summary: string; timeZone?: string; capturedStateVersion?: number; messageEmotion?: ShannonMessageEmotion; taskDecision?: ShannonTaskDecision; recalledMemoryIds?: readonly string[]; disclosure?: MemoryDisclosure; }
export interface MessageMetadata { noteOwnerAlone?: boolean; stateVersion?: number; messageEmotion?: ShannonMessageEmotion; taskDecision?: ShannonTaskDecision; artifacts?: readonly ShannonGeneratedArtifact[]; sourceAttribution?: ShannonSourceAttribution; studyPiece?: { id: string; title: string }; reminder?: ReminderReference; recalledMemoryIds?: readonly string[]; bodyLook?: { id: string; outcome: 'seen' | 'not_seen' }; }

export function parseSnapshot(raw: string, expectedScopeKey: string, nowIso: string): CompanionStateSnapshot {
  return restoreCompanionState(expectedScopeKey, parseJson(raw), nowIso);
}

export function freezeStoredMessage(row: MessageRow): StoredConversationMessage {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const metadata = row.metadata_json ? parseMessageMetadata(row.metadata_json) : null;
  return Object.freeze({
    id: row.message_id,
    sourceExperienceId: row.turn_id,
    role,
    content: row.content,
    observedAt: row.observed_at,
    ...(typeof metadata?.noteOwnerAlone === 'boolean' ? {noteOwnerAlone:metadata.noteOwnerAlone} : {}),
    ...(metadata?.messageEmotion ? { messageEmotion: Object.freeze({ ...metadata.messageEmotion }) } : {}),
    ...(metadata?.stateVersion !== undefined ? { stateVersion: metadata.stateVersion } : {}),
    ...(metadata?.taskDecision ? { taskDecision: Object.freeze({ ...metadata.taskDecision }) } : {}),
    ...(metadata?.artifacts?.length ? {
      artifacts: Object.freeze(metadata.artifacts.map(artifact => Object.freeze({ ...artifact }))),
    } : {}),
    ...(metadata?.sourceAttribution ? {
      sourceAttribution: Object.freeze({ ...metadata.sourceAttribution }),
    } : {}),
    ...(metadata?.studyPiece ? { studyPiece: Object.freeze({ ...metadata.studyPiece }) } : {}),
    ...(metadata?.reminder ? { reminder: Object.freeze({ ...metadata.reminder }) } : {}),
    ...(metadata?.bodyLook ? { bodyLook: Object.freeze({ ...metadata.bodyLook }) } : {}),
    ...(metadata?.recalledMemoryIds ? { recalledMemoryIds: metadata.recalledMemoryIds } : {}),
  });
}

export function parseMessageMetadata(raw: string): MessageMetadata | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as MessageMetadata;
  return {
    ...(typeof row.noteOwnerAlone === 'boolean' ? {noteOwnerAlone:row.noteOwnerAlone} : {}),
    ...(Number.isSafeInteger(row.stateVersion) ? { stateVersion: row.stateVersion } : {}),
    ...(validMessageEmotion(row.messageEmotion) ? { messageEmotion: storedMessageEmotion(row.messageEmotion) } : {}),
    ...(validTaskDecision(row.taskDecision) ? { taskDecision: row.taskDecision } : {}),
    ...(validGeneratedArtifacts(row.artifacts) ? { artifacts: row.artifacts } : {}),
    ...(validSourceAttribution(row.sourceAttribution) ? { sourceAttribution: row.sourceAttribution } : {}),
    ...(validStudyPiece(row.studyPiece) ? { studyPiece: { id: row.studyPiece.id, title: row.studyPiece.title } } : {}),
    ...(validBodyLook(row.bodyLook) ? { bodyLook: { id: row.bodyLook.id, outcome: row.bodyLook.outcome } } : {}),
    // Every reminder already stores its initiative source reference, so older rows resolve too.
    ...(reminderReference((value as { sourceItemId?: unknown }).sourceItemId)
      ? { reminder: reminderReference((value as { sourceItemId?: unknown }).sourceItemId)! } : {}),
    ...(boundedRecalledMemoryIds(row.recalledMemoryIds) ? { recalledMemoryIds: boundedRecalledMemoryIds(row.recalledMemoryIds)! } : {}),
  };
}

function validBodyLook(value: unknown): value is { id: string; outcome: 'seen' | 'not_seen' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as { id?: unknown; outcome?: unknown };
  return typeof row.id === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(row.id) && (row.outcome === 'seen' || row.outcome === 'not_seen');
}

export function validStudyPiece(value: unknown): value is { id: string; title: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as { id?: unknown; title?: unknown };
  return typeof row.id === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(row.id) && typeof row.title === 'string' && row.title.length <= 120;
}

export function validSourceAttribution(value: unknown): value is ShannonSourceAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonSourceAttribution>;
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) return false;
  if (typeof row.url !== 'string' || row.url.length > 2_000) return false;
  if (typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500) return false;
  try {
    const url = new URL(row.url);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validGeneratedArtifacts(value: unknown): value is readonly ShannonGeneratedArtifact[] {
  if (!Array.isArray(value) || value.length > 2) return false;
  let totalCharacters = 0;
  return value.every(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Partial<ShannonGeneratedArtifact>;
    totalCharacters += typeof row.content === 'string' ? row.content.length : 0;
    return typeof row.name === 'string'
      && row.name.length > 0 && row.name.length <= 120
      && !/[\\/\u0000-\u001F\u007F]/u.test(row.name)
      && typeof row.mimeType === 'string'
      && ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/x-source-code'].includes(row.mimeType)
      && typeof row.content === 'string' && row.content.length <= 12_000
      && totalCharacters <= 18_000
      && (row.summary === undefined || (typeof row.summary === 'string' && row.summary.length <= 160));
  });
}

export function validTaskDecision(value: unknown): value is ShannonTaskDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonTaskDecision>;
  return (row.disposition === 'none' || row.disposition === 'clarify' || row.disposition === 'propose')
    && typeof row.reason === 'string'
    && row.reason.length > 0
    && row.reason.length <= 500;
}

export function parseTurnPayload(raw: string): TurnPayload | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<TurnPayload>;
  if (typeof row.userMessage !== 'string'
    || typeof row.shannonReply !== 'string'
    || typeof row.summary !== 'string') return null;
  return row as TurnPayload;
}

export function parseBackgroundJobPayload(raw: string): BackgroundJobPayload {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKGROUND_JOB_CORRUPT');
  const row = value as Partial<BackgroundJobPayload> & Record<string, unknown>;
  if (row.kind === 'turn-refinement'
    && typeof row.experienceId === 'string'
    && typeof row.userMessage === 'string') {
    return { kind: row.kind, experienceId: row.experienceId, userMessage: row.userMessage,
      ...(typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt)) ? { observedAt: row.observedAt } : {}),
      ...(typeof row.timeZone === 'string' ? { timeZone: row.timeZone } : {}),
    };
  }
  if (row.kind === 'sleep-consolidation'
    && typeof row.dayKey === 'string'
    && typeof row.startAt === 'string'
    && typeof row.endAt === 'string') {
    return { kind: row.kind, dayKey: row.dayKey, startAt: row.startAt, endAt: row.endAt };
  }
  throw new Error('BACKGROUND_JOB_CORRUPT');
}

export function validMessageEmotion(value: unknown): value is ShannonMessageEmotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonMessageEmotion>;
  return typeof row.valence === 'number'
    && typeof row.arousal === 'number'
    && typeof row.openness === 'number'
    && typeof row.expression === 'string';
}

/** A stored face as it is returned: a `kind` this server does not know (a row written by a newer one) is left out, the face stays. */
function storedMessageEmotion(emotion: ShannonMessageEmotion): ShannonMessageEmotion {
  if (emotion.kind === undefined || isShannonEmotionKind(emotion.kind)) return emotion;
  const { kind: _unknown, ...face } = emotion;
  return face;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('SHANNON_DATABASE_JSON_CORRUPT');
  }
}

export function conciseThreadTitle(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新しいトーク';
  return cleaned.length <= 30 ? cleaned : `${cleaned.slice(0, 27)}…`;
}

export function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}
