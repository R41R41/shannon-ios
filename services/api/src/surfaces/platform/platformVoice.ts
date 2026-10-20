import { createHash } from 'node:crypto';
import { SHANNON_OWNER_NAME, shannonIdentityPrompt, type CompanionClock } from '@shannon/cognition';
import type { TextTurnInput, TextTurnResult } from '../../infra/http/apiKernel.js';
import type { ChatSentenceSink } from '../../contracts/contracts.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { MinecraftTurnLog } from '../../mind/action/respond/respondPorts.js';
import {
  PlatformBridgeError, keepOwnerPlatformTurn, platformBridgeThreadId, platformTextTurnInput, rememberPlatformPerson,
  type PlatformBridgeService, type ShannonPlatform,
} from '../../mind/memory/platformMemoryPorts.js';
import { SurfaceTurnAllowance, type SurfaceTurnLimits } from '../../mind/inhibition/minecraftTurnAllowance.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { VoiceSegmentTags, displayedVoiceText } from '../../infra/models/voiceAudioTags.js';
import { splitChatSentences } from '../text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../text/chatSentenceStream.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { voiceAddress } from './voiceAddress.js';
import { selectVoiceFiller } from './voiceFillers.js';
import { VOICE_ROOM_LIMITS, VoiceRooms, clipVoiceText, type HeardLine } from './voiceRoom.js';
import { VOICE_MOUTH_LIMITS } from './voiceMouth.js';
import type { VoiceMinecraftPort } from './voiceMinecraftPort.js';
import {
  FRIEND_NO_BODY_LINE, VOICE_MINECRAFT_REFUSALS, heardBlock, platformVoiceInstructions, situationBlock, voiceIntentInstructions,
} from './platformVoicePrompt.js';

/**
 * The reply to what someone said in a Discord voice channel (dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、Discordでライ氏や
 * 友人と会話し、今何をしているか・どういう状況かを込みで実況・会話できるように」). A platform runtime (the Discord bot) sends the words it
 * heard and who said them; the turn is a turn of the conversation kernel through the platform surface (`platformSurface.ts`), exactly
 * as `POST /v1/platform/reply` is, with these differences, all in the one place that knows the channel is a voice channel:
 *
 * - Who is present is the channel's members, not the text channel's readers: with anyone but the owner in it, a conversation bound
 *   `owner-private` is an audience of the channel as a whole (`PlatformAudienceOptions.sharedPresence`).
 * - She answers only what is said to her when several people are there (`voiceAddress.ts`); what she hears and does not answer is
 *   kept for a few minutes in memory as context (`voiceRooms`), never in her memory.
 * - The reply goes out as lines while the model writes it (`ChatStreamLine` sentences, cut at a clause, with the voice's own tags
 *   apart from the text shown), after a first `decision` line that may name a short filler for the body to play at once.
 * - The owner's spoken request for her Minecraft body is a message to the task under way (or a stop, or, with him alone, a new task),
 *   through the body port; a friend's words never move it.
 * - What is stored and shown never has the voice's audio tags (`displayedVoiceText`).
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

export interface PlatformVoiceConversation {
  textTurn(input: TextTurnInput): Promise<TextTurnResult>;
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
  situation?: string;
  sttMs?: number;
  utteranceMs?: number;
}

export type VoiceTurnLine =
  | { type: 'decision'; respond: boolean; reason: string; filler: { id: string; text: string } | null }
  | { type: 'sentence'; index: number; text: string; voiceText?: string; correction?: true }
  | { type: 'intent'; kind: 'task_message' | 'task' | 'stop' | 'none'; delivered: boolean; taskId?: string; reason?: string }
  | { type: 'done'; reply: string; threadId: string; duplicate: boolean; silent?: true; reason?: string;
    timings?: { decisionMs: number; firstSentenceMs: number | null; totalMs: number } }
  | { type: 'error'; status: number; error: string };

interface StoredVoiceTurn {
  reply: string;
  threadId: string;
  silent?: true;
  reason?: string;
  respond: boolean;
}

export interface PlatformVoiceDependencies {
  scopeKey: string;
  bridge: PlatformBridgeService;
  conversationStore: ConversationStore;
  conversation: PlatformVoiceConversation;
  turns: MinecraftTurnLog;
  now: CompanionClock;
  rooms?: VoiceRooms;
  /** Her Minecraft body's side of an owner's spoken request; null while the part is off. */
  minecraft?: () => VoiceMinecraftPort | null;
  /** The auxiliary model (Haiku) that puts event facts into her words (`wording`). */
  chatModel: Pick<ShannonChatModel, 'generate'>;
  environment?: () => SwitchValues;
  /** Content-free lines; `console.log` when absent. */
  log?(line: string): void;
}

