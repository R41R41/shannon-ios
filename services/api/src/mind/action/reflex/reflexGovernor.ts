/**
 * How often a task's body may enter a reflex on its own (Minecraft run 10, 2026-10-14, task 74a32315): 44 automatic sessions in
 * 37 minutes, one body action among all of them (the others observed and returned, or ran out of decisions), and from 21:53 a
 * session ran nearly all the time. Each session that starts while a decision is being made leaves that decision stale (`guard`), so
 * the FCA's next 20 decisions were discarded and it made five steps in three minutes. Kept per task across its steps: each step makes
 * a new body monitor. Only entries the body's observation starts are governed; an explicit `minecraft.reflex` call is the FCA's own.
 *
 * - A session that ended without a completed body action is followed by a cooldown of its mode (short for danger).
 * - Automatic sessions may hold the body at most `budgetMs` in any `windowMs`.
 * - A stuck body enters once per place until the FCA has decided again (or `stuckLatchMs` has passed).
 * - Danger that is getting worse (health or oxygen lower than at the last danger entry, or health at most `criticalHealth`) is
 *   never held by the cooldown or the budget.
 */
export const REFLEX_GOVERNOR_LIMITS = Object.freeze({
  idleCooldownMs: 30_000,
  dangerCooldownMs: 5_000,
  windowMs: 60_000,
  budgetMs: 20_000,
  stuckLatchMs: 120_000,
  criticalHealth: 4,
});
export type ReflexGovernorLimits = typeof REFLEX_GOVERNOR_LIMITS;
export type GovernedReflexMode = 'danger' | 'stuck' | 'visual';
export interface ReflexDangerEvidence { kind: 'health' | 'oxygen' | 'threat'; value: number }
export interface ReflexEntryFacts { mode: GovernedReflexMode; danger?: ReflexDangerEvidence | null; place?: string | null }
export type ReflexAdmission = { admit: true; escalated: boolean } | { admit: false; reason: 'reflex_cooldown' | 'reflex_budget' | 'stuck_latched' };
export interface ReflexGovernor {
  admit(taskId: string, at: number, entry: ReflexEntryFacts): ReflexAdmission;
  began(taskId: string, at: number, entry: ReflexEntryFacts): void;
  /** `cooldown` false: an ineffective end that touched nothing (an answer dropped before it cut anything off) arms no cooldown. */
  ended(taskId: string, at: number, entry: ReflexEntryFacts, effective: boolean, cooldown?: boolean): void;
  /** The FCA decided again for this task (a tool call): a stuck body may be helped once more. */
  decided(taskId: string, at: number): void;
  /** The fast judgment's memory of the task across its steps (`createFastJudgmentMemory`); absent on a governor made without it. */
  fast?: FastJudgmentMemory;
}

/**
 * What the image-free fast judgment remembers of a task across its steps (Minecraft run 16, 2026-10-19): each decision is a new step
 * with a new judgment, so a skill that failed and the interrupts spent for nothing are kept here, beside the governor's cooldowns.
 * Both belong to one life: a new arrival of the body (a respawn) clears them.
 */
export interface FastJudgmentMemory {
  /** The body's arrival as the step sees it: a different one than before clears the task's rests and spent interrupts. */
  arrival(taskId: string, arrived: number | null): void;
  /** The skills resting at `at`. */
  resting(taskId: string, at: number): Set<string>;
  rest(taskId: string, skill: string, until: number): void;
  /** One of her tools cut off for nothing at `at`. */
  spend(taskId: string, at: number): void;
  /** Those within `windowMs` before `at`. */
  spent(taskId: string, at: number, windowMs: number): number;
}
interface FastTaskMemory { arrived: number | null | undefined; rests: Map<string, number>; spent: number[] }

export function createFastJudgmentMemory(): FastJudgmentMemory {
  const tasks = new Map<string, FastTaskMemory>();
  const of = (taskId: string) => {
    const memory = tasks.get(taskId) ?? { arrived: undefined, rests: new Map<string, number>(), spent: [] };
    tasks.delete(taskId);
    tasks.set(taskId, memory);
    if (tasks.size > REMEMBERED_TASKS) tasks.delete(tasks.keys().next().value!);
    return memory;
  };
  return {
    arrival(taskId, arrived) {
      const memory = of(taskId);
      if (memory.arrived !== undefined && memory.arrived !== arrived) {
        memory.rests.clear();
        memory.spent = [];
      }
      memory.arrived = arrived;
    },
    resting: (taskId, at) => new Set([...of(taskId).rests].filter(([, until]) => until > at).map(([skill]) => skill)),
    rest(taskId, skill, until) { of(taskId).rests.set(skill, until); },
    spend(taskId, at) {
      const memory = of(taskId);
      memory.spent = [...memory.spent, at].slice(-16);
    },
    spent: (taskId, at, windowMs) => of(taskId).spent.filter(time => at - time <= windowMs).length,
  };
}

