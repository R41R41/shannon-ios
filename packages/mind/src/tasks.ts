/**
 * The one task vocabulary of the execution system (Syzygy ADR-0009 stage 1, S3), pure. In S3 the new columns of `agent_tasks`
 * (`task_kind`, `exec_state`, `wait_reason`, `effect_class`) and of `mind_actions` (`slot_class`, `effect_sent`) are derived here
 * from the old ones, which stay the authority: nothing decides from the new values yet. `legacyProjection` is the way back,
 * from a state to the old `status` and `pause_reason`; S4 makes the state machine the writer and keeps the old columns as
 * that projection, so every combination written today must come back unchanged (`tasks.test.ts`).
 */
export const TASK_KINDS = ['root', 'conversation', 'work', 'sleep', 'codex', 'activity'] as const;
export type TaskKind = typeof TASK_KINDS[number];

export const EXEC_STATES = [
  'proposed', 'ready', 'active', 'waiting', 'stopping', 'stopped', 'unknown', 'completed', 'failed', 'cancelled',
] as const;
export type ExecState = typeof EXEC_STATES[number];

/** `none`: the task only calls models; `external`: it acts outside (the Agent Host's Codex). */
export const EFFECT_CLASSES = ['none', 'external'] as const;
export type EffectClass = typeof EFFECT_CLASSES[number];

/** What a task row says today: `agent_tasks` and, for an FCA task, its checkpoint. */
export interface TaskFacts {
  readonly fcaKind: string | null;
  readonly status: string;
  readonly pauseReason: string | null;
  readonly currentAction: string | null;
  readonly stepId: string | null;
  readonly stopRequested: boolean;
  readonly checkpointWaitReason: string | null;
}

/** The new columns of one task, as derived from its facts. */
export interface DerivedTask {
  readonly taskKind: TaskKind;
  readonly execState: ExecState;
  readonly waitReason: string | null;
  readonly effectClass: EffectClass;
}

/** The old columns: `status` and `pause_reason`. */
export interface LegacyTaskState {
  readonly status: string;
  readonly pauseReason: string | null;
}

/**
 * What the Agent Host keeps beside the state: whether its task is still connecting (`starting`, else `running`), and the
 * reason of a wait (`approval` for `waiting_approval`, `owner` for a pause that needs the owner).
 */
export interface HostFlags {
  readonly starting?: boolean;
  readonly waitReason?: string | null;
}

const FCA_KINDS: Readonly<Record<string, TaskKind>> = Object.freeze({
  root: 'root', conversation: 'conversation', research: 'work', generic: 'work', sleep: 'sleep',
});

/** `COALESCE(fca_kind, 'codex')`, with the FCA research and generic tasks as `work`; an unknown FCA kind has none. */
export function deriveTaskKind(fcaKind: string | null): TaskKind | null {
  if (fcaKind === null) return 'codex';
  return FCA_KINDS[fcaKind] ?? null;
}

/** Codex acts outside; every FCA kind only calls models, so its unknown step is retired today (`retireUnknown`). */
export function effectClassOf(kind: TaskKind): EffectClass {
  return kind === 'codex' ? 'external' : 'none';
}

/** The pause of an Agent Host task as the app reads it (`pauseProjection`): an unset reason follows `current_action`. */
export function hostPauseReason(facts: Pick<TaskFacts, 'status' | 'pauseReason' | 'currentAction'>): string | null {
  if (facts.status !== 'paused') return facts.pauseReason;
  if (facts.pauseReason === 'owner' || facts.pauseReason === 'needs_owner') return facts.pauseReason;
  return facts.currentAction ? 'needs_owner' : 'owner';
}

const CODEX_STATES: Readonly<Record<string, ExecState>> = Object.freeze({
  proposed: 'proposed', queued: 'ready', starting: 'active', running: 'active', waiting_approval: 'waiting',
  completed: 'completed', failed: 'failed', cancelled: 'cancelled',
});

function codexState(facts: TaskFacts): ExecState | null {
  if (facts.status !== 'paused') return CODEX_STATES[facts.status] ?? null;
  return hostPauseReason(facts) === 'needs_owner' ? 'waiting' : 'stopped';
}

function codexWaitReason(facts: TaskFacts): string | null {
  if (facts.status === 'waiting_approval') return 'approval';
  if (facts.status === 'paused' && hostPauseReason(facts) === 'needs_owner') return 'owner';
  return null;
}

/**
 * An FCA task's state exactly as `SQLiteTaskRuntimeStore` derives its phase, with `executing` named `active` and a cancelled
 * task kept apart from a stopped one (`fcaPhaseOf` folds it back).
 */
