import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuthorized } from '../../infra/auth/apiAuth.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import { startStream, writeEvent } from '../../infra/http/ndjsonStream.js';
import { ONE_HEAD_CONVERSE_PATH, oneHeadEnabled, type ConversationTurn } from '../../contracts/oneHeadContract.js';
import { PlatformBridgeError } from '../../mind/memory/platformMemoryPorts.js';
import type { SwitchValues } from '@shannon/switches';
import { validatedPlatformReply, type PlatformReplyService } from './platformReply.js';
import { validatedVoiceTurn, type VoiceTurnLine } from './platformVoiceRequest.js';
import type { PlatformVoiceService } from './platformVoice.js';

/**
 * `POST /v1/converse` (one head, `SHANNON_ONE_HEAD`; owner 2026-10-20): every turn of a platform's entry in one shape
 * (`ConversationTurn`), answered as one stream of lines (`decision`, `expression`, `sentence`, `intent`, `done`, `error`). The entry only
 * hears and speaks; who is present, what she remembers and what she says are her one mind's. The bridge's service token only.
 *
 * - `modality: 'voice'`: the Discord voice channel's turn (`PlatformVoiceService`, through the one voice turn the apps use).
 * - `modality: 'text'`: a Discord message, bound or not, the owner's or anyone's (`PlatformReplyService`, the text turn); its reply is
 *   one `sentence` (a message is posted whole).
 *
 * A refusal before the first line is JSON (400, 403, 409, 429, 503); after it, an `error` line.
 */
export interface ConverseRoutes {
  token: string;
  voice: PlatformVoiceService | null;
  reply: PlatformReplyService | null;
  environment?: () => SwitchValues;
}

export function isConversePath(path: string): boolean {
  return path === ONE_HEAD_CONVERSE_PATH;
}

const TOP_FIELDS = new Set(['version', 'requestId', 'observedAt', 'modality', 'where', 'who', 'presence', 'words', 'voice']);

const badRequest = (message: string): PlatformBridgeError => new PlatformBridgeError('BAD_REQUEST', 400, message);