interface TaskReflexState {
  sessions: Array<{ start: number; end: number | null }>;
  cooldownUntil: Partial<Record<GovernedReflexMode, number>>;
  stuck: { place: string | null; at: number } | null;
  lastDanger: ReflexDangerEvidence | null;
}
/** Tasks remembered; the oldest is forgotten first (a task's state is only throttling, never authority). */
const REMEMBERED_TASKS = 64;

export function createReflexGovernor(overrides: Partial<ReflexGovernorLimits> = {}): ReflexGovernor {
  const limits = { ...REFLEX_GOVERNOR_LIMITS, ...overrides };
  const tasks = new Map<string, TaskReflexState>();
  const stateOf = (taskId: string) => {
    const state = tasks.get(taskId) ?? { sessions: [], cooldownUntil: {}, stuck: null, lastDanger: null };
    // Most recently used last, so the oldest is the first key.
    tasks.delete(taskId);
    tasks.set(taskId, state);
    if (tasks.size > REMEMBERED_TASKS) tasks.delete(tasks.keys().next().value!);
    return state;
  };
  const used = (state: TaskReflexState, at: number) => {
    const from = at - limits.windowMs;
    state.sessions = state.sessions.filter(session => session.end === null || session.end > from);
    return state.sessions.reduce((sum, session) => sum + Math.max(0, Math.min(session.end ?? at, at) - Math.max(session.start, from)), 0);
  };
  const escalated = (state: TaskReflexState, danger: ReflexDangerEvidence | null | undefined) => {
    if (!danger || danger.kind === 'threat') return false;
    if (danger.kind === 'health' && danger.value <= limits.criticalHealth) return true;
    const last = state.lastDanger;
    return !!last && (last.kind === 'threat' || (last.kind === danger.kind && danger.value < last.value));
  };
  return {
    fast: createFastJudgmentMemory(),
    admit(taskId, at, entry) {
      const state = stateOf(taskId);
      if (entry.mode === 'danger' && escalated(state, entry.danger)) return { admit: true, escalated: true };
      if (at < (state.cooldownUntil[entry.mode] ?? -Infinity)) return { admit: false, reason: 'reflex_cooldown' };
      if (entry.mode === 'stuck' && state.stuck && at - state.stuck.at < limits.stuckLatchMs
        && (state.stuck.place === null || entry.place == null || state.stuck.place === entry.place)) return { admit: false, reason: 'stuck_latched' };
      if (used(state, at) >= limits.budgetMs) return { admit: false, reason: 'reflex_budget' };
      return { admit: true, escalated: false };
    },
    began(taskId, at, entry) {
      const state = stateOf(taskId);
      state.sessions.push({ start: at, end: null });
      if (entry.mode === 'danger' && entry.danger) state.lastDanger = { ...entry.danger };
    },
    ended(taskId, at, entry, effective, cooldown = true) {
      const state = stateOf(taskId);
      const open = state.sessions.find(session => session.end === null);
      if (open) open.end = Math.max(open.start, at);
      if (!effective && cooldown) state.cooldownUntil[entry.mode] = at + (entry.mode === 'danger' ? limits.dangerCooldownMs : limits.idleCooldownMs);
      if (entry.mode === 'stuck') state.stuck = { place: entry.place ?? null, at };
    },
    decided(taskId, at) {
      const state = tasks.get(taskId);
      if (state?.stuck && state.stuck.at <= at) state.stuck = null;
    },
  };
}

/** A body's place as a 2-block cell of its world position (`state.world.position`), or null when the frame has none. */
export function reflexPlace(world: unknown): string | null {
  const position = world && typeof world === 'object' ? (world as { position?: unknown }).position : undefined;
  if (!position || typeof position !== 'object') return null;
  const { x, y, z } = position as { x?: unknown; y?: unknown; z?: unknown };
  const cell = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value / 2) : null;
  const cells = [cell(x), cell(y), cell(z)];
  return cells.every(value => value !== null) ? cells.join(',') : null;
}
