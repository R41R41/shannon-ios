import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActionThreads } from '../../../src/contracts/actionThreadContract.js';
import { CALENDAR_UPCOMING_PATH } from '../../../src/contracts/calendarContract.js';
import { SQLiteShannonStore } from '../../../src/infra/sqlite/sqliteStore.js';
import { createConfiguredChatModel, type ShannonChatModel } from '../../../src/infra/models/chatModel.js';
import type { LlmUsageEvent, LlmUsageStore } from '../../../src/infra/models/llmUsage.js';
import { SQLiteAgentTaskStore } from '../../../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { ShannonAutonomyService } from '../../../src/mind/action/ownTime/autonomyService.js';
import { SQLiteActionStore } from '../../../src/mind/action/threads/store/actionStore.js';
import { configuredAutonomy } from '../../../src/mind/inhibition/autonomyBudget.js';
import { createConfiguredTurnMemoryRecall } from '../../../src/mind/recall/turnMemoryRecall.js';
import { configuredVoiceDecision } from '../../../src/wiring/cognitionLedgerWiring.js';
import { DurableBackgroundDispatcher } from '../../../src/mind/sleep/backgroundUpdates.js';
import { foregroundRunner } from '../../../src/wiring/actionExecutionWiring.js';
import { createLocalApiKernel, type ShannonApiKernel } from '../../../src/wiring/apiKernelWiring.js';
import { SQLiteAutonomyStore } from '../../../src/wiring/autonomyStoreWiring.js';
import { dailyToolPorts } from '../../../src/wiring/dailyReadWiring.js';
import { configuredDeviceActions } from '../../../src/wiring/deviceActionWiring.js';
import { memoryPortsOf } from '../../../src/wiring/memoryOutboxWiring.js';
import { configuredOwnerUpcoming } from '../../../src/wiring/ownerUpcomingWiring.js';
import { configuredServerFca } from '../../../src/wiring/serverFcaWiring.js';
import { createModelModeWiring } from '../../../src/wiring/modelModeWiring.js';
import { configuredSonnet } from '../../../src/wiring/sonnetWiring.js';
import { readToolPorts, skillRoutingParts } from '../../../src/wiring/skillRoutingWiring.js';
import { stage5MemoryStoreOptions } from '../../../src/wiring/stage5MemoryWiring.js';
import type { DailyEvalTask, InitialState } from '../types.js';
import { CHARACTER_CORE, innerNoteDay } from '@shannon/cognition';
import { composedInnerNote } from '../../../src/wiring/innerNoteWiring.js';
import type { InnerNoteService } from '../../../src/mind/emotion/innerNoteService.js';
import { SQLiteInnerNoteStore } from '../../../src/mind/emotion/store/innerNoteStore.js';
import { localInstant } from './clock.js';
import { FAKE_DEVICE_ID, seededDeviceState, startFakeDevice, type FakeDeviceState } from './device.js';
import { emptyFixtureLog, fixturePlaceSearch, fixtureVoyager, fixtureWeather, fixtureWeb, type FixtureLog } from './fixtures.js';

export const OWNER_SCOPE = 'owner';

/**
 * The environment one trial runs with: the credentials this process was given (read, never printed), and fixed switches that
 * match the production shape the suite targets (common FCA with Stage 4 action threads, device actions, Haiku). Every
 * integration that could reach the owner's real data (Aether, Notion, Voyager, Jev, OpenAI memory) is absent.
 */
const PASSED_THROUGH = ['SHANNON_HAIKU_API_KEY', 'SHANNON_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'SHANNON_HAIKU_VOICE_THINKING',
  'SHANNON_CLAUDE_CACHE_PLAN', 'SHANNON_CLAUDE_CACHE_PLAN_VOICE', 'SHANNON_STRICT_CONVERSATION_TOOLS',
  // Jev (owner decision 2026-10-13, 「評価からもJevを呼ぶ」): the voice router and the turn's tool menu, as in production.
  'TYPESAFE_API_KEY'] as const;
/** Jev's settings (`SHANNON_JEV_MODEL`, `_ENDPOINT`, `_TIMEOUT_MS`, …) pass through with its key. */
const PASSED_THROUGH_PREFIXES = ['SHANNON_JEV_'] as const;
/** Names removed from this process's environment before a trial, so no default reader (`serverEnvironment()`) finds them. */
const WITHHELD_PREFIXES = ['SHANNON_AETHER_', 'SHANNON_NOTION_', 'SHANNON_VOYAGER_', 'SHANNON_JEV_', 'SHANNON_AGENT_', 'SHANNON_MINECRAFT_',
  'SHANNON_PLATFORM_', 'SHANNON_DATABASE_PATH', 'SHANNON_MIND_SOCKET', 'OPENAI_', 'GEMINI_', 'GOOGLE_', 'ELEVENLABS_', 'TYPESAFE_'];

