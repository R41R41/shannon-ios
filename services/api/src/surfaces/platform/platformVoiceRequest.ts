import { createHash } from 'node:crypto';
import { isSpeechMode, isSpeechRate, type SpeechMode, type SpeechRate } from '@shannon/mind';
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
  /** Words said over her reply are answered after the report of how far she got, for at most this long (no report: the answer goes on). */
  cutShortWaitMilliseconds: 1_000,
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

/** A place in the game as the body read it. */
export interface SpeakerPosition { x: number; y: number; z: number; dimension?: string | undefined }

export interface VoiceTurnRequest {
  platform: ShannonPlatform;
  requestId: string;
  conversationId: string;
  voiceChannelId?: string;
  sourceUserId: string;
  sourceDisplayName: string;
  /**
   * The speaker's Minecraft name, when the body knows who in the game this Discord member is (the body's Discord-to-Minecraft table). It goes
   * on to the Minecraft request (`VoiceSpeaker.minecraftName`) so that 「ここ」 and 「こっち」 can be read from where that player looks.
   */
  speakerMinecraftName?: string;
  /**
   * The body checked that the speaker is the owner (a person at the game's voice whose Minecraft account is the owner's, who has no Discord id
   * the body could give): the words are the owner's, as if they came with the owner's id (`ownerAsBound`). Present only when true.
   */
  speakerIsOwner?: boolean;
  /** Where the speaker is in the game (whole blocks), when the body read it from the world; it goes with a spoken request to the task's head. */
  speakerPosition?: SpeakerPosition;
  /** She is in the conversation's Discord call (the body knows); false: not, so 「おいで」 may bring her in. Absent: not known. */
  inCall?: boolean;
  userMessage: string;
  observedAt: string;
  participants: string[];
  heard: HeardLine[];
  followsShannonTurn: boolean;
  /**
   * The speaker pressed a key to talk (push to talk): the words were said to her, name or no name. She answers them without being named; a
   * breath or a key press with no words in it is still not a turn (`platformVoice.ts`, `addressOf`).
   */
  directed?: boolean;
  speakingNow: boolean;
  /**
   * How long ago she last finished speaking in the channel, as the body measured it (0: she is speaking now). `SHANNON_ADDRESSED` reads
   * it for the follow-up window (~20 s); without it the head's own record of her last reply is used.
   */
  shannonSpokeMsAgo?: number;
  /** The filler the body already began to play (it may start one without waiting for the decision line); she goes on from it. */
  fillerId?: string;
  situation?: string;
  /** How she speaks now and how often she speaks of her own accord (the body holds them): so that she can answer 「いまどうなってる？」 and change them from where they are. Absent: chatty, normal. */
  speechMode?: SpeechMode;
  speechRate?: SpeechRate;
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
  /** The owner asked how she speaks (from the intent field's `speech`): at least one is set. The body checks the speaker is the owner again. */
  | { type: 'speech'; mode?: SpeechMode; rate?: SpeechRate }
  /** Someone asked her to come into the Discord call (from the intent field's `call_join`): the body takes the channel the speaker is in now, else the owner's. */
  | { type: 'call'; action: 'join' }
  | { type: 'done'; reply: string; threadId: string; duplicate: boolean; silent?: true; reason?: string;
    timings?: { decisionMs: number; firstSentenceMs: number | null; totalMs: number };
    /** A typed message's answer only (rich chat §4): the emoji she put on the message she answered; the entry adds it as her reaction. */
    reaction?: string }
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
  'platform', 'requestId', 'conversationId', 'voiceChannelId', 'sourceUserId', 'sourceDisplayName', 'speakerMinecraftName', 'speakerIsOwner',
  'speakerPosition', 'inCall', 'userMessage', 'observedAt', 'participants', 'heard', 'followsShannonTurn', 'directed', 'speakingNow', 'shannonSpokeMsAgo', 'fillerId',
  'situation', 'sttMs', 'utteranceMs', 'speechMode', 'speechRate',
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

function validatedExtras(body: Record<string, unknown>): Pick<VoiceTurnRequest, 'situation' | 'sttMs' | 'utteranceMs' | 'shannonSpokeMsAgo' | 'speechMode' | 'speechRate'> {
  if (body.situation !== undefined && !bodyText(body.situation, 600)) throw badRequest('situation is invalid.');
  if (body.speechMode !== undefined && !isSpeechMode(body.speechMode)) throw badRequest('speechMode is invalid.');
  if (body.speechRate !== undefined && !isSpeechRate(body.speechRate)) throw badRequest('speechRate is invalid.');
  for (const field of ['sttMs', 'utteranceMs', 'shannonSpokeMsAgo'] as const) {
    if (body[field] !== undefined && !milliseconds(body[field])) throw badRequest(`${field} is invalid.`);
  }
  return {
    ...(body.shannonSpokeMsAgo !== undefined ? { shannonSpokeMsAgo: body.shannonSpokeMsAgo as number } : {}),
    ...(body.situation !== undefined ? { situation: clipVoiceText(body.situation as string, VOICE_ROOM_LIMITS.situationCharacters) } : {}),
    ...(body.speechMode !== undefined ? { speechMode: body.speechMode as SpeechMode } : {}),
    ...(body.speechRate !== undefined ? { speechRate: body.speechRate as SpeechRate } : {}),
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
  if (body.speakerMinecraftName !== undefined && !identifier(body.speakerMinecraftName, 80)) throw badRequest('speakerMinecraftName is invalid.');
  if (!bodyText(body.userMessage, PLATFORM_VOICE_LIMITS.messageCharacters)) throw badRequest('userMessage is invalid.');
  if (typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))) throw badRequest('observedAt is invalid.');
  validatedFlags(body);
}

