import type { CompanionClock } from '@shannon/cognition';
import type { TextTurnInput, TextTurnResult } from '../../infra/http/apiKernel.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { MinecraftTurnLog } from '../../mind/action/respond/respondPorts.js';
import type { CompletedTurn } from '../../mind/sleep/backgroundUpdates.js';
import {
  PlatformBridgeError, keepOwnerPlatformTurn, platformTextTurnInput, rememberPlatformPerson,
  type PlatformAudiencePolicy, type PlatformBridgeBinding, type PlatformBridgeService,
} from '../../mind/memory/platformMemoryPorts.js';
import { SurfaceTurnAllowance } from '../../mind/inhibition/minecraftTurnAllowance.js';
import { voiceAddress, type VoiceAddress } from '../../mind/perception/voiceChannelAddress.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { VoiceSegmentTags, displayedVoiceText } from '../../infra/models/voiceAudioTags.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import type { ChatSentenceSink } from '../../contracts/contracts.js';
import { switchOn, type SwitchValues } from '@shannon/switches';
import {
  PLATFORM_VOICE_ALLOWANCE, PLATFORM_VOICE_LIMITS, StoredVoiceTurn, VoiceTurnLine, VoiceTurnRequest, conflict, notBound, validatedVoiceTurn, voiceHash,
} from './platformVoiceRequest.js';
import {
  FRIEND_NO_BODY_LINE, VOICE_MINECRAFT_REFUSALS, heardBlock, platformVoiceInstructions, situationBlock, voiceIntentInstructions,
} from './platformVoicePrompt.js';
import { VoiceWords } from './platformVoiceWords.js';
import { selectVoiceFiller, type VoiceFiller } from './voiceFillers.js';
import { VoiceRooms } from './voiceRoom.js';
import type { VoiceMinecraftIntentResult, VoiceMinecraftPort, VoiceMinecraftState } from './voiceMinecraftPort.js';

/**
 * The reply to what someone said in a Discord voice channel (dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、Discordでライ氏や
 * 友人と会話し、今何をしているか・どういう状況かを込みで実況・会話できるように」). A platform runtime (the Discord bot) sends the words it
 * heard and who said them; the turn is a turn of the conversation kernel through the platform surface (`platformSurface.ts`), exactly
 * as `POST /v1/platform/reply` is, with these differences, all in the one place that knows the channel is a voice channel:
 *
 * - Who is present is the channel's members, not the text channel's readers: with anyone but the owner in it, a conversation bound
 *   `owner-private` is an audience of the channel as a whole (`PlatformAudienceOptions.sharedPresence`).
 * - She answers only what is said to her when several people are there (`voiceChannelAddress.ts`); what she hears and does not answer
 *   is kept for a few minutes in memory as context (`voiceRoom.ts`), never in her memory.
 * - The reply goes out as lines while the model writes it (`ChatStreamLine` sentences, cut at a clause, with the voice's own tags
 *   apart from the text shown), after a first `decision` line that may name a short filler for the body to play at once.
 * - The owner's spoken request for her Minecraft body is a message to the task under way (or a stop, or, with him alone, a new task),
 *   through the body port; a friend's words never move it.
 * - What is stored and shown never has the voice's audio tags (`displayedVoiceText`).
 */
export type { VoiceTurnLine, VoiceTurnRequest } from './platformVoiceRequest.js';
export {
  PLATFORM_VOICE_ALLOWANCE, PLATFORM_VOICE_LIMITS, SHANNON_PLATFORM_VOICE_PREFIX, platformVoiceEnabled, validatedVoiceTurn,
} from './platformVoiceRequest.js';

export interface PlatformVoiceConversation {
  textTurn(input: TextTurnInput): Promise<TextTurnResult>;
}

