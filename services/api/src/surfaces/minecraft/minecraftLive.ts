import { liveFactLine, type LiveMoment, type WorkingEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts } from './minecraftItems.js';
import { liveBlock, type LiveSnapshot } from './minecraftLiveBlock.js';
import { bodyInDanger, createMomentDetector, dayTick, dimensionOfWorld, type MomentDetector } from './minecraftMoments.js';
import { carriedWords, doingWords, mapWords, mobWords, timeWords } from './minecraftLiveWords.js';
import { MILESTONES, milestoneNow, milestoneTargetSeconds } from './minecraftStage.js';
import { withRecoverableDrops } from './minecraftSkillPointers.js';

/**
 * Her Minecraft body's present for every conversation, and the moments it shows (session dc-live; `SHANNON_MINECRAFT_LIVE`). The task's
 * body (`minecraftReflexAdapter.ts`) tells this what task it is on and which tool runs; the control (`minecraftControl.ts`) hands it each
 * frame and each batch of the body's events as they arrive. From those it keeps the block a conversation reads (`liveBlock`) and the moments
 * the commentary may speak of (`minecraftMoments.ts`). It owns no timer, calls no model, and nothing it does can wait for or fail a poll.
 */
export interface LiveTaskInfo {
  taskId: string;
  scopeKey: string;
  /** The task's own words (the owner's request, or her own goal). */
  goal: string;
  /** `owner_request` or `own_time` and the like: whether the goal is the owner's matter. */
  origin: string;
  createdAtMs: number;
  bodyId: string | null;
  netherReached: boolean | null;
}

/** What the task's body tells this: begin (again, for an update), the running tool, the end. */
export interface MinecraftLiveSink {
  begin(info: LiveTaskInfo): void;
  activity(taskId: string, call: { name: string; input: unknown } | null): void;
  end(taskId: string): void;
}

export interface LiveFrames {
  /** The body's newest frame at most `maxAgeMs` old (a connected one), or null. */
  latest(bodyId: string, maxAgeMs: number): { observation: BodyObservation; ageMs: number } | null;
  /** Bodies that have a current frame. */
  available(): string[];
}

export const LIVE_FRAME_MAXIMUM_SECONDS = 120;
const MOMENTS_KEPT = 40, DETECT_EVERY_MS = 400, SHOWN_MOMENT_MINUTES = 10, STUCK_SHOWN_SECONDS = 25;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const SKILL_WORDS: Readonly<Record<string, string>> = {
  'mine-block': '掘る作業', 'move-to': '移動', 'stair-mine': '階段掘り', 'explore-for-structure': '探索', 'attack-continuously': '戦い',
};

/** A task's step ended: the next step of the same task begins within this long, so the view keeps it meanwhile. */
const STEP_GAP_MS = 20_000;
interface TaskState {
  info: LiveTaskInfo; call: { name: string; input: unknown } | null; updatedAt: number; endedAt: number | null; milestone: number | null; late: Set<string>;
}

export class MinecraftLive implements MinecraftLiveSink {
  private readonly tasks = new Map<string, TaskState>();
  private readonly detectors = new Map<string, MomentDetector>();
  private readonly seenAt = new Map<string, number>();
  private readonly moments: LiveMoment[] = [];
  private readonly listeners = new Set<(moment: LiveMoment) => void>();
  private danger = false;
  /** Replies being written now, and when someone last wrote or spoke to her (the conversations tell: 
eplying, heard). */
  private replies = 0;
  private heardAt: number | null = null;
  private stall: { what: string; seconds: number; at: number } | null = null;

  constructor(private readonly parts: {
    frames: LiveFrames; now?: () => number; log?: (line: string) => void;
    /** Exchanges about her work (SHANNON_NATURAL_TALK), for the owner alone: given the minute, a few lines in the shape of the persona's. */
    exchanges?: (minute: number) => string;
  }) {}

  private now(): number { return (this.parts.now ?? Date.now)(); }

