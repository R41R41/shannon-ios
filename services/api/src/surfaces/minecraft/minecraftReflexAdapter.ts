import { followedGists, minecraftSituation, minecraftSkillContext, type SkillGistsPort } from './minecraftSkillPointers.js';
import { createHash } from 'node:crypto';
import { actionResource } from '../../contracts/actionThreadContract.js';
import { currentActionExecution, type ActionExecution } from '../../infra/context/actionExecution.js';
import type { TaskRuntime, TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaToolCall } from '../../mind/action/fca/fcaPorts.js';
import type { FcaEvidence } from '../../mind/action/fca/fcaEvidencePorts.js';
import { authorizeToolCall } from '../../mind/inhibition/toolGatePorts.js';
import { toolFailure, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import {
  createReflexController, evaluateReflexEntry, reflexSnapshot, ReflexHandoffNotSent, returnReflexControl, type BodyStopAcknowledgement,
  type BodyStopRequest, type BodyTaskContext, type ReflexEntrySelector, type ReflexEvent, type ReflexLimits,
  type ReflexPorts, type ReflexSelector, type ReflexSessionReceipt, type ReflexSessionRequest,
} from '../../mind/action/reflex/reflexPorts.js';
import { createReflexGovernor, reflexPlace, type ReflexEntryFacts, type ReflexGovernor } from '../../mind/action/reflex/reflexGovernor.js';
import { observerHandoff } from '../../infra/observer/observerContext.js';
import { createMinecraftFastJudgment } from './minecraftFastJudgment.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { MINECRAFT_SPAWN_GRACE_MILLISECONDS, type MinecraftControl } from './minecraftControl.js';
import { minecraftObservationSummary } from './minecraftObservationSummary.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const toolOk = (text: string): ToolResult => ({ ok: true, text, retryable: false });
const EMPTY = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const };
const DEFAULT_LIMITS: ReflexLimits = { maxDurationMs: 20_000, maxDecisions: 6, maxActions: 4, maxActionMs: 5_000, maxStateAgeMs: 3_000, maxImageAgeMs: 3_000 };
/** Frames in a row that must show concrete danger before a reflex starts on its own ahead of the task's first decision. */
export const REFLEX_DANGER_FRAMES = 2;

/**
 * The concrete evidence behind a body's `danger` fact (Minebot: health at most 8, oxygen at most 6, or a hostile within 5 blocks
 * that can reach it), read from the frame's world state; null when the frame shows none of it. Minecraft run 6 (2026-10-14): the
 * flag was true at spawn into a fresh world, before health had arrived (an unknown health reads as 0 there), and a reflex started
 * ahead of the task's first decision.
 */
export function concreteDanger(observation: BodyObservation): { kind: 'health' | 'oxygen' | 'threat'; value: number } | null {
  const world = observation.state.world as { health?: unknown; oxygen?: unknown; nearbyThreats?: unknown } | undefined;
  if (observation.facts.alive !== true || !world || typeof world !== 'object') return null;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (finite(world.health) && world.health > 0 && world.health <= 8) return { kind: 'health', value: world.health };
  if (finite(world.oxygen) && world.oxygen >= 0 && world.oxygen <= 6) return { kind: 'oxygen', value: world.oxygen };
  const threats = Array.isArray(world.nearbyThreats) ? world.nearbyThreats as Array<{ distance?: unknown; canReachMe?: unknown }> : [];
  const near = threats.filter(threat => finite(threat?.distance) && threat.distance <= 5 && threat.canReachMe !== false)
    .map(threat => threat.distance as number);
  return near.length ? { kind: 'threat', value: Math.min(...near) } : null;
}

/**
 * The task's pace as closed numbers (the old Minebot `describePace`; owner 2026-10-14: 「40分のまま速くする」): minutes since the task
 * began, its latest tool results that worked and failed (at most six), its steps in a row whose actions all failed, and its latest
 * milestones when the body reported them, and the seconds she has spent in `mc.wait-time` (Minecraft run 9: 390 s in nine calls) when any.
 */
