import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInitialCompanionState } from '@shannon/cognition';
import { createLocalApiKernel, type ShannonApiKernelOptions } from '../../src/infra/http/apiKernel.js';
import { OpenAIResponsesChatModel, LocalStubChatModel } from '../../src/infra/models/chatModel.js';
import { createConfiguredVoiceDecisionGateway, VOICE_SKILLS } from '../../src/mind/selectors/voiceDecision.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { createInMemoryAutonomyService } from '../../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../../src/mind/action/ownTime/store/autonomyStore.js';
import { SQLiteBodyReactionStore } from '../../src/surfaces/body/store/bodyReactionStore.js';
import { SQLiteBodyStore } from '../../src/surfaces/body/store/bodyStore.js';
import { OpenAIBodyReactionSpeaker } from '../../src/surfaces/body/bodyReactionModel.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../../src/surfaces/platform/platformBridge.js';
import { PlatformPeople } from '../../src/surfaces/platform/platformPeople.js';
import { PlatformReplyService } from '../../src/surfaces/platform/platformReply.js';
import { SQLiteMinecraftTurnLog, SQLiteSurfaceTurnLog } from '../../src/surfaces/minecraft/store/minecraftTurnStore.js';
import { MinecraftBody } from '../../src/surfaces/minecraft/minecraftBody.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import { SQLiteInitiativeStore } from '../../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutSpeaker } from '../../src/surfaces/outreach/reachOutDelivery.js';
import { DisabledVoyagerCatalog } from '../../src/integrations/voyager/organizeIntegrations.js';
import { readToolPorts, skillRoutingParts } from '../../src/wiring/skillRoutingWiring.js';
import { configuredTurnRouting } from '../../src/wiring/turnRoutingWiring.js';
import { configuredSkillMemory, skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { FakeModel, FakeShowing, loopHarness, runUntilIdle, type LoopHarnessOptions } from '../autonomyLoopHarness.js';
import type { MemoryCommands, MemoryProposals } from '../../src/mind/memory/memoryPorts.js';

/**
 * The scenarios of the stage-3 switched-off proof (`stage3SwitchedOff.test.ts`, Syzygy ADR-0008 stage 3,
 * `docs/mind-workspace-contract.md`). Every surface stage 3 touches runs here on fresh stores in a temporary folder, with the
 * real OpenAI adapters and the real Jev voice gateway over a capturing fetch, and the production wiring of stage 2 (on):
 * text, voice, a touch of her body, the platform reply, her Minecraft body and her own reach-out. What is digested:
 * - `openai`: every provider request body, in order;
 * - `jev`: every Jev request body, in order;
 * - `prompts`: every answer a client was given (the system prompt of a chat among it) and every prompt of her own time;
 * - `state`: every table of every database the scenario used, one digest per table (schema and rows).
 *
 * Never change a scenario of `v1`: its digests were recorded on afb38c28 itself (the stage-2 deploy, before any stage-3 code),
 * with this file as it was then, so it uses only APIs of that commit. A later step hands the stage-3 wiring in through `hooks`.
 */
export interface Stage3Capture { openai: string[]; jev: string[]; prompts: string[]; state: string[] }

export interface Stage3Hooks {
  /** Merged into every API kernel's options (the stage-3 wiring of a later step, built from its environment). */
  kernel?: (context: { jev: typeof fetch; databasePath: string; now: () => string }) => Partial<ShannonApiKernelOptions>;
  /** Merged into the options of her own time's loop (a later step's `emitMindEvent`, for one). */
  loop?: (context: { databasePath: string }) => Partial<LoopHarnessOptions>;
  /** Told of every scenario's unexpected answer, so the test names the scenario. */
  expectStatus?: (status: number, name: string) => void;
  /** The proactive gate her own messages pass where they are written (a later step's; absent, the speaker is afb38c28's). */
  reachOutGate?: (context: { databasePath: string }) => ConstructorParameters<typeof SQLiteReachOutSpeaker>[2];
  /**
   * Step F5: the memory outbox, built from the environment by the scenario's own wiring (`memoryOutboxWiring.ts`). It gives the
   * options of the scenario's store, and, on that store, the proposals and commands handed to the writers and a `settle` that
   * waits for the in-process writer. Null (switched off): every store and writer is built exactly as on afb38c28.
   */
  memory?: (context: { databasePath: string; now: () => string }) => Stage3MemoryHook | null;
}

export interface Stage3MemoryHook {
  /** The memory parts' store options (the outbox, compaction, people facts, the trust ledger), each as its switch says. */
  storeOptions: { memoryOutbox?: boolean; memoryNotify?: () => void; structuredCompaction?: boolean; peopleFacts?: { temporal: boolean; identity: boolean }; trustLedger?: true };
  /** The proposals of the outbox on that store, or null while the outbox is off (the other memory parts change only the store). */
  attach(store: SQLiteShannonStore): { proposals: MemoryProposals; commands: Pick<MemoryCommands, 'run'> | null; settle(): Promise<void> } | null;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
/** Ids made from a random id (a capture's, a promise's: `capture-ee270f39…`), and so random themselves. */
const DERIVED_ID = /\b([a-z]+)-[0-9a-f]{8,}\b/gu;
/** The text with its random ids taken out. */
export const normalized = (text: string) => text.replace(UUID, 'ID').replace(DERIVED_ID, '$1-HEX');
export const digest = (text: string) => createHash('sha256').update(normalized(text)).digest('hex').slice(0, 24);

const AT = '2026-10-07T03:00:00.000Z'; // 12:00 in Tokyo
const TIMINGS = new Set(['voiceMetrics', 'decisionLatencyMilliseconds']);
const MINUTE = 60_000;

const structured = (reply: string) => JSON.stringify({
  reply, feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
});

function jevRouterAnswers(): Record<string, unknown> {
  return {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
    transcript_reliable: { type: 'noul', noul: 0.95 },
    reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.7 },
    conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'bright' },
    affect_intensity: { type: 'choice', choice: 'moderate' }, delivery: { type: 'choice', choice: 'quick' },
    latency_class: { type: 'choice', choice: 'under_3s' }, waiting_scenario: { type: 'choice', choice: 'general' },
    waiting_variant: { type: 'choice', choice: 'steady' }, waiting_affect: { type: 'choice', choice: 'bright' },
    waiting_intensity: { type: 'choice', choice: 'subtle' }, waiting_delivery: { type: 'choice', choice: 'quick' },
  };
}

