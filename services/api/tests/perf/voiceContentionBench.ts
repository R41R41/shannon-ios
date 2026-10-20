/*
 * The voice / FCA contention bench (not a test): `node --import tsx tests/perf/voiceContentionBench.ts` from services/api.
 *
 * Does a Discord voice channel's turn (`PlatformVoiceService`, through the real conversation kernel) get slower while her Minecraft task
 * runs, and does the task get slower while people talk? Both run in this one process on one SQLite file, as the API does: the task is
 * `runLoopStall` (the real runtime, the dense production-shaped world, a body polling every 100 ms), the voice turns go through the
 * real kernel with the foreground runner over the same action store. Scripted: the chat model (its first token and its pace) and the
 * body. Three runs: voice alone, the task alone, both. What is printed is time spent in this process, not in a provider: the model's
 * own wait is subtracted (`preModel` is what the turn does before it calls the model; `emitLag` is from the delta that completed the
 * first clause to the line that carries it; `post` is what follows the model's last word).
 *
 * TURNS=30 GAP_MS=3000 STEPS=25 TTFT_MS=500 PACE_MS=30 SHARED=1 node --import tsx tests/perf/voiceContentionBench.ts
 */
import { setTimeout as delay } from 'node:timers/promises';
import { runLoopStall } from '../support/fcaLoopStallHarness.js';
import { fcaDenseWorld } from '../support/fcaDenseWorld.js';
import { monitorLoop, type LoopReport } from '../support/perfMeasure.js';
import { actionHarness } from '../support/actionThreadHarness.js';
import { createLocalApiKernel } from '../../src/wiring/apiKernelWiring.js';
import { foregroundRunner } from '../../src/wiring/actionExecutionWiring.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../../src/mind/memory/platformPeople.js';
import { SQLiteSurfaceTurnLog } from '../../src/mind/action/respond/store/surfaceTurnStore.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../../src/surfaces/platform/platformVoice.js';
import { ChatSentenceSplitter, splitChatSentences } from '../../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../../src/surfaces/text/chatSentenceStream.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../src/infra/models/chatModel.js';

const turns = Number(process.env.TURNS ?? 30);
const gapMs = Number(process.env.GAP_MS ?? 3_000);
const steps = Number(process.env.STEPS ?? 25);
const ttftMs = Number(process.env.TTFT_MS ?? 500);
const paceMs = Number(process.env.PACE_MS ?? 30);
const shared = process.env.SHARED !== '0';
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const ROOM = 'discord:222:300';
const TOKEN = 'd'.repeat(40);
const REPLY = 'うん、いまは鉄を探しながら洞窟を下りてるところだよ。体力はまだ大丈夫だから、このまま奥まで行ってみるね。';
const SAYINGS = ['シャノン、いまマイクラで何をしているの？', 'シャノン、体力はどれくらい残ってる？', 'シャノン、鉄は見つかりそう？', 'シャノン、そろそろ夜になりそうだけど大丈夫？'];

/** The model: a first token after `ttftMs`, then its words in pieces; it records when it was called and when each piece left it. */
class TimedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'bench-model';
  calls: Array<{ calledAt: number; deltas: Array<{ at: number; text: string }>; returnedAt: number }> = [];
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return this.generateStreaming(request, () => undefined);
  }
  async generateStreaming(_request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    const call = { calledAt: performance.now(), deltas: [] as Array<{ at: number; text: string }>, returnedAt: 0 };
    this.calls.push(call);
    await delay(ttftMs);
    for (let at = 0; at < REPLY.length; at += 4) {
      const text = REPLY.slice(at, at + 4);
      call.deltas.push({ at: performance.now(), text });
      await onReplyText(text);
      await delay(paceMs);
    }
    call.returnedAt = performance.now();
    return { mode: this.mode, model: this.model, reply: REPLY };
  }
}

interface TurnTimes {
  preModel: number; emitLag: number | null; post: number; decision: number; total: number;
}

const percentile = (values: number[], p: number): number => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const stats = (label: string, values: number[]): string =>
  `${label.padEnd(10)} p50=${percentile(values, 50).toFixed(1)}ms p95=${percentile(values, 95).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms`;

function voiceWorkload(world: { path: string; store: never }, actions: ReturnType<typeof actionHarness>) {
  const store = world.store as unknown as ConstructorParameters<typeof BackgroundUpdateCoordinator>[0] & ConstructorParameters<typeof BackgroundUpdateCoordinator>[1];
  const now = () => new Date().toISOString();
  const model = new TimedModel();
  const peopleStore = new SQLitePeopleMemoryStore(world.path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const mind = { foreground: foregroundRunner(actions.actions) };
  const api = createLocalApiKernel(now, {
    chatModel: model, stateStore: store as never, conversationStore: store as never, knowledgeStore: store as never, background,
    peopleMemory: peopleStore, mind: mind as never,
  });
  const environment = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
    SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: 'ライ氏の部屋', audience: 'owner-private' }]) };
  const bridge = new PlatformBridgeService(configuredPlatformBridge(environment)!, store as never, store as never, background, now,
    new PlatformPeople(peopleStore, store as never), () => true);
  const log = new SQLiteSurfaceTurnLog(world.path, 'platform_voice_turns');
  const service = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store as never, conversation: api, turns: log, now, chatModel: model,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), environment: () => ({ SHANNON_DC_VOICE: 'on' }), log: () => undefined,
  });
  const results: TurnTimes[] = [];
  let stopped = false;
  const one = async (index: number): Promise<void> => {
    const calls = model.calls.length;
    const lines: Array<{ at: number; line: VoiceTurnLine }> = [];
    const started = performance.now();
    await service.turn({
      platform: 'discord', requestId: `bench-${index}`, conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
      userMessage: SAYINGS[index % SAYINGS.length], observedAt: now(), participants: shared ? [OWNER, FRIEND] : [OWNER],
    }, line => lines.push({ at: performance.now(), line }));
    const call = model.calls[calls];
    const firstSentence = lines.find(item => item.line.type === 'sentence');
    const decision = lines.find(item => item.line.type === 'decision');
    const done = lines.find(item => item.line.type === 'done');
    if (!call || !firstSentence || !decision || !done) return;
    // The delta that completed the first clause.
    const splitter = new ChatSentenceSplitter(VOICE_SENTENCE_CUT);
    const completing = call.deltas.find(delta => splitter.append(delta.text).length > 0);
    results.push({
      preModel: call.calledAt - started, decision: decision.at - started, total: done.at - started,
      emitLag: completing ? firstSentence.at - completing.at : null, post: done.at - call.returnedAt,
    });
  };
  return {
    async run(): Promise<void> {
      for (let index = 0; index < turns && !stopped; index += 1) {
        const begun = performance.now();
        await one(index);
        await delay(Math.max(0, gapMs - (performance.now() - begun)));
      }
    },
    stop(): void { stopped = true; },
    results,
    async close(): Promise<void> {
      await background.waitForIdle('owner');
      log.close();
      peopleStore.close();
    },
  };
}