function fcaState(facts: TaskFacts): ExecState {
  if (facts.status === 'completed') return 'completed';
  if (facts.status === 'failed') return 'failed';
  if (facts.pauseReason === 'fca_unknown') return 'unknown';
  if (facts.status === 'cancelled') return 'cancelled';
  if (facts.status === 'paused') return 'stopped';
  if (facts.stopRequested) return 'stopping';
  if (facts.stepId) return 'active';
  return facts.status === 'queued' ? 'ready' : 'waiting';
}

/** The state of a task from what its row says today, or null for a status the vocabulary does not know. */
export function deriveExecState(facts: TaskFacts): ExecState | null {
  return facts.fcaKind === null ? codexState(facts) : fcaState(facts);
}

/** The new columns of one task, or null when its kind or status is not one written today. */
export function deriveTask(facts: TaskFacts): DerivedTask | null {
  const taskKind = deriveTaskKind(facts.fcaKind);
  const execState = deriveExecState(facts);
  if (!taskKind || !execState) return null;
  const fcaWait = execState === 'waiting' ? facts.checkpointWaitReason : null;
  const waitReason = taskKind === 'codex' ? codexWaitReason(facts) : fcaWait;
  return { taskKind, execState, waitReason, effectClass: effectClassOf(taskKind) };
}

/** The phase `SQLiteTaskRuntimeStore` shows for an FCA task in this state. */
export function fcaPhaseOf(state: ExecState): string {
  if (state === 'active') return 'executing';
  if (state === 'cancelled') return 'stopped';
  return state;
}

const legacy = (status: string, pauseReason: string | null = null): LegacyTaskState => ({ status, pauseReason });

const CODEX_PROJECTION: Readonly<Partial<Record<ExecState, LegacyTaskState>>> = Object.freeze({
  proposed: legacy('proposed'), ready: legacy('queued'), stopped: legacy('paused', 'owner'),
  completed: legacy('completed'), failed: legacy('failed'), cancelled: legacy('cancelled'),
});

function codexProjection(state: ExecState, flags: HostFlags): LegacyTaskState | null {
  if (state === 'active') return legacy(flags.starting ? 'starting' : 'running');
  if (state !== 'waiting') return CODEX_PROJECTION[state] ?? null;
  return flags.waitReason === 'approval' ? legacy('waiting_approval') : legacy('paused', 'needs_owner');
}

const FCA_PROJECTION: Readonly<Partial<Record<ExecState, LegacyTaskState>>> = Object.freeze({
  ready: legacy('queued'), active: legacy('running'), waiting: legacy('running'), stopping: legacy('running'),
  stopped: legacy('paused', 'fca_stopped'), unknown: legacy('paused', 'fca_unknown'),
  completed: legacy('completed'), failed: legacy('failed'), cancelled: legacy('cancelled'),
});

/**
 * The old `status` and `pause_reason` of a task in a state: what S4 writes in the same UPDATE as the state. Null for a state
 * that kind never takes (an FCA task is never proposed; a Codex task is never stopping or unknown, its doubt is its action's).
 */
export function legacyProjection(state: ExecState, kind: TaskKind, hostFlags: HostFlags = {}): LegacyTaskState | null {
  if (kind === 'codex') return codexProjection(state, hostFlags);
  return FCA_PROJECTION[state] ?? null;
}

/** The old columns of a task as they are compared: an Agent Host pause by the reason the app reads. */
export function legacyStateOf(facts: TaskFacts): LegacyTaskState {
  const pauseReason = facts.fcaKind === null ? hostPauseReason(facts) : facts.pauseReason;
  return legacy(facts.status, pauseReason);
}

/** The Host's flags for a projection, from the row (the Host keeps reporting `starting` in its own status). */
export function hostFlagsOf(facts: TaskFacts, waitReason: string | null): HostFlags {
  return { starting: facts.status === 'starting', waitReason };
}

/** Whether a stored state projects back onto the old columns of its row (the S3 check; `projectionMismatches` counts the rest). */
export function projectionMatches(stored: Pick<DerivedTask, 'taskKind' | 'execState' | 'waitReason'>, facts: TaskFacts): boolean {
  const projected = legacyProjection(stored.execState, stored.taskKind, hostFlagsOf(facts, stored.waitReason));
  const current = legacyStateOf(facts);
  return projected !== null && projected.status === current.status && projected.pauseReason === current.pauseReason;
}

/** Whether an action's outside effect may have happened and is not settled: what `sent` says, kept through an unknown release. */
export function effectSentOf(action: { readonly sent: boolean; readonly state: string }): boolean {
  return action.sent || action.state === 'unknown';
}

export const SLOT_CLASSES = ['respond', 'touch', 'creative', 'research', 'minecraft', 'codex', 'sleep', 'other'] as const;
export type SlotClass = typeof SLOT_CLASSES[number];