export interface PlatformVoiceDependencies {
  scopeKey: string;
  bridge: PlatformBridgeService;
  conversationStore: ConversationStore;
  conversation: PlatformVoiceConversation;
  turns: MinecraftTurnLog;
  now: CompanionClock;
  /** A reply's sentences, cut as a voice is spoken in (wiring hands over `splitChatSentences` with `VOICE_SENTENCE_CUT`). */
  sentences(text: string): string[];
  rooms?: VoiceRooms;
  /** Her Minecraft body's side of an owner's spoken request; null while the part is off. */
  minecraft?: () => VoiceMinecraftPort | null;
  /** The auxiliary model (Haiku) that puts event facts into her words (`wording`). */
  chatModel: Pick<ShannonChatModel, 'generate'>;
  environment?: () => SwitchValues;
  /** Content-free lines; `console.log` when absent. */
  log?(line: string): void;
}

/** Who is speaking where, as the platform policy settled it. */
interface VoiceSeat {
  binding: PlatformBridgeBinding;
  policy: PlatformAudiencePolicy;
  humans: Set<string>;
  owner: boolean;
  startedAt: number;
}

/** What the model was asked and what came back, for the lines that follow. */
interface VoiceAnswer {
  result: TextTurnResult;
  spoken: SpokenSentences;
  ignored: string | undefined;
}

/** Lines out, in order. A reader that left loses lines; the turn goes on. */
class VoiceOut {
  count = 0;

  constructor(private readonly write: (line: VoiceTurnLine) => void) {}

  line(line: VoiceTurnLine): void {
    this.count += 1;
    try {
      this.write(line);
    } catch {
      /* the reader went away */
    }
  }
}

/** The sentences of one reply: the text shown and the voice's own text (tags) apart, numbered, with when the first went out. */
class SpokenSentences {
  private readonly tags = new VoiceSegmentTags();
  private readonly streamed: string[] = [];
  private index = 0;
  firstAt: number | null = null;

  constructor(private readonly out: VoiceOut) {}

  get count(): number { return this.index; }

  /** A sentence that went out while the model wrote. */
  stream(raw: string): void {
    this.streamed.push(raw);
    this.say(raw);
  }

  say(raw: string, correction = false): void {
    const spoken = this.tags.take(raw);
    const text = spoken?.text.trim();
    if (!spoken || !text) return;
    this.firstAt ??= performance.now();
    const voiceText = spoken.voiceText?.trim();
    this.out.line({
      type: 'sentence', index: this.index, text,
      ...(voiceText && voiceText !== text ? { voiceText } : {}),
      ...(correction ? { correction: true as const } : {}),
    });
    this.index += 1;
  }

  /** What the model wrote after the last sentence that went out while it wrote (an unfinished one, or all of it when it could not stream). */
  rest(reply: string, split: (text: string) => string[]): void {
    const sent = this.streamed.join('');
    if (reply.startsWith(sent)) for (const sentence of split(reply.slice(sent.length))) this.say(sentence);
    else if (!sent) for (const sentence of split(reply)) this.say(sentence);
  }
}

export class PlatformVoiceService {
  private readonly pending = new Map<string, { hash: string; done: Promise<void> }>();
  private readonly allowance = new SurfaceTurnAllowance(PLATFORM_VOICE_ALLOWANCE);
  readonly rooms: VoiceRooms;
  private readonly words: VoiceWords;

  constructor(private readonly dependencies: PlatformVoiceDependencies) {
    this.rooms = dependencies.rooms ?? new VoiceRooms(() => Date.parse(dependencies.now()));
    this.words = new VoiceWords({ ...dependencies, rooms: this.rooms });
  }

  said(value: unknown): void { this.words.said(value); }

  wording(value: unknown): Promise<{ say: boolean; text?: string }> { return this.words.wording(value); }

  private get environment(): SwitchValues { return this.dependencies.environment?.() ?? serverEnvironment(); }

  private log(line: string): void {
    try {
      (this.dependencies.log ?? console.log)(line);
    } catch {
      /* logging never fails a turn */
    }
  }

