/**
 * The judge of the end-to-end checks of "continue" (contract 3.1, chapter 10 of `docs/continue-contracts.md`).
 *
 * It does not count a side's passing functions. It joins the records by the set of numbers (`TraceIds`: run, life, decision, reads, command,
 * queue/item, hand, pass) and judges on the joined chain: receipt -> real operations -> cut -> release -> the head's reading of the result.
 * The pass is "every command the judgement used is joined, and the conditions hold"; one command that does not join fails the folder
 * (chapter 10, last lines). `collect.sh` gathers one folder; `judge.ts <folder>` reads it.
 *
 *   tsx tools/continue-verify/judge.ts <folder> [--json] [--fixtures <dir>]
 *   tsx tools/continue-verify/judge.ts --all <root> [--json]       (root/<scene id>/ for every boundary, seam and boundary-8 scene)
 *
 * Exit status: 0 pass, 1 fail, 2 the arguments or the folder could not be read.
 *
 * ---- THE FOLDER (what `collect.sh` writes; every shape below is PROVISIONAL, decided by the judge's author for the head's records to meet) ----
 *   meta.json            RunMeta below: which scene, which revisions, which bench, the lab's own marks (deaths, injections).
 *   events.jsonl         the head's decision record (`docs/decision-records-2026-10.md`): the rows `request` `response` `sent` `applied`
 *                        `discarded` `call` that exist today (their old fields are read: `id`, `decisionId`, `commandId`, `queue`), and the
 *                        contract's StageRow rows (`received` `released` `corrected` `woke` `live` `input_change`, with `ids`), and the rows
 *                        this judge asks the head to add (see HeadRow: `head_boot` `unknown_notified` `ledger` `events` `plan_write`).
 *   receipts.jsonl       (or receipts.json, an array) one line for each delivery of a receipt: a MinecraftControlReceipt with `unit`
 *                        (ItemOutcome), `bodyTimes` (BodyTimes), `ids` (TraceIds), `lines` (the act result's hand lines), `handover`.
 *   body-trace.jsonl     (lines are read as {kind, at}, the contract's form, and no other: the body's opLog writes {k, t} today, a known gap the body fixes)
 *                        the body's own continuous file, appended from the bench's start to its end (never the 90-second ring):
 *                        TraceLine below (`trace_open` first, then `hand_start`, `op`, `death`, `life`, ...).
 *   marks.json           (optional) the lab's own marks: {deaths, injections, moments, resumes, excludeCommands}, merged into meta.
 *   probes.jsonl         (optional; boundaries 9 and 10) what the head's bench writes where there is no command: ProbeLine below.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BodyTimes, Handover, HandStart, ItemOutcome, TraceIds } from '../../services/api/src/contracts/continueContract.js';
import type { RecordEvent } from '../../services/api/src/infra/decisionRecords/decisionRecordRead.js';
import { STAGE_NAMES, stageTimes, type StageChain } from '../../services/api/src/infra/decisionRecords/decisionRecordStages.js';
import { runChecks } from './judgeChecks.js';

// ---- the shapes of the records ---------------------------------------------------------------------------------------------------------------
export type Bench = 'A' | 'B' | 'C' | 'D';
/** The numbers that join the records. Partial because a row of the old decision record has only some of them; but a record of a command that carries `ids` must have `obsSeq` and `obsAt` as the contract says (the join fails it otherwise). */
export type Ids = Partial<TraceIds>;

export interface DeathMark {
  /** The time of the `/kill`. */
  at: string; lifeBefore: number; lifeAfter: number;
  moment: 'running_hand' | 'waiting_for_reflex' | 'queued' | 'awaiting_model';
  /** The commands (and the decision, for awaiting_model) the lab knew were waiting at that moment. */
  waiting?: string[]; decision?: string;
}
export interface Injection {
  kind: string; at: string; command?: string; [key: string]: unknown;
}
export interface RunMeta {
  run: string;
  /** `boundary-N` (1 to 10 but 8), `seam-N` (1 to 8), or a boundary-8 scene id (`b8-lost-receipt` ...). */
  scene: string;
  benches: Bench[];
  headRev: string; bodyRev: string;
  /** The revision of the body that made the `produced/` files the run used; different from `bodyRev` is a fail (chapter 9). */
  producedRev?: string;
  startedAt?: string; endedAt?: string;
  /** Default: true when the bench C is in `benches` (the real head sends and decides), else false. */
  requireSent?: boolean; requireDecision?: boolean;
  /** Commands that are not part of the judgement (the internal `events` read, a probe query). */
  excludeCommands?: string[];
  deaths?: DeathMark[]; injections?: Injection[];
  /** Boundary 5: the moments this folder answers for; default all four. */
  moments?: string[];
  /** Boundary 2: the pairs (a hand ended, the command that resumed it). */
  resumes?: { from: string; to: string }[];
}