/** One scenario's capturing world: the fetches, the clock and the temporary folder. */
function world(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `shannon-stage3-${name}-`));
  const databasePath = join(directory, 'shannon.sqlite');
  const capture: Stage3Capture = { openai: [], jev: [], prompts: [], state: [] };
  const clock = { at: Date.parse(AT) };
  const now = () => new Date(clock.at).toISOString();
  let rounds = 0;
  /** A tool round asks for one call first (`toolRound`), then answers. */
  let toolRound = false;
  const openai = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    capture.openai.push(digest(body));
    rounds += 1;
    const parsed = JSON.parse(body) as { text?: { format?: { name?: string } }; tools?: unknown[] };
    if (toolRound && rounds === 1 && parsed.tools?.length) {
      return new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call-1', name: 'study_list', arguments: '{}' }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
    }
    const format = parsed.text?.format;
    const text = format?.name === 'shannon_body_reaction' ? JSON.stringify({ say: true, text: 'えへへ、なんですかライ氏？', feeling: 'bashful', stance: null })
      : format === undefined ? 'はい、聞こえています。' : structured('はい、聞こえています。');
    return new Response(JSON.stringify({ output_text: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
  }) as typeof fetch;
  const jev = (async (_url: string | URL | Request, init?: RequestInit) => {
    capture.jev.push(digest(String(init?.body)));
    const asked = (JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }).questions;
    const router = jevRouterAnswers();
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(asked).map(([key, question]) => [key, router[key]
      ?? (question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria)[0] } : { type: 'noul', noul: 0.2 })])) }));
  }) as typeof fetch;
  // A voice answer's timings (`voiceMetrics`, the router's `decisionLatencyMilliseconds`) are the machine's, not the code's.
  const answered = (status: number, body: unknown) => {
    capture.prompts.push(digest(JSON.stringify({ status, body }, (key, value) => (TIMINGS.has(key) ? undefined : value))));
  };
  const finish = () => {
    capture.state = databaseDigests(databasePath);
    rmSync(directory, { recursive: true, force: true });
    return capture;
  };
  return {
    directory, databasePath, capture, now, openai, jev, answered, finish,
    advance: (milliseconds: number) => { clock.at += milliseconds; },
    toolRound: () => { toolRound = true; },
  };
}

