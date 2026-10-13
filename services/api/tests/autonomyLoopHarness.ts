import type { AetherAccess } from '../src/integrations/aether/aetherAccess.js';
import { autonomyDayKey, configuredAutonomy, type AutonomyConfig } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyLoop, type AutonomyLoopTick } from '../src/mind/action/ownTime/autonomyLoop.js';
import { configuredAutonomyLoop, type AutonomyLoopConfig } from '../src/mind/action/ownTime/autonomyLoopConfig.js';
import type { AutonomyRoomLooks } from '../src/mind/action/ownTime/autonomyLoopLookStep.js';
import type { AutonomyReachOutObserver } from '../src/mind/action/ownTime/autonomyLoopObserve.js';
import type { AutonomyOwnerContext } from '../src/mind/action/ownTime/autonomyLoopOwnerContext.js';
import { callGateContext, type AutonomyPhone } from '../src/mind/action/ownTime/autonomyLoopPhoneStep.js';
import type { AutonomyReachOuts, AutonomyUpcoming } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import type { AutonomyNotionReader, StepDependencies } from '../src/mind/action/ownTime/autonomyLoopSteps.js';
import type { AutonomyToolResults } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import type { AutonomyPredictionTap } from '../src/mind/action/ownTime/store/autonomyLoopObservations.js';
import type { DecisionTraceWriter } from '../src/contracts/decisionTraceContract.js';
import type { AutonomyPublicReader, PublicReading } from '../src/mind/action/ownTime/autonomyReader.js';
import { ShannonAutonomyService, type AutonomyServiceDependencies } from '../src/mind/action/ownTime/autonomyService.js';
import type { ShowablePiece, ShowingOutcome, StudyShowing } from '../src/mind/action/ownTime/autonomyShowing.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import type { AutonomyTextModel, AutonomyTextRequest, AutonomyTextResult } from '../src/mind/action/ownTime/autonomyTextModel.js';

/** Deterministic stand-ins for the activity loop: no network, no real model, a clock the test moves. */
export const scope = 'owner';

export type ModelCallKind = 'think' | 'note' | 'draft' | 'revise' | 'reach_out' | 'follow_up';

export function callKind(request: Pick<AutonomyTextRequest, 'system'>): ModelCallKind {
  if (request.system.includes('[ひとりの時間]')) return 'think';
  if (request.system.includes('[読んだものをメモにする]')) return 'note';
  if (request.system.includes('[短い物語を書く]')) return 'draft';
  if (request.system.includes('[自分から話しかける]')) return 'reach_out';
  if (request.system.includes('[返事がないので、もう一度だけ声をかける]')) return 'follow_up';
  return 'revise';
}

export const STORY_BODY = `駅のベンチに、だれかの傘が立てかけてあった。${'夕方の光が、改札の床を少しずつ動いていく。'.repeat(18)}`;

export class FakeModel implements AutonomyTextModel {
  readonly calls: AutonomyTextRequest[] = [];
  usable = true;
  /** Replies of the thinking step, in order; when it runs out she rests. */
  plans: unknown[] = [];
  replies: Partial<Record<Exclude<ModelCallKind, 'think'>, unknown>> = {};
  usage: AutonomyTextResult['usage'] = { inputTokens: 1_000, outputTokens: 400 };
  /** Calls, by their place in `calls`, whose reply the provider cut off at the output ceiling. */
  truncatedCalls = new Set<number>();
  /** Runs inside the call, before the reply: lets a test pause, crash, or move the clock mid-step. */
  during?: (kind: ModelCallKind, request: AutonomyTextRequest) => void | Promise<void>;