  /**
   * One spoken turn. `emit` is called in order and never waits. A refusal before the first line is an exception (`PlatformBridgeError`,
   * for a JSON error); after it, a failure is an `error` line.
   */
  async turn(value: unknown, emit: (line: VoiceTurnLine) => void): Promise<void> {
    const request = validatedVoiceTurn(value);
    const hash = voiceHash(request);
    const key = `discord-voice:${request.requestId}`;
    const stored = this.dependencies.turns.find(this.dependencies.scopeKey, key);
    if (stored) return this.replay(stored.payloadHash, hash, stored.response as unknown as StoredVoiceTurn, emit);
    const running = this.pending.get(key);
    if (running) return this.replayAfter(running, key, hash, emit);
    const done = this.run(request, hash, key, emit);
    this.pending.set(key, { hash, done });
    try {
      await done;
    } finally {
      this.pending.delete(key);
    }
  }

  private async replayAfter(running: { hash: string; done: Promise<void> }, key: string, hash: string, emit: (line: VoiceTurnLine) => void): Promise<void> {
    if (running.hash !== hash) throw conflict();
    await running.done.catch(() => undefined);
    const again = this.dependencies.turns.find(this.dependencies.scopeKey, key);
    if (!again) throw conflict();
    this.replay(again.payloadHash, hash, again.response as unknown as StoredVoiceTurn, emit);
  }

  private replay(storedHash: string, hash: string, stored: StoredVoiceTurn, emit: (line: VoiceTurnLine) => void): void {
    if (storedHash !== hash) throw conflict();
    emit({ type: 'decision', respond: stored.respond, reason: stored.reason ?? 'replay', filler: null });
    if (!stored.respond) {
      emit({ type: 'done', reply: '', threadId: stored.threadId, duplicate: true, silent: true, ...(stored.reason ? { reason: stored.reason } : {}) });
      return;
    }
    const spoken = new SpokenSentences(new VoiceOut(emit));
    for (const sentence of this.dependencies.sentences(stored.reply)) spoken.say(sentence);
    emit({ type: 'done', reply: stored.reply, threadId: stored.threadId, duplicate: true });
  }

  private async run(request: VoiceTurnRequest, hash: string, key: string, write: (line: VoiceTurnLine) => void): Promise<void> {
    const out = new VoiceOut(write);
    try {
      await this.answer(request, hash, key, out);
    } catch (error) {
      // Before any line: the caller gets a JSON error. After one: the sentences already spoken stand, and the stream says why it stopped.
      if (!out.count) throw error;
      const status = error instanceof PlatformBridgeError ? error.status : 502;
      out.line({ type: 'error', status, error: error instanceof PlatformBridgeError ? error.code : 'MODEL_UNAVAILABLE' });
    }
  }

  /** Fresh, bound, and who is there: the policy of the platform, with the channel's members as the audience. */
  private seat(request: VoiceTurnRequest): VoiceSeat {
    const { bridge, now } = this.dependencies;
    const age = Date.parse(now()) - Date.parse(request.observedAt);
    if (age > PLATFORM_VOICE_LIMITS.maximumAgeMilliseconds || age < -PLATFORM_VOICE_LIMITS.futureSkewMilliseconds) {
      throw new PlatformBridgeError('BAD_REQUEST', 400, 'observedAt is outside the window in which a spoken turn is answered.');
    }
    const binding = bridge.bindingOf({ platform: request.platform, conversationId: request.conversationId });
    if (!binding) throw notBound();
    const humans = new Set([request.sourceUserId, ...request.participants]);
    // Anyone but the owner in the channel, or someone else speaking: the conversation as a whole is the audience.
    const shared = request.sourceUserId !== binding.ownerUserId || humans.size > 1;
    const policy = bridge.audiencePolicy({
      platform: request.platform, conversationId: request.conversationId, sourceUserId: request.sourceUserId,
      conversationKind: 'channel', participants: [...humans],
    }, { sharedPresence: shared });
    return { binding, policy, humans, owner: policy.ownerWrote, startedAt: performance.now() };
  }