function printVoice(label: string, results: TurnTimes[], loop: LoopReport | null): void {
  console.log(`--- ${label}: ${results.length} voice turns (model TTFT ${ttftMs}ms, ${paceMs}ms per 4 characters, ${shared ? 'owner + friend in the channel' : 'owner alone'})`);
  if (results.length) {
    console.log('  ' + stats('preModel', results.map(item => item.preModel)));
    console.log('  ' + stats('decision', results.map(item => item.decision)));
    console.log('  ' + stats('emitLag', results.flatMap(item => (item.emitLag === null ? [] : [item.emitLag]))));
    console.log('  ' + stats('post', results.map(item => item.post)));
    console.log('  ' + stats('overhead', results.map(item => item.preModel + (item.emitLag ?? 0))));
  }
  if (loop) console.log(`  loop: p99=${loop.p99Ms.toFixed(1)}ms max=${loop.maxMs.toFixed(0)}ms blocked(>=50ms)=${loop.blockedMs.toFixed(0)}ms stalls=${loop.stalls}`);
}

async function voiceAlone(): Promise<TurnTimes[]> {
  const dense = fcaDenseWorld();
  const actions = actionHarness(() => new Date().toISOString(), dense.world.path, dense.world.store.fcaDatabase());
  const work = voiceWorkload(dense.world as never, actions);
  const monitor = monitorLoop({ thresholdMs: 50 });
  await work.run();
  const loop = monitor.stop();
  printVoice('voice alone', work.results, loop);
  await work.close();
  actions.close();
  await dense.close();
  return work.results;
}

async function both(withVoice: boolean): Promise<{ voice: TurnTimes[]; decisions: number; stepMs: number[]; loop: LoopReport; cpuMs: number; wallMs: number }> {
  let work: ReturnType<typeof voiceWorkload> | null = null;
  let running: Promise<void> | null = null;
  const metrics: number[] = [];
  const result = await runLoopStall({
    steps, legacyShape: false, observer: true, modelMilliseconds: 800,
    metrics: line => { const m = /"stepMs":(\d+)/u.exec(line); if (m) metrics.push(Number(m[1])); },
    onWorld: ({ world, actions }) => {
      if (!withVoice) return;
      work = voiceWorkload(world as never, actions);
    },
    onDecision: decision => {
      if (decision === 2 && work && !running) running = work.run();
    },
  });
  if (work) {
    (work as ReturnType<typeof voiceWorkload>).stop();
    await running;
  }
  const voice = work ? (work as ReturnType<typeof voiceWorkload>).results : [];
  printVoice(withVoice ? 'both' : 'task alone', voice, result.loop);
  console.log(`  task: decisions=${result.decisions} stepMs ${stats('', metrics).trim()} cpu=${(100 * result.cpuMs / result.wallMs).toFixed(1)}% wall=${(result.wallMs / 1000).toFixed(1)}s`);
  if (work) await (work as ReturnType<typeof voiceWorkload>).close();
  await result.close();
  return { voice, decisions: result.decisions, stepMs: metrics, loop: result.loop, cpuMs: result.cpuMs, wallMs: result.wallMs };
}

console.log(`turns=${turns} gap=${gapMs}ms task steps=${steps}`);
const alone = await voiceAlone();
const task = await both(false);
const mixed = await both(true);
const worse = (a: number[], b: number[], p: number) => (percentile(b, p) - percentile(a, p)).toFixed(1);
const overhead = (items: TurnTimes[]) => items.map(item => item.preModel + (item.emitLag ?? 0));
console.log('=== effect');
console.log(`voice overhead (preModel + emitLag), both minus alone: p50 ${worse(overhead(alone), overhead(mixed.voice), 50)}ms, p95 ${worse(overhead(alone), overhead(mixed.voice), 95)}ms`);
console.log(`task step, both minus alone: p50 ${worse(task.stepMs, mixed.stepMs, 50)}ms, p95 ${worse(task.stepMs, mixed.stepMs, 95)}ms; decisions ${task.decisions} -> ${mixed.decisions}`);
console.log(`loop blocked(>=50ms): alone ${task.loop.blockedMs.toFixed(0)}ms, both ${mixed.loop.blockedMs.toFixed(0)}ms`);
process.exit(0);