const objectOf = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} is invalid.`);
  return value as Record<string, unknown>;
};

/** The one shape, its frame checked; each modality's own validator checks the fields it reads (`validatedVoiceTurn`, `validatedPlatformReply`). */
export function validatedConversationTurn(value: unknown): ConversationTurn {
  const body = objectOf(value, 'body');
  const unknown = Object.keys(body).find(key => !TOP_FIELDS.has(key));
  if (unknown) throw badRequest(`${unknown.slice(0, 40)} is not allowed.`);
  if (body.version !== 1) throw badRequest('version is invalid.');
  if (body.modality !== 'voice' && body.modality !== 'text') throw badRequest('modality is invalid.');
  const where = objectOf(body.where, 'where');
  if (where.platform !== 'discord') throw badRequest('where.platform is invalid.');
  if (where.conversationKind !== 'channel' && where.conversationKind !== 'dm') throw badRequest('where.conversationKind is invalid.');
  const title = where.title;
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 80)) throw badRequest('where.title is invalid.');
  objectOf(body.who, 'who');
  const presence = objectOf(body.presence ?? { participants: [] }, 'presence');
  if (body.voice !== undefined) objectOf(body.voice, 'voice');
  return { ...body, presence } as unknown as ConversationTurn;
}

/** A spoken turn in the voice channel's request form. */
export function voiceRequestOf(turn: ConversationTurn) {
  const { presence, voice } = turn;
  const request = validatedVoiceTurn({
    platform: turn.where.platform, requestId: turn.requestId, conversationId: turn.where.conversationId,
    ...(turn.where.voiceChannelId !== undefined ? { voiceChannelId: turn.where.voiceChannelId } : {}),
    sourceUserId: turn.who.userId, sourceDisplayName: turn.who.displayName, userMessage: turn.words, observedAt: turn.observedAt,
    participants: presence.participants, heard: presence.heard, followsShannonTurn: presence.followsShannonTurn, speakingNow: presence.speakingNow,
    ...(presence.situation !== undefined ? { situation: presence.situation } : {}),
    ...(voice?.fillerId !== undefined ? { fillerId: voice.fillerId } : {}),
    ...(voice?.sttMs !== undefined ? { sttMs: voice.sttMs } : {}), ...(voice?.utteranceMs !== undefined ? { utteranceMs: voice.utteranceMs } : {}),
  });
  return { ...request, conversationKind: turn.where.conversationKind, ...(turn.where.title ? { title: turn.where.title.trim() } : {}) };
}

/** A typed message in the reply route's request form. */
export function replyRequestOf(turn: ConversationTurn) {
  const request = validatedPlatformReply({
    platform: turn.where.platform, requestId: turn.requestId, conversationId: turn.where.conversationId, conversationKind: turn.where.conversationKind,
    sourceUserId: turn.who.userId, sourceDisplayName: turn.who.displayName, participants: turn.presence.participants,
    userMessage: turn.words, observedAt: turn.observedAt,
  });
  return { ...request, ...(turn.where.title ? { title: turn.where.title.trim() } : {}) };
}

/** A typed message's answer, as the one stream's lines. */
async function textLines(reply: PlatformReplyService, turn: ConversationTurn, write: (line: VoiceTurnLine) => void): Promise<void> {
  const answer = await reply.replyRequest(replyRequestOf(turn));
  write({ type: 'decision', respond: true, reason: 'text', filler: null });
  if (answer.reply) write({ type: 'sentence', index: 0, text: answer.reply });
  write({ type: 'done', reply: answer.reply, threadId: answer.threadId, duplicate: answer.duplicate, ...(answer.reply ? {} : { silent: true as const }) });
}

/** A modality whose part is switched off on the server: 503, and the entry answers as it did before. */
function switchedOff(routes: ConverseRoutes, turn: ConversationTurn): { error: string; message: string } | null {
  if (turn.modality === 'voice' && !routes.voice) return { error: 'PLATFORM_VOICE_DISABLED', message: 'Voice channel replies are switched off.' };
  if (turn.modality === 'text' && !routes.reply) return { error: 'PLATFORM_REPLY_DISABLED', message: 'Platform replies are switched off.' };
  return null;
}

export async function handleConverseRequest(request: IncomingMessage, response: ServerResponse, routes: ConverseRoutes | null): Promise<void> {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!routes) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
  if (!bearerAuthorized(request.headers.authorization, routes.token)) return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
  if (!oneHeadEnabled(routes.environment?.())) {
    return sendJson(response, 503, { error: 'ONE_HEAD_DISABLED', message: 'One head is switched off on the server.' });
  }
  let queue = Promise.resolve();
  const write = (line: VoiceTurnLine): void => {
    queue = queue.then(async () => {
      if (response.destroyed) return;
      startStream(response);
      await writeEvent(response, line).catch(() => undefined);
    });
  };
  try {
    const turn = validatedConversationTurn(await readJson(request, 32 * 1024));
    const off = switchedOff(routes, turn);
    if (off) return sendJson(response, 503, off);
    if (turn.modality === 'voice') await routes.voice!.turnRequest(voiceRequestOf(turn), write);
    else await textLines(routes.reply!, turn, write);
  } catch (error) {
    await queue;
    if (response.headersSent) {
      console.error('Shannon converse turn failed', { name: error instanceof Error ? error.name : 'Error' });
    } else if (error instanceof PlatformBridgeError) {
      return sendJson(response, error.status, { error: error.code, message: error.message });
    } else if (error instanceof SyntaxError) {
      return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'JSON body is invalid.' });
    } else {
      return sendJson(response, 502, { error: 'MODEL_UNAVAILABLE', message: '返答を生成できませんでした。' });
    }
  }
  await queue;
  if (!response.destroyed) response.end();
}