export function minecraftPace(step: TaskStep, recent: ReadonlyArray<{ ok: boolean }>, at: number, milestones: PaceMilestones | null = null,
  idleWaitMilliseconds = 0) {
  const began = Date.parse(step.snapshot.task.createdAt), checkpoint = step.snapshot.checkpoint as { consecutiveToolFailures?: unknown } | null;
  const failedSteps = Number(checkpoint?.consecutiveToolFailures ?? 0);
  return { elapsedMinutes: Number.isFinite(began) ? Math.max(0, Math.floor((at - began) / 60_000)) : null,
    recentResults: { worked: recent.filter(result => result.ok).length, failed: recent.filter(result => !result.ok).length },
    failedStepsInARow: Number.isSafeInteger(failedSteps) && failedSteps >= 0 ? failedSteps : 0, ...(milestones ? { milestones } : {}),
    ...(idleWaitMilliseconds > 0 ? { idleWaitSeconds: Math.round(idleWaitMilliseconds / 1000) } : {}) };
}

/** The milliseconds a `mc.wait-time` call asks for (`milliseconds`, or `ms`), bounded; 0 when it names none. */
export function waitTimeMilliseconds(input: unknown): number {
  const value = input && typeof input === 'object' ? (input as { milliseconds?: unknown; ms?: unknown }) : {};
  const milliseconds = Number(value.milliseconds ?? value.ms);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 3_600_000) : 0;
}

/**
 * The body's milestones (Minebot 4b047cf, `mc.goal-evidence`) as the pace note gives them: its dimension and whether it reached the
 * Nether, closed values only (`visited` and the counts are left out). Read from a result's whole text, before any summary of it is
 * cut (review of d36252e8: a long `visited` list passed the 1,000 characters kept and the milestones went missing); null when the
 * text carries none.
 */
export type PaceMilestones = { dimension: string | null; netherReached: boolean | null };
export function minecraftMilestones(value: unknown): PaceMilestones | null {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const milestones = parsed && typeof parsed === 'object' ? (parsed as { milestones?: unknown }).milestones : undefined;
  if (!milestones || typeof milestones !== 'object' || Array.isArray(milestones)) return null;
  const { dimension, netherReached } = milestones as { dimension?: unknown; netherReached?: unknown };
  return { dimension: typeof dimension === 'string' && /^[a-z_:]{1,40}$/u.test(dimension) ? dimension : null,
    netherReached: typeof netherReached === 'boolean' ? netherReached : null };
}