  canUse(): boolean { return this.usable; }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    this.calls.push(request);
    const kind = callKind(request);
    await this.during?.(kind, request);
    const reply = kind === 'think' ? this.plans.shift() ?? { thought: '今日はここまでにします。', pursuits: [], steps: [{ action: 'rest' }] }
      : this.replies[kind] ?? DEFAULT_REPLIES[kind];
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), usage: { ...(request.model.startsWith('claude-haiku-') ? { cacheCreationInputTokens: 0, cachedInputTokens: 0 } : {}), ...this.usage }, ...(this.truncatedCalls.has(this.calls.length - 1) ? { truncated: true as const } : {}) };
  }

  kinds(): ModelCallKind[] { return this.calls.map(callKind); }
  prompts(kind?: ModelCallKind): string[] {
    return this.calls.filter(call => !kind || callKind(call) === kind).map(call => `${call.system}\n${call.prompt}`);
  }
}

const DEFAULT_REPLIES: Record<Exclude<ModelCallKind, 'think'>, unknown> = {
  note: { title: '夕方の駅が懐かしい理由', body: '光の色と人の少なさが、懐かしさを作っているのだと思いました。物語では音を先に書くと効きそうです。', question: '', questionWhy: '' },
  draft: { title: '傘のある駅', body: STORY_BODY, note: '誰もいない場所に、誰かがいた気配だけを書こうとしました。' },
  revise: { title: '傘のある駅', body: `${STORY_BODY}最後に、傘はもうなかった。`, change: '終わりに傘がなくなる一文を足しました。余韻を残したかったからです。' },
  reach_out: { message: 'ライ氏、いま何をしていますか。ボクは少し気になりました。' },
  follow_up: { message: 'あれ、ライ氏、いませんか。' },
};

export class FakeReader implements AutonomyPublicReader {
  readonly reads: string[] = [];
  pages = new Map<string, PublicReading>();
  failure: string | null = null;

  async read(url: string): Promise<PublicReading> {
    this.reads.push(url);
    if (this.failure) throw new Error(this.failure);
    return this.pages.get(url) ?? {
      url, title: '夕方の駅についての随筆', links: [{ title: '光と記憶について', url: 'https://example.org/light' }],
      text: '夕方の駅では、光が低く差しこみ、人の影が長くなる。帰る人と待つ人が同じ場所にいることが、懐かしさの理由だと筆者は書いている。',
    };
  }
}

export class FakeShowing implements StudyShowing {
  readonly told: ShowablePiece[] = [];
  may: ShowingOutcome | 'ok' = 'ok';
  ownerActive = false;
  /** When the owner wrote or spoke, for a loop that watches for an answer; null while he has not. */
  repliedAt: string | null = null;

  mayMessageNow(): ShowingOutcome | 'ok' { return this.may; }
  tell(_scopeKey: string, piece: ShowablePiece): ShowingOutcome {
    if (this.told.some(item => item.id === piece.id && item.version === piece.version)) return 'already-told';
    if (this.may !== 'ok') return this.may;
    this.told.push(piece);
    return 'sent';
  }
  ownerActiveSince(_scopeKey: string, since: string): boolean { return this.ownerActive || (this.repliedAt !== null && this.repliedAt >= since); }
  ownerFirstActiveAfter(_scopeKey: string, after: string): string | null { return this.repliedAt !== null && this.repliedAt > after ? this.repliedAt : null; }
}