export function evalEnvironment(source: Readonly<Record<string, string | undefined>>, initial: InitialState): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PASSED_THROUGH) if (source[name]?.trim()) environment[name] = source[name]!;
  if (environment.TYPESAFE_API_KEY) {
    for (const [name, value] of Object.entries(source)) if (PASSED_THROUGH_PREFIXES.some(prefix => name.startsWith(prefix)) && value?.trim()) environment[name] = value;
  }
  const model = source.SHANNON_EVALS_MODEL?.trim();
  if (model) environment.SHANNON_LLM_MODEL = model;
  Object.assign(environment, {
    SHANNON_OWNER_SCOPE_KEY: OWNER_SCOPE,
    SHANNON_AUTONOMY_TIMEZONE: initial.timeZone ?? 'Asia/Tokyo',
    SHANNON_OWNER_HOME_LOCATION: `${initial.home.latitude},${initial.home.longitude},${initial.home.label}`,
    SHANNON_FCA_RUNTIME: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_FCA_SLEEP: 'off', SHANNON_FCA_TOUCH: 'off', SHANNON_FCA_MINECRAFT: 'off',
    // Sonnet routing as production (`SHANNON_SONNET_ROUTING=on`): the owner's model mode decides which tier answers.
    SHANNON_DEVICE_ACTIONS: 'on', SHANNON_AUTONOMY_ENABLED: 'off', SHANNON_MORNING_BRIEF: 'off', SHANNON_SONNET_ROUTING: 'on',
    SHANNON_CALENDAR_INGEST: 'on',
    // Syzygy ADR-0012 (the K tasks): her inner note, only for the tasks about it.
    ...(initial.innerNote ? { SHANNON_INNER_NOTE: 'on' } : {}),
    // The voice router's Haiku fallback (used without Jev, or when Jev fails) gets production's 3 s (deploy env); the code default
    // of 1.2 s times out on almost every turn and routes by keywords only, which offers no tools (first live smoke, 2026-10-13).
    SHANNON_VOICE_ROUTER_TIMEOUT_MS: source.SHANNON_VOICE_ROUTER_TIMEOUT_MS?.trim() || '3000',
  });
  return environment;
}

/** Makes this process's environment the trial's (eval process only): default readers see the same values. */
export function applyEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(process.env)) if (WITHHELD_PREFIXES.some(prefix => name.startsWith(prefix))) delete process.env[name];
  Object.assign(process.env, environment);
}

function actionThreadsOver(db: DatabaseSync, now: () => string): { store: SQLiteActionStore; actions: ActionThreads } {
  const store = new SQLiteActionStore(db);
  const holder = 'evals-daily';
  const actions: ActionThreads = {
    admitRespond: async draft => store.admitRespond(draft, holder, now()),
    enqueue: async draft => store.enqueue(draft, now()), claim: async id => store.claim(id, holder, now()),
    renew: async (lease, progress) => store.renew(lease, now(), progress), dispatch: async (lease, keys) => store.dispatch(lease, now(), keys),
    finish: async (lease, state, code) => store.finish(lease, state, code, now()), list: async scope => store.list(scope),
    get: async (scope, id) => { const action = store.get(id); return action?.scopeKey === scope ? action : null; },
    acknowledgeNotice: async (scope, id, notificationId, requestId) => store.acknowledgeNotice(scope, id, notificationId, requestId, now()),
    stop: async (scope, id, request) => store.stop(scope, id, request, now()), resume: async (scope, id) => store.resume(scope, id, now()),
    reconcile: async (lease, state, code) => store.reconcile(lease, state, code, now()),
    checkpoint: async (lease, code, failureCode) => store.checkpoint(lease, code, now(), failureCode),
    reconcileResource: async (lease, resource, id) => store.reconcileResource(lease, resource, id),
    reserve: async (lease, id, day, yen, cap, spent) => store.reserve(lease, id, day, yen, cap, spent, now()),
    settle: async (lease, id, yen) => store.settle(lease, id, yen, now()),
    acknowledge: async report => store.acknowledge(report, now()),
  };
  return { store, actions };
}

/** Observes first reply tokens without changing a request or a result (the model layer is untouched). */
export interface TokenProbe { firstTokenAt: number | null }