const REQUEST_FIELDS = new Set([
  'platform', 'requestId', 'conversationId', 'voiceChannelId', 'sourceUserId', 'sourceDisplayName', 'userMessage', 'observedAt',
  'participants', 'heard', 'followsShannonTurn', 'speakingNow', 'situation', 'sttMs', 'utteranceMs',
]);

const identifier = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const bodyText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
const badRequest = (message: string) => new PlatformBridgeError('BAD_REQUEST', 400, message);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_600_000;

export function validatedVoiceTurn(value: unknown): VoiceTurnRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('JSON object body is required.');
  const body = value as Record<string, unknown>;
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
  const participants = body.participants === undefined ? [] : body.participants;
  if (!Array.isArray(participants) || participants.length > PLATFORM_VOICE_LIMITS.participants || !participants.every(id => identifier(id, 160))) {
    throw badRequest('participants is invalid.');
  }
  const heard = body.heard === undefined ? [] : body.heard;
  if (!Array.isArray(heard) || heard.length > PLATFORM_VOICE_LIMITS.heardLines) throw badRequest('heard is invalid.');
  const lines: HeardLine[] = [];
  for (const line of heard) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) throw badRequest('heard is invalid.');
    const item = line as Record<string, unknown>;
    if (!identifier(item.userId, 160) || !bodyText(item.name, 80) || !bodyText(item.text, 600) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) {
      throw badRequest('heard is invalid.');
    }
    lines.push({ userId: item.userId.trim(), name: item.name.trim(), text: item.text.trim(), at: new Date(item.at).toISOString() });
  }
  for (const flag of ['followsShannonTurn', 'speakingNow'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw badRequest(`${flag} is invalid.`);
  }
  if (body.situation !== undefined && !bodyText(body.situation, 600)) throw badRequest('situation is invalid.');
  for (const field of ['sttMs', 'utteranceMs'] as const) {
    if (body[field] !== undefined && !number(body[field])) throw badRequest(`${field} is invalid.`);
  }
  return {
    platform: 'discord',
    requestId: (body.requestId as string).trim(),
    conversationId: (body.conversationId as string).trim(),
    ...(body.voiceChannelId !== undefined ? { voiceChannelId: (body.voiceChannelId as string).trim() } : {}),
    sourceUserId: (body.sourceUserId as string).trim(),
    sourceDisplayName: (body.sourceDisplayName as string).trim(),
    userMessage: (body.userMessage as string).trim(),
    observedAt: new Date(body.observedAt).toISOString(),
    participants: (participants as string[]).map(id => id.trim()),
    heard: lines,
    followsShannonTurn: body.followsShannonTurn === true,
    speakingNow: body.speakingNow === true,
    ...(body.situation !== undefined ? { situation: clipVoiceText(body.situation as string, VOICE_ROOM_LIMITS.situationCharacters) } : {}),
    ...(body.sttMs !== undefined ? { sttMs: body.sttMs as number } : {}),
    ...(body.utteranceMs !== undefined ? { utteranceMs: body.utteranceMs as number } : {}),
  };
}