  private async answer(request: VoiceTurnRequest, hash: string, key: string, out: VoiceOut): Promise<void> {
    const seat = this.seat(request);
    const address = voiceAddress({ transcript: request.userMessage, humans: seat.humans.size, followsShannonTurn: request.followsShannonTurn });
    if (!address.respond) return this.stayQuiet(seat, request, hash, key, address, out);
    this.admit(seat, request);
    const filler = this.fillerFor(request, address);
    out.line({ type: 'decision', respond: true, reason: address.reason, filler: filler ? { id: filler.id, text: filler.text } : null });
    const decisionMs = Math.round(performance.now() - seat.startedAt);
    const body = this.bodyFor(seat);
    const answer = await this.ask(seat, request, hash, filler, body, out);
    await this.carryIntent(seat, request, answer, body, out);
    this.finish(seat, request, hash, key, answer, { decisionMs, address: address.reason, filler }, out);
  }

  /** Heard, not answered: context for a few minutes, nothing in her memory. */
  private stayQuiet(seat: VoiceSeat, request: VoiceTurnRequest, hash: string, key: string, address: VoiceAddress, out: VoiceOut): void {
    const { scopeKey, turns, now } = this.dependencies;
    this.rooms.noteHeard(request.conversationId, [
      { userId: request.sourceUserId, name: request.sourceDisplayName, text: request.userMessage, at: request.observedAt },
    ]);
    const response: StoredVoiceTurn = { reply: '', threadId: seat.policy.threadId, silent: true, reason: address.reason, respond: false };
    turns.save(scopeKey, key, request.platform, hash, response as unknown as Record<string, unknown>, now(), PLATFORM_VOICE_LIMITS.replayDays);
    out.line({ type: 'decision', respond: false, reason: address.reason, filler: null });
    out.line({ type: 'done', reply: '', threadId: seat.policy.threadId, duplicate: false, silent: true, reason: address.reason });
    this.log(`Shannon platform voice turn respond=false reason=${address.reason} humans=${seat.humans.size}`);
  }

  private admit(seat: VoiceSeat, request: VoiceTurnRequest): void {
    if (!seat.owner && !request.sourceDisplayName) {
      throw new PlatformBridgeError('PLATFORM_ACTOR_DENIED', 403, 'This external actor is not bound to the Shannon owner.');
    }
    if (!this.allowance.take(seat.owner, `${request.platform}:${request.sourceUserId}`, Date.parse(this.dependencies.now()))) {
      const message = seat.owner ? 'Too many spoken turns from the owner; retry after a minute.' : 'Too many spoken turns from this person; retry later.';
      throw new PlatformBridgeError('RATE_LIMITED', 429, message);
    }
  }

  private fillerFor(request: VoiceTurnRequest, address: VoiceAddress): VoiceFiller | null {
    const wanted = switchOn(this.environment, 'SHANNON_DC_VOICE_FILLER');
    const previous = this.rooms.lastFiller(request.conversationId);
    const filler = wanted ? selectVoiceFiller({ transcript: request.userMessage, reason: address.reason, previous }) : null;
    this.rooms.useFiller(request.conversationId, filler?.id);
    return filler;
  }