function observedModel(model: ShannonChatModel, probe: TokenProbe): ShannonChatModel {
  const mark = () => { probe.firstTokenAt ??= performance.now(); };
  return {
    get mode() { return model.mode; }, get model() { return model.model; },
    ...(model.searchWeb ? { searchWeb: model.searchWeb } : {}), ...(model.readWeb ? { readWeb: model.readWeb } : {}),
    generate: request => model.generate(request),
    ...(model.generateStreaming ? { generateStreaming: (request, onText) => model.generateStreaming!(request, text => { mark(); return onText(text); }) } : {}),
    ...(model.generateVoice ? { generateVoice: request => model.generateVoice!(request) } : {}),
    ...(model.generateVoiceStreaming ? { generateVoiceStreaming: (request, onDelta, signal) =>
      model.generateVoiceStreaming!(request, delta => { mark(); return onDelta(delta); }, signal) } : {}),
  };
}

export interface ToolCallRecord { tool: string; surface: 'text' | 'voice'; ok: boolean; at: number }

export interface EvalRuntime {
  kernel: ShannonApiKernel;
  store: SQLiteShannonStore;
  device: FakeDeviceState;
  fixtures: FixtureLog;
  usage: LlmUsageEvent[];
  toolCalls: ToolCallRecord[];
  probe: TokenProbe;
  /** The conversation the task talks in (a K task's `newThread` turn opens another). */
  threadId: string;
  /** ADR-0012: her inner note's writer (K tasks), or null. */
  innerNote: InnerNoteService | null;
  /** The newest notes of the trial, newest first (K tasks; empty otherwise). */
  innerNotes(): ReturnType<SQLiteInnerNoteStore['since']>;
  /** FCA tasks of the owner (empty when the common FCA is not composed). */
  tasks(): ReturnType<NonNullable<ReturnType<typeof configuredServerFca>>['runtime']['list']>;
  fcaComposed: boolean;
  close(): Promise<void>;
}

/**
 * One trial's Shannon, in this process, over a fresh temporary SQLite database: the server's composition for the turn path
 * (`server.ts`), with the device, calendar, web, weather and Voyager behind the fakes above. `live: false` keeps the model a
 * local stub and leaves the FCA out (no credential is needed or read): the plumbing test uses it.
 */