function validatedFlags(body: Record<string, unknown>): void {
  for (const flag of ['followsShannonTurn', 'directed', 'speakingNow', 'speakerIsOwner', 'inCall'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw badRequest(`${flag} is invalid.`);
  }
  if (body.fillerId !== undefined && !identifier(body.fillerId, 80)) throw badRequest('fillerId is invalid.');
  if (body.speakerPosition !== undefined && validatedPosition(body.speakerPosition) === null) throw badRequest('speakerPosition is invalid.');
}

/** A position of whole or fractional blocks within the world's reach, with the dimension's name when it is given; null when it is not one. */
export function validatedPosition(value: unknown): SpeakerPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const coordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 40_000_000;
  if (!coordinate(item.x) || !coordinate(item.y) || !coordinate(item.z)) return null;
  const dimension = typeof item.dimension === 'string' && /^[a-z_:]{1,40}$/u.test(item.dimension) ? item.dimension.replace(/^minecraft:/u, '') : undefined;
  return { x: Math.round(item.x), y: Math.round(item.y), z: Math.round(item.z), ...(dimension ? { dimension } : {}) };
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
    ...(body.speakerMinecraftName !== undefined ? { speakerMinecraftName: trimmed('speakerMinecraftName') } : {}),
    ...(body.speakerIsOwner === true ? { speakerIsOwner: true } : {}),
    ...(body.speakerPosition !== undefined ? { speakerPosition: validatedPosition(body.speakerPosition)! } : {}),
    ...(typeof body.inCall === 'boolean' ? { inCall: body.inCall } : {}),
    userMessage: trimmed('userMessage'),
    observedAt: new Date(body.observedAt as string).toISOString(),
    participants: validatedParticipants(body.participants),
    heard: validatedHeard(body.heard),
    followsShannonTurn: body.followsShannonTurn === true,
    directed: body.directed === true,
    speakingNow: body.speakingNow === true,
    ...(body.fillerId !== undefined ? { fillerId: trimmed('fillerId') } : {}),
    ...validatedExtras(body),
  };
}

/**
 * The owner as the body confirmed him (`speakerIsOwner`): he carries the id the conversation is bound to, in the words and among the people
 * there, so that he is the owner and the only one there whichever id the body knew him by. Nothing changes without the mark.
 */
export function ownerAsBound(request: VoiceTurnRequest, ownerUserId: string): VoiceTurnRequest {
  if (!request.speakerIsOwner) return request;
  const people = request.participants.map(id => (id === request.sourceUserId ? ownerUserId : id));
  return { ...request, sourceUserId: ownerUserId, participants: [...new Set(people)] };
}

/** The words and who said them where; not who else is in the channel, so a retry with people coming and going still gets the answer. */
export function voiceHash(request: VoiceTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'voice', request.conversationId, request.sourceUserId, request.sourceDisplayName, request.userMessage, request.observedAt,
  ])).digest('hex');
}
