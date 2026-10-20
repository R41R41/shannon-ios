import { createHash } from 'node:crypto';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { PlatformBridgeError, type ShannonPlatform } from '../../mind/memory/platformMemoryPorts.js';
import type { SurfaceTurnLimits } from '../../mind/inhibition/minecraftTurnAllowance.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { VOICE_ROOM_LIMITS, clipVoiceText, type HeardLine } from './voiceRoom.js';
import type { ExpressionEvent } from '../../contracts/oneHeadContract.js';

/**
 * The wire form of a Discord voice channel's turn (`POST /v1/platform/voice/turn`, dc-voice, 2026-10-20): what the body sends, what
 * the stream answers with, and what is kept of an answer for a retry. `platformVoice.ts` is the service that answers it.
 */
export const SHANNON_PLATFORM_VOICE_PREFIX = '/v1/platform/voice/';

export const PLATFORM_VOICE_LIMITS = Object.freeze({
  messageCharacters: 1_000,
  /** A spoken turn is answered only while it is fresh: past this the conversation has moved on. */
  maximumAgeMilliseconds: 120_000,
  futureSkewMilliseconds: 60_000,
  participants: 50,
  heardLines: VOICE_ROOM_LIMITS.heardLines,
  replayDays: 1,
  replyCharacters: 1_200,
});

/** Spoken turns come in faster than typed ones; the owner and everyone else still count apart (`minecraftTurnAllowance.ts`). */
export const PLATFORM_VOICE_ALLOWANCE: SurfaceTurnLimits = Object.freeze({
  ownerPerMinute: 30,
  ownerPerDay: 3_000,
  speakerPerMinute: 12,
  speakerPerDay: 300,
  othersPerMinute: 30,
  othersPerDay: 800,
});

export function platformVoiceEnabled(environment: SwitchValues = serverEnvironment()): boolean {
  return switchOn(environment, 'SHANNON_DC_VOICE');
}

export interface VoiceTurnRequest {
  platform: ShannonPlatform;
  requestId: string;
  conversationId: string;
  voiceChannelId?: string;
  sourceUserId: string;
  sourceDisplayName: string;
  userMessage: string;
  observedAt: string;
  participants: string[];
  heard: HeardLine[];
  followsShannonTurn: boolean;
  speakingNow: boolean;
  /** The filler the body already began to play (it may start one without waiting for the decision line); she goes on from it. */
  fillerId?: string;
  situation?: string;
  sttMs?: number;
  utteranceMs?: number;
  /** One head (`POST /v1/converse`, never on this route's wire): a DM, and the channel's own name for a conversation nobody bound. */
  conversationKind?: 'channel' | 'dm';
  title?: string;
}

export type VoiceTurnLine =
  | { type: 'decision'; respond: boolean; reason: string; filler: { id: string; text: string } | null }
  | ExpressionEvent
  | { type: 'sentence'; index: number; text: string; voiceText?: string; correction?: true }
  | { type: 'intent'; kind: 'task_message' | 'task' | 'stop' | 'none'; delivered: boolean; taskId?: string; reason?: string }
  | { type: 'done'; reply: string; threadId: string; duplicate: boolean; silent?: true; reason?: string;
    timings?: { decisionMs: number; firstSentenceMs: number | null; totalMs: number } }
  | { type: 'error'; status: number; error: string };

/** What a retry is answered with: the words, or that she had nothing to say. */
export interface StoredVoiceTurn {
  reply: string;
  threadId: string;
  silent?: true;
  reason?: string;
  respond: boolean;
}

const REQUEST_FIELDS = new Set([
  'platform', 'requestId', 'conversationId', 'voiceChannelId', 'sourceUserId', 'sourceDisplayName', 'userMessage', 'observedAt',
  'participants', 'heard', 'followsShannonTurn', 'speakingNow', 'fillerId', 'situation', 'sttMs', 'utteranceMs',
]);

export const identifier = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);

export const bodyText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');

const milliseconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_600_000;

export const badRequest = (message: string): PlatformBridgeError => new PlatformBridgeError('BAD_REQUEST', 400, message);

export const conflict = (): PlatformBridgeError =>
  new PlatformBridgeError('PLATFORM_TURN_CONFLICT', 409, 'The requestId was already used for a different spoken turn.');

export const notBound = (): PlatformBridgeError =>
  new PlatformBridgeError('PLATFORM_CONVERSATION_DENIED', 403, 'This platform conversation is not allowlisted.');

export function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('JSON object body is required.');
  return value as Record<string, unknown>;
}

