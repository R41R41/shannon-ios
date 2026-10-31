import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { judge, loadFixtures, loadFolder, type Fixtures, type RunMeta, type Verdict } from '../../../../tools/continue-verify/judge.js';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import { aggregateGoal, type BodyTimes, type GoalOutcome, type InventoryEvent, type ItemOutcome, type RunEnd } from '../../src/contracts/continueContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt, MinecraftControlReply } from '../../src/contracts/minecraftControlContract.js';
import { DecisionRecorder } from '../../src/infra/decisionRecords/decisionRecorder.js';
import { installDecisionRecorder, recordRequest, recordResponse } from '../../src/infra/decisionRecords/decisionRecordNotes.js';
import { readRun } from '../../src/infra/decisionRecords/decisionRecordRead.js';
import { withDecisionScope } from '../../src/infra/decisionRecords/decisionRecordScope.js';
import { runName } from '../../src/infra/decisionRecords/decisionRecordStore.js';
import { MinecraftControl } from '../../src/surfaces/minecraft/minecraftControl.js';
import { forgetCleanups } from '../../src/surfaces/minecraft/minecraftControlRecovery.js';
import { forgetLlmcEvents } from '../../src/surfaces/minecraft/minecraftLlmcBody.js';
import { forgetLlmcQueues, type LlmcQueue, type QueueAdd } from '../../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { forgetActNodes } from '../../src/surfaces/minecraft/minecraftLlmcNode.js';
import { forgetOnceFacts } from '../../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { forgetFirstPlans } from '../../src/surfaces/minecraft/minecraftFirstPlan.js';
import { MinecraftControlStore } from '../../src/surfaces/minecraft/store/minecraftControlStore.js';
import type { ActInput } from '../../src/contracts/minecraftActContract.js';
import { createFcaHistoryAhead } from '../../src/mind/action/fca/fcaHistory.js';
import { llmcStepParts } from '../../src/wiring/minecraftLlmcWiring.js';
import { fcaMinecraftTools } from '../../src/wiring/fcaMinecraftTools.js';
import { inActionExecution } from '../../src/infra/context/actionExecution.js';
import type { ToolResult } from '../../src/mind/tools/toolRegistryPorts.js';

/**
 * The bench C of the continue contract (chapter 10): the head is the head's code, the model is a script, the body is a stand-in.
 *
 * - **The head** is what production makes of a body task's step (`llmcStepParts`): the real `MinecraftControl` over a real store (`node:sqlite`, in memory), the real
 *   queue, the plan tools and the ledger's one way in, the decision record (`DecisionRecorder`, in a temporary folder), the receipt box. A head restart is a new
 *   control (another `headBoot`) on the same database and a new set of step parts made from the plan's saved checkpoint, as a restarted process would have.
 * - **The model** is the test: `decide()` opens a decision as the runner does (a request that reads the results the queue gives, its answer), and what the test does
 *   inside it (`queue.add`, `plan.update`) is that decision's calls.
 * - **The body** is `BodyDouble`: it polls the head, takes the commands it is handed, and answers as the test scripts it: receipts it returns, holds back, returns twice,
 *   delays; a connection cut and made again; a restart of the body; a lease that was changed. Its receipts are built from the body's real outputs (`produced/`, made at body
 *   revision 100a80f68157) or from the fixtures' `input` and `expected`; what the body would decide (which waiting item it drops, which it starts) is the script's, and
 *   each scene says which fixture it follows. It writes the body's own records the judge reads (`body-trace.jsonl`: `hand_start`, `op`, `poll`; `receipts.jsonl`).
 * - `collect()` writes the folder `tools/continue-verify/judge.ts` reads, and `judged()` reads it back and judges it.
 */
export const RUN_BODY = 'minecraft:world';
/** The body revision the `produced/` files were made at (the body's `contracts/continue/produced/`); the stand-in answers as that body does. */
const producedIndex = JSON.parse(readFileSync(new URL('../fixtures/continue/produced/PRODUCED.json', import.meta.url), 'utf8')) as { madeBy: string };
// Keep the producer's actual spelling (short or full SHA), verified against the canonical commit.
export const PRODUCED_REV = (JSON.parse(readFileSync(new URL('../fixtures/continue/produced/catalog.json', import.meta.url), 'utf8')) as { bodyRevision: string }).bodyRevision;
if (!/^[a-f0-9]{7,40}$/u.test(PRODUCED_REV) || !producedIndex.madeBy.startsWith(PRODUCED_REV)) throw new Error('the produced catalog revision is not the indexed body');
const FIXTURES_DIR = new URL('../fixtures/continue/', import.meta.url);
export const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES_DIR), 'utf8')) as Record<string, any>;
export const produced = (name: string) => {
  const found = JSON.parse(readFileSync(new URL(`produced/${name}.json`, FIXTURES_DIR), 'utf8')) as Record<string, any>;
  if (found.bodyRevision !== PRODUCED_REV) throw new Error(`the body's produced file ${name} was made at ${String(found.bodyRevision)}, not ${PRODUCED_REV}`);
  return found;
};
const LOOSE = { type: 'object', properties: {}, required: [], additionalProperties: false };
export const iso = (at: number = Date.now()) => new Date(at).toISOString();
export async function until(condition: () => boolean, ms = 4_000, step = 5): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += step) { if (condition()) return true; await delay(step); }
  return condition();
}

// ---- what a script says of a hand, an event, a receipt -------------------------------------------------------------------------------------
export interface EventSpec { item: string; count: number; reason: InventoryEvent['reason']; intermediate?: boolean }
export interface HandSpec {
  do: string; i?: number; status?: 'done' | 'stopped' | 'failed' | 'skipped'; goal: GoalOutcome; end?: RunEnd; line?: string; code?: string; cutBy?: string; pass?: number; motorOps?: number;
  events?: EventSpec[]; progress?: Record<string, unknown>;
  /** A line as the body really wrote it (a `produced/` file): taken as it is, with `i` set. */
  raw?: Record<string, unknown>;
}
export interface FinishSpec {
  outcome?: MinecraftControlReceipt['outcome']; hands: HandSpec[];
  unit?: Partial<ItemOutcome>; failureType?: string; stoppedBy?: string;
  /** How many events the receipt carries itself; the rest are fetched by pages (`eventsMore`). Default: all. */
  inline?: number;
  /** The receipt is kept from the head until `release()`. */
  hold?: boolean;
  bodyTimes?: Partial<BodyTimes>;
  /** More fields of the result (a handover, ...). */
  result?: Record<string, unknown>;
  /** The inventory after (default: the events applied to it). */
  inventory?: Record<string, number>;
  /** Do not write `hand_start` lines (a receipt the body gave without running). */
  noTrace?: boolean;
}

interface Entry { command: MinecraftControlCommand; acceptedAt: string; startedAt?: string; state: 'waiting' | 'running' | 'cutting' | 'ended'; exec: number; life: number; headBoot: string | undefined; events: InventoryEvent[] }
interface Outgoing { receipt: MinecraftControlReceipt; hold: boolean; log: boolean; tries: number }
const lifeOf = (command: MinecraftControlCommand): number => command.queue?.madeIn?.life ?? command.context.life ?? 0;