/** One task's adapter/monitor. No extra planner, executor lease, memory writer or emotional state. */
export function createMinecraftTaskBody(parts: {
  control: MinecraftControl; runtime: TaskRuntime; step: TaskStep; entry: ReflexEntrySelector | null; selector: ReflexSelector | null;
  ownerAlone(): boolean; sourcesVisible(): boolean; now?: () => number; pollMilliseconds?: number;
  limits?: Partial<ReflexLimits>; evidence?: FcaEvidence;
  /** How long after a body's login, reconnection or respawn no reflex starts on its own (`MinecraftControl.settling`). */
  spawnGraceMilliseconds?: number;
  /** The skills she can open with `skill.read` now (`minecraftSkillPointers`); none when absent. */
  skillNames?(): ReadonlySet<string>;
  /** With `SHANNON_FCA_SKILL_GIST`: the gists of pointed skills (`fcaSkillGists.ts`); pointers alone when absent. */
  skillGists?: SkillGistsPort;
  /** A pointed skill whose shown gist this decision followed (a body tool it names, not read-only): a use of kind `gist`. */
  gistFollowed?(name: string): void;
  /** The task's automatic reflex entries across its steps (`reflexGovernor.ts`); one for this step alone when absent. */
  governor?: ReflexGovernor;
  /** Syzygy ADR-0011 stage 2 (`SHANNON_MINECRAFT_FAST_JUDGMENT`): danger is judged without an image (`minecraftFastJudgment.ts`). */
  fastJudgment?: boolean;
  log?(line: string): void;
}): { body: FcaBodyLifecycle; tools: FcaExternalTools; safeToAcknowledgeStop(): boolean } {
  const { control, runtime, step } = parts, now = parts.now ?? Date.now, limits = { ...DEFAULT_LIMITS, ...parts.limits };
  const governor = parts.governor ?? createReflexGovernor();
  const monitorAbort = new AbortController(), toolAborts = new Set<AbortController>(), claims = new Set<string>();
  const releasedSessions = new Set<string>();
  const captures = new Map<string, number>(), modes = new Map<string, 'explicit' | 'danger' | 'stuck' | 'visual'>();
  const cleanupListeners = new Set<() => void>();
  const prior = step.snapshot.checkpoint as { fcaToolSelection?: { recentResults?: Array<{ name: string; ok: boolean; summary: string }> } } | null;
  let recentResults = (prior?.fcaToolSelection?.recentResults ?? []).slice(-6).map(value => ({ name: value.name.slice(0, 160), ok: value.ok, summary: value.summary.slice(0, 1000) }));
  // The latest milestones, kept in the task's checkpoint across steps (`minecraftMilestones` key, through this port's `checkpoint`).
  const kept = (step.snapshot.checkpoint as { minecraftMilestones?: unknown } | null)?.minecraftMilestones;
  let milestones = minecraftMilestones({ milestones: kept });
  // Her idle waits in this task, kept in the checkpoint as the milestones are (`minecraftIdleWaitMs`).
  const keptWait = Number((step.snapshot.checkpoint as { minecraftIdleWaitMs?: unknown } | null)?.minecraftIdleWaitMs ?? 0);
  let idleWaitMs = Number.isSafeInteger(keptWait) && keptWait > 0 ? keptWait : 0, pendingWaitMs = 0;
  let activeAction: NonNullable<BodyTaskContext['taskState']>['activeAction'];
  let revision = 0, started = false, closed = false, unknown = false, attempts = 0, lastEntryAt = -Infinity;
  let execution: ActionExecution | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let monitoring: Promise<void> | null = null, active: Promise<ReflexSessionReceipt | null> | null = null, fault: unknown;
  let lastSignature = '', lastSequence = -1, lastFastSequence = -1;
  // The body tools named by the gists the latest decision was shown (`minecraftSkillContext`), by skill.
  let gistTools: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  // Before the task's first decision (none in its history, no call noted yet) a reflex starts on its own only for concrete danger
  // seen in `REFLEX_DANGER_FRAMES` frames in a row; never for `stuck` or `visual`. What held it back is told to the Observer once.
  let decided = step.snapshot.history.length > 0 || recentResults.length > 0, dangerFrames = 0, held = '';
  const spawnGrace = parts.spawnGraceMilliseconds ?? MINECRAFT_SPAWN_GRACE_MILLISECONDS;
  const log = parts.log ?? ((line: string) => console.info(line));
  // To the Observer (its sidecar, kept 15 minutes) and, with the fast judgment on, content-free to the journal too: the Minebot lane
  // looked for the governor's holds there after run 11 and found none. With the switch off nothing new is written (main, unchanged).
  const hold = (reason: string, detail: Record<string, string | number | boolean | null> = {}) => {
    if (held !== reason) {
      observerHandoff('bodyObserve', 'reflex', { phase: 'entry_held', reason, ...detail });
      if (parts.fastJudgment) log(`Shannon reflex entry held task=${step.taskId} reason=${reason}`);
    }
    held = reason;
  };
  const leaseMatches = () => !!execution && execution.lease.id === step.lease.id && execution.lease.holder === step.lease.holder && execution.lease.generation === step.lease.generation;
  const live = () => leaseMatches() && parts.ownerAlone() && parts.sourcesVisible() && !monitorAbort.signal.aborted
    && runtime.get(step.scopeKey, step.taskId)?.phase === 'executing';
  const bound = () => control.store.body(step.taskId);
  const availableBody = () => bound() ?? (control.available().length === 1 ? control.available()[0]! : null);
  const context = (bodyId: string, sessionId: string): BodyTaskContext => ({ scopeKey: step.scopeKey, taskId: step.taskId,
    taskRevision: step.revision, bodyId, sessionId, generation: step.lease.generation,
    goal: step.snapshot.task.goal, completionCondition: step.snapshot.task.completionCriteria,
    taskState: { phase: runtime.get(step.scopeKey, step.taskId)?.phase ?? 'unknown', progress: step.snapshot.task.summary.slice(0, 2000),
      ...(activeAction ? { activeAction } : {}), recentResults } });
  const permit = async (signal?: AbortSignal) => !signal?.aborted && live()
    && Boolean(await execution!.permit([actionResource(control.configuration.deviceId, 'minecraft-body')], signal)) && !signal?.aborted && live();
  const ackUnknown = (request: BodyStopRequest): BodyStopAcknowledgement => ({ bodyId: request.context.bodyId, sessionId: request.context.sessionId,
    generation: request.context.generation, requestId: request.requestId, state: 'unknown', inputsReleased: false, observedAt: new Date(now()).toISOString() });
  const physicalStop = async (request: BodyStopRequest, kind: 'stop' | 'release', signal?: AbortSignal): Promise<BodyStopAcknowledgement> => {
    const id = `${kind}:${hash(request.requestId)}`;
    try {
      const receipt = await control.command({ id, context: request.context, lease: step.lease, kind, stop: request, milliseconds: 5_000 }, signal);
      if (kind === 'release' && receipt.stop?.state === 'stopped' && receipt.stop.inputsReleased) releasedSessions.add(request.context.sessionId);
      return receipt.stop ?? ackUnknown(request);
    } catch { if (kind === 'stop' && !control.store.command(id)) throw new ReflexHandoffNotSent(); unknown = true; return ackUnknown(request); }
  };
  const actionCall = (operationId: string, operation: string, arguments_: unknown): FcaToolCall => {
    const eventId = operationId.replace(/:operation:(\d+)$/, ':action:$1');
    return { id: eventId.slice(step.id.length + 1), name: 'minecraft.reflex.action', input: { operation, arguments: arguments_ } };
  };
  const event = (value: ReflexEvent) => {
    // Live task-origin delivery inherits its current source lineage, including tasks without a conversation source.
    const text = JSON.stringify({ kind: 'body.reflex', eventId: value.id, bodyId: value.context.bodyId, phase: value.kind,
      ...(value.operationId ? { operationId: value.operationId } : {}), ...(value.evidenceId ? { evidenceId: value.evidenceId } : {}),
      ...(value.outcome ? { outcome: value.outcome } : {}), ...(value.reason ? { reason: value.reason } : {}) });
    runtime.send(step.scopeKey, step.taskId, step.taskId, text, value.id);
  };
  const ports: ReflexPorts = {
    now, current: ctx => live() && ctx.taskId === step.taskId && ctx.taskRevision === step.revision && ctx.generation === step.lease.generation,
    selector: { async choose(input, signal) { if (!parts.selector || !await permit(signal)) return null; signal.throwIfAborted(); return parts.selector.choose(input, signal); } }, event,
    handoff: {
      async inspect(ctx) { const old = control.store.session(ctx.sessionId); return old ? old.receipt ? 'duplicate' : 'unknown' : 'new'; },
      prepare: (_ctx, signal) => permit(signal),
      async stopNormal(request, signal) {
        if (!await permit(signal)) throw new ReflexHandoffNotSent();
        if (!control.store.beginSession(request.context.sessionId, request.context)) return ackUnknown(request);
        claims.add(request.context.sessionId);
        return physicalStop(request, 'stop', signal);
      },
      async acquire(ctx, _ack, signal) { return claims.has(ctx.sessionId) && await permit(signal) ? step.lease : null; },
      async returnStopped(request, receipt) {
        const release = await physicalStop(request, 'release');
        return returnReflexControl(ports, step.lease, { ...receipt, latestObservation: control.observe(request.context.bodyId) }, Promise.resolve(release), request);
      },
      valid: async (ctx, _lease, signal) => claims.has(ctx.sessionId) && await permit(signal),
      async finish(_lease, receipt) {
        if (receipt.control === 'held') unknown = true;
        control.store.endSession(receipt.context.sessionId, receipt);
        // The enclosing FCA still owns this exact lease until its history and segment receipt commit.
      },
    },
    body: {
      async observe(ctx, signal) {
        if (releasedSessions.has(ctx.sessionId)) return control.observe(ctx.bodyId);
        if (!await permit(signal)) return control.observe(ctx.bodyId);
        const count = (captures.get(ctx.sessionId) ?? 0) + 1; captures.set(ctx.sessionId, count);
        await control.command({ id: `capture:${hash(`${ctx.sessionId}:${count}`)}`, context: ctx, lease: step.lease, kind: 'capture', milliseconds: 3_000 }, signal);
        return control.observe(ctx.bodyId);
      },
      candidates: (_ctx, observation) => control.frame(observation.bodyId)?.poll.candidates ?? [],
      validate: (ctx, candidate, observation) => live() && observation.bodyId === ctx.bodyId && (control.frame(ctx.bodyId)?.poll.candidates ?? []).some(draft =>
        draft.kind === candidate.kind && draft.operation === candidate.operation && JSON.stringify(reflexSnapshot(draft.arguments)) === JSON.stringify(candidate.arguments)
        && draft.preconditions.every(condition => observation.facts[condition.key] === condition.value)),
      async execute(operation, lease, signal) {
        if (!await permit(signal)) throw new Error('FCA_BODY_LEASE_INVALID');
        signal.throwIfAborted();
        const call = actionCall(operation.operationId, operation.candidate.operation!, operation.candidate.arguments);
        if (parts.evidence && !parts.evidence.beforeActions(step, { decision: { kind: 'tools', calls: [call] }, history: [] })) throw new Error('FCA_EVIDENCE_FENCED');
        execution!.stepOutcome = 'unknown';
        try {
          const receipt = await control.command({ id: `reflex:${hash(operation.operationId)}`, context: operation.context, lease, kind: 'reflex', operation,
            milliseconds: Math.max(1, Date.parse(operation.deadlineAt) - now()) }, signal);
          const action = receipt.action;
          if (!action) throw new Error('FCA_BODY_ACTION_ACK_REQUIRED');
          execution!.stepOutcome = 'acknowledged';
          const text = JSON.stringify({ outcome: action.outcome, evidenceId: action.evidenceId, inputsReleased: action.inputsReleased, operationId: action.operationId });
          parts.evidence?.observed(step, call, action.outcome === 'completed' ? toolOk(text) : toolFailure('failed', text, { retryable: false }));
          return action;
        } catch (error) { unknown = true; parts.evidence?.unknown(step, call); throw error; }
      },
      releaseInputs: request => physicalStop(request, 'release'),
      termination: (ctx, observation, recent) => {
        if (observation.facts.targetLost === true) return { reason: 'target_lost', evidenceIds: [] };
        if (observation.facts.progressStopped === true) return { reason: 'no_progress', evidenceIds: [] };
        if (modes.get(ctx.sessionId) === 'danger' && observation.facts.danger === false && recent.length) return { reason: 'hazard_cleared', evidenceIds: [recent.at(-1)!.evidenceId] };
        return null;
      },
    },
  };
  const controller = createReflexController(ports);
  /**
   * RUNNER SEMANTICS (Minecraft run 10, 2026-10-14): a session makes the step's decision stale (`revision`, read by `guard`) only when
   * it interrupted a body tool in flight (or is her own `minecraft.reflex` call), or when it touched the body: it sent a body
   * action, its control is held, or it failed. One that only observed and returned leaves the decision made meanwhile valid; in run
   * 10 such sessions discarded the FCA's last 20 decisions (every tool result 「身体の状態が変わりました」).
   */
  const startSession = (request: ReflexSessionRequest, mode: 'explicit' | 'danger' | 'stuck' | 'visual', signal: AbortSignal, entry?: ReflexEntryFacts) => {
    const interrupting = mode === 'explicit' || activeAction !== undefined;
    if (interrupting) revision += 1;
    modes.set(request.context.sessionId, mode); toolAborts.forEach(abort => abort.abort());
    const job = controller.run(request, signal);
    if (entry) governor.began(step.taskId, now(), entry);
    // Effective: a body action completed in it. A session that only observed and returned is followed by its mode's cooldown.
    const ended = (effective: boolean) => { if (entry) governor.ended(step.taskId, now(), entry, effective); };
    const touched = () => { if (!interrupting) revision += 1; };
    // `active` settles only after this bookkeeping, so `guard` compares the revision as the session left it.
    const settled = job.then(receipt => {
      if (receipt?.control === 'held') unknown = true;
      if (receipt && (receipt.actions.length > 0 || receipt.control === 'held')) touched();
      ended(!!receipt?.actions.some(action => action.outcome === 'completed'));
      return receipt;
    }, error => {
      fault = error; unknown = true;
      touched();
      ended(false);
      return null;
    });
    active = settled;
    void settled.finally(() => { if (active === settled) active = null; });
    return job;
  };
  const fast = parts.fastJudgment ? createMinecraftFastJudgment({ control, step, governor, now, context, permit: signal => permit(signal),
    activeAction: () => activeAction, interrupt: () => toolAborts.forEach(abort => abort.abort()),
    touched: () => { revision += 1; }, stepOutcome: value => { execution!.stepOutcome = value; }, unknown: () => { unknown = true; },
    send: (text, id) => runtime.send(step.scopeKey, step.taskId, step.taskId, text, id), hold, log }) : null;
  const startFast = (job: Promise<void>) => {
    const settled = job.then(() => null, error => {
      fault = error; unknown = true;
      return null;
    });
    active = settled;
    void settled.finally(() => { if (active === settled) active = null; });
  };
  const tick = async () => {
    // The task's source check (`live`) walks its whole provenance when its verdict has expired (Minecraft run 10, 2026-10-14: 2–5 s
    // each on a long task, the API's thread blocked every ~5 s while this monitor polled every 250 ms). It is asked only once a
    // frame could start a reflex; nothing is shown, sent or started before it, and the entry asks it again (below).
    if (closed || active) return;
    const bodyId = bound(), observation = bodyId ? control.observe(bodyId) : null;
    // The image-free fast judgment comes first and needs no picture (ADR-0011 stage 2, run 11).
    if (fast && bodyId && observation && observation.sequence !== lastFastSequence) {
      lastFastSequence = observation.sequence;
      const job = fast.consider(bodyId, observation, live, monitorAbort.signal);
      if (job) return startFast(job);
    }
    if (!parts.entry || !parts.selector || attempts >= 4) return;
    // Every session requires a picture; without one it could only end `observation_unavailable` after the entry call.
    if (bodyId && control.imagesUnavailable(bodyId)) return;
    if (!observation || observation.sequence === lastSequence) return;
    lastSequence = observation.sequence;
    const facts = observation.facts, mode = facts.danger === true ? 'danger' : facts.stuck === true ? 'stuck' : facts.visualRequired === true ? 'visual' : null;
    const evidence = mode === 'danger' ? concreteDanger(observation) : null;
    dangerFrames = evidence ? dangerFrames + 1 : 0;
    if (!mode) return void (held = '');
    // With the fast judgment on, danger is its alone: the image reflex stopped her fight and stood still in run 11.
    if (fast && mode === 'danger') return;
    if (!live()) return;
    if (control.settling(bodyId!, spawnGrace)) return hold('spawn_grace', { mode, sequence: observation.sequence });
    if (!decided && !activeAction) {
      if (mode !== 'danger') return hold('before_first_decision', { mode, sequence: observation.sequence });
      if (!evidence) return hold('danger_without_evidence', { sequence: observation.sequence });
      if (dangerFrames < REFLEX_DANGER_FRAMES) return hold('danger_not_persistent', { kind: evidence.kind, value: evidence.value, frames: dangerFrames });
    }
    // A body skill in flight owns its own stalls (Minebot's pathfinding has its stuck count and timeout) and reports its result to the
    // task; only an immediate hazard preempts it. Minecraft operator run 5 (2026-10-14, task 68395576): `stuck` (controls held, no
    // movement for 1.5 s) 1.5 s into an mc.move-to entered a session that cancelled the skill ("Action interrupted"), then could not
    // get a picture and returned with no decision.
    if (activeAction && mode !== 'danger') return;
    const signature = JSON.stringify([mode, facts.target ?? null]);
    if (signature === lastSignature && now() - lastEntryAt < 2_000) return;
    // Cooldown after a session without effect, the per-minute budget, and one stuck entry per place until she decides again
    // (`reflexGovernor.ts`, Minecraft run 10). Worsening danger is never held here.
    const entryFacts: ReflexEntryFacts = { mode, danger: evidence, place: reflexPlace((observation.state as { world?: unknown }).world) };
    const admission = governor.admit(step.taskId, now(), entryFacts);
    if (!admission.admit) return hold(admission.reason, { mode, sequence: observation.sequence });
    if (!leaseMatches() || !await execution!.permit([], monitorAbort.signal) || !live()) return;
    lastSignature = signature; lastEntryAt = now(); attempts += 1; held = '';
    // The fact that started it, for the Observer (Minecraft run 6: an entry at spawn left no trace of why).
    observerHandoff('bodyObserve', 'reflex', { phase: 'entry', trigger: 'observation', mode, sequence: observation.sequence, decided,
      ...(admission.escalated ? { escalated: true } : {}),
      ...(evidence ? { evidence: evidence.kind, value: evidence.value, frames: dangerFrames } : {}), danger: facts.danger === true,
      stuck: facts.stuck === true, visual: facts.visualRequired === true });
    const ctx = context(bodyId!, `${step.id}:reflex:${attempts}`), request = { context: ctx, limits };
    if (await evaluateReflexEntry(request, { context: ctx, observation, trigger: 'observation', recent: [] }, parts.entry, ports, monitorAbort.signal)
      && !closed && live()) await startSession({ ...request, requiresImage: true }, mode, monitorAbort.signal, entryFacts);
  };
  const poll = () => {
    if (monitoring || closed) return;
    const job = tick(); monitoring = job;
    void job.catch(error => { if (!monitorAbort.signal.aborted) fault = error; }).finally(() => { if (monitoring === job) monitoring = null; });
  };
  const safe = () => !unknown && control.store.safe(step.taskId);
  // A body tool that changes something (not read-only), named by a gist the deciding step was shown; learning never fails a step.
  const noteGistFollowed = (name: string) => {
    const id = availableBody();
    const skill = id ? control.frame(id)?.poll.skills?.find(item => `mc.${item.name}` === name) : undefined;
    if (!parts.gistFollowed || !skill || skill.readOnly) return;
    for (const followed of followedGists(gistTools, name)) {
      try { parts.gistFollowed(followed); } catch { /* learning never fails a step */ }
    }
  };
  const body: FcaBodyLifecycle = {
    start(signal) {
      if (started) return; started = true; execution = currentActionExecution();
      const cancel = () => { monitorAbort.abort(); toolAborts.forEach(abort => abort.abort()); const id = bound(); if (id) controller.cancel(step.scopeKey, id); control.cancelTask(step.taskId); };
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      cleanupListeners.add(() => signal.removeEventListener('abort', cancel));
      timer = setInterval(poll, parts.pollMilliseconds ?? 250); timer.unref(); poll();
    },
    revision: () => revision,
    settling: () => !!availableBody() && control.settling(availableBody()!, spawnGrace),
    // A bounded summary: each decision's message stays in the task's history; `minecraft.observe` reads the whole frame.
    context: () => {
      const observation = live() && bound() ? control.observe(bound()!) : null;
      const pace = minecraftPace(step, recentResults, now(), milestones, idleWaitMs);
      const recentIdleWaits = recentResults.filter(result => result.name === 'mc.wait-time' && result.ok).length;
      const situation = minecraftSituation(observation, { ...pace, recentIdleWaits });
      const skills = minecraftSkillContext(situation, parts.skillNames?.() ?? new Set(), parts.skillGists);
      gistTools = skills.gistTools;
      return { revision, observation: observation ? minecraftObservationSummary(observation) : null, pace, ...skills.fields };
    },
    async guard(version) { if (active) await active; if (fault) throw fault; if (!safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN'); return version === revision; },
    toolSignal(name, parent) {
      if (!name.startsWith('mc.')) return parent;
      const id = availableBody(); if (id && live()) control.store.bind(step.taskId, id);
      const abort = new AbortController(); toolAborts.add(abort);
      const cancel = () => abort.abort(); parent.addEventListener('abort', cancel, { once: true });
      cleanupListeners.add(() => parent.removeEventListener('abort', cancel));
      // A tool cut off by a session in progress leaves the decision stale even when the session itself touches nothing.
      if (active) revision += 1;
      if (parent.aborted || active) abort.abort();
      return abort.signal;
    },
    noteCall(call, operationId) {
      decided = true;
      governor.decided(step.taskId, now());
      if (!call.name.startsWith('mc.')) return;
      noteGistFollowed(call.name);
      // Registered tools already bound inputs to 32K; malformed inputs are still only inert context.
      const encoded = JSON.stringify(call.input);
      activeAction = { name: call.name, operationId, input: encoded && encoded.length <= 32_000 ? JSON.parse(encoded) : null };
      pendingWaitMs = call.name === 'mc.wait-time' ? waitTimeMilliseconds(call.input) : 0;
    },
    noteResult(call, result) {
      if (activeAction?.name === call.name) activeAction = undefined;
      if (call.name === 'mc.goal-evidence' && result.ok) milestones = minecraftMilestones(result.text) ?? milestones;
      if (call.name === 'mc.wait-time' && result.ok) idleWaitMs = Math.min(idleWaitMs + pendingWaitMs, 86_400_000);
      pendingWaitMs = 0;
      recentResults = [...recentResults, { name: call.name, ok: result.ok, summary: result.text.slice(0, 1000) }].slice(-6);
    },
    async close() {
      if (!closed) { closed = true; if (timer) clearInterval(timer); cleanupListeners.forEach(remove => remove()); cleanupListeners.clear(); monitorAbort.abort(); await controller.close(); }
      if (monitoring) await monitoring.catch(() => {}); if (active) await active;
      if (!safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
    },
  };
  const definition = { name: 'minecraft.reflex', description: '現在のタスクの目的で、一人称画像を更新しながら短い身体操作を選ぶ。最新状態と結果を返し、長期計画はここで立てない。',
    input: EMPTY, domain: 'minecraft_body' as const, effect: 'write' as const, cost: 'model' as const,
    audiences: ['owner_alone' as const], surfaces: ['text' as const] };
  // Offered only while the body can give a picture: every session requires one (`imagesUnavailable`).
  const offered = !!parts.selector && !!availableBody() && !!control.frame(availableBody()!) && !control.imagesUnavailable(availableBody()!);
  const tools: FcaExternalTools = { definitions: offered ? [definition] : [],
    checkpoint: () => ({ ...(milestones ? { minecraftMilestones: milestones } : {}), ...(idleWaitMs ? { minecraftIdleWaitMs: idleWaitMs } : {}) }),
    async execute(call) {
    const denied = authorizeToolCall(call.name === definition.name ? definition : null, { scopeKey: call.scopeKey, surface: 'text', audience: parts.ownerAlone() ? 'owner_alone' : 'others' });
    if (denied) return denied;
    if (!parts.selector || call.taskId !== step.taskId || call.scopeKey !== step.scopeKey || !live()) throw new Error('FCA_BODY_LEASE_INVALID');
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input) || Object.keys(call.input).length) return toolFailure('invalid_input', '引数は空のオブジェクトです。');
    const bodyId = availableBody(); if (!bodyId || !control.frame(bodyId) || !control.store.bind(step.taskId, bodyId)) return toolFailure('unavailable', '操作できる体が接続されていません。');
    if (control.imagesUnavailable(bodyId)) return toolFailure('unavailable', '一人称画像が今は得られないため、短い視覚操作は使えません。minecraft.observe と mc.* の道具で進めます。');
    const ctx = context(bodyId, `${step.id}:reflex:${hash(call.operationId).slice(0, 16)}`);
    if (active) await active;
    const receipt = await startSession({ context: ctx, limits, requiresImage: true }, 'explicit', call.signal);
    if (!receipt || receipt.control === 'held' || !safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
    return toolOk(JSON.stringify(receipt));
  } };
  return { body, tools, safeToAcknowledgeStop: safe };
}
