import { InMemoryCompanionStateStore, type CompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import type { BodyReactionAnswer, BodyReactionConfig } from '../src/contracts/bodyReactionContract.js';
import type { BodyReactionSpeakRequest, BodyReactionSpeaker } from '../src/surfaces/body/bodyReactionModel.js';
import type { BodyReactionDecision } from '../src/surfaces/body/bodyReactionPrompt.js';
import { SQLiteBodyReactionStore } from '../src/surfaces/body/store/bodyReactionStore.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import type { BodyTouchDependencies } from '../src/mind/emotion/bodyTouch.js';
import type { TouchExperienceWriter } from '../src/mind/memory/store/bodyTouchMemory.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { InMemoryConversationStore, type ConversationStore } from '../src/mind/memory/store/conversationStore.js';
import type { InnerNotePort } from '../src/mind/emotion/innerNotePorts.js';
import type { FeelingPort } from '../src/mind/emotion/feelingPorts.js';

export const scope = 'owner';
export const START = '2026-10-02T06:00:00.000Z';
export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HEHE = 'えへへ、なんですかライ氏？';

/** The fast model, faked: it records what it was told and answers what the test sets, after `delayMilliseconds`. */
export class FakeSpeaker implements BodyReactionSpeaker {
  readonly calls: BodyReactionSpeakRequest[] = [];
  decision: BodyReactionDecision | Error = { say: true, text: HEHE, feeling: 'bashful' };
  /** Answers by call number (1-based) when set. */
  script?: (call: number, prompt: string) => BodyReactionDecision | Error;
  delayMilliseconds = 0;
  aborted = 0;
  completedLate = 0;

  async decide(request: BodyReactionSpeakRequest): Promise<BodyReactionDecision> {
    this.calls.push(request);
    const call = this.calls.length;
    request.signal.addEventListener('abort', () => { this.aborted += 1; });
    if (this.delayMilliseconds) {
      await new Promise(resolve => setTimeout(resolve, this.delayMilliseconds));
      if (request.signal.aborted) this.completedLate += 1;
    }
    const decision = this.script ? this.script(call, request.prompt) : this.decision;
    if (decision instanceof Error) throw decision;
    return decision;
  }

  get prompts(): string[] { return this.calls.map(call => call.prompt); }
}

export class FakeChat implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model = 'fake';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  voiceReply = 'ふふ、呼ばれた気がしたので。';
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい、ライ氏。' };
  }
  async generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    this.voiceRequests.push(request);
    return { mode: this.mode, model: this.model, reply: this.voiceReply };
  }
}

export interface ReactionHarnessOptions {
  config?: Partial<BodyReactionConfig>;
  ingestEnabled?: boolean;
  /** The fast model of a touch line; a real one only in a live evaluation. */
  speaker?: FakeSpeaker | BodyReactionSpeaker | null;
  stateStore?: CompanionStateStore;
  conversationStore?: ConversationStore;
  /** The same database path for the reaction tables when the stores are SQLite. */
  path?: string;
  experiences?: TouchExperienceWriter | null;
  /** Leaves the body unregistered: the device is then not her body. */
  unregistered?: boolean;
  /** Syzygy ADR-0006 stage 2 for touches; absent: `SHANNON_PREDICTION` (on unless stubbed off). */
  stage2?: boolean;
  /** The prediction record (stage 2 learns her stances in it); absent: none, every touch meets the empty prior. */
  prediction?: BodyTouchDependencies['prediction'];
  /** Syzygy ADR-0012 (`SHANNON_INNER_NOTE` on): her inner note's port, handed to the kernel; absent: every prompt as before. */
  innerNote?: InnerNotePort;
  /** Syzygy ADR-0013 (`SHANNON_FEELING_EVENTS` on): her feeling events' port; absent: every prompt and face as before. */
  feeling?: FeelingPort;
  /** The conversation's model; absent: `FakeChat`. */
  chatModel?: ShannonChatModel;
}

export async function reactionHarness(options: ReactionHarnessOptions = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const speaker = options.speaker === undefined ? new FakeSpeaker() : options.speaker;
  const chatModel = (options.chatModel ?? new FakeChat()) as FakeChat;
  const stateStore = options.stateStore ?? new InMemoryCompanionStateStore(now);
  const conversationStore = options.conversationStore ?? new InMemoryConversationStore();
  const autonomy = createInMemoryAutonomyService(now);
  const reactionStore = new SQLiteBodyReactionStore(options.path ?? ':memory:');
  const bodyStore = new SQLiteBodyStore(options.path ?? ':memory:');
  const api = createLocalApiKernel(now, {
    stateStore, conversationStore, chatModel, autonomy, ...(options.innerNote ? { innerNote: options.innerNote } : {}),
    ...(options.feeling ? { feeling: options.feeling } : {}),
    body: {
      store: bodyStore, ingestEnabled: options.ingestEnabled ?? true,
      reactions: { store: reactionStore, speaker, config: options.config ?? {}, experiences: options.experiences ?? null,
        ...(options.stage2 !== undefined ? { stage2: options.stage2 } : {}), ...(options.prediction !== undefined ? { prediction: options.prediction } : {}) },
    },
  });
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId = 'body-pc') =>
    api.dispatch({ method, path, body: { scopeKey: scope, ...body }, deviceId });
  if (!options.unregistered) await send('PUT', '/v1/body/capabilities', { expressions: ['smile'], gestures: [], flags: {} });
  let serial = 0;
  /** One reaction request; `touch` and the top-level fields may be overridden. */
  const react = (touch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, deviceId = 'body-pc') => {
    serial += 1;
    return send('POST', '/v1/body/reactions', {
      id: `touch-${serial}`, touch: { type: 'pet', durationMs: 1_500, ongoing: true, ...touch }, audience: 'owner', occurredAt: clock.at, ...extra,
    }, deviceId);
  };
  const said = async (touch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const response = await react(touch, extra);
    if (response.status !== 200) throw new Error(`reaction refused: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body as BodyReactionAnswer;
  };
  const events = (...items: Record<string, unknown>[]) => send('POST', '/v1/body/events', { events: items });
  const chat = async (message: string, extra: Record<string, unknown> = {}) =>
    (await send('POST', '/v1/chat', { message, ...extra }, 'iphone')).body as { systemPrompt: string; threadId: string; reply: string };
  const delegate = (transcript: string, extra: Record<string, unknown> = {}) =>
    send('POST', '/v1/voice/gemini/cascade/delegations', { transcript, ...extra }, 'body-pc');
  const persist = (userTranscript: string, shannonTranscript: string, extra: Record<string, unknown> = {}) =>
    send('POST', '/v1/voice/gemini/cascade/turns', { userTranscript, shannonTranscript, ...extra }, 'body-pc');
  const activity = () => autonomy.activityDays(scope, 2).flatMap(day => day.entries).filter(entry => entry.tool === 'body.reaction')
    .sort((left, right) => left.sequence - right.sequence);
  const messages = (threadId?: string) => conversationStore.conversationHistory(scope, threadId).map(message => ({ role: message.role, content: message.content }));
  const state = () => stateStore.snapshot(scope);
  return { clock, now, api, speaker: speaker as FakeSpeaker, chatModel, stateStore, conversationStore, autonomy, reactionStore, bodyStore,
    advance, send, react, said, events, chat, delegate, persist, activity, messages, state };
}