  begin(info: LiveTaskInfo): void {
    const before = this.tasks.get(info.taskId);
    const now = this.now();
    for (const [id, task] of this.tasks) if (task.endedAt !== null && now - task.endedAt > 600_000) this.tasks.delete(id);
    this.tasks.set(info.taskId, { info, call: before?.call ?? null, updatedAt: now, endedAt: null, milestone: before?.milestone ?? null,
      late: before?.late ?? new Set() });
  }
  activity(taskId: string, call: { name: string; input: unknown } | null): void {
    const task = this.tasks.get(taskId);
    if (task) task.call = call;
  }
  end(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.endedAt = this.now();
      task.call = null;
    }
  }

  /** A moment was seen: the commentary hears it. Listeners never throw into the poll. */
  onMoment(listener: (moment: LiveMoment) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A reply is being written (true) or done (false), for the commentary not to talk over it. */
  replying(on: boolean): void { this.replies = Math.max(0, this.replies + (on ? 1 : -1)); }
  /** Someone wrote or spoke to her just now. */
  heard(): void { this.heardAt = this.now(); }
  /** What only the API sees of the room: a reply being written, and the time since someone last wrote or spoke to her. */
  conversation(): { replying: boolean; sinceHumanMilliseconds: number | null } {
    return { replying: this.replies > 0, sinceHumanMilliseconds: this.heardAt === null ? null : Math.max(0, this.now() - this.heardAt) };
  }

  /** She is in danger now (the newest frame): a moment that comes then weighs more. */
  inDanger(): boolean { return this.danger; }

  /** The newest moments, oldest first. */
  recentMoments(): readonly LiveMoment[] { return this.moments; }

  private activeTask(): TaskState | null {
    const now = this.now();
    return [...this.tasks.values()].filter(task => task.endedAt === null || now - task.endedAt <= STEP_GAP_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }

  private emit(moment: LiveMoment): void {
    this.moments.push(moment);
    if (this.moments.length > MOMENTS_KEPT) this.moments.shift();
    for (const listener of this.listeners) {
      try { listener(moment); } catch { /* the commentary never fails a poll */ }
    }
  }

  /** One frame of a body (the control calls this on each poll). Cheap; at most one reading in `DETECT_EVERY_MS` per body. */
  frame(bodyId: string, observation: BodyObservation, arrival: { newConnection: boolean }): void {
    try {
      const now = this.now(), detector = this.detectors.get(bodyId) ?? createMomentDetector();
      this.detectors.set(bodyId, detector);
      if (arrival.newConnection) detector.reset();
      this.danger = bodyInDanger(observation);
      if (now - (this.seenAt.get(bodyId) ?? -Infinity) < DETECT_EVERY_MS) return;
      this.seenAt.set(bodyId, now);
      for (const moment of detector.observe(observation, now)) this.emit(moment);
      for (const moment of this.progress(bodyId, observation, now)) this.emit(moment);
    } catch (error) {
      this.parts.log?.(`Shannon Minecraft live frame failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
    }
  }

  /** The step the owner's order is at has moved on (or is late), for the task of this body. */
  private progress(bodyId: string, observation: BodyObservation, now: number): LiveMoment[] {
    const task = [...this.tasks.values()].find(item => item.info.bodyId === bodyId) ?? (this.tasks.size === 1 ? this.activeTask() : null);
    if (!task) return [];
    const { name, index } = this.stepOf(task, observation), seconds = Math.round((now - task.info.createdAtMs) / 1000), out: LiveMoment[] = [];
    const before = task.milestone !== null ? MILESTONES[task.milestone]?.name : undefined;
    if (before && task.milestone !== null && index > task.milestone) {
      out.push({ kind: 'milestone_passed', key: `milestone:${task.info.taskId}:${before}`, at: now, facts: { name: before, seconds } });
    }
    task.milestone = index;
    const target = milestoneTargetSeconds(name);
    if (target !== undefined && seconds > target + 120 && !task.late.has(name)) {
      task.late.add(name);
      out.push({ kind: 'milestone_late', key: `late:${task.info.taskId}:${name}`, at: now, facts: { name, target, over: seconds - target } });
    }
    return out;
  }

  private stepOf(task: TaskState, observation: BodyObservation): { name: string; next: string | null; index: number } {
    const world = record(observation.state.world) ?? {};
    const counts = withRecoverableDrops(carriedItemCounts(world, observation.facts), world);
    const dimension = dimensionOfWorld(world, observation.facts) ?? 'overworld';
    const { now, next } = milestoneNow({ counts, dimension, netherReached: task.info.netherReached === true,
      bedPlaced: typeof record(world.rememberedPlaces)?.respawn === 'string' });
    return { name: now.name, next: next?.name ?? null, index: MILESTONES.findIndex(item => item.name === now.name) };
  }

  /** The body's events as the control took them: a stalled command is a moment of its own (`stuck`), and the block says it for a while. */
  events(bodyId: string, events: readonly WorkingEvent[]): void {
    try {
      const now = this.now();
      for (const event of events) {
        if (event.kind !== 'action.stalled') continue;
        const skill = String(event.data.skill ?? ''), seconds = Math.round((finite(event.data.sinceProgressMs) ?? 0) / 1000), what = SKILL_WORDS[skill] ?? '作業';
        this.stall = { what, seconds, at: now };
        this.emit({ kind: 'stuck', key: `stuck:${bodyId}:${event.subject}`, at: now, facts: { what, seconds } });
      }
    } catch { /* the commentary never fails a poll */ }
  }

  /** Her body's present for a conversation, or null when she has neither a task nor a body in the world. */
  snapshot(): LiveSnapshot | null {
    const task = this.activeTask(), now = this.now();
    const bodyId = task?.info.bodyId ?? this.parts.frames.available()[0] ?? null;
    const found = bodyId ? this.parts.frames.latest(bodyId, LIVE_FRAME_MAXIMUM_SECONDS * 1000) : null;
    if (!found && !task) return null;
    const base = { goal: task?.info.goal ?? null, goalIsRequest: task ? task.info.origin !== 'own_time' : false,
      elapsedSeconds: task ? Math.max(0, Math.round((now - task.info.createdAtMs) / 1000)) : null, doing: doingWords(task?.call ?? null) };
    if (!found) return this.disconnected(base);
    return this.read(found.observation, found.ageMs, base, task);
  }

  private disconnected(base: Pick<LiveSnapshot, 'goal' | 'goalIsRequest' | 'elapsedSeconds' | 'doing'>): LiveSnapshot {
    return { ...base, frameAgeSeconds: null, milestone: null, dimension: null, biome: null, time: '', health: null, food: null, threats: [],
      carried: [], map: '',
      furnace: null, recent: [], stuck: null };
  }

  private read(observation: BodyObservation, ageMs: number, base: Pick<LiveSnapshot, 'goal' | 'goalIsRequest' | 'elapsedSeconds' | 'doing'>,
    task: TaskState | null): LiveSnapshot {
    const world = record(observation.state.world) ?? {}, now = this.now();
    const counts = withRecoverableDrops(carriedItemCounts(world, observation.facts), world);
    const step = task ? this.stepOf(task, observation) : null;
    const health = finite(world.health), food = finite(world.food);
    const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(item => {
      const threat = record(item), distance = finite(threat?.distance);
      return threat && distance !== null && distance <= 24 && typeof threat.name === 'string'
        ? [{ text: `${mobWords(threat.name)}${Math.round(distance)}m${threat.canReachMe === false ? '（壁の向こう）' : ''}`, distance }] : [];
    }).sort((a, b) => a.distance - b.distance).slice(0, 3).map(item => item.text);
    const recent = this.moments.filter(moment => now - moment.at <= SHOWN_MOMENT_MINUTES * 60_000 && moment.kind !== 'stuck').slice(-3).reverse()
      .map(moment => ({ ageSeconds: Math.round((now - moment.at) / 1000), line: liveFactLine(moment).replace(/。$/u, '') }));
    const stall = this.stall && now - this.stall.at <= STUCK_SHOWN_SECONDS * 1000 ? `${this.stall.what}が${this.stall.seconds}秒ほど進んでいない` : null;
    return { ...base, frameAgeSeconds: Math.round(ageMs / 1000), milestone: step ? { name: step.name, next: step.next, elapsed: base.elapsedSeconds } : null,
      dimension: dimensionOfWorld(world, observation.facts), biome: typeof world.biome === 'string' ? world.biome.slice(0, 40).replace(/_/gu, ' ') : null,
      time: timeWords(dimensionOfWorld(world, observation.facts) === 'overworld' ? dayTick(world) : null),
      health: health === null ? null : Math.round(health), food, threats, carried: carriedWords(counts), map: mapWords(world.mapSummary),
      furnace: furnaceWords(world.jobs), recent, stuck: stall };
  }

  /** The block a conversation reads; '' while she has neither a task nor a body in the world. `alone`: the owner alone reads it. */
  block(options: { alone: boolean }): string {
    try { return liveBlock(this.snapshot(), { ...options, exchanges: this.parts.exchanges?.(Math.floor(this.now() / 60_000)) ?? '' }); } catch { return ''; }
  }
}

/** The furnaces working (`world.jobs`): how many, and when the first is done, or that a finished one waits. */
function furnaceWords(jobs: unknown): string | null {
  const rows = (Array.isArray(jobs) ? jobs : []).flatMap(item => {
    const row = record(item);
    return row ? [row] : [];
  });
  if (!rows.length) return null;
  if (rows.some(row => row.status === 'verification_due')) return '焼き上がった物が入っている（取り出せる）';
  const left = rows.flatMap(row => finite(row.remainingEstimateMs) ?? []).sort((a, b) => a - b)[0];
  return left === undefined ? `${rows.length}台が動いている` : `${rows.length}台が動いている（早いものであと約${Math.max(1, Math.round(left / 1000))}秒）`;
}