export interface BodyLooks { life?: number; position?: { x: number; y: number; z: number }; hp?: number; hunger?: number; dimension?: string; utilities?: unknown; scan?: unknown }

/** The stand-in body: it keeps what the real one keeps of the commands it was handed, and answers as the script says. */
export class BodyDouble {
  connectionId = 'connection-1';
  bodyBoot = 'bb-1';
  sequence = 0;
  inventory: Record<string, number> = {};
  looks: Required<Pick<BodyLooks, 'life' | 'position' | 'hp' | 'hunger' | 'dimension'>> & Pick<BodyLooks, 'utilities' | 'scan'> = { life: 3, position: { x: 0.5, y: 64, z: 0.5 }, hp: 20, hunger: 20, dimension: 'overworld' };
  readonly entries = new Map<string, Entry>();
  readonly outbox: Outgoing[] = [];
  readonly handed: MinecraftControlCommand[] = [];
  readonly replies: MinecraftControlReply[] = [];
  readonly cancelled: string[] = [];
  readonly receiptLog: Array<Record<string, unknown>> = [];
  readonly trace: Array<Record<string, unknown>> = [];
  readonly pollErrors: string[] = [];
  /** The body's record of the inventory events of the commands it ran (the internal `events` command is answered from it); lost at a restart of the body. */
  private records = new Map<string, InventoryEvent[]>();
  private reflexEvents: unknown[] = [];
  private eventSeq = 0;
  private reflexSeq = 0;
  private lastHeadBoot: string | null = null;
  private firstPollOfConnection = true;
  private ackLosses = 0;
  private execs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** What the body does when a new `headBoot` is registered: cut the old head's commands (the contract) or leave them. */
  cutsOldHeadBoot = true;
  /** How long the cut of a running item takes (its receipt comes after this, the stop's proof may come before it). */
  cutDelayMs = 0;
  /** The reason the body gives for what the head cancels (a lease the body knows is gone is `lease_expired`). */
  cancelCode: 'cancelled' | 'lease_expired' = 'cancelled';
  /** What the body answers a stop with: `prove` (a receipt that proves the release), `late` (when `answerStop()` is called), `never`. */
  stopMode: 'prove' | 'late' | 'never' = 'prove';
  private lateStops: MinecraftControlCommand[] = [];
  /**
   * Amendment A-12 (the stand-in of the body's `utils/incidents.ts` and of its control loop, at body revision 100a80f68157): the hold it keeps (the head's id for a take, a failure's for its own), the sessions a
   * release closed (a release closes the session it names; a later act of it is refused as `BODY_COMMAND_REFUSED`), what the world allows (`canFreeze`: false is a server with someone else on it), and what
   * the head asked (`takes`) and was refused (`refused`).
   */
  incidentHold: { id: string; task: string; why: string; frozen: boolean } | null = null;
  canFreeze = true;
  /** A body before the take (or before incidents): a release naming one is answered with no `incident` in its result. */
  incidentsSupported = true;
  readonly closedSessions = new Set<string>();
  readonly takes: Array<{ id: string; why: string; notes: string[] | undefined; session: string; command: string }> = [];
  readonly releases: Array<{ command: string; session: string; incident: unknown }> = [];
  readonly refused: Array<{ command: string; session: string; because: 'held' | 'closed_session' }> = [];
  /** The world's clock: stands still while a hold has frozen it. */
  frozenNow(): boolean { return this.incidentHold?.frozen === true; }
  /** Whether the body answers the head's internal `events` command (`silent`: it gets it and says nothing). */
  eventsMode: 'answer' | 'silent' = 'answer';
  /** Receipts the head did not take for another connection's command are told once to the log and then dropped. */
  paused = false;

  constructor(private readonly bench: BenchC) {
    this.trace.push({ kind: 'trace_open', at: iso(), source: 'continuous', bodyBoot: this.bodyBoot });
  }

  // ---- the polling -----------------------------------------------------------------------------------------------------------------------
  start(everyMs = 4): void {
    this.stop();
    this.timer = setInterval(() => { if (!this.paused && !this.busy) this.poll(); }, everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  observation(): BodyObservation {
    const { life, position, hp, hunger, dimension, utilities, scan } = this.looks;
    const at = iso();
    return { schemaVersion: 1, bodyId: RUN_BODY, sequence: this.sequence, stateAt: at, receivedAt: at, connected: true,
      state: { world: { position, health: hp, food: hunger, dimension, inventory: { ...this.inventory }, ...(utilities !== undefined ? { utilities } : {}), ...(scan !== undefined ? { scan } : {}) },
        ...(this.incidentHold ? { incidentHold: { id: this.incidentHold.id, task: this.incidentHold.task, why: this.incidentHold.why } } : {}),
        life: { life, alive: true, since: at, dimension, dimensionSince: this.bench.dimensionSince, deathEpoch: 'de-bench', deathSeq: 0 },
        bodyRun: { bodyBoot: this.bodyBoot, connectionId: this.connectionId } },
      facts: { alive: true, dimension, life } } as unknown as BodyObservation;
  }
  /** The next observation's number (an event of the body points at the observation just after it). */
  nextSeq(): number { return this.sequence; }

  payload(): MinecraftControlPoll {
    const receipts = this.outbox.filter(out => !out.hold).map(out => out.receipt);
    // A receipt kept from the head (the script holds it) is a command the head has not heard has ended: the body's polls still list it as running.
    const held = new Set(this.outbox.filter(out => out.hold).map(out => out.receipt.id));
    const active = [...this.entries.values()].filter(entry => entry.state === 'running' || entry.state === 'cutting' || held.has(entry.command.id)).map(entry => entry.command.id);
    const queued = [...this.entries.values()].filter(entry => entry.state === 'waiting').map(entry => entry.command.id);
    const events = this.reflexEvents.length ? { events: this.reflexEvents.slice(0, 32) } : {};
    return { schemaVersion: 1, serverId: 'world', connectionId: this.connectionId, observation: this.observation(), candidates: [],
      skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: LOOSE }, { name: 'events', description: 'events', readOnly: true, inputSchema: LOOSE },
        { name: 'view', description: 'view', readOnly: true, inputSchema: LOOSE }],
      receipts, activeOperationIds: active, queuedOperationIds: queued, bodyVersion: { revision: PRODUCED_REV, catalogHash: 'bench-c' }, ...events } as unknown as MinecraftControlPoll;
  }