/** A row of events.jsonl. Only the fields the judge reads are named. */
export interface Row { ev: string; at?: string; id?: string; ids?: Ids; reads?: string[]; [key: string]: unknown }

/** The rows the judge asks the head to add besides the contract's StageRow (all provisional). */
export type HeadRow =
  | { ev: 'head_boot'; at: string; headBoot: string; ids: Ids }
  | { ev: 'unknown_notified'; at: string; ids: Ids }
  | { ev: 'ledger'; at: string; ids: Ids; applied: string[]; have: Record<string, number>; observed: Record<string, number>; rev?: number }
  | { ev: 'events'; at: string; ids: Ids; lost: boolean }
  | { ev: 'ledger_unexplained'; at: string; ids: Ids; count: number }
  | { ev: 'discarded'; at: string; id: string; reason: string };

export interface HandLineLike {
  i: number; do?: string; status?: string; goal?: string; end?: string; code?: string; cutBy?: string; pass?: number;
  progress?: { done?: number; at?: { x: number; y: number; z: number }; work?: { dug?: number; placeAttempts?: number; placedConfirmed?: number } };
}
/** One delivery of a receipt (the same receipt twice is two lines). */
export interface ReceiptRecord {
  id: string; connectionId?: string; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'; inputsReleased?: boolean; observedAt?: string;
  result?: string; failureType?: string;
  unit?: ItemOutcome; bodyTimes?: BodyTimes; ids?: Ids; lines?: HandLineLike[]; handover?: Handover;
  delivery?: { pollId: string; at: string };
}

export type OpKind = 'foot' | 'place' | 'place_held_back' | 'place_confirmed' | 'dig' | 'block_update' | 'attack' | 'eat' | 'key' | 'shield' | string;
export type Cell = [number, number, number];
export interface OpLine {
  kind: 'op'; at: string; command: string; hand?: number; pass?: number;
  /** The life of the COMMAND that caused the operation (its `context.life`); the contract names "life" without saying which one. */
  life: number;
  op: OpKind; exec?: string;
  from?: Cell; to?: Cell; pos?: Cell; usedForCorrection?: boolean;
  /** block_update: the block the cell became ('air', 'cobblestone', ...). */
  block?: string;
  /** The motor port refused it: it did not act and is not counted. */
  refused?: boolean;
}
export type HandStartLine = { kind: 'hand_start' } & Omit<HandStart, 'ids'> & { ids: Ids };
export type TraceLine =
  | { kind: 'trace_open'; at: string; source: 'continuous' | 'ring'; bodyBoot?: string }
  | HandStartLine
  | OpLine
  | { kind: 'life'; at: string; life: number; alive: boolean; dimension: string; advancedBy?: 'death' | 'file_unreadable' }
  | { kind: 'death'; at: string; life: number }
  | { kind: 'motor_refused'; at: string; command: string; call: string; holder?: string }
  | { kind: 'motor_state'; at: string; command: string; forward?: boolean; shield?: boolean; pathGoal?: 'kept' | 'cleared' }
  | { kind: 'reflex_hand'; at: string; reflex: string; target?: number }
  | { kind: 'reflex_end'; at: string; reflex: string }
  | { kind: 'poll'; at: string; connectionId: string; first?: boolean };

export type ProbeLine =
  | { kind: 'plan_snapshot'; at: string; stage: 'first_plan' | 'plan_update' | 'saved' | 'head_restart' | 'read_back'; nodes: { id: string; kind?: string; prep?: unknown }[] }
  | { kind: 'plan_decisions'; at: string; variant: 'original' | 'renamed'; values: Record<string, unknown> }
  | { kind: 'plan_write'; at: string; by: 'head' | 'llm'; node: string; fields: string[] }
  | { kind: 'request_bytes'; at: string; variant: 'normal' | 'urgent' | 'compressed'; bytes?: string; file?: string }
  | { kind: 'one_time_fact'; at: string; fact: string; perDecision: { d: string; compressedOut: boolean; inLastRequest: boolean }[] };