/** The words and who said them where; not who else is in the channel, so a retry with people coming and going still gets the answer. */
function voiceHash(request: VoiceTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'voice', request.conversationId, request.sourceUserId, request.sourceDisplayName, request.userMessage, request.observedAt,
  ])).digest('hex');
}

const sentencesOf = (reply: string): string[] => splitChatSentences(reply, VOICE_SENTENCE_CUT);

export class PlatformVoiceService {
  private readonly pending = new Map<string, { hash: string; done: Promise<void> }>();
  private readonly allowance = new SurfaceTurnAllowance(PLATFORM_VOICE_ALLOWANCE);
  private readonly wordingTimes: number[] = [];
  readonly rooms: VoiceRooms;

  constructor(private readonly dependencies: PlatformVoiceDependencies) {
    this.rooms = dependencies.rooms ?? new VoiceRooms(() => Date.parse(dependencies.now()));
  }

  private get environment(): SwitchValues { return this.dependencies.environment?.() ?? serverEnvironment(); }
  private log(line: string): void { try { (this.dependencies.log ?? console.log)(line); } catch { /* logging never fails a turn */ } }

  /**
   * One spoken turn. `emit` is called in order and never waits; it throws nothing the turn depends on. A refusal before the first
   * line is an exception (`PlatformBridgeError`, for a JSON error); after it, a failure is an `error` line.
   */
  async turn(value: unknown, emit: (line: VoiceTurnLine) => void): Promise<void> {
    const request = validatedVoiceTurn(value);
    const hash = voiceHash(request);
    const key = `discord-voice:${request.requestId}`;
    const { scopeKey, turns } = this.dependencies;
    const stored = turns.find(scopeKey, key);
    if (stored) return this.replay(stored.payloadHash, hash, stored.response as unknown as StoredVoiceTurn, emit);
    const running = this.pending.get(key);
    if (running) {
      if (running.hash !== hash) throw conflict();
      await running.done.catch(() => undefined);
      const again = turns.find(scopeKey, key);
      if (!again) throw conflict();
      return this.replay(again.payloadHash, hash, again.response as unknown as StoredVoiceTurn, emit);
    }
    const done = this.run(request, hash, key, emit);
    this.pending.set(key, { hash, done });
    try { await done; } finally { this.pending.delete(key); }
  }

  private replay(storedHash: string, hash: string, stored: StoredVoiceTurn, emit: (line: VoiceTurnLine) => void): void {
    if (storedHash !== hash) throw conflict();
    emit({ type: 'decision', respond: stored.respond, reason: stored.reason ?? 'replay', filler: null });
    if (!stored.respond) {
      emit({ type: 'done', reply: '', threadId: stored.threadId, duplicate: true, silent: true, ...(stored.reason ? { reason: stored.reason } : {}) });
      return;
    }
    const tags = new VoiceSegmentTags();
    let index = 0;
    for (const sentence of sentencesOf(stored.reply)) {
      const spoken = tags.take(sentence);
      if (spoken?.text.trim()) emit({ type: 'sentence', index: index++, text: spoken.text.trim() });
    }
    emit({ type: 'done', reply: stored.reply, threadId: stored.threadId, duplicate: true });
  }

