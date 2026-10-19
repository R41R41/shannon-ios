import { setTimeout as delay } from 'node:timers/promises';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { actionHarness } from './actionThreadHarness.js';
import { fcaDenseWorld, rng, type DENSE_WORLD } from './fcaDenseWorld.js';
import { message, scriptedAnthropic, type AnthropicMessage } from './anthropicFixtures.js';
import { monitorLoop, type LoopReport } from './perfMeasure.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import { actionResource } from '../../src/contracts/actionThreadContract.js';
import type { MinecraftControlReceipt } from '../../src/contracts/minecraftControlContract.js';
import { currentActionExecution, actionPermit } from '../../src/infra/context/actionExecution.js';
import { startEventLoopWatch, timedTick } from '../../src/infra/observer/eventLoopWatch.js';
import { startObserverPublisher } from '../../src/infra/observer/store/observerStore.js';
import { createAnthropicFcaModel } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import { createAnthropicFcaSummarizer } from '../../src/infra/models/anthropic/anthropicFcaSummary.js';
import { anthropicFcaHistoryCodec } from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
import { MinecraftControl } from '../../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../../src/surfaces/minecraft/store/minecraftControlStore.js';
import { createMinecraftTaskBody } from '../../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { createReflexGovernor } from '../../src/mind/action/reflex/reflexGovernor.js';
import { createFcaProgressTools } from '../../src/mind/action/fca/fcaProgressTools.js';
import { createFcaSourceGuard } from '../../src/mind/action/fca/fcaConversationPorts.js';
import { FCA_SOURCE_VERDICT_MS } from '../../src/mind/action/fca/fcaConversationSources.js';
import { providerToolName } from '../../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import { createFcaSharedWiring } from '../../src/wiring/fcaSharedWiring.js';
import { fcaMinecraftTools, combineFcaTools } from '../../src/wiring/fcaMinecraftTools.js';
import { createFcaTaskObservationMonitor } from '../../src/wiring/fcaTaskObservationWiring.js';
import { stepVisibility, taskGates } from '../../src/wiring/fcaPeekGates.js';
import { MINECRAFT_REQUEST_CRITERIA } from '../../src/wiring/fcaMinecraftRequests.js';

/**
 * An offline Minecraft body task as production runs it, for measuring what holds the API's one thread (the stalls of production run 14,
 * 2026-10-17: `event loop blocked` 204 times in 30 minutes while the task ran). Real: the task runtime, the FCA step with its history,
 * recall, evidence and compaction, the Anthropic request builders and codecs, the Minecraft control and its task adapter (monitor,
 * metrics, fast judgment), the source guard over a production-dense remembered-turn graph (`fcaDenseWorld.ts`) in one SQLite file
 * shared by all of them. Scripted: the model's answers (instant, with a pause) and the body, which polls every 100 ms with a world
 * frame of the size production sends and runs the skills it is handed for a while. Nothing here is copied from production.
 */
export interface LoopStallOptions {
  /** Model decisions to run (then the task waits). */
  steps: number;
  /** `current` is the guard and monitors as in main; `run14` is production of 2026-10-17 (monitors walk, a base lasts one verdict). */
  variant?: 'current' | 'run14';
  frameMilliseconds?: number; frameCharacters?: number;
  /** How long a body skill runs, and the model's answer takes (production: ~10-20 s a skill and ~8 s a decision). */
  skillMilliseconds?: [number, number]; modelMilliseconds?: number;
  dense?: Partial<Record<keyof typeof DENSE_WORLD, number>>;
  /** The history a step leaves: characters of thinking and of the result text, per call. */
  thinkingCharacters?: number; resultCharacters?: [number, number];
  /** Called after each decision with its number (a profile can start and stop around steps). */
  onDecision?(decision: number): void;
  /** The task starts with this many provenance rows over pool distinct remembered turns (run 14 had 100 rows over 190 ids by its end). */
  seedProvenance?: { rows: number; pool?: number; perRow?: number };
  /** Every source-guard check above this many milliseconds is recorded in walks (the guard's own line is 100). */
  walkLogMilliseconds?: number;
  /** The Observer's sidecar as the API installs it (every span and handoff of the task is written to its SQLite file); on unless false. */
  observer?: boolean;
  /** Gives up after this long. */
  timeoutMilliseconds?: number;
  /**
   * As production wires it since 2026-10-19 (serverFcaWiring.ts): the observation mode (default transient), the body task's recall
   * (bodyTaskRecall.ts, default on) and the scheduler's next turn at once (continueAtOnce, default on). legacyShape gives all three as before
   */
  legacyShape?: boolean;
  /** Jev's tool selection takes this long (production: p50 209 ms, p90 455 ms); 0, instant. */
  selectorMilliseconds?: number;
  /** Every n-th body skill fails (failureType target_occupied, a hint to change the situation); 0, none. Run 15: 3 of its first 24 decisions failed whole. */
  failureEvery?: number;
  /** Each fca_decision_metrics line, as the API writes it. */
  metrics?(line: string): void;
  log?(line: string): void;
}