export interface LoopHarnessOptions {
  /** Her study in Aether (a fake Aether in tests); absent, the SQLite study as before. */
  aether?: AetherAccess;
  enabled?: boolean;
  actionSteps?: StepDependencies['actionSteps'];
  concurrentActions?: boolean;
  path?: string;
  environment?: Record<string, string>;
  loop?: Partial<AutonomyLoopConfig>;
  notion?: AutonomyNotionReader;
  clock?: { at: string };
  model?: FakeModel;
  reader?: FakeReader;
  showing?: FakeShowing;
  /** Looking at the room in her own time: the desk the loop asks, and the counts its service hands the gate. */
  looks?: AutonomyRoomLooks;
  roomLooks?: AutonomyServiceDependencies['roomLooks'];
  /** Speaking up on her own: the way her message leaves, and the owner's upcoming items. */
  reachOuts?: AutonomyReachOuts;
  upcoming?: AutonomyUpcoming;
  /** Phoning the owner's iPhone: absent, as on a server where he has not switched calls on, no prompt speaks of it. */
  phone?: AutonomyPhone;
  /**
   * Act → observe → think again. Off unless asked for, so every test written before it runs the loop with
   * `SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0`, the kill switch that restores the loop as it was.
   */
  agentic?: boolean;
  observer?: AutonomyReachOutObserver;
  /** Runs at every pause of a step that waits, after the clock moved. */
  onWait?: (at: string) => void | Promise<void>;
  /**
   * She paces her own day in sessions. Off unless asked for, so every test written before sessions runs the loop with
   * `SHANNON_AUTONOMY_PACING=cycles`, the kill switch that restores the fixed cycles.
   */
  sessions?: boolean;
  /** The owner's context for her thinking and her messages; absent, as with `SHANNON_AUTONOMY_OWNER_CONTEXT=off`, no prompt carries it. */
  ownerContext?: AutonomyOwnerContext;
  selfInterests?: StepDependencies['selfInterests'];
  /** Receives the content-free lines the loop writes to the service log. */
  log?: (line: string) => void;
  /** Environment of the loop's own configuration (`configuredAutonomyLoop`). */
  loopEnvironment?: Record<string, string>;
  /** Her registry tools in her own time; absent, as with `SHANNON_OWN_TOOLS=off`, none is offered. */
  toolResults?: AutonomyToolResults;
  /** Syzygy ADR-0008 stage 3: the one function she is handed of the mind; absent, nothing is written. */
  emitMindEvent?: StepDependencies['emitMindEvent'];
  /** Moments she perceived and wanted to speak of (owner decision 2026-10-14); absent, none. */
  moments?: StepDependencies['moments'];
  /** Syzygy ADR-0006/0008: the write-only taps of the prediction record; absent, as with their switches off. */
  prediction?: AutonomyPredictionTap;
  /** Syzygy ADR-0008 stage 1: the decision trace writer; absent, as with `SHANNON_DECISION_TRACES=off`. */
  trace?: DecisionTraceWriter;
  /** Syzygy ADR-0008 stage 1: told the owner's reaction to a story; absent, as with `SHANNON_PREDICTION_LEDGER=off`. */
  storyReacted?: AutonomyServiceDependencies['storyReacted'];
  /** Syzygy ADR-0008 stage 1, step 7a: the value facts of a thought; absent, as with `SHANNON_VALUE_FACTS=off`. */
  valueFacts?: (scopeKey: string, offered: readonly string[], at: string) => string | null;
  /** Syzygy ADR-0008 §14: told each step the gate did not allow, and the 「止められたこと」 of a thought; absent, as with stage 2 off. */
  withheld?: AutonomyServiceDependencies['withheld'];
  withheldFacts?: (scopeKey: string, at: string) => string | null;
  /** Syzygy ADR-0009 stage 2 (E5): the Executive; absent, as with `SHANNON_EXECUTIVE=off`, the loop thinks as before. */
  executive?: StepDependencies['executive'];
}