/** Every table of the database, schema and rows, one digest each (`table:digest`), in name order. */
export function databaseDigests(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string; sql: string }>;
    return tables.map(table => {
      // Rows are compared without their random ids, so they are sorted after those are taken out.
      const rows = (database.prepare(`SELECT * FROM "${table.name}"`).all() as unknown[]).map(row => normalized(JSON.stringify(row, (_key, value) =>
        (value instanceof Uint8Array ? Buffer.from(value).toString('base64') : typeof value === 'bigint' ? String(value) : value)))).sort();
      return `${table.name}:${digest(`${table.sql}\n${rows.join('\n')}`)}`;
    });
  } finally { database.close(); }
}

/** The stage-2 wiring as `server.ts` builds it (on, with Jev), on the scenario's database, and how to close it. */
function stage2Parts(databasePath: string, jev: typeof fetch, now: () => string): { parts: Partial<ShannonApiKernelOptions>; close(): void } {
  const environment = { TYPESAFE_API_KEY: 'jev-test' };
  const reads = readToolPorts(environment, { notion: null, voyagerCatalog: new DisabledVoyagerCatalog(), upcoming: { promptFor: () => '' }, chatModel: new LocalStubChatModel() });
  const skillMemory = configuredSkillMemory(environment, { databasePath, createsSchema: true, defer: task => task() });
  const skills = skillMemory ? skillTurnPorts(skillMemory.memory, scopeKey => createInitialCompanionState(scopeKey, now())) : null;
  const routing = configuredTurnRouting(environment, { databasePath, choices: null, skills, now, defer: task => task() });
  return {
    parts: {
      ...skillRoutingParts(environment, { trace: null, jevFetch: jev, now }),
      ...(reads ? { readTools: reads } : {}), ...(routing ? { turnRouting: routing.routing } : {}), ...(skills ? { skills } : {}),
    },
    close: () => { routing?.close(); skillMemory?.close(); },
  };
}

type Turn = { kind: 'text' | 'voice'; words: string; extra?: Record<string, unknown> };

/** Text and voice turns through the API kernel on SQLite stores, the stage-2 wiring on. */
async function kernelScenario(name: string, turns: readonly Turn[], hooks: Stage3Hooks, options: { toolRound?: true } = {}): Promise<Stage3Capture> {
  const w = world(name);
  if (options.toolRound) w.toolRound();
  const memoryHook = hooks.memory?.({ databasePath: w.databasePath, now: w.now }) ?? null;
  const store = new SQLiteShannonStore({ path: w.databasePath, now: w.now, ...memoryHook?.storeOptions });
  const memory = memoryHook?.attach(store) ?? null;
  const peopleStore = new SQLitePeopleMemoryStore(w.databasePath);
  const background = memory ? new BackgroundUpdateCoordinator(store, store, undefined, undefined, memory.proposals) : new BackgroundUpdateCoordinator(store, store);
  const autonomyStore = new SQLiteAutonomyStore(w.databasePath);
  const autonomy = createInMemoryAutonomyService(w.now, { store: autonomyStore });
  const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: w.openai, now: w.now });
  const voiceDecision = createConfiguredVoiceDecisionGateway({ TYPESAFE_API_KEY: 'jev-test' }, undefined, w.jev);
  const stage2 = stage2Parts(w.databasePath, w.jev, w.now);
  const api = createLocalApiKernel(w.now, {
    chatModel, voiceDecision, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore, autonomy,
    ...stage2.parts, ...hooks.kernel?.({ jev: w.jev, databasePath: w.databasePath, now: w.now }), ...(memory ? { memory } : {}),
  });
  for (const turn of turns) {
    const response = await api.dispatch(turn.kind === 'text'
      ? { method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: turn.words, ...turn.extra } }
      : { method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner', threadId: 'thread-voice', transcript: turn.words, deviceContext: {
          timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...turn.extra,
          userUtterance: { id: `u-${turn.words.length}`, text: turn.words, source: 'speech', rawText: turn.words },
        } } });
    hooks.expectStatus?.(response.status, `${name}: ${turn.words}`);
    w.answered(response.status, response.body);
    await api.waitForBackground('owner');
    w.advance(MINUTE);
  }
  await background.waitForIdle('owner');
  await memory?.settle();
  stage2.close(); autonomyStore.close(); peopleStore.close(); store.close();
  return w.finish();
}

