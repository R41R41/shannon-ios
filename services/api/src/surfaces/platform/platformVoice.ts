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
import { voiceAddress, voiceFragment, type VoiceAddress } from '../../mind/perception/voiceChannelAddress.js';
import { ADDRESSED_WINDOW_MILLISECONDS, type AddressedJudge } from '../../mind/perception/addressed.js';
import { addressedInputOf, answersAsk, answersHerQuestion, saidToHer, questionJudged, shannonSpokeAgoMs, workOf } from './platformVoiceAddressed.js';
import type { ShannonChatModel, ShannonChatModelResult } from '../../infra/models/chatModel.js';
import { displayedVoiceText } from '../../infra/models/voiceAudioTags.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import type { ChatSentenceSink } from '../../contracts/contracts.js';
import { oneHeadEnabled } from '../../contracts/oneHeadContract.js';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { SpokenSentences, VoiceOut } from './platformVoiceLines.js';
import { askSeated, platformVoiceSeat, type SeatedVoiceTurn, type SentenceSplitter } from './platformVoiceOneHead.js';
import { OPEN_CONVERSATION_TITLE } from '../../mind/memory/platformMemoryPorts.js';
import {
  PLATFORM_VOICE_ALLOWANCE, PLATFORM_VOICE_LIMITS, StoredVoiceTurn, VoiceTurnLine, VoiceTurnRequest, conflict, notBound, ownerAsBound,
  validatedVoiceTurn, voiceHash,
} from './platformVoiceRequest.js';
import {
  VOICE_MINECRAFT_REFUSALS, askedBackBlock, callJoinInstructions, directedBlock, heardBlock, lifecycleInstructions, platformVoiceInstructions, situationBlock,
  speakerPositionLine, speechInstructions, voiceIntentInstructions,
} from './platformVoicePrompt.js';
import { VoiceWords } from './platformVoiceWords.js';
import { warmedAudiences, type VoiceWarmAsk, type WarmAudience } from '../voice/voiceWarm.js';
import { selectVoiceFiller, voiceFillerById, type VoiceFiller } from './voiceFillers.js';
import { VoiceRooms } from './voiceRoom.js';
import { voiceIntentLineKind, intentLog, type VoiceMinecraftIntentResult, type VoiceMinecraftPort, type VoiceMinecraftState } from './voiceMinecraftPort.js';
import { lifecycleRefusalLine, type LifecycleRequestAction, type VoiceLifecyclePort } from './voiceLifecyclePort.js';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';

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
 * - A spoken request for her Minecraft body, from the owner or anyone in the channel (owner decision 2026-11-21), is a message to the task
 *   under way, a stop, or a new task, through the body port, with who asked.
 * - What is stored and shown never has the voice's audio tags (`displayedVoiceText`).
 */
export type { VoiceTurnLine, VoiceTurnRequest } from './platformVoiceRequest.js';
export {
  PLATFORM_VOICE_ALLOWANCE, PLATFORM_VOICE_LIMITS, SHANNON_PLATFORM_VOICE_PREFIX, platformVoiceEnabled, validatedVoiceTurn,
} from './platformVoiceRequest.js';

export interface PlatformVoiceConversation {
  textTurn(input: TextTurnInput): Promise<TextTurnResult>;
  /** One head (`SHANNON_ONE_HEAD`): the one voice turn the apps use, with this channel's seat (`ShannonApiKernel.seatedVoiceTurn`). */
  seatedVoiceTurn?: SeatedVoiceTurn;
  /** A call opening: the cache of a spoken reply filled for one audience (`voiceWarm.ts`), nothing said or kept; null for a model with nothing to warm. */
  warmVoiceReply?(ask: VoiceWarmAsk): Promise<ShannonChatModelResult['warmed'] | null>;
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
  /** One head: the same cut, while the reply is written (wiring: a `ChatSentenceSplitter` with `VOICE_SENTENCE_CUT`); absent, cut at the end. */
  splitter?: () => SentenceSplitter;
  rooms?: VoiceRooms;
  /**
   * 「話しかけられたか」 (`SHANNON_ADDRESSED`): the one judge of whom a spoken line was said to (`mind/perception/addressed.ts`). Absent or
   * the switch off, the shared-table rules of `voiceChannelAddress.ts` decide as before.
   */
  addressed?: AddressedJudge | null;
  /** Her Minecraft body's side of an owner's spoken request; null while the part is off. */
  minecraft?: () => VoiceMinecraftPort | null;
  /** Her going into and out of the Minecraft server, for the owner's own spoken request (`lifecycleOffer`); read at each turn. */
  lifecycle?: () => VoiceLifecyclePort | null;
  /** The auxiliary model (Haiku) that puts event facts into her words (`wording`). */
  chatModel: Pick<ShannonChatModel, 'generate'>;
  environment?: () => SwitchValues;
  /** How long an answer to words said over her reply waits for the report of how far she got (default `PLATFORM_VOICE_LIMITS.cutShortWaitMilliseconds`). */
  cutShortWaitMilliseconds?: number;
  /** Content-free lines; `console.log` when absent. */
  log?(line: string): void;
}