// ---- the fixtures the judge reads --------------------------------------------------------------------------------------------------------------
export interface Fixtures {
  dir: string;
  boundaries: { boundaries: { n: number; name: string; benches: Bench[]; fixtures: string[]; pass: string[] }[]; seams: string[];
    boundary8Scenes: { id: string; inject: string; command: string; corrections: number; deadline: string | null; records: string[] }[] };
  evidence: Record<'refused_before_start' | 'already' | 'normal' | 'unknown', string[]>;
  urgentNeedles: string[];
  oneTime: Record<string, boolean>;
  sameDecisions: string[];
}
export const DEFAULT_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../services/api/tests/fixtures/continue');
export function loadFixtures(dir: string = DEFAULT_FIXTURES): Fixtures {
  const read = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8')) as Record<string, any>;
  const boundaries = read('e2e/boundaries.json') as Fixtures['boundaries'];
  return { dir, boundaries, evidence: read('measure/evidence-by-command-kind.json').expected,
    urgentNeedles: read('measure/urgent-max-input.json').expected.eachVersionMustContain,
    oneTime: read('measure/one-time-fact-delivery.json').expected.inLastRequest,
    sameDecisions: read('plan/title-renamed-same-decisions.json').expected.sameDecisions };
}

// ---- the joined model ---------------------------------------------------------------------------------------------------------------------------
export interface CommandView {
  id: string; item?: string;
  sent: Row[]; received: Row[]; receipts: ReceiptRecord[]; released: Row[]; corrected: Row[];
  handStarts: HandStartLine[]; ops: OpLine[];
}
export interface DecisionView { id: string; request?: Row; response?: Row; sent: Row[]; discarded: Row[] }
export interface Input { dir?: string; meta: RunMeta; rows: Row[]; receipts: ReceiptRecord[]; trace: TraceLine[]; probes: ProbeLine[] }
export interface Model extends Input {
  fixtures: Fixtures; commands: Map<string, CommandView>; decisions: Map<string, DecisionView>;
  requireSent: boolean; requireDecision: boolean;
}

/** `q12` and `skill:q12` are one command. */
export const cmdKey = (id: string): string => (/^q\d+[a-z]*$/u.test(id) ? `skill:${id}` : id);
export const itemOf = (id: string): string => id.replace(/^skill:/u, '');
export const ms = (iso: unknown): number | undefined => {
  if (typeof iso !== 'string') return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
};

/** The numbers of a row: the new `ids` over the old fields of today's decision record. */
export function idsOf(row: Row, meta: RunMeta): Ids {
  const legacy: Ids = { run: meta.run } as Ids;
  if (row.ev === 'request' || row.ev === 'response' || row.ev === 'applied' || row.ev === 'discarded' || row.ev === 'failed') {
    if (typeof row.id === 'string') legacy.decision = row.id;
  }
  if (row.ev === 'sent') {
    if (typeof row.decisionId === 'string') legacy.decision = row.decisionId;
    if (typeof row.commandId === 'string') legacy.command = row.commandId;
    const queue = row.queue as { item?: string; queue?: string } | null | undefined;
    if (queue?.item) legacy.item = queue.item;
    if (queue?.queue) legacy.queue = queue.queue;
    const context = row.context as { life?: number } | undefined;
    if (typeof context?.life === 'number') legacy.life = context.life;
  }
  const merged = { ...legacy, ...(row.ids ?? {}) } as Ids;
  if (merged.command) merged.command = cmdKey(merged.command);
  return merged;
}
export const readsOf = (row: Row): string[] => (row.reads ?? row.ids?.reads ?? []).map(cmdKey);

/** The life a command was made in: the `sent` row's context or madeIn, else the life its operations carry. */
export function commandLife(command: CommandView): number | undefined {
  for (const row of command.sent) {
    const context = row.context as { life?: number } | undefined;
    const madeIn = (row.queue as { madeIn?: { life?: number } } | null | undefined)?.madeIn;
    if (typeof context?.life === 'number') return context.life;
    if (typeof madeIn?.life === 'number') return madeIn.life;
  }
  return command.ops[0]?.life ?? command.handStarts[0]?.ids.life;
}