/** A touch of her body (the reflex's one model call), then a chat that follows it. */
async function bodyScenario(name: string, audience: 'owner' | 'others', hooks: Stage3Hooks): Promise<Stage3Capture> {
  const w = world(name);
  const store = new SQLiteShannonStore({ path: w.databasePath, now: w.now });
  const autonomyStore = new SQLiteAutonomyStore(w.databasePath);
  const autonomy = createInMemoryAutonomyService(w.now, { store: autonomyStore });
  const reactionStore = new SQLiteBodyReactionStore(w.databasePath);
  const bodyStore = new SQLiteBodyStore(w.databasePath);
  const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'test-only', fetcher: w.openai, now: w.now });
  const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: w.openai, now: w.now });
  const api = createLocalApiKernel(w.now, {
    chatModel, stateStore: store, conversationStore: store, knowledgeStore: store, autonomy,
    body: { store: bodyStore, ingestEnabled: true, reactions: { store: reactionStore, speaker, config: {}, experiences: null } },
    ...hooks.kernel?.({ jev: w.jev, databasePath: w.databasePath, now: w.now }),
  });
  const send = async (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId: string) => {
    const response = await api.dispatch({ method, path, body: { scopeKey: 'owner', ...body }, deviceId });
    hooks.expectStatus?.(response.status, `${name}: ${method} ${path}`);
    w.answered(response.status, response.body);
    return response;
  };
  await send('PUT', '/v1/body/capabilities', { expressions: ['smile'], gestures: [], flags: {} }, 'body-pc');
  await send('POST', '/v1/body/reactions', { id: 'touch-1', touch: { type: 'pet', durationMs: 1_500, ongoing: true }, audience, occurredAt: w.now() }, 'body-pc');
  w.advance(5_000);
  await send('POST', '/v1/body/reactions', { id: 'touch-2', touch: { type: 'poke', durationMs: 200, ongoing: false }, audience, occurredAt: w.now() }, 'body-pc');
  w.advance(MINUTE);
  await send('POST', '/v1/chat', { threadId: 'thread', message: 'いま触ったのわかった？' }, 'iphone');
  await api.waitForBackground('owner');
  reactionStore.close(); bodyStore.close(); autonomyStore.close(); store.close();
  return w.finish();
}

const OWNER_DISCORD = '900000000000000001';
const FRIEND_DISCORD = '900000000000000002';
const PLATFORM_ENVIRONMENT = {
  SHANNON_PLATFORM_BRIDGE_TOKEN: 'b'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([
    { platform: 'discord', conversationId: 'discord::555', ownerUserId: OWNER_DISCORD, title: 'ライ氏とのDM', audience: 'owner-private' },
    { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER_DISCORD, title: 'テストサーバー' },
  ]),
};