  private async run(request: VoiceTurnRequest, hash: string, key: string, rawEmit: (line: VoiceTurnLine) => void): Promise<void> {
    const startedAt = performance.now();
    const { scopeKey, bridge, conversationStore, turns, now } = this.dependencies;
    let emitted = 0;
    const emit = (line: VoiceTurnLine) => { emitted += 1; try { rawEmit(line); } catch { /* a reader that left loses lines, the turn goes on */ } };
    const age = Date.parse(now()) - Date.parse(request.observedAt);
    if (age > PLATFORM_VOICE_LIMITS.maximumAgeMilliseconds || age < -PLATFORM_VOICE_LIMITS.futureSkewMilliseconds) {
      throw badRequest('observedAt is outside the window in which a spoken turn is answered.');
    }
    const binding = bridge.bindingOf({ platform: request.platform, conversationId: request.conversationId });
    if (!binding) throw new PlatformBridgeError('PLATFORM_CONVERSATION_DENIED', 403, 'This platform conversation is not allowlisted.');
    const humans = new Set([request.sourceUserId, ...request.participants]);
    const ownerWrote = request.sourceUserId === binding.ownerUserId;
    // Anyone but the owner in the channel, or someone else speaking: the conversation as a whole is the audience.
    const shared = !ownerWrote || humans.size > 1;
    const policy = bridge.audiencePolicy({
      platform: request.platform, conversationId: request.conversationId, sourceUserId: request.sourceUserId,
      conversationKind: 'channel', participants: [...humans],
    }, { sharedPresence: shared });
    const owner = policy.ownerWrote;
    const transcript = request.userMessage;
    const roomKey = request.conversationId;
    try {
      const address = voiceAddress({ transcript, humans: humans.size, followsShannonTurn: request.followsShannonTurn });
      const threadId = policy.threadId;
      if (!address.respond) {
        // Heard, not answered: context for a few minutes, nothing in her memory.
        this.rooms.noteHeard(roomKey, [{ userId: request.sourceUserId, name: request.sourceDisplayName, text: transcript, at: request.observedAt }]);
        const response: StoredVoiceTurn = { reply: '', threadId, silent: true, reason: address.reason, respond: false };
        turns.save(scopeKey, key, request.platform, hash, response as unknown as Record<string, unknown>, now(), PLATFORM_VOICE_LIMITS.replayDays);
        emit({ type: 'decision', respond: false, reason: address.reason, filler: null });
        emit({ type: 'done', reply: '', threadId, duplicate: false, silent: true, reason: address.reason });
        this.log(`Shannon platform voice turn respond=false reason=${address.reason} humans=${humans.size}`);
        return;
      }
      if (!owner && !request.sourceDisplayName) {
        throw new PlatformBridgeError('PLATFORM_ACTOR_DENIED', 403, 'This external actor is not bound to the Shannon owner.');
      }
      if (!this.allowance.take(owner, `${request.platform}:${request.sourceUserId}`, Date.parse(now()))) {
        throw new PlatformBridgeError('RATE_LIMITED', 429, owner ? 'Too many spoken turns from the owner; retry after a minute.' : 'Too many spoken turns from this person; retry later.');
      }
      const environment = this.environment;
      const filler = switchOn(environment, 'SHANNON_DC_VOICE_FILLER')
        ? selectVoiceFiller({ transcript, reason: address.reason, previous: this.rooms.lastFiller(roomKey) }) : null;
      this.rooms.useFiller(roomKey, filler?.id);
      emit({ type: 'decision', respond: true, reason: address.reason, filler: filler ? { id: filler.id, text: filler.text } : null });
      const decisionMs = Math.round(performance.now() - startedAt);

      const minecraft = switchOn(environment, 'SHANNON_DC_VOICE_MINECRAFT') ? this.dependencies.minecraft?.() ?? null : null;
      const bodyState = minecraft ? safe(() => minecraft.state()) : null;
      const allowNew = humans.size <= 1;
      // The owner alone in a conversation that is his: her ordinary tools reach the body (as in his DM). Otherwise a spoken request is
      // the turn's `minecraftIntent`, delivered below to the task under way.
      const toolsForBody = owner && policy.gate.ownerOnly;
      const offerIntent = owner && !policy.gate.ownerOnly && minecraft !== null && bodyState !== null && bodyState.connected;
      this.rooms.noteHeard(roomKey, request.heard);
      const heard = this.rooms.heard(roomKey, transcript);
      const situation = request.situation ?? this.rooms.situation(roomKey) ?? this.rooms.situation('default');
      const prompt = [
        platformVoiceInstructions({
          title: binding.title, ownerAlone: policy.gate.ownerOnly, ownerSpeaking: owner, speakerName: owner ? null : request.sourceDisplayName,
          humans: humans.size, fillerText: filler?.text,
        }),
        situationBlock(situation, owner ? bodyState?.running?.goal ?? null : null),
        heardBlock(heard),
        owner ? (toolsForBody ? '' : minecraft && bodyState ? voiceIntentInstructions(bodyState, allowNew) : '') : FRIEND_NO_BODY_LINE,
      ].filter(Boolean).join('\n\n');

      const tags = new VoiceSegmentTags();
      const streamedRaw: string[] = [];
      let index = 0;
      let firstSentenceAt: number | null = null;
      const speak = (raw: string, correction = false) => {
        const spoken = tags.take(raw);
        const text = spoken?.text.trim();
        if (!spoken || !text) return;
        firstSentenceAt ??= performance.now();
        const voiceText = spoken.voiceText?.trim();
        emit({ type: 'sentence', index: index++, text, ...(voiceText && voiceText !== text ? { voiceText } : {}), ...(correction ? { correction: true as const } : {}) });
      };
      const sink: ChatSentenceSink = {
        write: line => { if (line.type === 'sentence') { streamedRaw.push(line.text); speak(line.text); } },
      };
      let ignored: string | undefined;
      const receipt = { platform: request.platform, requestId: `voice:${request.requestId}`, payloadHash: hash };
      const result = await this.dependencies.conversation.textTurn({
        ...platformTextTurnInput({
          scopeKey, policy, message: owner ? transcript : `${request.sourceDisplayName}: ${transcript}`, rawMessage: transcript, prompt,
          threadTitle: binding.title, voice: true, ownOutreach: false,
          ...(toolsForBody ? { minecraftTools: true } : {}),
          ...(offerIntent ? { offerMinecraftIntent: true } : {}),
          perception: { surface: 'platform', ownerWrote: owner },
          store: turn => {
            // What is kept never has the voice's audio tags.
            const heardReply = { ...turn, shannonReply: displayedVoiceText(turn.shannonReply) };
            try {
              if (owner) return keepOwnerPlatformTurn(conversationStore, receipt, heardReply);
              ignored = rememberPlatformPerson(bridge, {
                platform: request.platform, requestId: receipt.requestId, conversationId: request.conversationId, sourceUserId: request.sourceUserId,
                userMessage: transcript, shannonReply: heardReply.shannonReply, observedAt: request.observedAt,
                conversationKind: 'channel', sourceDisplayName: request.sourceDisplayName, sourceKind: 'person',
              });
              return null;
            } catch (error) {
              if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') throw conflict();
              throw error;
            }
          },
        }),
        body: { scopeKey, message: transcript, stream: 'sentences', readAloud: true },
        request: { chatSentences: sink },
      });
      const completion = result.completion;
      if (!completion) throw new Error('PLATFORM_VOICE_WITHOUT_COMPLETION');
      // What the model wrote after the last sentence that went out while it wrote (an unfinished one, or all of it when it could not stream).
      const sent = streamedRaw.join('');
      if (completion.reply.startsWith(sent)) for (const sentence of sentencesOf(completion.reply.slice(sent.length))) speak(sentence);
      else if (!sent) for (const sentence of sentencesOf(completion.reply)) speak(sentence);
      const reply = displayedVoiceText(completion.reply).trim().slice(0, PLATFORM_VOICE_LIMITS.replyCharacters);

      if (offerIntent && completion.minecraftIntent && completion.minecraftIntent.kind !== 'none' && minecraft) {
        const outcome = await minecraft.intent({
          scopeKey, requestId: request.requestId, observedAt: request.observedAt, intent: completion.minecraftIntent,
          experienceId: result.experienceId ?? null, allowNew,
        }).catch((): { delivered: false; reason?: undefined; as?: undefined; taskId?: undefined } => ({ delivered: false }));
        emit({
          type: 'intent', kind: outcome.as === 'message' ? 'task_message' : completion.minecraftIntent.kind, delivered: outcome.delivered,
          ...(outcome.taskId ? { taskId: outcome.taskId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
        this.log(`Shannon platform voice intent kind=${completion.minecraftIntent.kind} delivered=${outcome.delivered} as=${outcome.as ?? '-'} reason=${outcome.reason ?? '-'}`);
        if (!outcome.delivered) {
          // She has already said she would: the fixed words of the refusal are said after it, and kept as what she said.
          const text = VOICE_MINECRAFT_REFUSALS[outcome.reason ?? 'not_owner_scope'];
          speak(text, true);
          try {
            conversationStore.appendNoteOnce?.(scopeKey, threadId, `dcv-refusal:${request.requestId}`, text, now(), 'discord_voice_refusal', false);
          } catch { /* the words are said all the same */ }
        }
      }

      const response: StoredVoiceTurn = { reply, threadId, respond: true, reason: address.reason };
      turns.save(scopeKey, key, request.platform, hash, response as unknown as Record<string, unknown>, now(), PLATFORM_VOICE_LIMITS.replayDays);
      const totalMs = Math.round(performance.now() - startedAt);
      const firstSentenceMs = firstSentenceAt === null ? null : Math.round(firstSentenceAt - startedAt);
      emit({ type: 'done', reply, threadId, duplicate: false, timings: { decisionMs, firstSentenceMs, totalMs } });
      this.log(`Shannon platform voice turn respond=true reason=${address.reason} owner=${owner} humans=${humans.size} filler=${filler?.id ?? '-'} `
        + `decisionMs=${decisionMs} firstSentenceMs=${firstSentenceMs ?? '-'} totalMs=${totalMs} sentences=${index} ignored=${ignored ?? '-'}`);
    } catch (error) {
      // Before any line: the caller gets a JSON error. After one: the sentences already spoken stand, and the stream says why it stopped.
      if (!emitted) throw error;
      const status = error instanceof PlatformBridgeError ? error.status : 502;
      emit({ type: 'error', status, error: error instanceof PlatformBridgeError ? error.code : 'MODEL_UNAVAILABLE' });
    }
  }

  /**
   * What she said by herself (a line from her mouth) or the part of a reply that was heard before someone spoke over her, kept in
   * the conversation as her own words, so the next turn knows what was and was not said.
   */
  said(value: unknown): void {
    const body = recordOf(value);
    if (!identifier(body.conversationId, 240)) throw badRequest('conversationId is invalid.');
    if (!bodyText(body.text, 1_200)) throw badRequest('text is invalid.');
    if (body.source !== 'mouth' && body.source !== 'reply') throw badRequest('source is invalid.');
    if (typeof body.at !== 'string' || !Number.isFinite(Date.parse(body.at))) throw badRequest('at is invalid.');
    if (body.interrupted !== undefined && typeof body.interrupted !== 'boolean') throw badRequest('interrupted is invalid.');
    if (body.spokenText !== undefined && typeof body.spokenText !== 'string') throw badRequest('spokenText is invalid.');
    const { scopeKey, bridge, conversationStore, now } = this.dependencies;
    if (!bridge.bindingOf({ platform: 'discord', conversationId: body.conversationId })) {
      throw new PlatformBridgeError('PLATFORM_CONVERSATION_DENIED', 403, 'This platform conversation is not allowlisted.');
    }
    const threadId = platformBridgeThreadId('discord', body.conversationId);
    const at = new Date(Date.parse(body.at)).toISOString();
    const text = displayedVoiceText(body.text).trim().slice(0, PLATFORM_VOICE_LIMITS.replyCharacters);
    const spoken = displayedVoiceText(typeof body.spokenText === 'string' ? body.spokenText : '').trim().slice(0, PLATFORM_VOICE_LIMITS.replyCharacters);
    const content = body.interrupted === true
      ? (spoken ? `（直前の返事は、人に話をかぶせられて「${spoken}」までしか言えなかった）` : '（直前の返事は、人に話をかぶせられて言えなかった）')
      : text;
    const id = `dcv-said:${createHash('sha256').update(`${body.conversationId}\u0000${at}\u0000${body.source}\u0000${content}`).digest('hex').slice(0, 32)}`;
    try {
      conversationStore.appendNoteOnce?.(scopeKey, threadId, id, content, now(), 'discord_voice_said', false);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'TASK_NOTE_CONFLICT') throw error;
    }
  }

  /** Event facts put into her words for a line from her mouth, or nothing when there is nothing worth saying (`{ say: false }`). */
  async wording(value: unknown): Promise<{ say: boolean; text?: string; tags?: string }> {
    const body = recordOf(value);
    if (!identifier(body.conversationId, 240)) throw badRequest('conversationId is invalid.');
    if (!Array.isArray(body.facts) || !body.facts.length || body.facts.length > VOICE_MOUTH_LIMITS.facts
      || !body.facts.every(fact => bodyText(fact, VOICE_MOUTH_LIMITS.factCharacters))) throw badRequest('facts is invalid.');
    if (!identifier(body.source, VOICE_MOUTH_LIMITS.sourceCharacters)) throw badRequest('source is invalid.');
    const { scopeKey, bridge, chatModel, now } = this.dependencies;
    if (!bridge.bindingOf({ platform: 'discord', conversationId: body.conversationId })) {
      throw new PlatformBridgeError('PLATFORM_CONVERSATION_DENIED', 403, 'This platform conversation is not allowlisted.');
    }
    const at = Date.parse(now());
    while (this.wordingTimes.length && at - this.wordingTimes[0]! >= 60_000) this.wordingTimes.shift();
    if (this.wordingTimes.length >= 20) throw new PlatformBridgeError('RATE_LIMITED', 429, 'Too many wording requests; retry after a minute.');
    this.wordingTimes.push(at);
    const roomKey = body.conversationId;
    if (Array.isArray(body.heard)) {
      const lines = body.heard.flatMap(line => (typeof line === 'object' && line !== null && identifier((line as HeardLine).userId, 160)
        && bodyText((line as HeardLine).text, 600) && bodyText((line as HeardLine).name, 80) && Number.isFinite(Date.parse((line as HeardLine).at))
        ? [line as HeardLine] : []));
      this.rooms.noteHeard(roomKey, lines);
    }
    const situation = typeof body.situation === 'string' ? clipVoiceText(body.situation, VOICE_ROOM_LIMITS.situationCharacters)
      : this.rooms.situation(roomKey) ?? this.rooms.situation('default');
    const heard = heardBlock(this.rooms.heard(roomKey));
    const result = await chatModel.generate({
      scopeKey,
      systemPrompt: [
        shannonIdentityPrompt('guest'),
        [
          '[Discordのボイスチャンネルで、自分から一言いう]',
          `いまボクは、${SHANNON_OWNER_NAME}と友だちがいるボイスチャンネルで、声で話している。次の出来事を見て、自分から一言いうなら、その一言だけを書く。`,
          '- 1文、長くても40字。声に出す自然な日本語。かぎかっこ・絵文字・見出しは使わない。',
          '- 出来事にある事実だけを言う。ないことは足さない。個人的なことや秘密には触れない。',
          '- 言うほどのことでなければ、「（なし）」とだけ書く。',
        ].join('\n'),
        situationBlock(situation, null),
        heard,
      ].filter(Boolean).join('\n\n'),
      history: [],
      message: `出来事:\n${(body.facts as string[]).map(fact => `- ${fact}`).join('\n')}`,
    });
    const text = displayedVoiceText(result.reply).replace(/\s+/gu, ' ').trim();
    if (!text || /^[（(]?なし[）)]?[。.]?$/u.test(text)) return { say: false };
    return { say: true, text: clipVoiceText(text, VOICE_MOUTH_LIMITS.textCharacters) };
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('JSON object body is required.');
  return value as Record<string, unknown>;
}

function conflict(): PlatformBridgeError {
  return new PlatformBridgeError('PLATFORM_TURN_CONFLICT', 409, 'The requestId was already used for a different spoken turn.');
}

function safe<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}