export function buildModel(input: Input, fixtures: Fixtures): Model {
  const { meta, rows, receipts, trace } = input;
  const commands = new Map<string, CommandView>();
  const decisions = new Map<string, DecisionView>();
  const excluded = new Set((meta.excludeCommands ?? []).map(cmdKey));
  const command = (id: string): CommandView => {
    const key = cmdKey(id);
    let found = commands.get(key);
    if (!found) { found = { id: key, item: itemOf(key), sent: [], received: [], receipts: [], released: [], corrected: [], handStarts: [], ops: [] }; commands.set(key, found); }
    return found;
  };
  const decision = (id: string): DecisionView => {
    let found = decisions.get(id);
    if (!found) { found = { id, sent: [], discarded: [] }; decisions.set(id, found); }
    return found;
  };
  for (const row of rows) {
    const ids = idsOf(row, meta);
    if (row.ev === 'request' && ids.decision) decision(ids.decision).request = row;
    else if (row.ev === 'response' && ids.decision) decision(ids.decision).response = row;
    else if (row.ev === 'discarded' && ids.decision) decision(ids.decision).discarded.push(row);
    if (row.ev === 'sent' && ids.command) {
      if ((row as { skill?: unknown }).skill === 'events') continue;
      command(ids.command).sent.push(row);
      if (ids.decision) decision(ids.decision).sent.push(row);
    } else if (ids.command && (row.ev === 'received' || row.ev === 'released' || row.ev === 'corrected')) {
      const view = command(ids.command);
      (row.ev === 'received' ? view.received : row.ev === 'released' ? view.released : view.corrected).push(row);
    }
  }
  for (const receipt of receipts) command(receipt.id).receipts.push(receipt);
  for (const line of trace) {
    if (line.kind === 'hand_start' && line.ids?.command) command(line.ids.command).handStarts.push(line);
    else if (line.kind === 'op') command(line.command).ops.push(line);
  }
  for (const key of excluded) commands.delete(key);
  const benches = meta.benches ?? [];
  return { ...input, fixtures, commands, decisions,
    requireSent: meta.requireSent ?? benches.includes('C'), requireDecision: meta.requireDecision ?? benches.includes('C') };
}

// ---- the evidence of a command, by its kind (measure/evidence-by-command-kind.json) ----------------------------------------------------------------
export type CommandKind = 'refused_before_start' | 'already' | 'normal' | 'unknown';
export const unitOf = (command: CommandView): ItemOutcome | undefined => {
  for (let index = command.receipts.length - 1; index >= 0; index -= 1) if (command.receipts[index].unit) return command.receipts[index].unit;
  for (let index = command.received.length - 1; index >= 0; index -= 1) {
    const unit = (command.received[index].receipt as { unit?: ItemOutcome } | undefined)?.unit;
    if (unit) return unit;
  }
  return undefined;
};
export const sawUnknown = (command: CommandView): boolean =>
  command.receipts.some(receipt => receipt.outcome === 'unknown' || receipt.unit?.goal === 'unknown')
  || command.received.some(row => { const receipt = row.receipt as { outcome?: string; unit?: ItemOutcome } | undefined; return receipt?.outcome === 'unknown' || receipt?.unit?.goal === 'unknown'; });

/** The kind of a command from what its receipts said (unknown if it ever was unknown), or undefined when it has no receipt. */
export function kindOf(command: CommandView): CommandKind | undefined {
  if (command.receipts.length === 0 && command.received.length === 0) return undefined;
  if (sawUnknown(command)) return 'unknown';
  const unit = unitOf(command);
  // (not_started, cut) is a hand cut from outside with no operation (chapter 14, A-1): nothing was done, so it is read as a command refused before it began
  if (unit?.end === 'not_run' || (unit?.goal === 'not_started' && unit.end === 'cut')) return 'refused_before_start';
  if (unit?.goal === 'already') return 'already';
  return 'normal';
}
export const linesOf = (command: CommandView): HandLineLike[] => {
  const last = command.receipts[command.receipts.length - 1];
  if (!last) return [];
  if (last.lines) return last.lines;
  try { const parsed = JSON.parse(last.result ?? 'null') as { lines?: HandLineLike[] } | null; return parsed?.lines ?? []; } catch { return []; }
};
export const bodyTimesOf = (command: CommandView): BodyTimes | undefined =>
  [...command.receipts].reverse().find(receipt => receipt.bodyTimes)?.bodyTimes
  ?? ([...command.received].reverse().map(row => row.bodyTimes as BodyTimes | undefined).find(Boolean));