function validatedParticipants(value: unknown): string[] {
  const list = value === undefined ? [] : value;
  const valid = Array.isArray(list) && list.length <= PLATFORM_VOICE_LIMITS.participants && list.every(id => identifier(id, 160));
  if (!valid) throw badRequest('participants is invalid.');
  return (list as string[]).map(id => id.trim());
}

function validatedHeardLine(line: unknown): HeardLine {
  const item = line !== null && typeof line === 'object' && !Array.isArray(line) ? line as Record<string, unknown> : {};
  const sound = identifier(item.userId, 160) && bodyText(item.name, 80) && bodyText(item.text, 1_000);
  if (!sound || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) throw badRequest('heard is invalid.');
  return {
    userId: (item.userId as string).trim(), name: (item.name as string).trim(), text: (item.text as string).trim(),
    at: new Date(item.at).toISOString(),
  };
}

function validatedHeard(value: unknown): HeardLine[] {
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list) || list.length > PLATFORM_VOICE_LIMITS.heardLines) throw badRequest('heard is invalid.');
  return list.map(validatedHeardLine);
}

function validatedExtras(body: Record<string, unknown>): Pick<VoiceTurnRequest, 'situation' | 'sttMs' | 'utteranceMs'> {
  if (body.situation !== undefined && !bodyText(body.situation, 600)) throw badRequest('situation is invalid.');
  for (const field of ['sttMs', 'utteranceMs'] as const) {
    if (body[field] !== undefined && !milliseconds(body[field])) throw badRequest(`${field} is invalid.`);
  }
  return {
    ...(body.situation !== undefined ? { situation: clipVoiceText(body.situation as string, VOICE_ROOM_LIMITS.situationCharacters) } : {}),
    ...(body.sttMs !== undefined ? { sttMs: body.sttMs as number } : {}),
    ...(body.utteranceMs !== undefined ? { utteranceMs: body.utteranceMs as number } : {}),
  };
}

function validatedIdentity(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).find(key => !REQUEST_FIELDS.has(key));
  if (unknown) throw badRequest(`${unknown.slice(0, 40)} is not allowed.`);
  if (body.platform !== 'discord') throw badRequest('platform is invalid.');
  if (!identifier(body.requestId, 160)) throw badRequest('requestId is invalid.');
  if (!identifier(body.conversationId, 240)) throw badRequest('conversationId is invalid.');
  if (body.voiceChannelId !== undefined && !identifier(body.voiceChannelId, 160)) throw badRequest('voiceChannelId is invalid.');
  if (!identifier(body.sourceUserId, 160)) throw badRequest('sourceUserId is invalid.');
  if (!bodyText(body.sourceDisplayName, 80)) throw badRequest('sourceDisplayName is invalid.');
  if (!bodyText(body.userMessage, PLATFORM_VOICE_LIMITS.messageCharacters)) throw badRequest('userMessage is invalid.');
  if (typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))) throw badRequest('observedAt is invalid.');
  validatedFlags(body);
}

function validatedFlags(body: Record<string, unknown>): void {
  for (const flag of ['followsShannonTurn', 'speakingNow'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw badRequest(`${flag} is invalid.`);
  }
  if (body.fillerId !== undefined && !identifier(body.fillerId, 80)) throw badRequest('fillerId is invalid.');
}

export function validatedVoiceTurn(value: unknown): VoiceTurnRequest {
  const body = recordOf(value);
  validatedIdentity(body);
  const trimmed = (field: string): string => (body[field] as string).trim();
  return {
    platform: 'discord',
    requestId: trimmed('requestId'),
    conversationId: trimmed('conversationId'),
    ...(body.voiceChannelId !== undefined ? { voiceChannelId: trimmed('voiceChannelId') } : {}),
    sourceUserId: trimmed('sourceUserId'),
    sourceDisplayName: trimmed('sourceDisplayName'),
    userMessage: trimmed('userMessage'),
    observedAt: new Date(body.observedAt as string).toISOString(),
    participants: validatedParticipants(body.participants),
    heard: validatedHeard(body.heard),
    followsShannonTurn: body.followsShannonTurn === true,
    speakingNow: body.speakingNow === true,
    ...(body.fillerId !== undefined ? { fillerId: trimmed('fillerId') } : {}),
    ...validatedExtras(body),
  };
}

/** The words and who said them where; not who else is in the channel, so a retry with people coming and going still gets the answer. */
export function voiceHash(request: VoiceTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'voice', request.conversationId, request.sourceUserId, request.sourceDisplayName, request.userMessage, request.observedAt,
  ])).digest('hex');
}