  /** Her Minecraft body's side for this turn: the port and what it says now; null when the part is off. */
  private bodyFor(seat: VoiceSeat): { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null {
    const port = switchOn(this.environment, 'SHANNON_DC_VOICE_MINECRAFT') ? this.dependencies.minecraft?.() ?? null : null;
    if (!port) return null;
    try {
      return { port, state: port.state() };
    } catch {
      return null;
    }
  }

  /** Whether the intent field is offered: the owner, in a conversation that is not his alone, with the body connected. */
  private offersIntent(seat: VoiceSeat, body: { state: VoiceMinecraftState } | null): boolean {
    return seat.owner && !seat.policy.gate.ownerOnly && body !== null && body.state.connected;
  }

  private promptFor(seat: VoiceSeat, request: VoiceTurnRequest, filler: VoiceFiller | null, body: { state: VoiceMinecraftState } | null): string {
    const roomKey = request.conversationId;
    this.rooms.noteHeard(roomKey, request.heard);
    const situation = request.situation ?? this.rooms.situation(roomKey) ?? this.rooms.situation('default');
    const running = seat.owner ? body?.state.running?.goal ?? null : null;
    const ownerTools = seat.owner && seat.policy.gate.ownerOnly;
    const intent = seat.owner && !ownerTools && body ? voiceIntentInstructions(body.state, seat.humans.size <= 1) : '';
    return [
      platformVoiceInstructions({
        title: seat.binding.title, ownerAlone: seat.policy.gate.ownerOnly, ownerSpeaking: seat.owner,
        speakerName: seat.owner ? null : request.sourceDisplayName, humans: seat.humans.size, fillerText: filler?.text,
      }),
      situationBlock(situation, running),
      heardBlock(this.rooms.heard(roomKey, request.userMessage)),
      seat.owner ? intent : FRIEND_NO_BODY_LINE,
    ].filter(Boolean).join('\n\n');
  }

  private async ask(
    seat: VoiceSeat, request: VoiceTurnRequest, hash: string, filler: VoiceFiller | null,
    body: { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null, out: VoiceOut,
  ): Promise<VoiceAnswer> {
    const { scopeKey, conversation } = this.dependencies;
    const spoken = new SpokenSentences(out);
    const sink: ChatSentenceSink = { write: line => { if (line.type === 'sentence') spoken.stream(line.text); } };
    const kept: { ignored: string | undefined } = { ignored: undefined };
    const transcript = request.userMessage;
    const result = await conversation.textTurn({
      ...platformTextTurnInput({
        scopeKey, policy: seat.policy, message: seat.owner ? transcript : `${request.sourceDisplayName}: ${transcript}`, rawMessage: transcript,
        prompt: this.promptFor(seat, request, filler, body), threadTitle: seat.binding.title, voice: true, ownOutreach: false,
        ...(seat.owner && seat.policy.gate.ownerOnly ? { minecraftTools: true } : {}),
        ...(this.offersIntent(seat, body) ? { offerMinecraftIntent: true } : {}),
        perception: { surface: 'platform', ownerWrote: seat.owner },
        store: turn => this.keep(seat, request, hash, turn, kept),
      }),
      body: { scopeKey, message: transcript, stream: 'sentences', readAloud: true },
      request: { chatSentences: sink },
    });
    if (!result.completion) throw new Error('PLATFORM_VOICE_WITHOUT_COMPLETION');
    spoken.rest(result.completion.reply, this.dependencies.sentences);
    return { result, spoken, ignored: kept.ignored };
  }

  /** The turn where the platform keeps it: the owner's in his platform thread, anyone else's as person memory. Never with the voice's tags. */
  private keep(seat: VoiceSeat, request: VoiceTurnRequest, hash: string, turn: CompletedTurn, kept: { ignored: string | undefined }) {
    const { conversationStore, bridge } = this.dependencies;
    const heard = { ...turn, shannonReply: displayedVoiceText(turn.shannonReply) };
    const receipt = { platform: request.platform, requestId: `voice:${request.requestId}`, payloadHash: hash };
    try {
      if (seat.owner) return keepOwnerPlatformTurn(conversationStore, receipt, heard);
      kept.ignored = rememberPlatformPerson(bridge, {
        platform: request.platform, requestId: receipt.requestId, conversationId: request.conversationId, sourceUserId: request.sourceUserId,
        userMessage: request.userMessage, shannonReply: heard.shannonReply, observedAt: request.observedAt,
        conversationKind: 'channel', sourceDisplayName: request.sourceDisplayName, sourceKind: 'person',
      });
      return null;
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') throw conflict();
      throw error;
    }
  }

  /** The owner's spoken request for her body: delivered after the reply, and the fixed words of a refusal said after a reply that promised. */
  private async carryIntent(
    seat: VoiceSeat, request: VoiceTurnRequest, answer: VoiceAnswer,
    body: { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null, out: VoiceOut,
  ): Promise<void> {
    const intent = answer.result.completion?.minecraftIntent;
    if (!body || !intent || intent.kind === 'none' || !this.offersIntent(seat, body)) return;
    const { scopeKey } = this.dependencies;
    const outcome = await body.port.intent({
      scopeKey, requestId: request.requestId, observedAt: request.observedAt, intent,
      experienceId: answer.result.experienceId ?? null, allowNew: seat.humans.size <= 1,
    }).catch((): VoiceMinecraftIntentResult => ({ delivered: false }));
    out.line({
      type: 'intent', kind: outcome.as === 'message' ? 'task_message' : intent.kind, delivered: outcome.delivered,
      ...(outcome.taskId ? { taskId: outcome.taskId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    this.log(`Shannon platform voice intent kind=${intent.kind} delivered=${outcome.delivered} as=${outcome.as ?? '-'} reason=${outcome.reason ?? '-'}`);
    if (!outcome.delivered) this.refuse(seat, request, answer, outcome.reason ?? 'not_owner_scope');
  }

  private refuse(seat: VoiceSeat, request: VoiceTurnRequest, answer: VoiceAnswer, reason: keyof typeof VOICE_MINECRAFT_REFUSALS): void {
    const { scopeKey, conversationStore, now } = this.dependencies;
    const text = VOICE_MINECRAFT_REFUSALS[reason];
    answer.spoken.say(text, true);
    try {
      conversationStore.appendNoteOnce?.(scopeKey, seat.policy.threadId, `dcv-refusal:${request.requestId}`, text, now(), 'discord_voice_refusal', false);
    } catch {
      /* the words are said all the same */
    }
  }

  private finish(
    seat: VoiceSeat, request: VoiceTurnRequest, hash: string, key: string, answer: VoiceAnswer,
    facts: { decisionMs: number; address: string; filler: VoiceFiller | null }, out: VoiceOut,
  ): void {
    const { scopeKey, turns, now } = this.dependencies;
    const completion = answer.result.completion!;
    const reply = displayedVoiceText(completion.reply).trim().slice(0, PLATFORM_VOICE_LIMITS.replyCharacters);
    const threadId = seat.policy.threadId;
    const response: StoredVoiceTurn = { reply, threadId, respond: true, reason: facts.address };
    turns.save(scopeKey, key, request.platform, hash, response as unknown as Record<string, unknown>, now(), PLATFORM_VOICE_LIMITS.replayDays);
    const totalMs = Math.round(performance.now() - seat.startedAt);
    const firstSentenceMs = answer.spoken.firstAt === null ? null : Math.round(answer.spoken.firstAt - seat.startedAt);
    out.line({ type: 'done', reply, threadId, duplicate: false, timings: { decisionMs: facts.decisionMs, firstSentenceMs, totalMs } });
    const who = `owner=${seat.owner} humans=${seat.humans.size} filler=${facts.filler?.id ?? '-'}`;
    const times = `decisionMs=${facts.decisionMs} firstSentenceMs=${firstSentenceMs ?? '-'} totalMs=${totalMs}`;
    const tail = `sentences=${answer.spoken.count} ignored=${answer.ignored ?? '-'}`;
    this.log(`Shannon platform voice turn respond=true reason=${facts.address} ${who} ${times} ${tail}`);
  }
}