/** What each named piece of evidence needs; a name the judge does not know stops the judgement rather than passing it. */
function hasEvidence(name: string, command: CommandView): string | null {
  const unit = unitOf(command), times = bodyTimesOf(command);
  switch (name) {
    case 'receipt': return command.receipts.length + command.received.length > 0 ? null : 'receipt';
    case 'receipt.unit(not_run)': return unit?.end === 'not_run' || (unit?.goal === 'not_started' && unit.end === 'cut') ? null : 'receipt.unit(not_run)';
    case 'handLine': return linesOf(command).some(line => line.goal === 'already') ? null : 'handLine';
    case 'bodyTimes.lockAt': return times?.lockAt ? null : 'bodyTimes.lockAt';
    // A command that never moved (motorOps 0) has no first motor time: the contract does not say so (reported), the judge asks for it only when motorOps > 0.
    case 'bodyTimes.firstMotorAt': return (times?.motorOps ?? 0) === 0 || times?.firstMotorAt ? null : 'bodyTimes.firstMotorAt';
    case 'bodyTimes.motorOps': return typeof times?.motorOps === 'number' ? null : 'bodyTimes.motorOps';
    case 'hand_start': return handStartsCover(command) ? null : 'hand_start';
    case 'released(cleanup)': return command.released.some(row => row.by === 'cleanup' && row.ok === true) ? null : 'released(cleanup)';
    default: throw new Error(`the judge does not know the evidence "${name}" (measure/evidence-by-command-kind.json)`);
  }
};
/** Every hand that ran has its start: when the receipt has lines, each line that did not end "skipped" needs a `hand_start` of the same number; else one is enough. */
function handStartsCover(command: CommandView): boolean {
  if (command.handStarts.length === 0) return false;
  const ran = linesOf(command).filter(line => line.status !== 'skipped' && line.goal !== 'not_started');
  return ran.every(line => command.handStarts.some(start => start.ids.hand === line.i));
}

// ---- the join: which commands are joined, and what is missing for the others ------------------------------------------------------------------------
export interface Unlinked { command: string; reasons: string[] }
/** `gaps`: what the contract requires and the records do not yet have (TraceIds' obsSeq and obsAt). Told in every verdict, never counted as a pass; they do not fail a folder (a record is still joined by run, life, decision and command). */
export interface Joined { judged: string[]; linked: string[]; unlinked: Unlinked[]; kinds: Record<string, CommandKind | undefined>; gaps: string[] }

export function joinCommands(model: Model): Joined {
  const { meta, fixtures } = model;
  const judged: string[] = [], linked: string[] = [], unlinked: Unlinked[] = [], kinds: Joined['kinds'] = {}, gaps: string[] = [];
  for (const command of model.commands.values()) {
    const reasons: string[] = [];
    judged.push(command.id);
    const kind = kindOf(command);
    kinds[command.id] = kind;
    if (model.requireSent && command.sent.length === 0) reasons.push('no_sent');
    for (const row of command.sent) {
      const ids = idsOf(row, meta), view = ids.decision ? model.decisions.get(ids.decision) : undefined;
      if (ids.decision && !view?.request) reasons.push(`no_request:${ids.decision}`);
      else if (ids.decision && !view?.response) reasons.push(`no_response:${ids.decision}`);
      else if (!ids.decision && model.requireDecision) reasons.push('sent_without_decision');
    }
    const lives = new Set<number>();
    for (const part of [...command.handStarts.map(start => start.ids.life), ...command.ops.map(op => op.life)]) if (typeof part === 'number') lives.add(part);
    if (lives.size > 1) reasons.push('life_mismatch');
    const runs = [...command.received, ...command.released, ...command.corrected].map(row => idsOf(row, meta).run)
      .concat(command.receipts.map(receipt => receipt.ids?.run ?? meta.run), command.handStarts.map(start => start.ids.run));
    if (runs.some(run => run !== undefined && run !== meta.run)) reasons.push('run_mismatch');
    // TraceIds keep obsSeq and obsAt required (the contract's form is the only one read); a record that lacks them is a told gap, not a silent pass
    const idsOfRecords = [...command.sent, ...command.received, ...command.released, ...command.corrected].map(row => row.ids).concat(command.receipts.map(receipt => receipt.ids), command.handStarts.map(start => start.ids));
    if (idsOfRecords.some(ids => ids && (typeof ids.obsSeq !== 'number' || typeof ids.obsAt !== 'string'))) gaps.push(`${command.id}: ids without obsSeq/obsAt`);
    if (!kind) reasons.push('no_receipt');
    else for (const name of fixtures.evidence[kind]) { const missing = hasEvidence(name, command); if (missing) reasons.push(`missing:${missing}`); }
    if (reasons.length === 0) linked.push(command.id); else unlinked.push({ command: command.id, reasons });
  }
  return { judged, linked, unlinked, kinds, gaps };
}