export async function createEvalRuntime(task: DailyEvalTask, environment: Record<string, string>, options: {
  live: boolean; log: (line: string) => void;
  /** A scripted model in place of the configured one (harness tests); the recorded web is still installed on it. */
  model?: ShannonChatModel;
  /**
   * The owner's model mode, as the app's switch sets it (`/v1/model-mode`, `primary_model_preferences`): `haiku` (default; every
   * turn at medium, `luna_plus`) or `sonnet` (the tiered model: Sonnet answers, luna when Sonnet fails before anything happened).
   */
  modelMode?: 'haiku' | 'sonnet';
}): Promise<EvalRuntime> {
  const initial = task.initial;
  const directory = mkdtempSync(join(tmpdir(), 'shannon-evals-daily-'));
  const path = join(directory, 'shannon.sqlite');
  const now = () => new Date().toISOString();
  const usageEvents: LlmUsageEvent[] = [];
  const store = new SQLiteShannonStore({ path, now, ...stage5MemoryStoreOptions(environment) });
  const usage: LlmUsageStore = {
    recordLlmUsage: event => { usageEvents.push(event); try { store.recordLlmUsage(event); } catch { /* the trial's own count stands */ } },
    backgroundLlmCostUsd: monthKey => store.backgroundLlmCostUsd(monthKey),
    voiceLlmCostUsdForDay: (scopeKey, dayKey) => store.voiceLlmCostUsdForDay?.(scopeKey, dayKey) ?? 0,
  };
  const memoryPorts = memoryPortsOf(store, now);
  const fixtures = emptyFixtureLog(), web = fixtureWeb(initial, fixtures);
  const liveChat = options.model ?? createConfiguredChatModel(options.live ? environment : {}, usage);
  // The recorded web: the model's own query-only reads answer from the task's fixtures.
  Object.defineProperty(liveChat, 'searchWeb', { value: web.search, configurable: true, writable: true });
  Object.defineProperty(liveChat, 'readWeb', { value: web.read, configurable: true, writable: true });
  // Place searches answer from the task's `placeResults`, never from the model's own (live) web search.
  const chat = fixturePlaceSearch(liveChat, initial, fixtures);
  const probe: TokenProbe = { firstTokenAt: null };
  // Live: the kernel's model is production's (`server.ts`): the primary-mode model over Haiku and the Sonnet tier, with the
  // owner's mode stored in this trial's database. The scripted test model stays as it is.
  const sonnet = options.live && !options.model ? configuredSonnet(environment, { usageStore: usage, now, webSearch: web.search }) : null;
  const modelModes = options.live && !options.model ? createModelModeWiring(environment, { path, ownerScope: OWNER_SCOPE, haiku: chat, sonnet }) : null;
  if (modelModes && (options.modelMode ?? 'haiku') !== 'haiku') {
    if (!sonnet || !modelModes.store.compareAndSet(OWNER_SCOPE, 0, options.modelMode!)) throw new Error(`MODEL_MODE_UNAVAILABLE ${options.modelMode}`);
  }
  const model = observedModel(modelModes?.chatModel ?? chat, probe);
  const autonomyStore = new SQLiteAutonomyStore(path);
  const autonomyConfig = configuredAutonomy(environment, { databasePath: path });
  const agentTasks = new SQLiteAgentTaskStore(path);
  const autonomy = new ShannonAutonomyService({ store: autonomyStore, config: autonomyConfig, now, agentTasks, defaultThread: scope => store.threadId(scope) });
  const toolCalls: ToolCallRecord[] = [];
  autonomy.tools.observeChoices((_scope, call) => { toolCalls.push({ tool: call.tool, surface: call.surface, ok: call.ok, at: performance.now() }); }, now);
  const voyagerCatalog = fixtureVoyager(initial, fixtures);
  const ownerUpcoming = configuredOwnerUpcoming(environment, path, { snapshot: scope => store.snapshot(scope), now, tasks: voyagerCatalog });
  const reads = readToolPorts({ ...environment, SHANNON_READ_TOOLS: 'on' }, { notion: null, voyagerCatalog, upcoming: ownerUpcoming.upcoming, chatModel: chat, now });
  const readTools = reads ? { ...reads, daily: dailyToolPorts(environment, {
    schedule: (scope: string, at: string) => ownerUpcoming.upcoming.loopLines?.(scope, at, 'owner') ?? [], web: web.search, fetcher: fixtureWeather(initial, fixtures), now,
  }) } : undefined;
  const deviceActions = configuredDeviceActions(environment, path, now, autonomy.tools);
  const memoryRecall = createConfiguredTurnMemoryRecall(store, environment, null);
  const actionDb = new DatabaseSync(path);
  if (initial.innerNote?.seed?.length) seedInnerNotes(path, initial);
  const innerNote = initial.innerNote ? composedInnerNote(environment, { databasePath: path, ownerScope: OWNER_SCOPE, timeZone: initial.timeZone ?? 'Asia/Tokyo',
    now, usageStore: usage, state: store, conversation: store, log: options.log }) : null;
  const innerNotes = initial.innerNote ? new SQLiteInnerNoteStore(path) : null;
  const threads = actionThreadsOver(actionDb, now);
  let kernel!: ShannonApiKernel;
  const fca = options.live ? configuredServerFca(environment, {
    path, ownerScope: OWNER_SCOPE, ownerAlone: () => kernel.ownerAloneForFeedback(OWNER_SCOPE), usage, affect: store,
    memory: memoryPorts?.proposals ?? null, enrich: memoryRecall, state: store, conversations: store, tools: autonomy.tools, actionThreads: threads.actions,
    readSources: { upcoming: ownerUpcoming.upcoming, voyagerAvailable: () => true, aetherAvailable: () => false, notionAvailable: () => false },
  }) : null;
  kernel = createLocalApiKernel(now, {
    chatModel: model, auxiliaryChatModel: modelModes ? chat : model, voiceDecision: configuredVoiceDecision(options.live ? environment : {}, usage, null), // As `server.ts` builds it (no traces in a trial).
    stateStore: store, conversationStore: store, background: new DurableBackgroundDispatcher(store, store), knowledgeStore: store,
    agentTasks, voyagerCatalog, upcoming: ownerUpcoming.upcoming, memoryRecall, autonomy,
    minecraftRequests: deviceActions.reports(null), ...(readTools ? { readTools } : {}), ...(memoryPorts ? { memory: memoryPorts } : {}),
    mind: { perceive: () => null, foreground: foregroundRunner(threads.actions) },
    fcaConversation: () => fca?.conversation ?? null, fcaVoice: () => fca?.voice ?? null,
    // Stage 2 (`server.ts`): Jev's tool menu for the turn while its key is set (no decision traces in a trial).
    ...(options.live ? skillRoutingParts(environment, { trace: null, now }) : {}),
    ...(innerNote ? { innerNote: innerNote.port } : {}),
  });
  const threadId = seedConversation(store, initial);
  const device = seededDeviceState(initial);
  const uploadCalendar = () => {
    void kernel.dispatch({ method: 'PUT', path: CALENDAR_UPCOMING_PATH, deviceId: FAKE_DEVICE_ID, body: calendarSnapshot(device, initial) })
      .then(result => { if (result.status >= 300) options.log(`calendar snapshot refused: ${result.status}`); })
      .catch(() => options.log('calendar snapshot failed'));
  };
  uploadCalendar();
  const fake = deviceActions.actions
    ? startFakeDevice(deviceActions.actions, OWNER_SCOPE, initial, device, { inCall: task.surface === 'voice', onChange: uploadCalendar, log: options.log })
    : null;
  return {
    kernel, store, device, fixtures, usage: usageEvents, toolCalls, probe, threadId, fcaComposed: Boolean(fca), innerNote: innerNote?.service ?? null,
    innerNotes: () => innerNotes?.since(OWNER_SCOPE, '1970-01-01T00:00:00.000Z', 200) ?? [],
    tasks: () => fca ? fca.runtime.list(OWNER_SCOPE) : [],
    async close() {
      // A reply's feeling is committed on the next tick after the response (`commitReplyEmotionLater`); let it land.
      await new Promise(resolve => setTimeout(resolve, 50));
      await fake?.stop();
      await fca?.close();
      try { await kernel.waitForBackground(OWNER_SCOPE); } catch { /* nothing waits on it */ }
      await innerNote?.close(); innerNotes?.close();
      deviceActions.close(); ownerUpcoming.close(); autonomyStore.close(); modelModes?.close(); actionDb.close(); store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The task's earlier conversations, written as stored turns; returns the thread the task talks in. */
function seedConversation(store: SQLiteShannonStore, initial: InitialState): string {
  const clock = Date.now();
  let current: string | null = null;
  for (const thread of initial.threads ?? []) {
    const threadId = store.createThread(OWNER_SCOPE, thread.title);
    for (const turn of thread.turns) store.appendTurn(OWNER_SCOPE, threadId, turn.user, turn.reply, new Date(clock - turn.minutesAgo * 60_000).toISOString());
    if (thread.current) current = threadId;
  }
  return current ?? store.createThread(OWNER_SCOPE, '新しいトーク');
}

function calendarSnapshot(device: FakeDeviceState, initial: InitialState): Record<string, unknown> {
  const timeZone = initial.timeZone ?? 'Asia/Tokyo', clock = Date.now();
  const iso = (local: string) => new Date(localInstant(local.length === 10 ? `${local}T00:00` : local, timeZone)).toISOString();
  return {
    scopeKey: OWNER_SCOPE, generatedAt: new Date(clock).toISOString(), timeZone,
    windowStart: new Date(clock - 86_400_000).toISOString(), windowEnd: new Date(clock + 14 * 86_400_000).toISOString(),
    events: device.calendar.map(event => ({ id: event.id, title: event.title, start: iso(event.start), end: iso(event.end), allDay: event.allDay === true,
      ...(event.location ? { location: event.location } : {}) })),
  };
}

/** The notes she wrote before the task (ADR-0012 K6, K7, K10), oldest first, as the reflection would have stored them. */
function seedInnerNotes(path: string, initial: InitialState): void {
  const store = new SQLiteInnerNoteStore(path);
  const clock = Date.now();
  try {
    for (const seed of [...initial.innerNote!.seed!].sort((left, right) => right.minutesAgo - left.minutesAgo)) {
      const createdAt = new Date(clock - seed.minutesAgo * 60_000).toISOString();
      const day = innerNoteDay(createdAt, initial.timeZone ?? 'Asia/Tokyo');
      const previous = store.latest(OWNER_SCOPE);
      store.append({ scopeKey: OWNER_SCOPE, dayId: previous?.dayKey === day.dayKey ? previous.dayId : null, dayKey: day.dayKey, dayEndsAt: day.endsAt,
        text: seed.text, hooks: { shown: seed.shown as never, tell: seed.tell ?? 'none', scale: seed.scale, dayReason: seed.dayReason ?? null, intent: seed.intent,
          until: seed.untilMinutes === undefined ? null : new Date(clock + seed.untilMinutes * 60_000).toISOString(),
          routeSummary: 'Shannon is acting a little sulky and cool.' },
        triggers: ['touch'], events: [], sourceIds: [], flags: {}, changeReason: null, summary: null, coreVersion: CHARACTER_CORE.version,
        coreHash: CHARACTER_CORE.hash, usage: null, elapsedMs: 0, createdAt, closing: false });
    }
  } finally { store.close(); }
}
