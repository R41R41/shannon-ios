import {
  bedSearchMemory, createRoutePlanning, followedGists, gistFollowLine, milestoneFollowMemory, minecraftSituation, minecraftSkillContext, routeWatcher,
  type SkillGistsPort,
} from './minecraftSkillPointers.js';
import { adoptionTags } from './minecraftStage.js';
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
import { createReflexTimings } from './minecraftReflexTiming.js';
import { createBodyRevisions, createFightOwner, fightCall } from './minecraftFightOwner.js';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { MINECRAFT_SPAWN_GRACE_MILLISECONDS, type MinecraftControl } from './minecraftControl.js';
import { minecraftObservationSummary } from './minecraftObservationSummary.js';
import { stepMetrics } from './minecraftTaskMetrics.js';
import { createPaceLedger } from './minecraftPaceLedger.js';
import { withFailureReview } from './minecraftFailureReview.js';
import { bedDeferredNow } from './minecraftProcedureTool.js';
import { minecraftTransientBody } from './minecraftTransientBody.js';
import { storedBodyResult } from './minecraftStoredResult.js';
import { minecraftRecallCues } from './minecraftRecallCues.js';
import { llmcBodyContext } from './minecraftLlmcContext.js';
import { minecraftMilestones, minecraftPace, waitTimeMilliseconds, withNetherCare } from './minecraftPace.js';
export { minecraftMilestones, minecraftPace, waitTimeMilliseconds, type PaceMilestones } from './minecraftPace.js';

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
  /** The strong model's route plan (`minecraftRouteWiring.ts`, `SHANNON_MINECRAFT_ROUTE_PLAN`): the answer's JSON, or a throw; none when absent. */
  routePlanner?(system: string, input: string, signal: AbortSignal): Promise<unknown>;
  log?(line: string): void;
  /** Where the content-free measurement lines (`minecraftTaskMetrics`: milestones, stage, adoption, gaps) go; the journal when absent. */
  metricsLog?(line: string): void;
  /**
   * SHANNON_MINECRAFT_LLM_CENTRIC (design mb-llm-centric): a reflex session's context carries the plan. The live state and the recall's
   * events are the wrapper's (`withLlmcBody`, `minecraftLlmcBody.ts`). Absent: as before.
   */
  llmc?: { plan(): BodyPlanView | undefined };
}): { body: FcaBodyLifecycle; tools: FcaExternalTools; safeToAcknowledgeStop(): boolean } {
  const { control, runtime, step } = parts, now = parts.now ?? Date.now, limits = { ...DEFAULT_LIMITS, ...parts.limits };
  const governor = parts.governor ?? createReflexGovernor(), monitorAbort = new AbortController(), toolAborts = new Set<AbortController>(),
    claims = new Set<string>();
  const releasedSessions = new Set<string>(), captures = new Map<string, number>(), modes = new Map<string, 'explicit' | 'danger' | 'stuck' | 'visual'>();
  const cleanupListeners = new Set<() => void>();
  const prior = step.snapshot.checkpoint as { fcaToolSelection?: { recentResults?: Array<{ name: string; ok: boolean; summary: string }> } } | null;
  let recentResults = (prior?.fcaToolSelection?.recentResults ?? []).slice(-6).map(value => ({ name: value.name.slice(0, 160), ok: value.ok, summary: value.summary.slice(0, 1000) }));
  // The latest milestones, kept in the task's checkpoint across steps (`minecraftMilestones` key, through this port's `checkpoint`).
  const kept = (step.snapshot.checkpoint as { minecraftMilestones?: unknown } | null)?.minecraftMilestones;
  let milestones = minecraftMilestones({ milestones: kept });
  // Her idle waits in this task, kept in the checkpoint as the milestones are (`minecraftIdleWaitMs`).
  const keptWait = Number((step.snapshot.checkpoint as { minecraftIdleWaitMs?: unknown } | null)?.minecraftIdleWaitMs ?? 0);
  let idleWaitMs = Number.isSafeInteger(keptWait) && keptWait > 0 ? keptWait : 0, pendingWaitMs = 0;
  // Her sheep search that found none, kept in the checkpoint for the rest of that day (`minecraftNoSheepDarkIn`, `bedSearchMemory`).
  const marks = step.snapshot.checkpoint as { minecraftNoSheepDarkIn?: unknown; minecraftVillageSearched?: unknown; minecraftRoute?: unknown;
    minecraftRouteAsks?: unknown } | null,
    bedSearch = bedSearchMemory(marks?.minecraftNoSheepDarkIn, marks?.minecraftVillageSearched),
    // Daytime decisions in a row that went elsewhere than the step now (`minecraftMilestoneFollow.ts`), kept as the marks are.
    follow = milestoneFollowMemory((step.snapshot.checkpoint as { minecraftMilestoneDrift?: unknown } | null)?.minecraftMilestoneDrift,
    decisions => log(`Shannon Minecraft milestone steps task=${step.taskId} decisions=${decisions}`)),
    // Her route to the Nether, planned by a strong model at the task's start and when a step is late (`minecraftRoutePlanner.ts`).
    routePlan = createRoutePlanning({ kept: marks?.minecraftRoute, keptAsks: marks?.minecraftRouteAsks, planner: parts.routePlanner,
      log: line => log(line), taskId: step.taskId });
  // A transient decision's pace beyond `minecraftPace` (`minecraftPaceLedger.ts`), kept in the checkpoint as the above are, and its body state.
  const paceLedger = createPaceLedger({ kept: (step.snapshot.checkpoint as { minecraftPaceLedger?: unknown } | null)?.minecraftPaceLedger,
    began: Date.parse(step.snapshot.task.createdAt), now });
  /** What the last context() read, for the decision that follows: its transient live state and its recall cues (built only if asked). */
  let latest: { transient(): Record<string, unknown>; cues(): ReturnType<typeof minecraftRecallCues> } | null = null;
  let activeAction: NonNullable<BodyTaskContext['taskState']>['activeAction'];
  let started = false, closed = false, unknown = false, attempts = 0, lastEntryAt = -Infinity, stopped = false;
  // mb-r21 (run 21): the body's revision moves for every touch of the body, her tool being cut off ("hard") or only a reflex acting
  // beside it ("soft"); a fight she chose goes on past soft touches (`guardFor`) and the fast judgment leaves it to her (`fightOwned`).
  const revisions = createBodyRevisions(), fightOwner = createFightOwner(now), fightOwned = () => fightOwner.owned();
  let execution: ActionExecution | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let monitoring: Promise<void> | null = null, active: Promise<ReflexSessionReceipt | null> | null = null, fault: unknown;
  let lastSignature = '', lastSequence = -1, lastFastSequence = -1;
  // The body tools named by the gists the latest decision was shown (`minecraftSkillContext`), by skill.
  let gistTools: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  // The skills pointed at the latest decision and her stage then, for the content-free adoption line (`adoptionTags`).
  let pointedSkills: readonly string[] = [], stageNow: number | null = null;
  // Before the task's first decision (none in its history, no call noted yet) a reflex starts on its own only for concrete danger
  // seen in `REFLEX_DANGER_FRAMES` frames in a row; never for `stuck` or `visual`. What held it back is told to the Observer once.
  let decided = step.snapshot.history.length > 0 || recentResults.length > 0, dangerFrames = 0, held = '';
  const spawnGrace = parts.spawnGraceMilliseconds ?? MINECRAFT_SPAWN_GRACE_MILLISECONDS, log = parts.log ?? ((line: string) => console.info(line)),
    timings = createReflexTimings({ task: step.taskId, now, log, held: !!parts.fastJudgment }); // ADR-0014 D8: when each stage happened
  // Measurement only (observation redesign P1): it reads this body's frames and writes journal lines; no decision depends on it.
  // mb-r25: every frame also tells the route whether its step is late now (`minecraftRouteWatch.ts`), not only the decisions.
  const metrics = stepMetrics(step, now, parts.metricsLog, routeWatcher({ plan: routePlan, createdAt: step.snapshot.task.createdAt, now }));
  const measured = (work: () => void) => { try { work(); } catch { /* measuring never fails a step */ } };
  // To the Observer (its sidecar, kept 15 minutes) and, with the fast judgment on, content-free to the journal too: the Minebot lane
  // looked for the governor's holds there after run 11 and found none. With the switch off nothing new is written (main, unchanged).
  const hold = (reason: string, detail: Record<string, string | number | boolean | null> = {}) => {
    if (held !== reason) {
      observerHandoff('bodyObserve', 'reflex', { phase: 'entry_held', reason, ...detail });
      timings.held(reason, detail);
    }
    held = reason;
  };
  const leaseMatches = () => !!execution && execution.lease.id === step.lease.id && execution.lease.holder === step.lease.holder && execution.lease.generation === step.lease.generation;
  const live = () => leaseMatches() && parts.ownerAlone() && parts.sourcesVisible() && !monitorAbort.signal.aborted
    && runtime.get(step.scopeKey, step.taskId)?.phase === 'executing';
  const bound = () => control.store.body(step.taskId), availableBody = () => bound() ?? (control.available().length === 1 ? control.available()[0]! : null);
  const context = (bodyId: string, sessionId: string): BodyTaskContext => ({ scopeKey: step.scopeKey, taskId: step.taskId,
    taskRevision: step.revision, bodyId, sessionId, generation: step.lease.generation,
    goal: step.snapshot.task.goal, completionCondition: step.snapshot.task.completionCriteria,
    taskState: { phase: runtime.get(step.scopeKey, step.taskId)?.phase ?? 'unknown', progress: step.snapshot.task.summary.slice(0, 2000),
      ...(activeAction ? { activeAction } : {}), recentResults }, ...(parts.llmc ? { plan: parts.llmc.plan() } : {}) });
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
          const receipt = await timings.around(operation.context.sessionId, operation.candidate.operation, () => control.command({
            id: `reflex:${hash(operation.operationId)}`, context: operation.context, lease, kind: 'reflex', operation,
            milliseconds: Math.max(1, Date.parse(operation.deadlineAt) - now()) }, signal));
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
    if (interrupting) revisions.hard();
    modes.set(request.context.sessionId, mode); toolAborts.forEach(abort => abort.abort());
    const job = timings.session(request.context.sessionId, mode).track(controller.run(request, signal));
    if (entry) governor.began(step.taskId, now(), entry);
    // Effective: a body action completed in it. A session that only observed and returned is followed by its mode's cooldown.
    const ended = (effective: boolean) => { if (entry) governor.ended(step.taskId, now(), entry, effective); };
    const touched = () => { if (!interrupting) revisions.soft(); };
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
    activeAction: () => activeAction, interrupt: reason => toolAborts.forEach(abort => abort.abort(reason)), fightOwned,
    touched: () => { revisions.soft(); }, stepOutcome: value => { execution!.stepOutcome = value; }, unknown: () => { unknown = true; },
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
    const bodyId = bound(), observation = timings.seen(bodyId ? control.observe(bodyId) : null);
    // The image-free fast judgment comes first and needs no picture (ADR-0011 stage 2, run 11).
    if (fast && bodyId && observation && observation.sequence !== lastFastSequence) {
      lastFastSequence = observation.sequence;
      const job = fast.consider(bodyId, observation, live, monitorAbort.signal);
      if (job) return startFast(job);
    }
    // The LLM-centric mode has no reflex session of the head (design mb-llm-centric 2.4, contract 6: the body's own reflexes stay, the
    // head's fast judgment and image reflex go). Run 27 (2026-10-22): with the fast judgment off, a `stuck` or `danger` frame still
    // entered this image reflex: a stop that cut her act, captures, gpt-6-luna-decisions three times with no answer, and a release.
    if (parts.llmc || !parts.entry || !parts.selector || attempts >= 4) return;
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
    if (!closed) measured(() => { const id = bound(), frame = id ? control.observe(id) : null; if (frame) metrics.sample(frame); });
    if (monitoring || closed) return;
    const job = tick(); monitoring = job;
    void job.catch(error => { if (!monitorAbort.signal.aborted) fault = error; }).finally(() => { if (monitoring === job) monitoring = null; });
  };
  const safe = () => !unknown && control.store.safe(step.taskId);
  // A body tool that changes something (not read-only), named by a gist the deciding step was shown; learning never fails a step.
  const noteGistFollowed = (name: string, input: unknown) => {
    const id = availableBody();
    const skill = id ? control.frame(id)?.poll.skills?.find(item => `mc.${item.name}` === name) : undefined;
    const followed = parts.gistFollowed && skill && !skill.readOnly ? followedGists(gistTools, name) : [];
    // Content-free: which branch applied to a call made while a gist was shown (a tool name and skill names, never a gist).
    if (gistTools.size) {
      const line = gistFollowLine(step.taskId, { name, input }, gistTools, { port: !!parts.gistFollowed, skill, followed });
      try { log(line); } catch { /* logging never fails a step */ }
    }
    for (const gist of followed) {
      try { parts.gistFollowed!(gist); } catch { /* learning never fails a step */ }
    }
  };
  // A call that matches what a pointed skill is about (a tool and an argument, `ADOPTIONS`): a closed tag, never her content. Measuring only.
  const noteStageAdoption = (call: { name: string; input: unknown }) => {
    if (!pointedSkills.length) return;
    for (const { skill, tag } of adoptionTags(pointedSkills, call)) {
      const line = `Shannon Minecraft stage adoption task=${step.taskId} stage=${stageNow ?? '-'} skill=${skill} tag=${tag} tool=${call.name}`;
      try { log(line); } catch { /* logging never fails a step */ }
    }
  };
  const body: FcaBodyLifecycle = {
    start(signal) {
      if (started) return; started = true; execution = currentActionExecution();
      const cancel = () => { stopped = true; monitorAbort.abort(); toolAborts.forEach(abort => abort.abort()); const id = bound(); if (id) controller.cancel(step.scopeKey, id); control.cancelTask(step.taskId); };
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      cleanupListeners.add(() => signal.removeEventListener('abort', cancel));
      timer = setInterval(poll, parts.pollMilliseconds ?? 250); timer.unref(); poll();
    },
    revision: () => revisions.revision,
    settling: () => !!availableBody() && control.settling(availableBody()!, spawnGrace),
    // A bounded summary: each decision's message stays in the task's history; `minecraft.observe` reads the whole frame.
    context: () => {
      if (parts.llmc) return llmcBodyContext({ observation: bound() ? control.observe(bound()!) : null, step, recentResults, now: now(), milestones, idleWaitMs,
        revision: revisions.revision, keep: value => { latest = value; } });
      const observation = live() && bound() ? control.observe(bound()!) : null;
      // From three failed steps in a row the decision looks back before it acts, and before the task may stop (`minecraftFailureReview.ts`).
      const pace = withFailureReview(minecraftPace(step, recentResults, now(), milestones, idleWaitMs), recentResults);
      const recentIdleWaits = recentResults.filter(result => result.name === 'mc.wait-time' && result.ok).length;
      // mb-r24: with the Nether's first seconds and the digs that keep failing there among the lines every decision carries.
      const situation = withNetherCare(routePlan.situate(follow.situate(minecraftSituation(observation, {
        ...pace, recentIdleWaits, ...bedSearch.facts(observation), bedDeferred: bedDeferredNow(step.taskId, observation),
        elapsedSeconds: Math.max(0, (now() - Date.parse(step.snapshot.task.createdAt)) / 1000) })), observation?.state.world),
      observation, recentResults, bound() ? control.arrivedAt?.(bound()!) ?? null : null, now());
      const skills = minecraftSkillContext(situation, parts.skillNames?.() ?? new Set(), parts.skillGists);
      gistTools = skills.gistTools;
      pointedSkills = skills.pointed;
      stageNow = situation.stage;
      const summary = observation ? minecraftObservationSummary(observation) : null;
      measured(() => metrics.context(observation, summary, skills.fields));
      // Built only if the decision is transient (`transient()` below); the legacy decision reads the summary above, as before.
      latest = { transient: () => minecraftTransientBody({ observation, pace, fields: skills.fields, ledger: paceLedger }),
        cues: () => minecraftRecallCues(observation, situation, recentResults) };
      return { revision: revisions.revision, observation: summary, pace, ...skills.fields };
    },
    transient: () => latest?.transient() ?? {},
    recallCues: () => latest?.cues() ?? { words: [], tags: [] },
    storedResult: (call, text) => storedBodyResult(call.name, text),
    async guard(version) { if (active) await active; if (fault) throw fault; if (!safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN'); return revisions.current(version); },
    /** A fight she chose goes on when only reflexes touched the body since the decision (not when her own tool was cut off): the fight is hers. */
    async guardFor(version, call) {
      if (active) await active;
      if (fault) throw fault;
      if (!safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
      // The LLM-centric mode: the body checks each hand of an act against the world as it is then and stops at the first that does not
      // fit, so only a cut of her own tool makes the decision stale (run 27: ten acts came back "身体の状態が変わりました" while she drowned).
      if (revisions.current(version) || (parts.llmc && call.name.startsWith('mc.') && revisions.current(version, true))) return true;
      if (!fightCall(call.name)) return false;
      fightOwner.claim();
      const kept = revisions.current(version, true);
      measured(() => log(`Shannon Minecraft fight kept task=${step.taskId} tool=${call.name} touches=${revisions.since(version)} kept=${kept}`));
      return kept;
    },
    toolSignal(name, parent) {
      if (!name.startsWith('mc.')) return parent;
      const id = availableBody(); if (id && live()) control.store.bind(step.taskId, id);
      const abort = new AbortController(); toolAborts.add(abort);
      const cancel = () => abort.abort(); parent.addEventListener('abort', cancel, { once: true });
      cleanupListeners.add(() => parent.removeEventListener('abort', cancel));
      // A tool cut off by a session in progress leaves the decision stale even when the session itself touches nothing.
      if (active) revisions.hard();
      if (parent.aborted || active) abort.abort();
      return abort.signal;
    },
    noteCall(call, operationId) {
      decided = true;
      governor.decided(step.taskId, now());
      measured(() => metrics.noteCall(call.name, call.input, gistTools));
      follow.note(call);
      if (!call.name.startsWith('mc.')) return;
      if (fightCall(call.name)) fightOwner.began();
      // Not for a call a session in progress cuts off (`toolSignal` aborts it before it runs): that is no use of the gist.
      if (!active && !closed) noteGistFollowed(call.name, call.input);
      if (!active && !closed) noteStageAdoption(call);
      // Registered tools already bound inputs to 32K; malformed inputs are still only inert context.
      const encoded = JSON.stringify(call.input);
      activeAction = { name: call.name, operationId, input: encoded && encoded.length <= 32_000 ? JSON.parse(encoded) : null };
      pendingWaitMs = call.name === 'mc.wait-time' ? waitTimeMilliseconds(call.input) : 0;
    },
    noteResult(call, result, durationMilliseconds) {
      measured(() => paceLedger.note(call, { ok: result.ok, failure: result.failure ?? null, bodyReflex: result.bodyReflex === true },
        durationMilliseconds ?? 0));
      if (activeAction?.name === call.name) activeAction = undefined;
      if (fightCall(call.name)) fightOwner.ended();
      if (call.name === 'mc.goal-evidence' && result.ok) milestones = minecraftMilestones(result.text) ?? milestones;
      if (call.name === 'mc.wait-time' && result.ok) idleWaitMs = Math.min(idleWaitMs + pendingWaitMs, 86_400_000);
      pendingWaitMs = 0;
      bedSearch.note(call, result, () => live() && bound() ? control.observe(bound()!) : null);
      recentResults = [...recentResults, { name: call.name, ok: result.ok, summary: result.text.slice(0, 1000) }].slice(-6);
    },
    async close() {
      measured(() => metrics.flush());
      // The route's request goes on past the step (it is the task's, `createRoutePlanning`); only a task stopped or cancelled ends it
      // (`stopped`, set by the step's own abort). It was `monitorAbort.signal.aborted`, which the first close of a step itself sets:
      // a step is closed twice (the runner's `closeMs` and its `finally`), and the second close ended the request every time (run 21:
      // three of four requests aborted at the step's end, the first plan came at 34 s, the late one never).
      const route = routePlan.close(stopped).catch(() => {});
      measured(() => log(`Shannon Minecraft route close task=${step.taskId} stopped=${stopped} first=${!closed}`));
      if (!closed) { closed = true; if (timer) clearInterval(timer); cleanupListeners.forEach(remove => remove()); cleanupListeners.clear(); monitorAbort.abort(); await controller.close(); }
      if (monitoring) await monitoring.catch(() => {}); if (active) await active;
      await route;
      if (!safe()) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
    },
  };
  const definition = { name: 'minecraft.reflex', description: '現在のタスクの目的で、一人称画像を更新しながら短い身体操作を選ぶ。最新状態と結果を返し、長期計画はここで立てない。',
    input: EMPTY, domain: 'minecraft_body' as const, effect: 'write' as const, cost: 'model' as const,
    audiences: ['owner_alone' as const], surfaces: ['text' as const] };
  // Offered only while the body can give a picture: every session requires one (`imagesUnavailable`).
  const offered = !!parts.selector && !!availableBody() && !!control.frame(availableBody()!) && !control.imagesUnavailable(availableBody()!);
  const tools: FcaExternalTools = { definitions: offered ? [definition] : [],
    checkpoint: () => ({ ...(milestones ? { minecraftMilestones: milestones } : {}), ...(idleWaitMs ? { minecraftIdleWaitMs: idleWaitMs } : {}),
      ...bedSearch.checkpoint(), ...follow.checkpoint(), ...routePlan.checkpoint(),
      ...(() => { try { return metrics.checkpoint(); } catch { return {}; } })(),
      ...(() => { try { return paceLedger.checkpoint(); } catch { return {}; } })() }),
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