export function loopHarness(options: LoopHarnessOptions = {}) {
  // 10:00 in Tokyo.
  const clock = options.clock ?? { at: '2026-10-02T01:00:00.000Z' };
  const store = new SQLiteAutonomyStore(options.path ?? ':memory:');
  const config: AutonomyConfig = configuredAutonomy({
    SHANNON_AUTONOMY_ENABLED: options.enabled === false ? 'false' : 'true', ...(options.agentic ? {} : { SHANNON_AUTONOMY_MAX_FOLLOW_UPS: '0' }),
    ...options.environment,
  });
  const loopConfig: AutonomyLoopConfig = {
    ...configuredAutonomyLoop({ SHANNON_AUTONOMY_PACING: options.sessions ? 'sessions' : 'cycles', ...options.loopEnvironment }), ...options.loop,
  };
  const now = () => clock.at;
  const reachOuts = options.reachOuts;
  const service = new ShannonAutonomyService({
    store, config, now, ...(options.roomLooks ? { roomLooks: options.roomLooks } : {}), ...(options.storyReacted ? { storyReacted: options.storyReacted } : {}),
    ...(reachOuts ? { reachOuts: (scopeKey: string, at: string) => ({ today: reachOuts.sentOn(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutsPerDay }) } : {}),
    ...(options.phone ? { calls: (scopeKey: string, at: string) => callGateContext(options.phone!, scopeKey, at) } : {}),
    ...(options.aether ? { aether: { access: options.aether, ownerDocuments: loopConfig.ownerDocuments } } : {}), ...(options.withheld ? { withheld: options.withheld } : {}),
    ...(reachOuts?.followUpsOn ? { reachOutFollowUps: (scopeKey: string, at: string) => ({ today: reachOuts.followUpsOn!(scopeKey, autonomyDayKey(at, config)), maximumPerDay: config.maximumReachOutFollowUpsPerDay }) } : {}),
  });
  /** A waiting step does not sleep: the pause moves the test's clock. */
  const waits: number[] = [];
  const wait = async (milliseconds: number) => {
    waits.push(milliseconds);
    clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString();
    await options.onWait?.(clock.at);
  };
  const model = options.model ?? new FakeModel();
  const reader = options.reader ?? new FakeReader();
  const showing = options.showing ?? new FakeShowing();
  const newLoop = (workerId: string) => new ShannonAutonomyLoop({
    store, service, config, loop: loopConfig, model, reader, showing, now, workerId, wait,
    actionSteps:options.actionSteps, concurrentActions:options.concurrentActions,
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.notion ? { notion: options.notion } : {}), ...(options.looks ? { looks: options.looks } : {}),
    ...(reachOuts ? { reachOuts } : {}), ...(options.upcoming ? { upcoming: options.upcoming } : {}), ...(options.phone ? { phone: options.phone } : {}),
    ...(options.ownerContext ? { ownerContext: options.ownerContext } : {}), ...(options.log ? { log: options.log } : {}),
    ...(options.selfInterests ? { selfInterests: options.selfInterests } : {}),
    ...(options.toolResults ? { toolResults: options.toolResults } : {}),
    ...(options.prediction ? { prediction: options.prediction } : {}), ...(options.trace ? { trace: options.trace } : {}),
    ...(options.valueFacts ? { valueFacts: options.valueFacts } : {}), ...(options.withheldFacts ? { withheldFacts: options.withheldFacts } : {}),
    ...(options.emitMindEvent ? { emitMindEvent: options.emitMindEvent } : {}), ...(options.executive ? { executive: options.executive } : {}),
    ...(options.moments ? { moments: options.moments } : {}),
  });
  const loop = newLoop('runner-a');
  const entries = () => service.activityDays(scope, 30).flatMap(day => day.entries);
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { clock, store, config, loopConfig, service, model, reader, showing, loop, newLoop, entries, advance, waits };
}

/** Ticks until the loop has nothing more to do right now; returns every tick. */
export async function runUntilIdle(loop: ShannonAutonomyLoop, maximum = 30): Promise<AutonomyLoopTick[]> {
  const ticks: AutonomyLoopTick[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const tick = await loop.tick();
    ticks.push(tick);
    if (tick !== 'stepped' && tick !== 'cycle-ended') break;
    if (tick === 'cycle-ended') break;
  }
  return ticks;
}

export const FULL_PLAN = {
  thought: '夕方の駅のことを読んで、短い物語にしてみます。',
  pursuits: [{ op: 'add', kind: 'question', title: 'なぜ夕方の駅は懐かしいのか', why: '人がいないのに寂しくない場所が、ずっと気になっているからです。' }],
  steps: [
    { action: 'read', url: 'https://example.org/station' },
    { action: 'note' },
    { action: 'draft', idea: '誰もいない駅に残された傘の話' },
  ],
};