/** Who is speaking where, as the platform policy settled it. */
interface ChannelSeat {
  binding: PlatformBridgeBinding;
  policy: PlatformAudiencePolicy;
  humans: Set<string>;
  owner: boolean;
  startedAt: number;
  /** The conversation's title: a bound one's, or for one nobody bound (one head) the channel's own name when the body gave it. */
  title: string;
}

/** What came back, for the lines that follow. */
interface VoiceAnswer {
  reply: string;
  minecraftIntent?: ShannonChatModelResult['minecraftIntent'];
  experienceId?: string;
  spoken: SpokenSentences;
  ignored: string | undefined;
  /** The turn as it was completed, for the record a request may need (`requestRecord`). */
  turn?: CompletedTurn | undefined;
}

/** What `keep` leaves for the turn's answer. */
interface KeptTurn {
  ignored: string | undefined;
  turn?: CompletedTurn;
}

/** An audience's warm-up of the spoken reply's cache is not asked again within this time (the provider keeps it an hour). */
const REPLY_WARM_INTERVAL_MILLISECONDS = 10 * 60_000;

/** What one audience's warm-up counted (tokens the provider read from and wrote to its cache), for the caller's log. */
export interface ReplyWarm { audience: WarmAudience; warmed: boolean; input?: number; cacheRead?: number; cacheWrite?: number; output?: number; milliseconds?: number }

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

  /**
   * A call opened (or the channel was silent for long): warms the auxiliary model (`VoiceWords.warm`) and the cache of the spoken reply, the
   * first reply's own request with a few output tokens (`voiceWarm.ts`), for the audiences the channel may hear. `others`: someone but the owner is
   * in the channel. Each audience at most once in ten minutes; nothing is said, kept or remembered; a failure is not an error.
   */
  async warm(value?: unknown): Promise<{ warmed: boolean; reply?: ReplyWarm[] }> {
    const [words, reply] = await Promise.all([this.words.warm(), this.warmReply(value)]);
    return reply.length ? { ...words, reply } : words;
  }

  private readonly replyWarmedAt = new Map<WarmAudience, number>();

  private async warmReply(value: unknown): Promise<ReplyWarm[]> {
    const warm = this.dependencies.conversation.warmVoiceReply;
    if (!warm || !this.seated) return [];
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const at = Date.parse(this.dependencies.now());
    const known = typeof body.conversationId === 'string' && body.conversationId.length > 0 && body.conversationId.length <= 240
      ? this.dependencies.bridge.bindingOf({ platform: 'discord', conversationId: body.conversationId }) : null;
    const wanted = warmedAudiences(body.others === true, known ? known.audience === 'owner-private' : undefined).filter(audience => {
      const last = this.replyWarmedAt.get(audience);
      return last === undefined || at - last >= REPLY_WARM_INTERVAL_MILLISECONDS;
    });
    for (const audience of wanted) this.replyWarmedAt.set(audience, at);
    const offerMinecraftIntent = body.intent !== false;
    const settled = await Promise.all(wanted.map(async (audience): Promise<ReplyWarm> => {
      try {
        const used = await warm.call(this.dependencies.conversation, { scopeKey: this.dependencies.scopeKey, audience, offerMinecraftIntent });
        this.log(`Shannon platform voice reply warm audience=${audience} ${used ? `input=${used.input} cacheRead=${used.cacheRead} cacheWrite=${used.cacheWrite} ms=${used.milliseconds}` : 'skipped'}`);
        return { audience, warmed: used !== null, ...(used ?? {}) };
      } catch {
        this.replyWarmedAt.delete(audience); // The next call may try again.
        return { audience, warmed: false };
      }
    }));
    return settled;
  }

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
    return this.turnRequest(validatedVoiceTurn(value), emit);
  }

  /** One spoken turn already in the request's form (one head: `POST /v1/converse` reads the one shape into it). */
  async turnRequest(request: VoiceTurnRequest, emit: (line: VoiceTurnLine) => void): Promise<void> {
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
  private seat(request: VoiceTurnRequest): ChannelSeat {
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
      conversationKind: request.conversationKind ?? 'channel', participants: [...humans],
    }, { sharedPresence: shared });
    const title = binding.title === OPEN_CONVERSATION_TITLE && request.title ? request.title : binding.title;
    return { binding, policy, humans, owner: policy.ownerWrote, startedAt: performance.now(), title };
  }

  /** One head: the turn through the one voice turn the apps use, when the switch is on and the kernel offers it. */
  private get seated(): SeatedVoiceTurn | null {
    return oneHeadEnabled(this.environment) ? this.dependencies.conversation.seatedVoiceTurn ?? null : null;
  }

  private async answer(asked: VoiceTurnRequest, hash: string, key: string, out: VoiceOut): Promise<void> {
    const binding = this.dependencies.bridge.bindingOf({ platform: asked.platform, conversationId: asked.conversationId });
    const request = binding ? ownerAsBound(asked, binding.ownerUserId) : asked;
    const seat = this.seat(request);
    const cutShortBefore = this.words.cutShortCount(request.conversationId);
    const address = await this.addressOf(seat, request);
    if (!address.respond) return this.stayQuiet(seat, request, hash, key, address, out);
    this.admit(seat, request);
    const filler = this.fillerFor(request, address);
    out.line({ type: 'decision', respond: true, reason: address.reason, filler: filler ? { id: filler.id, text: filler.text } : null });
    const decisionMs = Math.round(performance.now() - seat.startedAt);
    // Said over her reply: the decision line above is what stops it, and the body then reports how far she got. The answer waits for that.
    if (request.speakingNow) {
      const wait = this.dependencies.cutShortWaitMilliseconds ?? PLATFORM_VOICE_LIMITS.cutShortWaitMilliseconds;
      await this.words.untilCutShort(request.conversationId, cutShortBefore, wait);
    }
    const body = this.bodyFor(seat);
    const seated = this.seated;
    const answer = seated ? await this.askOneHead(seated, seat, request, hash, filler, body, address, out)
      : await this.ask(seat, request, hash, filler, body, address, out);
    const handed = await this.carryIntent(seat, request, hash, answer, body, out);
    this.finish(seat, request, hash, key, answer, { decisionMs, address: address.reason, filler, handed }, out);
  }

  /**
   * Whether she answers these words. With `SHANNON_ADDRESSED` on: only words said to her by name, and the same person's follow-up within
   * ~20 s of her last words (Jev judges; local rules when it does not answer), also with one person in the channel. Off: the shared-table rules.
   */
  private async addressOf(seat: ChannelSeat, request: VoiceTurnRequest): Promise<VoiceAddress> {
    const judge = this.dependencies.addressed ?? null;
    const humans = seat.humans.size;
    const judged = judge !== null && switchOn(this.environment, 'SHANNON_ADDRESSED');
    if (request.directed) return this.directedAddress(request, judged ? judge : null);
    if (!judge || !judged) {
      return voiceAddress({ transcript: request.userMessage, humans, followsShannonTurn: request.followsShannonTurn });
    }
    const room = request.conversationId;
    this.noteHeardLines(request);
    // A request of anyone may be under way, and anyone's stop word stops it (the body part on: `offersIntent`).
    const body = this.bodyFor(seat);
    const bodyRunning = (body?.state.running ?? null) !== null;
    const built = addressedInputOf(this.rooms, request, { scopeKey: this.dependencies.scopeKey, humans, owner: seat.owner, bodyRunning,
      guestsMayStop: this.offersIntent(seat, body), work: workOf(body?.state) });
    const { shown, waiting, fragment } = questionJudged(built, judge, request.userMessage);
    if (fragment) return { respond: false, reason: 'fragment' };
    const verdict = await judge.judge(shown);
    // The question is taken when she takes these words (an answer, or a named call): chat judged not to be an answer leaves it open for the real one.
    if (waiting && verdict.addressed) this.rooms.closeQuestion(room);
    this.rooms.noteExchange(room, { role: 'person', userId: request.sourceUserId, name: request.sourceDisplayName, text: request.userMessage, at: request.observedAt });
    this.log(`Shannon platform voice addressed=${verdict.addressed} reason=${verdict.reason} source=${verdict.source} ms=${verdict.ms} humans=${humans}`);
    return { respond: verdict.addressed, reason: verdict.reason };
  }

  /** What the body heard of the others and did not send as a turn belongs to the talk the judgement reads. */
  private noteHeardLines(request: VoiceTurnRequest): void {
    for (const line of request.heard) {
      this.rooms.noteExchange(request.conversationId, { role: 'person', userId: line.userId, name: line.name, text: line.text, at: line.at });
    }
  }

  /**
   * Words said with the push-to-talk key held are to her: she answers them without being named, whoever else is in the room and with or
   * without `SHANNON_ADDRESSED`. A breath, a key press or a lone sound nobody waits on is still no turn (`voiceFragment`). The words go into the
   * room's talk as every answered turn's do, and they take a question of hers that was waiting.
   */
  private directedAddress(request: VoiceTurnRequest, judge: AddressedJudge | null): VoiceAddress {
    const spokeAgo = shannonSpokeAgoMs(this.rooms, request);
    const window = judge?.windowMilliseconds ?? ADDRESSED_WINDOW_MILLISECONDS;
    const follows = request.followsShannonTurn || (spokeAgo !== null && spokeAgo <= window);
    if (voiceFragment({ transcript: request.userMessage, followsShannonTurn: follows })) return { respond: false, reason: 'fragment' };
    if (judge) {
      const room = request.conversationId;
      this.noteHeardLines(request);
      this.rooms.closeQuestion(room);
      this.rooms.noteExchange(room, {
        role: 'person', userId: request.sourceUserId, name: request.sourceDisplayName, text: request.userMessage, at: request.observedAt,
      });
    }
    return { respond: true, reason: 'directed', ...answersHerQuestion(this.rooms, request, judge?.questionWindowMilliseconds) };
  }

  /** Heard, not answered: context for a few minutes, nothing in her memory. */
  private stayQuiet(seat: ChannelSeat, request: VoiceTurnRequest, hash: string, key: string, address: VoiceAddress, out: VoiceOut): void {
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

  private admit(seat: ChannelSeat, request: VoiceTurnRequest): void {
    if (!seat.owner && !request.sourceDisplayName) {
      throw new PlatformBridgeError('PLATFORM_ACTOR_DENIED', 403, 'This external actor is not bound to the Shannon owner.');
    }
    if (!this.allowance.take(seat.owner, `${request.platform}:${request.sourceUserId}`, Date.parse(this.dependencies.now()))) {
      const message = seat.owner ? 'Too many spoken turns from the owner; retry after a minute.' : 'Too many spoken turns from this person; retry later.';
      throw new PlatformBridgeError('RATE_LIMITED', 429, message);
    }
  }

  private fillerFor(request: VoiceTurnRequest, address: VoiceAddress): VoiceFiller | null {
    const begun = request.fillerId ? voiceFillerById(request.fillerId) : null;
    if (begun) {
      this.rooms.useFiller(request.conversationId, begun.id);
      return begun;
    }
    // Words said with the key held are certainly answered (no filler is played for a decision not to answer): they get a short sound first even with the switch off.
    const wanted = switchOn(this.environment, 'SHANNON_DC_VOICE_FILLER') || request.directed === true;
    const previous = this.rooms.lastFiller(request.conversationId);
    const filler = wanted ? selectVoiceFiller({ transcript: request.userMessage, reason: address.reason, previous }) : null;
    this.rooms.useFiller(request.conversationId, filler?.id);
    return filler;
  }

  /** Her Minecraft body's side for this turn: the port and what it says now; null when the part is off. */
  private bodyFor(seat: ChannelSeat): { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null {
    const port = switchOn(this.environment, 'SHANNON_DC_VOICE_MINECRAFT') ? this.dependencies.minecraft?.() ?? null : null;
    if (!port) return null;
    try {
      return { port, state: port.state() };
    } catch {
      return null;
    }
  }

  /**
   * Whether the intent field is offered: anyone in the channel (owner decision 2026-11-21), with the body connected, except the owner alone
   * in his private room, who has her ordinary tools.
   */
  private offersIntent(seat: ChannelSeat, body: { state: VoiceMinecraftState } | null): boolean {
    return !seat.policy.gate.ownerOnly && body !== null && body.state.connected;
  }

  /**
   * Whether the intent field is offered for the way of speaking: wherever the field is, and also to the owner alone in his private room (who
   * has her ordinary tools for requests, so there the field only carries `speech`; anything else it carries is dropped by `carryIntent`).
   */
  private offersSpeech(seat: ChannelSeat, body: { state: VoiceMinecraftState } | null): boolean {
    return this.offersIntent(seat, body) || (seat.owner && seat.policy.gate.ownerOnly);
  }

  /**
   * Whether the intent field is offered for going into or out of the server, and which: anyone's turn (who is listening
   * changes nothing she does), with the body part on and the server's state known. Her body out of the server: `login`; in it: `logout`; an
   * operation under way or a state not known: none. It does not need the body to be connected: that is what `login` brings.
   */
  private lifecycleOffer(_seat: ChannelSeat): LifecycleRequestAction | null {
    if (!switchOn(this.environment, 'SHANNON_DC_VOICE_MINECRAFT')) return null;
    try {
      const state = this.dependencies.lifecycle?.()?.state() ?? null;
      if (!state || state.pending) return null;
      if (state.running === 'running' && state.bot === 'absent') return 'login';
      return state.bot === 'joined' ? 'logout' : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the intent field offers coming into the Discord call: the speaker spoke from the game's own voice (a key held) and the body says she is
   * not in the conversation's call. A body that does not say (`inCall` absent) is not asked.
   */
  private callJoinOffer(request: VoiceTurnRequest): boolean {
    return request.directed === true && request.inCall === false;
  }

  /** Whether the intent field is offered at all: for requests, for the way of speaking, for going in or out, or for coming into the call. */
  private offersField(seat: ChannelSeat, body: { state: VoiceMinecraftState } | null, request: VoiceTurnRequest): boolean {
    return this.offersSpeech(seat, body) || this.lifecycleOffer(seat) !== null || this.callJoinOffer(request);
  }

  private promptFor(
    seat: ChannelSeat, request: VoiceTurnRequest, filler: VoiceFiller | null, body: { state: VoiceMinecraftState } | null, address: VoiceAddress,
  ): string {
    const roomKey = request.conversationId;
    this.rooms.noteHeard(roomKey, request.heard);
    const situation = request.situation ?? this.rooms.situation(roomKey) ?? this.rooms.situation('default');
    const running = body?.state.running?.goal ?? null;
    const ownerTools = seat.owner && seat.policy.gate.ownerOnly;
    const who = seat.owner ? SHANNON_OWNER_NAME : request.sourceDisplayName?.replace(/\s+/gu, ' ').trim().slice(0, 40) || '話している人';
    const intent = !ownerTools && body ? voiceIntentInstructions(body.state, who, seat.owner) : '';
    // The way of speaking is a kind of the intent field, so it is offered where the field is.
    const offer = this.lifecycleOffer(seat);
    const callJoin = this.callJoinOffer(request);
    const speech = this.offersSpeech(seat, body)
      ? speechInstructions({ owner: seat.owner, who, mode: request.speechMode, rate: request.speechRate, speechOnly: !this.offersIntent(seat, body), lifecycle: offer, callJoin }) : '';
    const lifecycle = offer ? lifecycleInstructions({ offer, who }) : '';
    return [
      platformVoiceInstructions({
        title: seat.title, ownerAlone: seat.policy.gate.ownerOnly || this.ownerAloneIn(seat), ownerSpeaking: seat.owner,
        speakerName: seat.owner ? null : request.sourceDisplayName, humans: seat.humans.size, fillerText: filler?.text,
        viaMod: request.directed === true && request.speakerMinecraftName !== undefined, modOnly: this.modOnly(request),
        speakerPosition: speakerPositionLine(request.speakerPosition),
      }),
      situationBlock(situation, running, body?.state.resting ?? [], body ? this.rooms.unhanded(roomKey) : []),
      answersAsk(address) ? askedBackBlock(this.rooms.lastShannon(roomKey)?.text ?? null) : '',
      heardBlock(this.rooms.heard(roomKey, request.userMessage)),
      intent, speech, lifecycle, callJoin ? callJoinInstructions({ who }) : '', directedBlock(request.directed === true, who, intent !== ''),
    ].filter(Boolean).join('\n\n');
  }

  /** The owner is the only one in the room (whatever the conversation's binding says): what the reply is told of who is listening follows this. */
  private ownerAloneIn(seat: ChannelSeat): boolean {
    return seat.owner && seat.humans.size === 1;
  }

  /** The words came by the game's own voice and nobody is in a Discord call under this conversation (the room's channel is the mod's own, `mod:<guild>`). */
  private modOnly(request: VoiceTurnRequest): boolean {
    return request.voiceChannelId?.startsWith('mod:') === true;
  }

  private async ask(
    seat: ChannelSeat, request: VoiceTurnRequest, hash: string, filler: VoiceFiller | null,
    body: { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null, address: VoiceAddress, out: VoiceOut,
  ): Promise<VoiceAnswer> {
    const { scopeKey, conversation } = this.dependencies;
    const spoken = new SpokenSentences(out);
    const sink: ChatSentenceSink = { write: line => { if (line.type === 'sentence') spoken.stream(line.text); } };
    const kept: KeptTurn = { ignored: undefined };
    const transcript = request.userMessage;
    const result = await conversation.textTurn({
      ...platformTextTurnInput({
        scopeKey, policy: seat.policy, message: seat.owner ? transcript : `${request.sourceDisplayName}: ${transcript}`, rawMessage: transcript,
        prompt: this.promptFor(seat, request, filler, body, address), threadTitle: seat.title, voice: true, ownOutreach: false,
        ...(seat.owner && seat.policy.gate.ownerOnly ? { minecraftTools: true } : {}),
        ...(this.offersField(seat, body, request) ? { offerMinecraftIntent: true } : {}),
        perception: { surface: 'platform', ownerWrote: seat.owner },
        store: turn => this.keep(seat, request, hash, turn, kept),
      }),
      body: { scopeKey, message: transcript, stream: 'sentences', readAloud: true },
      request: { chatSentences: sink },
    });
    if (!result.completion) throw new Error('PLATFORM_VOICE_WITHOUT_COMPLETION');
    spoken.rest(result.completion.reply, this.dependencies.sentences);
    const { reply, minecraftIntent } = result.completion;
    const experience = result.experienceId ? { experienceId: result.experienceId } : {};
    return { reply, ...(minecraftIntent ? { minecraftIntent } : {}), ...experience, spoken, ignored: kept.ignored, turn: kept.turn };
  }

  /**
   * One head (`SHANNON_ONE_HEAD`): the same turn through the one voice turn the apps use (the router, recall when it is wanted, her plain
   * spoken stream), with this channel's seat: the bridge's policy, the audience's and the channel's blocks, and where the turn is kept.
   */
  private async askOneHead(
    seated: SeatedVoiceTurn, seat: ChannelSeat, request: VoiceTurnRequest, hash: string, filler: VoiceFiller | null,
    body: { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null, address: VoiceAddress, out: VoiceOut,
  ): Promise<VoiceAnswer> {
    const kept: KeptTurn = { ignored: undefined };
    const transcript = request.userMessage;
    const voiceSeat = platformVoiceSeat({
      policy: seat.policy, owner: seat.owner, message: seat.owner ? transcript : `${request.sourceDisplayName}: ${transcript}`,
      prompt: this.promptFor(seat, request, filler, body, address), title: seat.title, offerMinecraftIntent: this.offersField(seat, body, request),
      answered: saidToHer(address), keep: turn => this.keep(seat, request, hash, turn, kept),
      // The owner speaking with nobody else in the channel: his room for her feelings, whatever the channel's binding says.
      ownerAloneInRoom: this.ownerAloneIn(seat),
    });
    const answer = await askSeated(seated, { scopeKey: this.dependencies.scopeKey, transcript, seat: voiceSeat }, out, {
      sentences: this.dependencies.sentences, ...(this.dependencies.splitter ? { splitter: this.dependencies.splitter } : {}),
    });
    return { ...answer, ignored: kept.ignored, turn: kept.turn };
  }

  /** The turn where the platform keeps it: the owner's in his platform thread, anyone else's as person memory. Never with the voice's tags. */
  private keep(seat: ChannelSeat, request: VoiceTurnRequest, hash: string, turn: CompletedTurn, kept: KeptTurn) {
    const { conversationStore, bridge } = this.dependencies;
    const heard = { ...turn, shannonReply: displayedVoiceText(turn.shannonReply) };
    const receipt = { platform: request.platform, requestId: `voice:${request.requestId}`, payloadHash: hash };
    try {
      kept.turn = heard;
      if (seat.owner) return keepOwnerPlatformTurn(conversationStore, receipt, heard);
      kept.ignored = rememberPlatformPerson(bridge, {
        platform: request.platform, requestId: receipt.requestId, conversationId: request.conversationId, sourceUserId: request.sourceUserId,
        userMessage: request.userMessage, shannonReply: heard.shannonReply, observedAt: request.observedAt,
        conversationKind: request.conversationKind ?? 'channel', sourceDisplayName: request.sourceDisplayName, sourceKind: 'person',
      });
      return null;
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') throw conflict();
      throw error;
    }
  }

  /**
   * The record a request stands on, written into the channel's thread with the speaker's name on it (`keepOwnerPlatformTurn`: no background
   * learning from it). A guest's turn was kept only as person memory, which no task may read as its source, so theirs is always written. The
   * owner's own turn is already in his thread (`answer.experienceId`) and is used first; this is the one to fall back on when it is refused
   * as not visible (the reply recalled what a task source may not stand on, e.g. a guest's person memory). Null when it could not be written.
   */
  private requestRecord(seat: ChannelSeat, request: VoiceTurnRequest, hash: string, answer: VoiceAnswer): string | null {
    if (!answer.turn) return null;
    const name = request.sourceDisplayName || '通話の参加者';
    try {
      const receipt = { platform: request.platform, requestId: `voice-request:${request.requestId}`, payloadHash: hash };
      // Without the reply's recall: it read other people's memory (`person:…`), which no task source may stand on, and the record is only their words.
      const { recalledMemoryIds: _recalled, ...record } = answer.turn;
      const kept = keepOwnerPlatformTurn(this.dependencies.conversationStore, receipt, { ...record, userMessage: `${name}（通話）: ${request.userMessage}` });
      return kept?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Hands the intent to the body's port. A request or a message needs a source the owner can read: a guest's own turn is person memory, so
   * theirs is written as a record (`requestRecord`); the owner's own turn is tried first and the record only when it was not visible.
   */
  private async deliver(
    seat: ChannelSeat, request: VoiceTurnRequest, hash: string, answer: VoiceAnswer, kind: string,
    ask: (experienceId: string | null) => Promise<VoiceMinecraftIntentResult>,
  ): Promise<VoiceMinecraftIntentResult> {
    const needsSource = kind === 'task' || kind === 'message';
    const outcome = await ask(seat.owner || !needsSource ? answer.experienceId ?? null : this.requestRecord(seat, request, hash, answer));
    if (outcome.delivered || outcome.reason !== 'turn_not_visible' || !seat.owner || !needsSource) return outcome;
    const record = this.requestRecord(seat, request, hash, answer);
    return record ? ask(record) : outcome;
  }

  /**
   * A spoken request for her body: delivered after the reply, and the fixed words of a refusal said after a reply that promised.
   * True when the reply went with something the body took (a request, a way of speaking, a way in or out): false for words only.
   */
  private async carryIntent(
    seat: ChannelSeat, request: VoiceTurnRequest, hash: string, answer: VoiceAnswer,
    body: { port: VoiceMinecraftPort; state: VoiceMinecraftState } | null, out: VoiceOut,
  ): Promise<boolean> {
    const intent = answer.minecraftIntent;
    if (intent?.kind === 'speech') { this.carrySpeech(seat, intent, out); return true; }
    if (intent?.kind === 'call_join') { this.carryCallJoin(request, out); return true; }
    if (intent?.kind === 'login' || intent?.kind === 'logout') { this.carryLifecycle(seat, request, intent.kind, answer); return true; }
    if (!body || !intent || intent.kind === 'none' || !this.offersIntent(seat, body)) return false;
    const { scopeKey } = this.dependencies;
    const ask = (experienceId: string | null) => body.port.intent({
      scopeKey, requestId: request.requestId, observedAt: request.observedAt, intent, experienceId, words: request.userMessage,
      speaker: { id: request.sourceUserId, name: request.sourceDisplayName, owner: seat.owner,
        ...(request.speakerMinecraftName ? { minecraftName: request.speakerMinecraftName } : {}),
        ...(request.speakerPosition ? { position: request.speakerPosition } : {}) },
    }).catch((): VoiceMinecraftIntentResult => ({ delivered: false }));
    const outcome = await this.deliver(seat, request, hash, answer, intent.kind, ask);
    out.line({
      type: 'intent', kind: voiceIntentLineKind(intent.kind, outcome.as), delivered: outcome.delivered,
      ...(outcome.taskId ? { taskId: outcome.taskId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    this.log(intentLog(intent, outcome));
    if (!outcome.delivered) this.refuse(seat, request, answer, outcome.reason ?? 'not_owner_scope');
    return outcome.delivered;
  }

  /**
   * The owner's words about how she speaks, handed to the body in the turn's lines (not through the Minecraft port: the voice's body holds it).
   * Only the owner's seat: anyone else's words never change it, and no refusal is said (what a guest asked for is just not done). The body
   * checks the speaker again before it changes anything.
   */
  private carrySpeech(seat: ChannelSeat, intent: NonNullable<VoiceAnswer['minecraftIntent']>, out: VoiceOut): void {
    if (!seat.owner || (!intent.speechMode && !intent.speechRate)) {
      this.log(`Shannon platform voice speech dropped owner=${seat.owner}`);
      return;
    }
    out.line({ type: 'speech', ...(intent.speechMode ? { mode: intent.speechMode } : {}), ...(intent.speechRate ? { rate: intent.speechRate } : {}) });
    this.log(`Shannon platform voice speech mode=${intent.speechMode ?? '-'} rate=${intent.speechRate ?? '-'}`);
  }

  /**
   * Anyone's words about her coming into the Discord call: the body is told in the turn's lines (the body holds the Discord side, as it holds the way
   * of speaking), and takes the channel the speaker is in now, else the owner's. Only when the field offered it this turn (a key held, not in the call).
   */
  private carryCallJoin(request: VoiceTurnRequest, out: VoiceOut): void {
    if (!this.callJoinOffer(request)) {
      this.log('Shannon platform voice call join dropped: not offered');
      return;
    }
    out.line({ type: 'call', action: 'join' });
    this.log('Shannon platform voice call join handed to the body');
  }

  /**
   * Anyone's words about her going into or out of the server, asked of the operator's door, in parallel with her reply (never waited for:
   * it takes seconds, and its end is told when it comes). Only the kind that fits where her body is now at this
   * moment: the field is read again here, so a model that chose the other one, or a turn that raced another, changes nothing. A request that
   * would be refused at once says so in a fixed sentence, because her reply has already said she would.
   */
  private carryLifecycle(seat: ChannelSeat, request: VoiceTurnRequest, kind: LifecycleRequestAction, answer: VoiceAnswer): void {
    const offer = this.lifecycleOffer(seat);
    const port = this.dependencies.lifecycle?.() ?? null;
    if (!port || offer !== kind) {
      this.log(`Shannon platform voice lifecycle dropped: kind=${kind} offer=${offer ?? '-'}`);
      return;
    }
    const quick = port.check(kind);
    if (quick) {
      this.log(`Shannon platform voice lifecycle ${kind} answered at once: ${quick.ok ? quick.state : quick.code}`);
      if (!quick.ok) answer.spoken.say(lifecycleRefusalLine(quick, kind), true);
      return;
    }
    const actor = seat.owner ? SHANNON_OWNER_NAME : request.sourceDisplayName.replace(/\s+/gu, ' ').trim().slice(0, 40) || '通話の参加者';
    void port.request(kind, { threadId: seat.policy.threadId, actor }).then(
      result => this.log(`Shannon platform voice lifecycle ${kind} ok=${result.ok} ${result.ok ? result.state : result.code}`),
      () => this.log(`Shannon platform voice lifecycle ${kind} failed`),
    );
  }

  private refuse(seat: ChannelSeat, request: VoiceTurnRequest, answer: VoiceAnswer, reason: keyof typeof VOICE_MINECRAFT_REFUSALS): void {
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
    seat: ChannelSeat, request: VoiceTurnRequest, hash: string, key: string, answer: VoiceAnswer,
    facts: { decisionMs: number; address: string; filler: VoiceFiller | null; handed: boolean }, out: VoiceOut,
  ): void {
    const { scopeKey, turns, now } = this.dependencies;
    const reply = displayedVoiceText(answer.reply).trim().slice(0, PLATFORM_VOICE_LIMITS.replyCharacters);
    const threadId = seat.policy.threadId;
    const response: StoredVoiceTurn = { reply, threadId, respond: true, reason: facts.address };
    // Her words are for this speaker: the follow-up window of 「話しかけられたか」 opens from here (`addressOf`).
    if (reply) this.rooms.noteShannon(request.conversationId, { at: now(), userId: request.sourceUserId, text: reply }, facts.handed);
    turns.save(scopeKey, key, request.platform, hash, response as unknown as Record<string, unknown>, now(), PLATFORM_VOICE_LIMITS.replayDays);
    const totalMs = Math.round(performance.now() - seat.startedAt);
    const firstSentenceMs = answer.spoken.firstAt === null ? null : Math.round(answer.spoken.firstAt - seat.startedAt);
    out.line({ type: 'done', reply, threadId, duplicate: false, timings: { decisionMs: facts.decisionMs, firstSentenceMs, totalMs } });
    const who = `owner=${seat.owner} humans=${seat.humans.size} filler=${facts.filler?.id ?? '-'}`;
    const times = `decisionMs=${facts.decisionMs} firstSentenceMs=${firstSentenceMs ?? '-'} totalMs=${totalMs}`;
    const tail = `sentences=${answer.spoken.count} tags=${answer.spoken.tagSummary} ignored=${answer.ignored ?? '-'}`;
    this.log(`Shannon platform voice turn respond=true reason=${facts.address} ${who} ${times} ${tail}`);
  }
}