  /** One poll to the head: the receipts it holds, what it runs; the reply's commands are taken, its acknowledgements settle the outbox (unless the script loses them). */
  poll(options: { loseAck?: boolean; twice?: boolean } = {}): MinecraftControlReply | null {
    this.busy = true;
    try {
      const payload = this.payload();
      this.sequence += 1;
      const first = this.firstPollOfConnection;
      this.firstPollOfConnection = false;
      this.trace.push({ kind: 'poll', at: iso(), connectionId: this.connectionId, ...(first ? { first: true } : {}) });
      for (const receipt of payload.receipts) {
        const out = this.outbox.find(item => item.receipt === receipt);
        if (out) out.tries += 1;
        if (out?.log) this.receiptLog.push(this.logOf(receipt, payload));
      }
      let reply: MinecraftControlReply | null = null;
      try { reply = this.bench.control().poll({ scopeKey: 'owner', deviceId: 'minebot' }, payload); } catch (error) { this.pollErrors.push(String((error as Error).message ?? error)); return null; }
      if (options.twice) {
        // The same request again (a retry): the head refuses a frame it already has, and takes nothing twice.
        for (const receipt of payload.receipts) { const out = this.outbox.find(item => item.receipt === receipt); if (out?.log) this.receiptLog.push(this.logOf(receipt, payload)); }
        try { this.bench.control().poll({ scopeKey: 'owner', deviceId: 'minebot' }, payload); } catch (error) { this.pollErrors.push(String((error as Error).message ?? error)); }
      }
      if (options.loseAck) { this.ackLosses += 1; this.takeReply({ ...reply, acknowledged: [] }); } else this.takeReply(reply);
      return reply;
    } finally { this.busy = false; }
  }
  private logOf(receipt: MinecraftControlReceipt, payload: MinecraftControlPoll): Record<string, unknown> {
    const entry = this.entries.get(receipt.id);
    const result = receipt.result ? safeJson(receipt.result) : null;
    return { id: receipt.id, connectionId: receipt.connectionId, outcome: receipt.outcome, inputsReleased: receipt.inputsReleased, observedAt: receipt.observedAt,
      ...(receipt.result !== undefined ? { result: receipt.result } : {}), ...(receipt.failureType ? { failureType: receipt.failureType } : {}),
      ...(receipt.unit ? { unit: receipt.unit } : {}), ...(receipt.bodyTimes ? { bodyTimes: receipt.bodyTimes } : {}),
      ids: { run: this.bench.run, command: receipt.id, life: entry?.life ?? this.looks.life, obsSeq: payload.observation.sequence, obsAt: payload.observation.stateAt },
      ...(result && Array.isArray(result.lines) ? { lines: result.lines } : {}), ...(result?.handover ? { handover: result.handover } : {}),
      delivery: { pollId: `${this.connectionId}#${payload.observation.sequence}`, at: iso() } };
  }

  private takeReply(reply: MinecraftControlReply): void {
    this.replies.push(reply);
    for (const id of reply.acknowledged) {
      const index = this.outbox.findIndex(out => out.receipt.id === id);
      if (index >= 0) this.outbox.splice(index, 1);
    }
    if (reply.headBoot !== this.lastHeadBoot) {
      const before = this.lastHeadBoot;
      this.lastHeadBoot = reply.headBoot;
      if (before !== null && this.cutsOldHeadBoot) this.cutOldHead(reply.headBoot);
    }
    if (reply.eventsThrough !== undefined) this.takeSentEvents(reply.eventsThrough);
    for (const id of reply.cancel) this.cancelOne(id);
    for (const command of reply.commands) this.accept(command);
  }