// ---- the stages of time (chapter 8, "時間の段") ------------------------------------------------------------------------------------------------
// The computation is the head's own (`decisionRecordStages.ts`, the one `scripts/decision-record.ts stages` shows): the judge joins the same rows by the same numbers and
// adds the receipts the bench collected as a second source of the body's times.
export { STAGE_NAMES, type StageChain };

/** For a failed command: the decision that read it (same run and life), its reply, the command it sent and that command's times; see `stageTimes`. */
export function stageChain(model: Model, failed: CommandView): StageChain {
  const times = (command: string) => { const view = model.commands.get(command); return view ? bodyTimesOf(view) : undefined; };
  return stageTimes(model.rows as RecordEvent[], { run: model.meta.run, only: failed.id, bodyTimesOf: times })[0]
    ?? { failed: failed.id, linked: false, why: 'no received row with failedAt' };
}

// ---- the verdict --------------------------------------------------------------------------------------------------------------------------------------
export interface CheckResult { id: string; ok: boolean; detail: string; commands?: string[] }
export interface Verdict {
  pass: boolean; scene: string; headRev: string; bodyRev: string; benches: Bench[];
  commands: { judged: number; linked: number; unlinked: Unlinked[] };
  /** Told, not failed: what the contract requires of the records and they do not have yet. */
  gaps: string[];
  checks: CheckResult[]; stages: StageChain[]; text: string;
}

export function judge(input: Input, fixtures: Fixtures = loadFixtures()): Verdict {
  const model = buildModel(input, fixtures), { meta } = model;
  const joined = joinCommands(model);
  const checks: CheckResult[] = [];
  const versionOk = Boolean(meta.headRev && meta.bodyRev) && (meta.producedRev === undefined || meta.producedRev === meta.bodyRev);
  checks.push({ id: 'versions', ok: versionOk, detail: versionOk ? `head ${meta.headRev} body ${meta.bodyRev}${meta.producedRev ? ` produced ${meta.producedRev}` : ''}`
    : `headRev/bodyRev missing, or the produced files were made by ${meta.producedRev} not ${meta.bodyRev} (a produced file of another version is a fail)` });
  checks.push(...runChecks(model, joined));
  const stages = [...model.commands.values()].filter(command => command.received.some(row => (row.bodyTimes as BodyTimes | undefined)?.failedAt))
    .map(command => stageChain(model, command));
  const pass = joined.unlinked.length === 0 && checks.length > 1 && checks.every(check => check.ok);
  const verdict: Verdict = { pass, scene: meta.scene, headRev: meta.headRev, bodyRev: meta.bodyRev, benches: meta.benches,
    commands: { judged: joined.judged.length, linked: joined.linked.length, unlinked: joined.unlinked }, gaps: joined.gaps, checks, stages, text: '' };
  verdict.text = verdictText(verdict);
  return verdict;
}