export interface LoopStallResult {
  loop: LoopReport; decisions: number; summaries: number; wallMs: number;
  /** CPU time of the process (user and system) over the run: steadier than the stalls, which depend on when things coincide. */
  cpuMs: number;
  /** `event loop blocked` lines the production watch would have written (500 ms threshold), as milliseconds. */
  watch: number[];
  /** How long each write of the Observer's sidecar held the thread, milliseconds. */
  observerWrites: number[];
  walks: Array<{ total: number; epoch: number; provenance: number; reads: number; walk: number; mode: string; via: string; line: string; at: number }>;
  /** performance.now() at the start of the run, and of each decision, for reading loop.events and walks against them. */
  startedAt: number; decisionAt: number[];
  warnings: string[];
  requestCharacters: number[];
  /** Blocked time per decision interval (decision n to n+1), to see whether it grows with the task's state. */
  blockedByDecision: number[];
  close(): Promise<void>;
}

const SKILL_WORDS = ['dig', 'mine', 'craft', 'place', 'move-to', 'find', 'collect', 'smelt', 'eat', 'sleep', 'attack', 'build', 'fish', 'plant', 'trade'];

export async function runLoopStall(options: LoopStallOptions): Promise<LoopStallResult> {
  const random = rng(11), variant = options.variant ?? 'current';
  const frameMs = options.frameMilliseconds ?? 100, modelMs = options.modelMilliseconds ?? 800;
  const [skillMin, skillMax] = options.skillMilliseconds ?? [400, 1500];
  const [resultMin, resultMax] = options.resultCharacters ?? [1_500, 7_000];
  const lines: string[] = [], warnings: string[] = [], walks: LoopStallResult['walks'] = [];
  const say = options.log ?? (() => {});
  const dense = fcaDenseWorld(options.dense);
  const observer = options.observer === false ? null : startObserverPublisher(dense.world.path);
  const flushes: number[] = [];
  if (observer) {
    const store = observer.store, original = store.flush.bind(store), prune = store.prune.bind(store);
    store.flush = () => { const started = performance.now(); original(); flushes.push(performance.now() - started); };
    store.prune = () => { const started = performance.now(); prune(); flushes.push(performance.now() - started); };
  }
  const world = dense.world;
  const clock = () => new Date().toISOString();
  // One SQLite file for the store, the actions and the task runtime, as production's API process has (the sleep store's database).
  const actions = actionHarness(clock, world.path, world.store.fcaDatabase());
  const ownerAlone = () => true;
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
    servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const bodyStore = new MinecraftControlStore(actions.db);
  const control = new MinecraftControl(bodyStore, configuration, { now: Date.now, ownerAlone,
    leaseValid: lease => !!actions.store.check(lease, clock())?.resources.includes(actionResource('minebot', 'minecraft-body')),
    leaseKnown: lease => { const action = actions.store.get(lease.id); return !!action && action.generation === lease.generation && [action.holder, action.lastHolder].includes(lease.holder); } });

  // --- the model: scripted answers of the size production's are
  let decisions = 0, summaries = 0;
  const requestCharacters: number[] = [], decisionTimes: number[] = [];
  const thinking = (n: number) => `観測した状況を整理する。${'地形と持ち物と周囲の危険を見て、次にやることを考える。'.repeat(Math.ceil(n / 24))}`.slice(0, n);
  const summaryTemplate = () => JSON.stringify(Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}の要点を短く記録する`, `座標と持ち物を保つ`]])));
  const skillNames = Array.from({ length: 77 }, (_, index) => `${SKILL_WORDS[index % SKILL_WORDS.length]}-${index}`);
  const fixture = scriptedAnthropic((body, index) => {
    const tools = (body.tools as Array<{ name: string }> | undefined) ?? [];
    requestCharacters.push(JSON.stringify(body).length);
    if (tools.some(tool => tool.name === 'fca_history_summary')) {
      summaries += 1;
      return message([{ type: 'tool_use', id: `toolu_summary_${index}`, name: 'fca_history_summary', input: { template: summaryTemplate() } }], 'tool_use');
    }
    decisions += 1;
    const n = decisions;
    decisionTimes.push(performance.now());
    queueMicrotask(() => options.onDecision?.(n));
    if (n > options.steps) return message([{ type: 'tool_use', id: `toolu_wait_${n}`, name: 'fca_wait', input: { summary: '観測を待つ' } }], 'tool_use');
    const calls = [0, 1].slice(0, n % 3 === 0 ? 2 : 1).map(k => ({ type: 'tool_use', id: `toolu_${n}_${k}`,
      name: providerToolName(`mc.${skillNames[(n * 7 + k * 13) % skillNames.length]}`), input: { count: 1 + (n + k) % 8 } }));
    return message([{ type: 'thinking', thinking: thinking(options.thinkingCharacters ?? 1_200), signature: `sig-${n}-${'s'.repeat(300)}` }, ...calls], 'tool_use');
  });
  const slowFetcher = (async (url: string | URL | Request, init?: RequestInit) => { await delay(modelMs); return fixture.fetcher(url, init); }) as typeof fetch;
  const usage = () => {};
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: slowFetcher, recordUsage: usage,
    clock: () => ({ localTime: '2026-10-17 06:34', timeZone: 'Asia/Tokyo' }) });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: slowFetcher, recordUsage: usage });

  // --- the guard, the shared parts and the runtime, as `serverFcaWiring.ts` makes them
  const walkLog = (line: string) => {
    const number = (name: string) => Number(new RegExp(String.raw`\b${name}=(\d+)`, 'u').exec(line)?.[1] ?? 0);
    walks.push({ total: number('total'), epoch: number('epoch'), provenance: number('provenance'), reads: number('reads'), walk: number('walk'),
      mode: /mode=(\w+)/u.exec(line)?.[1] ?? '?', via: /via=(\w+)/u.exec(line)?.[1] ?? '?', line, at: performance.now() });
  };
  let visible!: ReturnType<typeof createFcaSourceGuard>;
  let shared!: ReturnType<typeof createFcaSharedWiring>;
  const selector = { async select(request: { tools: ReadonlyArray<{ name: string }> }) {
    if (options.selectorMilliseconds) await delay(options.selectorMilliseconds);
    return { names: request.tools.map(tool => tool.name), source: 'jev' as const };
  } };
  const legacy = options.legacyShape === true;
  const driver = createTaskRuntimeWiring({ db: actions.db, actions: actions.actions, scopeKey: 'owner', ownerAlone, now: clock, model, provenanceRefs: true,
    ...(legacy ? {} : { continueAtOnce: true }),
    ...taskGates({ ownerScope: 'owner', guard: () => visible, sleepVisible: () => false }),
    stepPorts: (runtime, step) => {
      const history = { codec: anthropicFcaHistoryCodec, summarizer };
      const check = stepVisibility(() => visible, step);
      const body = createMinecraftTaskBody({ control, entry: null, selector: null, governor: createReflexGovernor(), runtime, step, ownerAlone, evidence: shared.evidence,
        fastJudgment: true, sourcesVisible: () => check.whole('body') ?? false, metricsLog: () => {}, log: () => {} });
      const sourcesVisible = () => check.whole('step') ?? step.snapshot.sources.length === 0;
      const taskVisible = (id: string) => id === step.taskId ? sourcesVisible() : visible('owner', id, undefined, 'child_monitor');
      const observeTasks = (ids: readonly string[]) => { if (!runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = runtime.taskSources('owner', step.taskId, step.messageIds); return sourcesVisible(); };
      const observations = [createFcaTaskObservationMonitor({ runtime, step, allowed: ownerAlone, sourcesVisible: variant === 'run14' ? sourcesVisible : check.peek, taskVisible, observeTasks })];
      const permitProgress = async () => {
        await actionPermit();
        const active = currentActionExecution();
        if (!active || active.lease.id !== step.lease.id || !ownerAlone() || !sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
        active.signal.throwIfAborted();
        if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
      };
      return { selector, observations, keepBodyTools: () => true, body: body.body, safeToAcknowledgeStop: body.safeToAcknowledgeStop,
        obsMode: legacy ? 'legacy' as const : 'transient' as const, ...(legacy ? {} : { bodyRecall: shared.bodyRecall }),
        recall: shared.recall, evidence: shared.evidence, observeMemory: (ids: readonly string[]) => shared.observeMemory(step, ids),
        sourcesVisible, taskVisible, observeTasks, history,
        tools: createFcaProgressTools(combineFcaTools(fcaMinecraftTools({ control, step, ownerAlone, sourcesVisible: () => check.whole('tool') ?? false }), body.tools),
          { checkpoint: step.snapshot.checkpoint, permit: permitProgress, observationSignal: (name, signal) => body.body.toolSignal(name, signal) }) };
    } });
  visible = createFcaSourceGuard({ runtime: driver.runtime, state: world.store, conversations: world.store, ownerScope: 'owner', ownerAlone,
    readSourceVisible: dense.readSourceVisible, log: walkLog, ...(options.walkLogMilliseconds !== undefined ? { walkLogMilliseconds: options.walkLogMilliseconds } : {}), ...(variant === 'run14' ? { baseMilliseconds: FCA_SOURCE_VERDICT_MS } : {}) });
  shared = createFcaSharedWiring({ db: actions.db, runtime: driver.runtime, state: world.store, affect: world.store, conversations: world.store,
    memory: world.ports.proposals, ownerScope: 'owner', ownerAlone, visible, readSourceVisible: dense.readSourceVisible, now: clock, provenanceRefs: true });
  const wake = () => { void shared.evidence?.drain({ segments: true }).catch(() => {}); void driver.tick().catch(() => {}); };
  const wakeTimer = setInterval(() => timedTick('fca_wake', wake, { log: line => warnings.push(line) }), 1000); wakeTimer.unref();

  // --- the body: a paired client that polls every `frameMs` and runs what it is handed
  const frameBase = JSON.stringify(worldState(options.frameCharacters ?? 20_000, random));
  const catalog = skillNames.map(name => ({ name, description: `身体のスキル${name}。${'指定した対象に近づき、条件を満たしたら操作する。'.repeat(8)}`, readOnly: false,
    inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 16, description: '回数' }, target: { type: 'string', description: `対象の名前${'（例: zombie, oak_log）'.repeat(5)}` } },
      required: ['count'], additionalProperties: false } }));
  let sequence = 0, polls = 0, firstPoll = true, skills = 0;
  const running = new Map<string, { until: number; text: string; fails?: boolean }>(), cancelled = new Set<string>();
  const pollMs: number[] = [];
  const poll = () => {
    const now = Date.now(), receipts: MinecraftControlReceipt[] = [];
    for (const [id, work] of running) {
      if (work.until <= now || cancelled.has(id)) {
        receipts.push({ id, connectionId: 'connection', outcome: cancelled.has(id) ? 'cancelled' : work.fails ? 'failed' : 'completed', inputsReleased: true,
          observedAt: new Date(now).toISOString(), result: work.text, ...(work.fails ? { failureType: 'target_occupied' } : {}) } as MinecraftControlReceipt);
        running.delete(id); cancelled.delete(id);
        if (receipts.length >= 8) break;
      }
    }
    const at = new Date(now).toISOString();
    // The wire: the body's JSON is parsed by the API (`readJson`) and the reply is serialized (`sendJson`).
    const text = JSON.stringify({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: at, receivedAt: at, connected: true,
        state: JSON.parse(frameBase), facts: { connected: true, alive: true, danger: false, stuck: false, visualRequired: false, imageAvailable: false, dimension: 'overworld' } },
      ...(firstPoll ? { skills: catalog } : {}), candidates: [], receipts, activeOperationIds: [...running.keys()] });
    firstPoll = false;
    const started = performance.now();
    try {
      const reply = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, JSON.parse(text));
      JSON.stringify(reply);
      for (const command of reply.commands) {
        const span = skillMin + random() * (skillMax - skillMin);
        const fails = command.kind === 'skill' && !!options.failureEvery && ++skills % options.failureEvery === 0;
        running.set(command.id, { until: Date.now() + (command.kind === 'skill' ? span : 50), fails,
          text: JSON.stringify({ ok: !fails, observation: 'x'.repeat(resultMin + Math.floor(random() * (resultMax - resultMin))) }) });
      }
      for (const id of reply.cancel) if (running.has(id)) cancelled.add(id);
    } catch (error) { warnings.push(`poll failed: ${error instanceof Error ? error.message : String(error)}`); }
    polls += 1; pollMs.push(performance.now() - started);
  };
  poll();
  const bodyTimer = setInterval(poll, frameMs);

  // --- the task
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '質問について調べる', goal: '質問について調べて、最新の様子をまとめる', completionCriteria: MINECRAFT_REQUEST_CRITERIA }, 'minecraft-request');
  bodyStore.bind(task.id, 'minecraft:world');
  if (options.seedProvenance) {
    const { rows, pool, perRow } = options.seedProvenance;
    dense.provenance(rows, pool, perRow).forEach((row, index) => {
      const id = `memory:seed-${index}:seed`;
      actions.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,read_ids_json,state,source_kind) VALUES(?,?,'',?,?,?,'bound','memory')")
        .run(id, 'owner', row.kind === 'memory' ? row.observedAt : '', JSON.stringify([...new Set(row.kind === 'memory' ? row.recalledMemoryIds : [])].sort()), JSON.stringify([...new Set(row.kind === 'memory' ? row.readSourceIds ?? [] : [])].sort()));
      actions.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(task.id, id);
    });
  }

  const originalWarn = console.warn, originalLog = console.log, originalInfo = console.info;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { const line = args.map(String).join(' '); if (line.includes('fca_decision_metrics')) options.metrics?.(line); };
  const watch: number[] = [];
  const stopWatch = startEventLoopWatch('bench', { log: line => { const m = /ms=(\d+)/u.exec(line); if (m) watch.push(Number(m[1])); } });
  const monitor = monitorLoop({ thresholdMs: 50 });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const deadline = started + (options.timeoutMilliseconds ?? 20 * 60_000);
  try {
    while (decisions <= options.steps && performance.now() < deadline) {
      await delay(250);
    }
    // Let the last step settle.
    await delay(Math.max(1_500, modelMs * 2));
  } finally {
    console.warn = originalWarn; console.log = originalLog; console.info = originalInfo;
  }
  const cpu = process.cpuUsage(cpuStart), cpuMs = (cpu.user + cpu.system) / 1000;
  const loop = monitor.stop();
  const blockedByDecision = decisionTimes.map((at, index) => loop.events.filter(event => event.at > at && event.at <= (decisionTimes[index + 1] ?? Infinity)).reduce((sum, event) => sum + event.late, 0));
  stopWatch();
  const wallMs = performance.now() - started;
  say(`decisions=${decisions} summaries=${summaries} polls=${polls} poll mean=${(pollMs.reduce((a, b) => a + b, 0) / Math.max(1, pollMs.length)).toFixed(2)}ms max=${Math.max(...pollMs).toFixed(1)}ms`);
  return { loop, decisions, summaries, wallMs, cpuMs, observerWrites: flushes, watch, walks, startedAt: started, decisionAt: decisionTimes, warnings: [...warnings, ...lines.filter(line => /Shannon/u.test(line))], requestCharacters, blockedByDecision,
    async close() {
      clearInterval(bodyTimer); clearInterval(wakeTimer);
      await driver.close(); await shared.recall.cancelAll();
      for (const row of bodyStore.pending('minecraft:world')) bodyStore.settle({ id: row.command.id, connectionId: row.command.connectionId, outcome: 'cancelled', inputsReleased: true, observedAt: clock() });
      observer?.close(); actions.close(); await dense.close();
    } };
}

/** A Minebot-shaped world state (`captureWorldObservation`) of about `characters`. */
function worldState(characters: number, random: () => number) {
  const entity = (index: number) => ({ name: index % 3 ? 'zombie' : 'enderman', kind: index % 3 ? 'hostile' : 'mob', distance: 20 + index,
    position: { x: 100.5 + index, y: 64, z: -20.25 - index }, closingSpeed: 0.4, secondsToContact: 9.5 });
  const world: Record<string, unknown> = {
    observedAt: '2026-10-17T06:34:00.000Z', dimension: 'overworld', position: { x: 100.5, y: 64, z: -20.25 }, health: 20, food: 18, oxygen: 20,
    isInWater: false, weather: 'clear', time: '13000', biome: 'plains', heldItem: 'diamond_sword',
    inventory: Array.from({ length: 30 }, (_, index) => ({ name: `item_${index}`, count: index + 1 })),
    nearbyEntities: Array.from({ length: 16 }, (_, index) => entity(index)), nearbyThreats: [], rememberedPlaces: { 拠点: '100,64,-20', 村: '400,70,300' },
    landmarks: [] as unknown[],
  };
  const state = { world, primitives: { inventory: [], targets: [], ray: null } };
  const landmarks = world.landmarks as unknown[];
  while (JSON.stringify(state).length < characters) landmarks.push({ name: `目印${landmarks.length}`, kind: 'structure', position: { x: landmarks.length * 17, y: 70, z: -landmarks.length * 13 }, note: `遠くに見えた建物の角${Math.floor(random() * 10)}` });
  return state;
}
export type { AnthropicMessage };