/** The touch reflex's action source (`touch:<sha256>`, `fcaTouchWiring.ts`). */
const TOUCH_SOURCE = /^touch:[a-f0-9]{64}$/u;

const TASK_SLOTS: Readonly<Record<TaskKind, SlotClass>> = Object.freeze({
  root: 'research', conversation: 'research', work: 'research', sleep: 'sleep', codex: 'codex', activity: 'creative',
});

/** The slot class of an action: by its kind, and for an Agent Task step by the kind of its task (none: `other`). */
export function slotClassOf(action: { readonly kind: string; readonly sourceId: string }, taskKind: TaskKind | null): SlotClass {
  if (action.kind === 'respond') return 'respond';
  if (action.kind === 'ownTime') return 'creative';
  if (action.kind === 'minecraft') return 'minecraft';
  if (action.kind !== 'agentTask') return 'other';
  if (TOUCH_SOURCE.test(action.sourceId)) return 'touch';
  return taskKind ? TASK_SLOTS[taskKind] : 'other';
}

/** The rows of `mind_action_slot_pools` and `mind_action_slot_classes`. */
export interface SlotLimits {
  readonly pools: Readonly<Record<string, number>>;
  readonly classes: Readonly<Record<SlotClass, { readonly pool: string; readonly maxLive: number }>>;
}

const inBackground = (maxLive: number) => Object.freeze({ pool: 'background', maxLive });

/** Today's limits, seeded by schema step 009: one foreground slot, two background slots, every background class up to two. */
export const SLOT_LIMITS_TODAY: SlotLimits = Object.freeze({
  pools: Object.freeze({ foreground: 1, background: 2 }),
  classes: Object.freeze({
    respond: Object.freeze({ pool: 'foreground', maxLive: 1 }), touch: inBackground(2), creative: inBackground(2), research: inBackground(2),
    minecraft: inBackground(2), codex: inBackground(2), sleep: inBackground(2), other: inBackground(2),
  }),
});

/**
 * The owner's limits of 2026-10-12 (ADR-0009 stage 1 plan, §6 answer 1), in force since S6 (schema step 011 writes them as
 * data): three background slots in all; creative 1, research 2, Minecraft 1, Codex 1, sleep 1, other 1; the touch reflex in a
 * pool of its own with one; one foreground slot.
 */
export const SLOT_LIMITS_OWNER_2026_10_12: SlotLimits = Object.freeze({
  pools: Object.freeze({ foreground: 1, background: 3, touch: 1 }),
  classes: Object.freeze({
    respond: Object.freeze({ pool: 'foreground', maxLive: 1 }), touch: Object.freeze({ pool: 'touch', maxLive: 1 }),
    creative: inBackground(1), research: inBackground(2), minecraft: inBackground(1), codex: inBackground(1), sleep: inBackground(1),
    other: inBackground(1),
  }),
});

/** What is wrong with a set of limits: a class without a pool, a class above its pool, a limit that is not a positive integer. */
export function slotLimitProblems(limits: SlotLimits): string[] {
  const problems: string[] = [];
  for (const [pool, maxLive] of Object.entries(limits.pools)) {
    if (!Number.isSafeInteger(maxLive) || maxLive < 1) problems.push(`pool ${pool}: ${maxLive}`);
  }
  for (const slotClass of SLOT_CLASSES) {
    const limit = limits.classes[slotClass];
    const poolMax = limit ? limits.pools[limit.pool] : undefined;
    if (!limit || poolMax === undefined) problems.push(`class ${slotClass}: no pool`);
    else if (!Number.isSafeInteger(limit.maxLive) || limit.maxLive < 1 || limit.maxLive > poolMax) problems.push(`class ${slotClass}: ${limit.maxLive}`);
  }
  return problems;
}

/** The slot tables' rows as limits, or null when they are incomplete or wrong (`slotLimitProblems`). */
export function slotLimitsOf(
  pools: ReadonlyArray<{ readonly pool: unknown; readonly max_live: unknown }>,
  classes: ReadonlyArray<{ readonly slot_class: unknown; readonly pool: unknown; readonly max_live: unknown }>,
): SlotLimits | null {
  const poolLimits: Record<string, number> = {};
  for (const row of pools) poolLimits[String(row.pool)] = Number(row.max_live);
  const classLimits: Partial<Record<SlotClass, { pool: string; maxLive: number }>> = {};
  for (const row of classes) {
    const slotClass = String(row.slot_class) as SlotClass;
    if (SLOT_CLASSES.includes(slotClass)) classLimits[slotClass] = { pool: String(row.pool), maxLive: Number(row.max_live) };
  }
  const limits = { pools: poolLimits, classes: classLimits as SlotLimits['classes'] };
  return slotLimitProblems(limits).length ? null : limits;
}