export function verdictText(verdict: Verdict): string {
  const lines = [`${verdict.pass ? '合格' : '不合格'}  ${verdict.scene}  頭 ${verdict.headRev}  体 ${verdict.bodyRev}  台 ${verdict.benches.join('+')}`,
    `つながった命令 ${verdict.commands.linked}/${verdict.commands.judged}`];
  for (const gap of verdict.gaps) lines.push(`  既知の欠け: ${gap}`);
  for (const item of verdict.commands.unlinked) lines.push(`  つながらない: ${item.command}  (${item.reasons.join(', ')})`);
  for (const check of verdict.checks) lines.push(`  ${check.ok ? 'OK ' : 'NG '} ${check.id}: ${check.detail}`);
  for (const chain of verdict.stages) {
    lines.push(chain.linked ? `  段 ${chain.failed} -> ${chain.decision} -> ${chain.next}: 合計 ${chain.totalMs} ms ${JSON.stringify(chain.stagesMs)}`
      : `  段 ${chain.failed}: つながらない (${chain.why})`);
  }
  return lines.join('\n');
}

// ---- reading a folder ---------------------------------------------------------------------------------------------------------------------------
const jsonLines = <T>(path: string): T[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T) : []);
export function loadFolder(dir: string): Input {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMeta;
  // the lab's own marks (deaths, injections, ...) are a file of their own; collect.sh copies it untouched
  if (existsSync(join(dir, 'marks.json'))) Object.assign(meta, JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')));
  const receiptsJson = join(dir, 'receipts.json');
  const receipts = existsSync(receiptsJson) ? JSON.parse(readFileSync(receiptsJson, 'utf8')) as ReceiptRecord[] : jsonLines<ReceiptRecord>(join(dir, 'receipts.jsonl'));
  return { dir, meta, rows: jsonLines<Row>(join(dir, 'events.jsonl')), receipts, trace: jsonLines<TraceLine>(join(dir, 'body-trace.jsonl')),
    probes: jsonLines<ProbeLine>(join(dir, 'probes.jsonl')) };
}

/** Every scene the contract names, as a folder name under the root: boundary-1..10, seam-1..8, the boundary-8 scenes. A missing folder is a fail ("not run"). */
export function sceneIds(fixtures: Fixtures): string[] {
  return [...fixtures.boundaries.boundaries.filter(item => item.n !== 8).map(item => `boundary-${item.n}`), ...fixtures.boundaries.seams.map((_, index) => `seam-${index + 1}`),
    ...fixtures.boundaries.boundary8Scenes.map(scene => scene.id)];
}
export function judgeAll(root: string, fixtures: Fixtures = loadFixtures()): { pass: boolean; verdicts: Verdict[]; missing: string[] } {
  const verdicts: Verdict[] = [], missing: string[] = [];
  for (const id of sceneIds(fixtures)) {
    const dir = join(root, id);
    if (!existsSync(join(dir, 'meta.json'))) { missing.push(id); continue; }
    verdicts.push(judge(loadFolder(dir), fixtures));
  }
  return { pass: missing.length === 0 && verdicts.every(verdict => verdict.pass), verdicts, missing };
}

// ---- the command line ----------------------------------------------------------------------------------------------------------------------------
function main(argv: string[]): number {
  const json = argv.includes('--json');
  const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const flagValues = new Set([option('--fixtures'), option('--all')].filter((value): value is string => value !== undefined));
  const folder = argv.find(arg => !arg.startsWith('--') && !flagValues.has(arg));
  const all = option('--all');
  try {
    const fixtures = loadFixtures(option('--fixtures'));
    if (all) {
      const result = judgeAll(all, fixtures);
      console.log(json ? JSON.stringify({ pass: result.pass, missing: result.missing, verdicts: result.verdicts.map(({ text: _text, ...rest }) => rest) }, null, 1)
        : [...result.verdicts.map(verdict => verdict.text), ...result.missing.map(id => `未実行: ${id}`), result.pass ? '全体: 合格' : '全体: 不合格'].join('\n'));
      return result.pass ? 0 : 1;
    }
    if (!folder) { console.error('usage: judge.ts <folder> [--json] [--fixtures <dir>] | --all <root>'); return 2; }
    const verdict = judge(loadFolder(folder), fixtures);
    console.log(json ? JSON.stringify({ ...verdict, text: undefined }, null, 1) : verdict.text);
    return verdict.pass ? 0 : 1;
  } catch (error) {
    console.error(`judge: ${(error as Error).message}`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