/** The platform reply: the owner in his DM, then a friend and the owner in a shared channel. */
async function platformScenario(hooks: Stage3Hooks): Promise<Stage3Capture> {
  const w = world('platform');
  const memoryHook = hooks.memory?.({ databasePath: w.databasePath, now: w.now }) ?? null;
  const store = new SQLiteShannonStore({ path: w.databasePath, now: w.now, ...memoryHook?.storeOptions });
  const memory = memoryHook?.attach(store) ?? null;
  const peopleStore = new SQLitePeopleMemoryStore(w.databasePath);
  const background = memory ? new BackgroundUpdateCoordinator(store, store, undefined, undefined, memory.proposals) : new BackgroundUpdateCoordinator(store, store);
  const autonomyStore = new SQLiteAutonomyStore(w.databasePath);
  const autonomy = createInMemoryAutonomyService(w.now, { store: autonomyStore });
  const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: w.openai, now: w.now });
  const api = createLocalApiKernel(w.now, { chatModel, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore, autonomy,
    ...hooks.kernel?.({ jev: w.jev, databasePath: w.databasePath, now: w.now }), ...(memory ? { memory } : {}) });
  const people = memory ? new PlatformPeople(peopleStore, store, undefined, memory.proposals) : new PlatformPeople(peopleStore, store);
  const bridge = new PlatformBridgeService(configuredPlatformBridge(PLATFORM_ENVIRONMENT)!, store, store, background, w.now, people, () => true);
  const turns = new SQLiteSurfaceTurnLog(w.databasePath, 'platform_reply_turns');
  const service = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now: w.now });
  const messages: Array<Record<string, unknown>> = [
    { requestId: 'dm-1', conversationId: 'discord::555', sourceUserId: OWNER_DISCORD, userMessage: '今日は寒いね' },
    { requestId: 'dm-2', conversationId: 'discord::555', sourceUserId: OWNER_DISCORD, userMessage: 'さっき何の話をした？' },
    { requestId: 'ch-1', conversationId: 'discord:111:222', conversationKind: 'channel', sourceUserId: FRIEND_DISCORD, sourceDisplayName: 'ミナ', userMessage: 'シャノン、はじめまして！' },
    { requestId: 'ch-2', conversationId: 'discord:111:222', conversationKind: 'channel', sourceUserId: OWNER_DISCORD, userMessage: 'ミナはぼくの友達だよ' },
  ];
  for (const message of messages) {
    try {
      w.answered(200, await service.reply({ platform: 'discord', observedAt: w.now(), ...message }));
    } catch (error) {
      hooks.expectStatus?.(500, `platform: ${String(message.requestId)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await background.waitForIdle('owner');
    await memory?.settle();
    w.advance(MINUTE);
  }
  await background.waitForIdle('owner');
  await memory?.settle();
  turns.close(); autonomyStore.close(); peopleStore.close(); store.close();
  return w.finish();
}

const OWNER_UUID = 'b9191317-c52d-4d67-85fe-ab831e6db146';
const FRIEND_UUID = '0f6a8c52-1b2d-4e3f-9a8b-7c6d5e4f3a2b';

/** Her Minecraft body's game chat: the owner, then a friend, on an online-mode server. */
async function minecraftScenario(hooks: Stage3Hooks): Promise<Stage3Capture> {
  const w = world('minecraft');
  const memoryHook = hooks.memory?.({ databasePath: w.databasePath, now: w.now }) ?? null;
  const store = new SQLiteShannonStore({ path: w.databasePath, now: w.now, ...memoryHook?.storeOptions });
  const memory = memoryHook?.attach(store) ?? null;
  const peopleStore = new SQLitePeopleMemoryStore(w.databasePath);
  const background = memory ? new BackgroundUpdateCoordinator(store, store, undefined, undefined, memory.proposals) : new BackgroundUpdateCoordinator(store, store);
  const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: w.openai, now: w.now });
  const api = createLocalApiKernel(w.now, { chatModel, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore,
    ...hooks.kernel?.({ jev: w.jev, databasePath: w.databasePath, now: w.now }), ...(memory ? { memory } : {}) });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot-dev', servers: [
    { serverId: 'lab-qywEbW', ownerUuid: OWNER_UUID, title: 'マイクラ実験ワールド', onlineMode: true },
  ] }) })!;
  const turns = new SQLiteMinecraftTurnLog(w.databasePath);
  const body = new MinecraftBody({ configuration, stateStore: store, conversationStore: store, background, now: w.now, chatModel, turns,
    conversation: { textTurn: input => api.textTurn(input) }, peopleStore, peopleEnabled: () => true, ...(memory ? { memory: memory.proposals } : {}) });
  const said: Array<Record<string, unknown>> = [
    { requestId: 'mc-1', speaker: { uuid: OWNER_UUID, name: 'Rai1241' }, message: 'こんばんは、シャノン' },
    { requestId: 'mc-2', speaker: { uuid: FRIEND_UUID, name: 'Mina_77' }, message: 'シャノン、一緒に家を建てよう' },
    { requestId: 'mc-3', speaker: { uuid: OWNER_UUID, name: 'Rai1241' }, message: '木材集めといて' },
  ];
  for (const fields of said) {
    try {
      w.answered(200, await body.turn('owner', 'minebot-dev', { serverId: 'lab-qywEbW', conversation: { kind: 'channel' }, observedAt: w.now(), ...fields }));
    } catch (error) {
      hooks.expectStatus?.(500, `minecraft: ${String(fields.requestId)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await background.waitForIdle('owner');
    await memory?.settle();
    w.advance(MINUTE);
  }
  await background.waitForIdle('owner');
  await memory?.settle();
  turns.close(); peopleStore.close(); store.close();
  return w.finish();
}

const WONDER = { thought: 'ライ氏はいま何をしているのでしょう。', steps: [{ action: 'reach_out', reason: 'wonder' }] };
const UPCOMING = { thought: '歯医者の時間が近いです。', steps: [{ action: 'reach_out', reason: 'upcoming' }] };

/**
 * Her own reach-out: one message sent; one held by the spacing (5 minutes); one held while the owner was active (10 minutes);
 * one sent with others present. Prompts are her loop's, digested in order; the state is the database's.
 */
async function reachOutScenario(hooks: Stage3Hooks): Promise<Stage3Capture> {
  const w = world('reach-out');
  const clock = { at: '2026-10-07T01:00:00.000Z' }; // 10:00 in Tokyo
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path: w.databasePath, now });
  const initiatives = new SQLiteInitiativeStore(w.databasePath, now);
  let othersPresent = false;
  const gate = hooks.reachOutGate?.({ databasePath: w.databasePath });
  const speaker = gate ? new SQLiteReachOutSpeaker(w.databasePath, () => othersPresent, gate) : new SQLiteReachOutSpeaker(w.databasePath, () => othersPresent);
  const showing = new FakeShowing();
  const model = new FakeModel();
  const harness = loopHarness({
    path: join(w.directory, 'autonomy.sqlite'), clock, model, showing, reachOuts: speaker,
    upcoming: { lines: () => [{ kindLabel: '予定', title: '歯医者', when: '今日 14:00〜15:00' }] },
    loop: { cycleIntervalMilliseconds: MINUTE, cyclesPerDay: 24, reachOutSpacingMilliseconds: 5 * MINUTE },
    ...hooks.loop?.({ databasePath: w.databasePath }),
  });
  const cycle = async (plan: unknown, afterMinutes: number) => {
    harness.advance(afterMinutes * MINUTE);
    model.plans = [plan];
    return runUntilIdle(harness.loop);
  };
  await cycle(WONDER, 2); // sent
  await cycle(UPCOMING, 2); // held: within the spacing
  showing.ownerActive = true;
  await cycle(WONDER, 10); // held: the owner is active
  showing.ownerActive = false;
  othersPresent = true;
  await cycle(UPCOMING, 20); // sent, with others present
  for (const prompt of model.prompts()) w.capture.prompts.push(digest(prompt));
  const record = [...harness.entries()].sort((left, right) => left.sequence - right.sequence)
    .map(entry => ({ kind: entry.kind, tool: entry.tool ?? null, outcome: entry.outcome, reasonCode: entry.reasonCode ?? null, summary: entry.summary, occurredAt: entry.occurredAt }));
  w.capture.prompts.push(digest(JSON.stringify(record)));
  const autonomyState = databaseDigests(join(w.directory, 'autonomy.sqlite')).map(item => `autonomy/${item}`);
  harness.store.close(); speaker.close(); initiatives.close(); persistent.close();
  const capture = w.finish();
  capture.state = [...capture.state, ...autonomyState];
  return capture;
}

