import { configuredAutonomy, type AutonomyConfig } from '../src/autonomyBudget.js';
import { ShannonAutonomyLoop, type AutonomyLoopTick } from '../src/autonomyLoop.js';
import { configuredAutonomyLoop, type AutonomyLoopConfig } from '../src/autonomyLoopConfig.js';
import type { AutonomyNotionReader } from '../src/autonomyLoopSteps.js';
import type { AutonomyPublicReader, PublicReading } from '../src/autonomyReader.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import type { ShowablePiece, ShowingOutcome, StudyShowing } from '../src/autonomyShowing.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import type { AutonomyTextModel, AutonomyTextRequest, AutonomyTextResult } from '../src/autonomyTextModel.js';

/** Deterministic stand-ins for the activity loop: no network, no real model, a clock the test moves. */
export const scope = 'owner';

export type ModelCallKind = 'think' | 'note' | 'draft' | 'revise';

export function callKind(request: Pick<AutonomyTextRequest, 'system'>): ModelCallKind {
  if (request.system.includes('[ひとりの時間]')) return 'think';
  if (request.system.includes('[読んだものをメモにする]')) return 'note';
  if (request.system.includes('[短い物語を書く]')) return 'draft';
  return 'revise';
}

export const STORY_BODY = `駅のベンチに、だれかの傘が立てかけてあった。${'夕方の光が、改札の床を少しずつ動いていく。'.repeat(18)}`;

export class FakeModel implements AutonomyTextModel {
  readonly calls: AutonomyTextRequest[] = [];
  usable = true;
  /** Replies of the thinking step, in order; when it runs out she rests. */
  plans: unknown[] = [];
  replies: Partial<Record<Exclude<ModelCallKind, 'think'>, unknown>> = {};
  usage = { inputTokens: 1_000, outputTokens: 400 };
  /** Runs inside the call, before the reply: lets a test pause, crash, or move the clock mid-step. */
  during?: (kind: ModelCallKind, request: AutonomyTextRequest) => void | Promise<void>;

  canUse(): boolean { return this.usable; }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    this.calls.push(request);
    const kind = callKind(request);
    await this.during?.(kind, request);
    const reply = kind === 'think' ? this.plans.shift() ?? { thought: '今日はここまでにします。', pursuits: [], steps: [{ action: 'rest' }] }
      : this.replies[kind] ?? DEFAULT_REPLIES[kind];
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), usage: { ...this.usage } };
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

  mayMessageNow(): ShowingOutcome | 'ok' { return this.may; }
  tell(_scopeKey: string, piece: ShowablePiece): ShowingOutcome {
    if (this.told.some(item => item.id === piece.id && item.version === piece.version)) return 'already-told';
    if (this.may !== 'ok') return this.may;
    this.told.push(piece);
    return 'sent';
  }
  ownerActiveSince(): boolean { return this.ownerActive; }
}

export interface LoopHarnessOptions {
  enabled?: boolean;
  path?: string;
  environment?: Record<string, string>;
  loop?: Partial<AutonomyLoopConfig>;
  notion?: AutonomyNotionReader;
  clock?: { at: string };
  model?: FakeModel;
  reader?: FakeReader;
  showing?: FakeShowing;
}

export function loopHarness(options: LoopHarnessOptions = {}) {
  // 10:00 in Tokyo.
  const clock = options.clock ?? { at: '2026-10-02T01:00:00.000Z' };
  const store = new SQLiteAutonomyStore(options.path ?? ':memory:');
  const config: AutonomyConfig = configuredAutonomy({
    SHANNON_AUTONOMY_ENABLED: options.enabled === false ? 'false' : 'true', ...options.environment,
  });
  const loopConfig: AutonomyLoopConfig = { ...configuredAutonomyLoop({}), ...options.loop };
  const now = () => clock.at;
  const service = new ShannonAutonomyService({ store, config, now });
  const model = options.model ?? new FakeModel();
  const reader = options.reader ?? new FakeReader();
  const showing = options.showing ?? new FakeShowing();
  const newLoop = (workerId: string) => new ShannonAutonomyLoop({
    store, service, config, loop: loopConfig, model, reader, showing, now, workerId,
    ...(options.notion ? { notion: options.notion } : {}),
  });
  const loop = newLoop('runner-a');
  const entries = () => service.activityDays(scope, 30).flatMap(day => day.entries);
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { clock, store, config, loopConfig, service, model, reader, showing, loop, newLoop, entries, advance };
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