  // ---- the commands the head hands in -------------------------------------------------------------------------------------------------------
  private accept(command: MinecraftControlCommand): void {
    if (this.handed.some(item => item.id === command.id)) return;
    this.handed.push(command);
    if (command.kind === 'stop') { this.stopped(command); return; }
    if (command.kind === 'release') { this.releasedBy(command); return; }
    if (command.kind !== 'skill') return;
    if (command.skill === 'events') { if (this.eventsMode === 'answer') this.answerEvents(command); return; }
    if (command.skill !== 'act') return;
    if (this.refuses(command)) return;
    this.entries.set(command.id, { command, acceptedAt: iso(), state: 'waiting', exec: 0, life: lifeOf(command), headBoot: command.queue?.madeIn?.headBoot ?? command.context.headBoot, events: [] });
  }
  private stopped(command: MinecraftControlCommand): void {
    if (this.stopMode === 'never') return;
    if (this.stopMode === 'late') { this.lateStops.push(command); return; }
    this.proveStop(command);
  }
  // ---- amendment A-12: releases, the head's take, the hold ------------------------------------------------------------------------------------
  private sessionKey(command: MinecraftControlCommand): string { return `${command.lease.id}:${command.context.taskId}:${command.context.sessionId}`; }
  /** A release: what runs is cut (unless its session was closed already), the session is closed, and the incident it names is answered in the receipt's result. */
  private releasedBy(command: MinecraftControlCommand): void {
    const key = this.sessionKey(command);
    if (!this.closedSessions.has(key)) this.cleanupStop();
    this.closedSessions.add(key);
    const named = (command.context as { incident?: { take?: { id?: string; why?: string; notes?: string[] }; resume?: string; cancel?: string } }).incident;
    const incident = named && this.incidentsSupported ? this.incidentAnswer(command, named) : null;
    this.releases.push({ command: command.id, session: command.context.sessionId, incident });
    this.outbox.push({ receipt: { id: command.id, connectionId: this.connectionId, outcome: 'completed', inputsReleased: true, observedAt: iso(), ...(incident ? { result: JSON.stringify({ incident }) } : {}),
      ...(command.stop ? { stop: { bodyId: RUN_BODY, sessionId: command.stop.context.sessionId, generation: command.stop.context.generation, requestId: command.stop.requestId, state: 'stopped', inputsReleased: true, observedAt: iso() } } : {}) },
      hold: false, log: false, tries: 0 });
  }
  /** The body's answer to a release that names an incident (`takeIncident`, `resumeIncident`, `cancelIncident` of the body): the shapes of the docs' `IncidentTakeResult`. */
  private incidentAnswer(command: MinecraftControlCommand, named: { take?: { id?: string; why?: string; notes?: string[] }; resume?: string; cancel?: string }): Record<string, unknown> | null {
    if (named.take) {
      const id = String(named.take.id ?? '');
      this.takes.push({ id, why: String(named.take.why ?? ''), notes: named.take.notes, session: command.context.sessionId, command: command.id });
      const box = `/body/blackbox/${command.context.taskId}/${id.replace(/[^A-Za-z0-9._-]/gu, '_')}.json.gz`, scene = `/body/scenes/${id.replace(/[^A-Za-z0-9._-]/gu, '_')}`;
      if (this.incidentHold?.id === id) return { op: 'take', id, done: true, hold: id, unfreeze: null, held: true, frozen: this.incidentHold.frozen, freeze: 'The game is frozen', box, scene, again: true };
      if (this.incidentHold) return { op: 'take', id, done: false, hold: this.incidentHold.id, unfreeze: null };
      if (!this.canFreeze) return { op: 'take', id, done: true, hold: null, unfreeze: null, held: false, frozen: false, notHeld: 'players are on the server', box, scene };
      this.incidentHold = { id, task: command.context.taskId, why: String(named.take.why ?? ''), frozen: true };
      return { op: 'take', id, done: true, hold: id, unfreeze: null, held: true, frozen: true, freeze: 'The game is frozen', box, scene };
    }
    const op = named.resume ? 'resume' : named.cancel ? 'cancel' : null, id = String(named.resume ?? named.cancel ?? '');
    if (!op) return null;
    if (this.incidentHold && this.incidentHold.id !== id) return { op, id, done: false, hold: this.incidentHold.id, unfreeze: null };
    this.incidentHold = null;
    return { op, id, done: true, hold: null, unfreeze: 'The game is running normally' };
  }
  /** An act the body refuses before it has an entry: its session was closed by a release, or the body is held. */
  private refuses(command: MinecraftControlCommand): boolean {
    const because = this.closedSessions.has(this.sessionKey(command)) ? 'closed_session' as const : this.incidentHold ? 'held' as const : null;
    if (!because) return false;
    this.refused.push({ command: command.id, session: command.context.sessionId, because });
    this.outbox.push({ receipt: { id: command.id, connectionId: this.connectionId, outcome: 'failed', inputsReleased: true, observedAt: iso(), failureType: because === 'held' ? 'held' : undefined,
      result: because === 'held' ? JSON.stringify({ held: `保留中（${this.incidentHold!.id}: ${this.incidentHold!.why}）。再開の命令（resume）が来るまで動かない` }) : 'BODY_COMMAND_REFUSED',
      unit: { goal: 'not_started', end: 'not_run', released: true }, bodyTimes: { acceptedAt: iso(), endedAt: iso() } } as MinecraftControlReceipt, hold: false, log: false, tries: 0 });
    return true;
  }
  /** The stop's receipt proves the release; what waited is dropped and what ran is cut, each with the receipt of its own (`cleanup_stop`). */
  private proveStop(command: MinecraftControlCommand): void {
    this.cleanupStop();
    this.outbox.push({ receipt: { id: command.id, connectionId: this.connectionId, outcome: 'completed', inputsReleased: true, observedAt: iso(),
      stop: { bodyId: RUN_BODY, sessionId: command.stop!.context.sessionId, generation: command.stop!.context.generation, requestId: command.stop!.requestId, state: 'stopped',
        inputsReleased: true, observedAt: iso() } }, hold: false, log: false, tries: 0 });
  }
  /** Answers a stop the script kept (`stopMode: 'late'`). */
  answerStop(): void { for (const command of this.lateStops.splice(0)) this.proveStop(command); }
  /** The body's `cleanup_stop`: running items are cut and waiting ones dropped, each with the receipt a body gives (not held back by anything). */
  private cleanupStop(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === 'ended' || entry.state === 'cutting') continue;
      if (entry.state === 'running') this.finish(entry.command.id, { outcome: 'cancelled', hands: [{ do: 'wait', status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'operator_stop', code: 'cleanup_stop', motorOps: 1 }], unit: { goal: 'partial', end: 'cut' }, stoppedBy: 'cancelled' });
      else this.drop(entry.command.id, 'operator_stop', { failureType: 'queue_dropped', code: 'cleanup_stop' });
    }
  }
  private cutOldHead(headBoot: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.state === 'ended' || !entry.headBoot || entry.headBoot === headBoot) continue;
      if (entry.state === 'running') this.cut(entry.command.id, 'connection_changed');
      else this.drop(entry.command.id, 'connection_changed', { failureType: 'queue_dropped' });
    }
  }
  /** A running item is cut from outside: its receipt (partial, cut, `cutBy`) comes after `cutDelayMs`, and it is `active` until then. */
  private cut(id: string, cutBy: string): void {
    const entry = this.must(id);
    const end = () => { if (entry.state === 'cutting' || entry.state === 'running') this.finish(id, { outcome: 'cancelled', hands: [{ do: 'wait', status: 'stopped', goal: 'partial', end: 'cut', cutBy, motorOps: 1 }], unit: { goal: 'partial', end: 'cut' }, stoppedBy: 'cancelled' }); };
    if (this.cutDelayMs <= 0) { end(); return; }
    entry.state = 'cutting';
    setTimeout(end, this.cutDelayMs).unref?.();
  }
  private cancelOne(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'ended') return;
    this.cancelled.push(id);
    if (entry.state === 'running') this.cut(id, this.cancelCode);
    else this.drop(id, this.cancelCode, { failureType: 'queue_dropped' });
  }
  /** The internal `events` command: a page of the events the body kept for a command, or `lost` (the body restarted). */
  private answerEvents(command: MinecraftControlCommand): void {
    const arguments_ = command.arguments as { command: string; fromSeq: number; max: number };
    const kept = this.records.get(arguments_.command) ?? [];
    const lost = !this.records.has(arguments_.command);
    const total = kept.length, from = Math.max(0, Number(arguments_.fromSeq)), to = Math.min(total, from + Math.max(1, Number(arguments_.max)));
    const page = lost ? { command: arguments_.command, from, to: from, total, nextSeq: total, done: true, lost: true, events: [] }
      : { command: arguments_.command, from, to, total, nextSeq: to, done: to >= total, lost: false, events: kept.slice(from, to) };
    this.outbox.push({ receipt: { id: command.id, connectionId: this.connectionId, outcome: 'completed', inputsReleased: true, observedAt: iso(), result: JSON.stringify(page) }, hold: false, log: false, tries: 0 });
  }

  // ---- the script: start, finish, drop, hold ------------------------------------------------------------------------------------------------
  /** The commands the head handed in that have not ended, in the order they came. */
  waiting(): string[] { return [...this.entries.values()].filter(entry => entry.state === 'waiting').map(entry => entry.command.id); }
  running(): string[] { return [...this.entries.values()].filter(entry => entry.state === 'running').map(entry => entry.command.id); }
  /** The body begins the command (it is `active` in the next polls). */
  begin(id: string): void {
    const entry = this.must(id);
    entry.state = 'running';
    entry.startedAt = iso();
    entry.exec = ++this.execs;
  }
  /** The command ends: its receipt (with its unit and times) goes to the outbox, its hands' starts and operations go to the trace, the inventory follows its events. */
  finish(id: string, spec: FinishSpec): MinecraftControlReceipt {
    const entry = this.must(id);
    if (entry.state === 'waiting') this.begin(id);
    entry.state = 'ended';
    const ran = spec.hands.filter(hand => hand.status !== 'skipped' && hand.goal !== 'not_started');
    const events: InventoryEvent[] = [];
    const lines = spec.hands.map((hand, index) => {
      const i = hand.i ?? index + 1, pass = hand.pass ?? 1;
      const own: InventoryEvent[] = (hand.events ?? []).map((item, at) => ({ id: `${id}:${pass}:${i}:${at + 1}`, obsSeq: this.nextSeq(), item: item.item, count: item.count, reason: item.reason,
        ...(item.intermediate ? { intermediate: true } : {}), deliverySeq: events.length + at }));
      events.push(...own);
      const motorOps = hand.motorOps ?? (hand.goal === 'not_started' || hand.goal === 'already' ? 0 : 1);
      return { ...(hand.raw ?? { line: hand.line ?? `${hand.do} ${hand.goal}` }), i, do: hand.do, status: hand.status ?? (hand.goal === 'done' || hand.goal === 'already' ? 'done' : hand.goal === 'not_started' ? 'skipped' : 'stopped'),
        goal: hand.goal, end: hand.end ?? 'finished', motorOps, ...(hand.code ? { code: hand.code } : {}), ...(hand.cutBy ? { cutBy: hand.cutBy } : {}), ...(hand.pass ? { pass: hand.pass } : {}),
        ...(hand.progress ? { progress: hand.progress } : {}), ...(own.length ? { delta: own } : {}) } as Record<string, unknown>;
    });
    // The events the receipt carries itself and the pages the body keeps for the rest (chapter 3).
    const inline = spec.inline ?? events.length;
    let given = 0;
    for (const line of lines) if (Array.isArray(line.delta)) { const keep = (line.delta as InventoryEvent[]).filter(() => given++ < inline); if (keep.length) line.delta = keep; else delete line.delta; }
    entry.events = events;
    this.records.set(id, events);
    const motorOps = lines.reduce((sum, line) => sum + Number(line.motorOps ?? 0), 0);
    const goal = spec.unit?.goal ?? aggregateGoal(spec.hands.map(hand => ({ goal: hand.goal, motorOps: Number(lines[spec.hands.indexOf(hand)]!.motorOps ?? 0) })), false);
    const unitEnd: RunEnd = spec.unit?.end ?? (spec.hands.some(hand => hand.end === 'cut') ? 'cut' : spec.hands.every(hand => hand.goal === 'not_started') ? 'not_run' : 'finished');
    const unit: ItemOutcome = { goal, end: unitEnd, released: spec.unit?.released ?? true, ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(spec.unit?.droppedBecause ? { droppedBecause: spec.unit.droppedBecause } : {}),
      ...(spec.unit?.keptDespite ? { keptDespite: spec.unit.keptDespite } : {}) };
    const eventsMore = events.length > inline ? { command: id, nextSeq: inline, total: events.length } : undefined;
    const outcome = spec.outcome ?? (goal === 'done' || goal === 'already' ? 'completed' : 'failed');
    const bodyTimes: BodyTimes = { acceptedAt: entry.acceptedAt, ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(motorOps > 0 ? { lockAt: entry.startedAt ?? iso(), firstMotorAt: entry.startedAt ?? iso() } : {}),
      ...(outcome === 'failed' ? { failedAt: iso() } : {}), endedAt: iso(), motorOps, ...spec.bodyTimes };
    if (motorOps === 0 && !spec.bodyTimes?.lockAt && ran.length > 0) bodyTimes.lockAt = entry.startedAt ?? iso();
    const result = JSON.stringify({ v: 1, ok: outcome === 'completed', done: spec.hands.filter(hand => hand.goal === 'done' || hand.goal === 'already').length, of: spec.hands.length, ms: 1500, at: this.looks.position,
      hp: this.looks.hp, food: this.looks.hunger, lines, outcome: { goal, end: unitEnd, life: entry.life }, ...(spec.stoppedBy ? { stoppedBy: spec.stoppedBy } : {}),
      ...(eventsMore ? { eventsMore } : {}), ...(spec.result ?? {}) });
    const receipt: MinecraftControlReceipt = { id, connectionId: entry.command.connectionId, outcome, inputsReleased: true, observedAt: iso(), result,
      unit, bodyTimes, ...(spec.failureType ? { failureType: spec.failureType } : {}), ...(eventsMore ? { eventsMore } : {}) };
    // The inventory is the body's, and it follows the events before the poll that carries the receipt.
    if (spec.inventory) this.inventory = { ...spec.inventory };
    else this.applyEvents(events);
    if (!spec.noTrace) this.traceHands(entry, ran.length ? lines.filter(line => line.status !== 'skipped' && line.goal !== 'not_started') : [], spec);
    this.outbox.push({ receipt, hold: spec.hold === true, log: true, tries: 0 });
    return receipt;
  }
  /** A waiting item the body drops without running it: a receipt with `droppedBecause` and nothing moved. */
  drop(id: string, code: string, options: { item?: { queue: string; item: string }; failureType?: string; hold?: boolean; code?: string } = {}): MinecraftControlReceipt {
    const entry = this.must(id);
    entry.state = 'ended';
    const why = code === 'depends_failed' || code === 'depends_unknown' ? { code, ...(options.item ? { item: options.item } : {}) } : { code };
    const unit: ItemOutcome = { goal: 'not_started', end: 'not_run', released: true, droppedBecause: why as ItemOutcome['droppedBecause'] };
    const text = options.item ? `捨てた: 頼る項目 ${options.item.item} が済んでいない。手は動いていない` : `捨てた: ${code}。手は動いていない`;
    const receipt: MinecraftControlReceipt = { id, connectionId: entry.command.connectionId, outcome: code === 'cancelled' || code === 'operator_stop' || code === 'lease_expired' ? 'cancelled' : 'failed', inputsReleased: true, observedAt: iso(), result: text,
      unit, bodyTimes: { acceptedAt: entry.acceptedAt, endedAt: iso(), motorOps: 0 }, failureType: options.failureType ?? 'queue_dropped' };
    this.records.set(id, []);
    this.outbox.push({ receipt, hold: options.hold === true, log: true, tries: 0 });
    return receipt;
  }
  /** The body did not start the waiting item because its `pre` is false or cannot be told: a receipt of an act that did not start (the body's `precondition`). */
  notStarted(id: string, failureType: 'precondition' | 'precondition_unknown', after?: { queue: string; item: string }): MinecraftControlReceipt {
    const entry = this.must(id);
    entry.state = 'ended';
    const unit: ItemOutcome = { goal: 'not_started', end: 'not_run', released: true, ...(after ? { keptDespite: { item: after, code: 'failed' } } : {}) };
    const receipt: MinecraftControlReceipt = { id, connectionId: entry.command.connectionId, outcome: 'failed', inputsReleased: true, observedAt: iso(), failureType,
      result: `始めなかった: ${failureType === 'precondition' ? '始まりの条件が偽' : '始まりの条件を判定できない'}。手は動いていない`, unit,
      bodyTimes: { acceptedAt: entry.acceptedAt, endedAt: iso(), motorOps: 0 } };
    this.records.set(id, []);
    this.outbox.push({ receipt, hold: false, log: true, tries: 0 });
    return receipt;
  }
  /** Keeps a command's receipt from the head until `release()` (the receipt is already in the outbox). */
  hold(id: string): void { for (const out of this.outbox) if (out.receipt.id === id) out.hold = true; }
  release(id: string): void { for (const out of this.outbox) if (out.receipt.id === id) out.hold = false; }
  /** A reflex ate or armoured outside any act: the body's working event `inventory.changed` (id `reflex:<connection>:<seq>`), the inventory following it. */
  reflexEvent(item: string, count: number, reason: InventoryEvent['reason'] = 'reflex_eat', id?: string): InventoryEvent {
    const event: InventoryEvent = { id: id ?? `reflex:${this.connectionId}:${++this.reflexSeq}`, obsSeq: this.nextSeq(), item, count, reason };
    this.applyEvents([event]);
    this.reflexEvents.push({ seq: ++this.eventSeq, at: iso(), kind: 'inventory.changed', subject: item, data: { id: event.id, item, count, reason, obsSeq: event.obsSeq } });
    return event;
  }
  /** The events a poll carried are the head's (`eventsThrough`); the body drops them once taken. */
  takeSentEvents(through: number): void { this.reflexEvents = this.reflexEvents.filter(event => (event as { seq: number }).seq > through); }

  // ---- the faults ---------------------------------------------------------------------------------------------------------------------------
  /** The connection is cut and made again: a new connection id and a new numbering; the running and waiting items of the old connection are the old connection's. */
  reconnect(): string {
    this.connectionId = `connection-${Number(this.connectionId.split('-')[1]) + 1}`;
    this.sequence = 0;
    this.firstPollOfConnection = true;
    for (const entry of this.entries.values()) {
      if (entry.state === 'ended') continue;
      // The body keeps its running item stopped by the cut (inputs released); a waiting item of the old connection is dropped `connection_changed`.
      if (entry.state === 'running') { entry.state = 'ended'; } else this.drop(entry.command.id, 'connection_changed', { failureType: 'queue_dropped' });
    }
    // A receipt of the old connection cannot go on the new one: the head refuses a poll that carries one (`validControlPoll`: a receipt's connection is the poll's). The body made
    // them, so the body's record has them (undelivered); the head never does.
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const out = this.outbox[index]!;
      if (out.receipt.connectionId === this.connectionId) continue;
      if (out.log && out.tries === 0) this.receiptLog.push({ ...this.logOf(out.receipt, { observation: { sequence: this.sequence, stateAt: iso() } } as MinecraftControlPoll), delivery: { undelivered: 'connection_changed', at: iso() } });
      this.outbox.splice(index, 1);
    }
    return this.connectionId;
  }
  /** The body dropped its record of a command's events without restarting (the cap on unacknowledged events): the `events` command is answered `lost: true`. */
  forgetEvents(id: string): void { this.records.delete(id); }
  /** The body process restarts: a new boot and connection; what it ran and what it held are gone with it, and so is its record of the events it had not delivered. */
  restart(): void {
    for (const entry of this.entries.values()) entry.state = 'ended';
    this.outbox.length = 0;
    this.reconnect();
    this.bodyBoot = `bb-${Number(this.bodyBoot.split('-')[1]) + 1}`;
    this.records = new Map();
    this.trace.push({ kind: 'trace_open', at: iso(), source: 'continuous', bodyBoot: this.bodyBoot });
  }

  // ---- the trace the judge reads --------------------------------------------------------------------------------------------------------------
  private traceHands(entry: Entry, lines: Array<Record<string, unknown>>, spec: FinishSpec): void {
    const at = entry.startedAt ?? iso();
    const execution = `x${entry.exec || ++this.execs}`;
    for (const line of lines) {
      const ids = { run: this.bench.run, command: entry.command.id, hand: line.i, pass: line.pass ?? 1, life: entry.life, bodyBoot: this.bodyBoot, obsSeq: this.nextSeq(), obsAt: at };
      this.trace.push({ kind: 'hand_start', at, ids, pos: this.looks.position, hp: this.looks.hp, food: this.looks.hunger, saturation: 5, inventory: JSON.stringify(this.inventory),
        holder: { kind: 'command', actionId: execution, command: entry.command.id, life: entry.life, since: at }, lastOps: [] });
      if (Number(line.motorOps ?? 0) > 0) this.trace.push({ kind: 'op', at: iso(), command: entry.command.id, hand: line.i, pass: line.pass ?? 1, life: entry.life, op: String(line.do), exec: execution });
    }
    void spec;
  }
  private applyEvents(events: readonly InventoryEvent[]): void {
    for (const event of events) {
      const next = (this.inventory[event.item] ?? 0) + event.count;
      if (next > 0) this.inventory[event.item] = next; else delete this.inventory[event.item];
    }
  }
  private must(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`the stand-in body was never handed ${id}`);
    return entry;
  }
  /** The ids the script has for the commands handed in, in order, by the head's mark (`q1`). */
  idOf(item: string): string {
    const found = this.handed.find(command => command.queue?.item === item);
    if (!found) throw new Error(`no command with the mark ${item} was handed to the stand-in body (${this.handed.map(command => command.queue?.item ?? command.kind).join(',')})`);
    return found.id;
  }
  hasBeenHanded(item: string): boolean { return this.handed.some(command => command.queue?.item === item); }
}
const safeJson = (text: string): Record<string, any> | null => { try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' ? value as Record<string, any> : null; } catch { return null; } };

// ---- the bench ---------------------------------------------------------------------------------------------------------------------------
export interface BenchOptions {
  /** The scene the judge judges this by (`boundary-1`, `seam-2`, `b8-reconnect`...). */
  scene: string;
  /** The folder's name when a scene is run more than once. */
  folder?: string;
  /** The task's id and so the run's name in the decision record. */
  run?: string;
  headBoot?: string;
  /** The plan's saved checkpoint the first head starts from (a task that had a plan). */
  checkpoint?: unknown;
  goal?: string;
  /** The strong model that makes the first plan (a script): its answer is taken as the production takes it (`startFirstPlan`). */
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  life?: number;
  /** The body polls on its own every `pollEveryMs` (default 4); `false`: the script polls by hand. */
  autoPoll?: boolean | number;
  ownerAlone?(): boolean;
  gameplayAllowed?(): boolean;
  /** Amendment A-10: the model that decides the step (a real `AnthropicFcaModel` over a scripted client asks Opus again) and its name; absent: a model that cannot be asked again. */
  model?: { model: unknown; name: string };
}
export interface Head { headBoot: string; control: MinecraftControl; parts: ReturnType<typeof llmcStepParts>; queue: LlmcQueue; stepId: string; step?: ReturnType<typeof fakeStep>; lease: { id: string; generation: number; holder: string }; lines: string[];
  /** The head's process is gone: whatever of it is still running (a wait for a receipt) finds the database closed to it and ends. */
  kill(): void }

/** The head's own connection to the shared database: once killed, every call of it throws (a process that is gone writes nothing, cancels nothing). */
function deadable(db: DatabaseSync): { db: DatabaseSync; kill(): void } {
  let dead = false;
  const check = () => { if (dead) throw new Error('BENCH_C_PROCESS_GONE'); };
  const wrap = <T extends object>(target: T): T => new Proxy(target, { get(held, name) {
    const value = (held as Record<string | symbol, unknown>)[name];
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { check(); const out = (value as (...inner: unknown[]) => unknown).apply(held, args); return out && typeof out === 'object' && 'run' in out ? wrap(out as object) : out; };
  } });
  return { db: wrap(db), kill: () => { dead = true; } };
}

let runCounter = 0;
export class BenchC {
  readonly run: string;
  readonly root: string;
  readonly records: string;
  readonly db = new DatabaseSync(':memory:');
  readonly body: BodyDouble;
  readonly marks: { deaths: unknown[]; injections: Array<Record<string, unknown>>; resumes: unknown[]; excludeCommands: string[] } = { deaths: [], injections: [], resumes: [], excludeCommands: [] };
  readonly dimensionSince = iso();
  readonly heads: Head[] = [];
  readonly probes: Array<Record<string, unknown>> = [];
  /** What each decision was told of the results (the queue's news it took), in order. */
  readonly told: ReturnType<LlmcQueue['take']> = [];
  private leaseSerial = 1;
  private validLease = 'lease-1';
  private bootNumber = 0;
  private current!: Head;
  private closed = false;
  private readonly configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true,
    ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  private checkpoint: unknown;

  constructor(readonly options: BenchOptions) {
    this.run = options.run ?? `bench-c-${options.scene}-${++runCounter}`;
    this.root = mkdtempSync(join(tmpdir(), 'bench-c-'));
    this.records = join(this.root, 'records');
    installDecisionRecorder(new DecisionRecorder({ root: this.records, head: { revision: 'bench-c', source: 'git', node: process.version }, log: () => undefined }));
    this.body = new BodyDouble(this);
    this.body.looks.life = options.life ?? 3;
    this.checkpoint = options.checkpoint ?? null;
  }

  control(): MinecraftControl { return this.current.control; }
  get head(): Head { return this.current; }
  get queue(): LlmcQueue { return this.current.queue; }
  get plan() { return this.current.parts.ports.plan; }
  /** A-20: the model the runner decides with (the step parts' own, with the credit guard). */
  get model() { return this.current.parts.ports.model; }
  get planTools() { return this.current.parts.planTools; }

  /** The head starts (the first time, or after a stop): a control on the shared database, step parts from the plan's checkpoint, the queue. */
  startHead(headBoot = `hb-${++this.bootNumber}`): Head {
    const gate = deadable(this.db);
    const store = new MinecraftControlStore(gate.db);
    const lease = { id: this.validLease, generation: this.leaseSerial, holder: 'bench-c' };
    const control = new MinecraftControl(store, this.configuration, { now: () => Date.now(), ownerAlone: this.options.ownerAlone ?? (() => true),
      taskAudienceAllowed: () => this.options.gameplayAllowed?.() === true,
      leaseValid: candidate => candidate.id === this.validLease, leaseKnown: () => true, pollMilliseconds: 1, cancelWaitMilliseconds: 50, frameMilliseconds: 600_000, headBoot });
    this.current = { headBoot, control, lease, lines: [], stepId: `step-${this.bootNumber}`, parts: null as never, queue: null as never, kill: gate.kill };
    // A frame first, as in production (the body is polling before the step begins): the queue's start cleans up with a stop, which needs a body to send to.
    if (this.heads.length > 0) this.body.poll();
    const step = fakeStep(this.run, this.current.stepId, lease, this.checkpoint, this.options.goal ?? 'エンドラを倒して');
    control.store.bind(this.run, RUN_BODY);
    const llmc = { names: { main: this.options.model?.name ?? 'm', escalate: null, plan: 'p' }, models: { main: (this.options.model?.model ?? {}) as never, escalate: null }, summarizer: null, policy: {}, historyAhead: createFcaHistoryAhead(),
      ...(this.options.planner ? { planner: this.options.planner } : {}) };
    const parts = llmcStepParts(llmc as never, step as never, control, line => this.current.lines.push(line));
    this.current.parts = parts;
    this.current.step = step;
    this.current.queue = parts.tools.llmc.queue as LlmcQueue;
    this.heads.push(this.current);
    return this.current;
  }
  /** The plan as a restarted head would read it back: saved (as JSON) when the old head stopped. */
  savedCheckpoint(): unknown { return JSON.parse(JSON.stringify(this.current.parts.planTools.checkpoint?.() ?? {})); }
  /**
   * The head's process stops and starts again: a new control (another `headBoot`) on the same database, the plan read back from the checkpoint **of the last `commit()`** (what
   * a step had not committed is lost with the process), a new queue (its receipt box is read at once). The body does not poll while the head is down; `between` is what happens then.
   */
  async restartHead(between?: () => void | Promise<void>): Promise<Head> {
    const wasPaused = this.body.paused;
    this.body.paused = true;
    this.stopHead();
    await between?.();
    const head = this.startHead();
    this.body.paused = wasPaused;
    return head;
  }
  stopHead(): void {
    this.current.queue.stop();
    this.current.kill();
    forgetCleanups();
  }
  /** The step's end: the plan (the tree and the ledger's memory) is saved as the runtime would keep it, so a head that starts after this reads it back. */
  commit(): unknown {
    this.checkpoint = this.savedCheckpoint();
    this.current.parts.ports.plan.afterCommit?.();      // the runner tells the plan it was saved (the receipts its ledger took are marked processed)
    return this.checkpoint;
  }
  /** The plan a head that starts next reads (what the last step committed): set by a test that begins from a saved task. */
  setCheckpoint(checkpoint: unknown): void { this.checkpoint = checkpoint; }
  /** The step's lifecycle of the body (the mode's `withLlmcBody` over an empty inner): what a decision reads (`context`), the frame it read (`readOf`) and whether the body has left it (`drifted`). */
  lifecycle() {
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; }, toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    return this.current.parts.wrap(inner as never);
  }
  /** The model's `plan.update`, as a call of a decision. */
  async planUpdate(label: string, input: unknown): Promise<{ ok: boolean; [key: string]: unknown }> {
    return this.decide(label, () => this.current.parts.planTools.execute({ scopeKey: 'owner', taskId: this.run, operationId: `op-${++this.opCount}`, name: 'plan.update', input,
      signal: new AbortController().signal } as never) as never) as never;
  }
  private opCount = 0;
  /** The lease is renewed: the old one no longer lets a command through (a stop and a release still go: the head knows the old lease). */
  swapLease(): void { this.leaseSerial += 1; this.validLease = `lease-${this.leaseSerial}`; }

  /**
   * A decision of the scripted model: it begins as the runner's does (a request that reads the results the queue gives, and its answer), and `work` is its calls.
   * The commands it sends are that decision's (`sent` rows with its number).
   */
  async decide<T>(label: string, work: (news: ReturnType<LlmcQueue['take']>) => Promise<T> | T): Promise<T> {
    const head = this.current;
    return withDecisionScope({ taskId: this.run, stepId: head.stepId, record: true, versions: () => head.parts.ports.versions() }, async () => {
      const news = head.queue.take();
      this.told.push(...news);
      const text = news.length ? `（列の知らせ）\n${news.map(item => `${item.label}: ${item.result.text}`).join('\n')}` : label;
      const id = recordRequest('decision', { model: 'claude-opus-5-5', max_tokens: 4_000, system: [{ type: 'text', text: 'あなたは体を動かす' }],
        messages: [{ role: 'user', content: text }], tools: [{ name: 'mc_act', description: '動く', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } });
      if (id) recordResponse(id, { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
        content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'mc_act', input: { why: label } }], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
      return work(news);
    });
  }
  /**
   * The model's `mc.act` through the real tool: `fcaMinecraftTools` over the head's own step parts (`llmcStepParts`'s `tools`, as the server wires them), as a decision of the scripted model.
   * What it answers is what the model reads of the call (the line of the queue and the facts beside it).
   */
  async actThroughTools(input: Record<string, unknown>, options: { urgent?: boolean } = {}): Promise<ToolResult> {
    const head = this.current;
    // `urgent`: the decision was an urgent one (the lifecycle's flag, `urgentDecision`, is the step's own).
    const llmc = options.urgent ? { ...head.parts.tools.llmc, urgent: () => true } : head.parts.tools.llmc;
    const tools = fcaMinecraftTools({ control: head.control, step: head.step as never, ownerAlone: this.options.ownerAlone ?? (() => true), gameplayAllowed: this.options.gameplayAllowed, sourcesVisible: () => true, ...head.parts.tools, llmc } as never);
    const controller = new AbortController();
    return this.decide('act', () => inActionExecution({ lease: head.step!.lease, signal: controller.signal, permit: async () => true } as never,
      () => tools.execute({ scopeKey: 'owner', taskId: this.run, operationId: `op-act-${++this.opCount}`, name: 'mc.act', input, signal: controller.signal } as never) as never)) as Promise<ToolResult>;
  }
  /** A queue item for an act, as the model's `mc.act` makes it. */
  spec(hands: ActInput['hands'], extra: Partial<ActInput> = {}, node: string | null = 'p1'): QueueAdd {
    const counter = (this.specCount = (this.specCount ?? 0) + 1);
    const input: ActInput = { hands, why: extra.why ?? `[${node ?? 'p0'}] 項目${counter}`, ...extra };
    return { call: { id: `c${counter}`, name: 'mc.act', input }, operationId: `${this.run}:c${counter}`, input, arguments: input as unknown as Record<string, unknown>, skill: 'act', node,
      why: input.why ?? '', fixes: [] as string[], maxMs: 20_000, ...(extra.pre ? { pre: extra.pre } : {}) };
  }
  private specCount?: number;
  /** Adds an item inside a decision; the item's command id is then known (`body.idOf`). */
  async add(hands: ActInput['hands'], extra: Partial<ActInput> = {}, node: string | null = 'p1', maxMs = 20_000) {
    const result = await this.current.queue.add({ ...this.spec(hands, extra, node), maxMs });
    if (!result.ok) throw new Error(`the queue refused: ${result.text}`);
    return result;
  }

  // ---- running ---------------------------------------------------------------------------------------------------------------------------
  /** The body begins polling; it polls once first so the head has a frame. */
  async begin(): Promise<void> {
    this.startHead();
    const auto = this.options.autoPoll ?? true;
    this.body.poll();
    this.body.poll();
    if (auto !== false) this.body.start(typeof auto === 'number' ? auto : 4);
  }
  /** Polls by hand a few times and lets the head's promises run. */
  async spin(rounds = 3, pause = 6): Promise<void> {
    for (let index = 0; index < rounds; index += 1) { this.body.poll(); await delay(pause); }
  }
  async settle(ms = 60): Promise<void> { await delay(ms); }
  /** Waits until the head's queue has the item's result. */
  async until(condition: () => boolean, ms = 4_000): Promise<boolean> { return until(condition, ms); }

  // ---- the judge ---------------------------------------------------------------------------------------------------------------------------------
  /** The decision record as written so far. */
  events(): Array<Record<string, any>> { return readRun(join(this.records, runDirectory(this.run))).events as Array<Record<string, any>>; }
  /**
   * The folder `judge.ts` reads. The head's commands are `skill:<sha256>`; the judge names a scene's commands by their marks (`q1`), so the ids are written as the marks
   * (`skill:q1`) in every file (one rewrite of the text, the same for the head's rows, the receipts and the trace).
   */
  collect(extra: Partial<RunMeta> & { injections?: Array<Record<string, unknown>> } = {}): { dir: string; marks: Map<string, string> } {
    const dir = join(this.root, 'folder', this.options.folder ?? this.options.scene);
    mkdirSync(dir, { recursive: true });
    const eventsFile = join(this.records, runDirectory(this.run), 'events.jsonl');
    const eventsText = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '';
    const marks = new Map<string, string>();
    for (const line of eventsText.split('\n')) {
      if (!line.includes('"sent"')) continue;
      try { const row = JSON.parse(line) as { ev: string; commandId?: string; queue?: { item?: string } }; if (row.ev === 'sent' && row.commandId && row.queue?.item) marks.set(row.commandId, `skill:${row.queue.item}`); } catch { /* a cut line */ }
    }
    const rename = (text: string): string => { let out = text; for (const [id, mark] of marks) out = out.split(id).join(mark); return out; };
    const stand = [...this.body.handed].filter(command => command.kind !== 'skill' || command.skill !== 'act').map(command => rename(command.id));
    const meta: RunMeta = { run: this.run, scene: this.options.scene, benches: ['C'], headRev: process.env.BENCH_C_HEAD_REV ?? 'bench-c-worktree', bodyRev: PRODUCED_REV, producedRev: PRODUCED_REV,
      startedAt: this.events()[0]?.at, endedAt: iso(), excludeCommands: [...stand, ...this.marks.excludeCommands.map(rename)], deaths: this.marks.deaths as never, resumes: this.marks.resumes as never,
      injections: [...this.marks.injections, ...(extra.injections ?? [])].map(item => JSON.parse(rename(JSON.stringify(item)))), ...extra };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'events.jsonl'), rename(eventsText));
    writeFileSync(join(dir, 'receipts.jsonl'), this.body.receiptLog.map(line => rename(JSON.stringify(line))).join('\n') + (this.body.receiptLog.length ? '\n' : ''));
    writeFileSync(join(dir, 'body-trace.jsonl'), this.body.trace.map(line => rename(JSON.stringify(line))).join('\n') + '\n');
    writeFileSync(join(dir, 'probes.jsonl'), this.probes.map(line => JSON.stringify(line)).join('\n') + (this.probes.length ? '\n' : ''));
    return { dir, marks };
  }
  /** Collects the folder and judges it (the judge's own reader, the contract's fixtures). */
  judged(extra: Partial<RunMeta> & { injections?: Array<Record<string, unknown>> } = {}, fixtures: Fixtures = loadFixtures()): { verdict: Verdict; dir: string; marks: Map<string, string> } {
    const collected = this.collect(extra);
    if (process.env.BENCH_C_KEEP) { const to = join(process.env.BENCH_C_KEEP, this.options.folder ?? this.options.scene); mkdirSync(to, { recursive: true }); for (const name of ['meta.json', 'events.jsonl', 'receipts.jsonl', 'body-trace.jsonl', 'probes.jsonl']) copyFileSync(join(collected.dir, name), join(to, name)); }
    return { verdict: judge(loadFolder(collected.dir), fixtures), ...collected };
  }
  /** Copies a folder out of the temporary place (for reading it afterwards). */
  keep(to: string): void { mkdirSync(to, { recursive: true }); for (const name of ['meta.json', 'events.jsonl', 'receipts.jsonl', 'body-trace.jsonl', 'probes.jsonl']) { const from = join(this.root, 'folder', this.options.folder ?? this.options.scene, name); if (existsSync(from)) copyFileSync(from, join(to, name)); } }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.body.stop();
    try { this.current?.queue.stop(); } catch { /* stopped */ }
    for (const head of this.heads) try { head.queue.stop(); } catch { /* stopped */ }
    try { this.db.close(); } catch { /* closed */ }
    installDecisionRecorder(null);
    forgetLlmcQueues(); forgetLlmcEvents(); forgetActNodes(); forgetCleanups(); forgetOnceFacts(); forgetFirstPlans();
    rmSync(this.root, { recursive: true, force: true });
  }
}
export function benchC(options: BenchOptions): BenchC { return new BenchC(options); }

const runDirectory = runName;

/** A task step as the runtime gives it, with what the step's parts read of it. */
function fakeStep(taskId: string, id: string, lease: { id: string; generation: number; holder: string }, checkpoint: unknown, goal: string) {
  return { id, taskId, scopeKey: 'owner', revision: 1, lease, snapshot: { checkpoint, task: { id: taskId, goal, completionCriteria: 'Observed result', createdAt: '2026-10-28T12:00:00.000Z' } } };
}