const text = (words: string, extra: Record<string, unknown> = {}): Turn => ({ kind: 'text', words, extra });
const voice = (words: string, extra: Record<string, unknown> = {}): Turn => ({ kind: 'voice', words, extra });

export const STAGE3_SCENARIOS = Object.freeze([
  'text-two-turns', 'text-promise', 'text-others', 'text-name', 'tool-round', 'voice-greeting', 'voice-name', 'voice-companion',
  'body-touch', 'body-touch-others', 'platform', 'minecraft', 'reach-out',
] as const);

/** Every scenario, in order, each on fresh stores. */
export async function capturedStage3Digests(hooks: Stage3Hooks = {}): Promise<Record<string, Stage3Capture>> {
  const out: Record<string, Stage3Capture> = {};
  out['text-two-turns'] = await kernelScenario('text-two-turns', [text('こんにちは、シャノン'), text('さっきの話の続きをしよう')], hooks);
  out['text-promise'] = await kernelScenario('text-promise', [text('あした10時に歯医者があるから、覚えておいて'), text('ぼくの予定、覚えてる？')], hooks);
  out['text-others'] = await kernelScenario('text-others', [text('書斎の下書き、どうなってる？', { audience: 'others' })], hooks);
  out['text-name'] = await kernelScenario('text-name', [text('シャノン、聞いてる？'), text('ぼくの名前はライだよ。覚えておいてね')], hooks);
  out['tool-round'] = await kernelScenario('tool-round', [text('書斎に何がある？')], hooks, { toolRound: true });
  out['voice-greeting'] = await kernelScenario('voice-greeting', [voice('おはよう、今日は寒いね'), voice('きのうの話、覚えてる？')], hooks);
  out['voice-name'] = await kernelScenario('voice-name', [voice('シャノン、聞いてる？')], hooks);
  out['voice-companion'] = await kernelScenario('voice-companion', [voice('書斎のメモを読んで', { companionPresent: true })], hooks);
  out['body-touch'] = await bodyScenario('body-touch', 'owner', hooks);
  out['body-touch-others'] = await bodyScenario('body-touch-others', 'others', hooks);
  out.platform = await platformScenario(hooks);
  out.minecraft = await minecraftScenario(hooks);
  out['reach-out'] = await reachOutScenario(hooks);
  return out;
}
