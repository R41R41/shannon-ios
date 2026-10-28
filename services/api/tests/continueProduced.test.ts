import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { aggregateGoal, allowedOutcome, dependStateOf, deathBetween, GOAL_OUTCOMES, keepDecision, RUN_ENDS, unitFromOutcome, unitView, type DeathCounter, type ItemOutcome } from '../src/contracts/continueContract.js';
import { ACT_CONTRACT_VERSION, ACT_INPUT_SCHEMA, actExpectedMilliseconds, actOutcomeOf, HAND_KINDS, readActResult, type ActInput } from '../src/contracts/minecraftActContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { eventsOfReceipt, readEventsReply } from '../src/surfaces/minecraft/minecraftControlEvents.js';
import { skillSchema, validBodyTimes, validBodyVersion, validControlPoll, validLifeView, validSkills, validUnit } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { applyLedger, emptyLedgerSeen, LEDGER_REASONS } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { itemResult, unitOfReceipt, type QueueWordsItem } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { actFacts, handFacts, placementCorrections, VERTICAL_STOP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { readingOf } from '../src/surfaces/minecraft/store/minecraftOperationState.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';

/**
 * Contract chapter 9: the body's REAL outputs (`produced/`, written by the body's `continue-produce.ts` and copied by `scripts/sync-body-produced.sh`) go through the head's
 * real readers. Each file of the body names itself at its top: `producedBy`, `bench` (`offline`: the body's own code; `B`: the body in the isolated lab), `bodyRevision` (a git
 * revision of the body, the same in every file), `answers` (the head's fixture under `tests/fixtures/continue/` it answers, without `.json`, or null) and `fixtureSha256`
 * (that fixture's sha256, or null), then `output`: what the body made (`result` = the act's result as the body writes it, `receiptUnit`/`unit` = the receipt's unit,
 * `bodyTimes`, `receipt`, `page` = an `events` reply, …). A produced file of a body that is not the one named in PRODUCED.json is a FAIL (chapter 9, 警告ではなく不合格).
 *
 * The four readers of `HEAD_READERS` are the head's real ones, connected: the unit into the store's two axes and the head's reading of the unit, the unit into the item's
 * result sentence, the events into the ledger, the hand lines' goal, end and progress. They run on the expected receipts of the fixtures and on every receipt of every
 * produced file.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'continue');
const PRODUCED = join(FIXTURES, 'produced');
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const fixtureJson = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), 'utf8')) as { input: Record<string, any>; expected: Record<string, any> };
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const AT = '2026-10-28T12:00:00.000Z';

// ---- the receipt the body sends -------------------------------------------------------------------------------------------------------------------------
export interface ReceiptShape {
  id: string; connectionId: string; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'; inputsReleased: boolean; observedAt: string;
  result?: string; failureType?: string; unit?: ItemOutcome; bodyTimes?: Record<string, unknown>;
}
const outcomeOf = (unit: ItemOutcome): ReceiptShape['outcome'] =>
  unit.end === 'unknown' ? 'unknown' : unit.end === 'cut' ? 'cancelled' : (unit.goal === 'done' || unit.goal === 'already') && unit.end === 'finished' ? 'completed' : 'failed';

/** The receipt a body would send for a fixture whose `expected` has a result's lines or a receipt; null for the fixtures that are about something else. */
export function expectedReceiptOf(path: string, now: Date): ReceiptShape | null {
  const { expected } = fixtureJson(path);
  const base = { id: 'skill:q1', connectionId: 'conn-1', observedAt: now.toISOString() };
  if (Array.isArray(expected.lines) && expected.outcome) {
    const unit: ItemOutcome = expected.receiptUnit ?? { ...expected.outcome, released: true };
    // The way the body writes a line: a hand that ran says how many operations it made (none for one that did not start), and each event of its delta has an id and its number.
    let delivery = 0;
    const lines: Record<string, unknown>[] = expected.lines.map((line: Record<string, any>) => ({ line: '', ...line,
      ...(line.status !== 'skipped' && line.motorOps === undefined ? { motorOps: line.goal === 'not_started' ? 0 : 1 } : {}),
      ...(Array.isArray(line.delta) ? { delta: line.delta.map((entry: Record<string, unknown>, index: number) => ({ id: `skill:q1:1:${line.i}:${index}`, obsSeq: 1, deliverySeq: delivery++, ...entry })) } : {}) }));
    const done = lines.filter(line => line.status === 'done').length;
    const result = { v: ACT_CONTRACT_VERSION, ok: done === lines.length, done, of: lines.length, lines, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20 };
    return { ...base, outcome: outcomeOf(unit), inputsReleased: unit.released, result: JSON.stringify(result), unit };
  }
  if (expected.receipt && expected.receiptUnit) {
    return { ...base, outcome: expected.receipt.outcome, inputsReleased: expected.receipt.inputsReleased, failureType: expected.receipt.failureType, unit: expected.receiptUnit };
  }
  return null;
}
export const pollOf = (receipts: ReceiptShape[], now: Date) => ({
  schemaVersion: 1, serverId: 'server-1', connectionId: 'conn-1',
  observation: { schemaVersion: 1, bodyId: 'minecraft:shannon-home', sequence: 1, stateAt: now.toISOString(), receivedAt: now.toISOString(), connected: true, state: {}, facts: {} },
  candidates: [], activeOperationIds: [], receipts,
});

// ---- the head's readers --------------------------------------------------------------------------------------------------------------------------------
export interface Reading { reader: string; ok: boolean; detail: string }
const reading = (reader: string, problems: string[], detail = 'read'): Reading => ({ reader, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : detail });

/** The readers that were there before the continue contract: the result is an ActResult of this version, within the poll's 16,000 characters, and the poll takes the receipt. */
export function readWithToday(receipt: ReceiptShape, now: Date): Reading[] {
  const out: Reading[] = [];
  if (receipt.result !== undefined) {
    const result = readActResult(receipt.result);
    out.push({ reader: 'readActResult()', ok: result !== null, detail: result ? `${result.lines.length} line(s), done ${result.done} of ${result.of}` : 'the result is not an ActResult of this version' });
    out.push({ reader: 'result <= 16,000 chars', ok: receipt.result.length <= 16_000, detail: `${receipt.result.length} chars` });
  }
  out.push({ reader: 'validControlPoll()', ok: validControlPoll(pollOf([receipt], now), now.getTime()), detail: 'a poll that carries this receipt' });
  return out;
}

const COMMAND: MinecraftControlCommand = { schemaVersion: 1, id: 'skill:q1', serverId: 'world', connectionId: 'conn-1', kind: 'skill', skill: 'act',
  context: { scopeKey: 'owner', taskId: 't1', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session-1', generation: 1, goal: 'g', completionCondition: 'c' } as never,
  lease: { id: 'lease-1', generation: 1, holder: 'test' } as never, deadlineAt: '2099-01-01T00:00:00.000Z', arguments: {} };

/** 1. The unit into the store: `settleWith` settles the command on its two axes, `unitOfReceipt` and the store's `unitOf` give back the unit (the old words when there is none). */
function readUnitInStore(receipt: ReceiptShape): Reading {
  const name = 'unit -> operation state / hold state';
  const problems: string[] = [];
  const store = new MinecraftControlStore(new DatabaseSync(':memory:'));
  const taken = receipt as unknown as MinecraftControlReceipt;
  const command = { ...COMMAND, id: receipt.id, connectionId: receipt.connectionId };
  store.insert(command, AT, undefined, { headBoot: 'hb-1' });
  if (receipt.unit && !validUnit(receipt.unit)) problems.push('validUnit() refuses the unit');
  const change = store.settleWith(taken);
  if (!change.acked) problems.push('settleWith() did not take the receipt');
  const known = readingOf(receipt) === 'known';
  if (store.state(receipt.id) !== (known ? 'settled_known' : 'settled_unknown')) problems.push(`result state ${store.state(receipt.id)} for a ${known ? 'known' : 'unknown'} receipt`);
  if (store.holdOf(receipt.id) !== 'none') problems.push(`hold state ${store.holdOf(receipt.id)}`);
  const stored = store.unitOf(receipt.id), mine = unitOfReceipt(receipt);
  if (JSON.stringify(stored) !== JSON.stringify(mine)) problems.push(`unitOf() ${JSON.stringify(stored)} is not unitOfReceipt() ${JSON.stringify(mine)}`);
  if (receipt.unit && JSON.stringify(stored) !== JSON.stringify(receipt.unit)) problems.push('the stored unit is not the body\'s');
  return reading(name, problems, `${store.state(receipt.id)}/${store.holdOf(receipt.id)}`);
}

/** 2. The unit into the queue item's state and the result sentence: `itemResult` says what ended, in words the model reads; its ok is the table's `succeeded`. */
function readUnitInQueue(receipt: ReceiptShape): Reading {
  const name = 'unit -> queue item state and the result sentence';
  const problems: string[] = [];
  const unit = unitOfReceipt(receipt);
  const item: QueueWordsItem = { item: 'q1', node: null, why: '[p0] 試験', input: { hands: [], why: '' } as unknown as ActInput, pre: undefined, done: undefined,
    startedAt: unit.end === 'not_run' ? null : Date.parse(unit.startedAt ?? AT), because: null, reason: () => null };
  const told = itemResult(item, receipt as unknown as MinecraftControlReceipt, []);
  if (typeof told.text !== 'string' || told.text.trim() === '') problems.push('an empty sentence');
  const state = dependStateOf(unitView(unit));
  const result = readActResult(receipt.result);
  const ran = !(unit.end === 'not_run' && unit.goal === 'not_started');
  if (ran && result) {
    if (state === 'succeeded' && !told.ok) problems.push(`the unit succeeded but the sentence is a failure: ${told.text.split('\n')[0]}`);
    if (told.ok && state !== 'succeeded') problems.push(`the sentence is ok but the unit is ${state}`);
  }
  if (!ran && told.ok) problems.push('an item that did not run is told as ok');
  if (!ran && !/捨てた|断られた/u.test(told.text)) problems.push('an item that did not run does not say it was dropped');
  return reading(name, problems, `${state}: ${told.text.split('\n')[0]!.slice(0, 60)}`);
}

/** The reasons the head's ledger knows for an event (an unknown one is read as `unexplained`: a failure to read what the body wrote). */
const KNOWN_REASONS: readonly string[] = LEDGER_REASONS;
/** 3. The result's events into the ledger: each event is read once, by its id, put to the promise of its item, and the count she has follows the observation, nothing is unexplained. */
function readEventsInLedger(receipt: ReceiptShape): Reading {
  const name = 'result events -> ledger';
  const problems: string[] = [];
  const { events, more } = eventsOfReceipt(receipt as unknown as MinecraftControlReceipt);
  if (new Set(events.map(entry => entry.id)).size !== events.length) problems.push('an event id twice');
  for (const entry of events) if (!KNOWN_REASONS.includes(entry.reason)) problems.push(`the reason ${entry.reason} of ${entry.id} is not one the ledger knows`);
  if (more && !(Number.isSafeInteger(more.nextSeq) && more.total >= more.nextSeq)) problems.push('eventsMore is not a place to fetch');
  const sorted = events.every(entry => entry.deliverySeq !== undefined) ? [...events].sort((a, b) => a.deliverySeq! - b.deliverySeq!) : events;
  if (JSON.stringify(sorted.map(entry => entry.id)) !== JSON.stringify(events.map(entry => entry.id))) problems.push('the events are not in the body\'s delivery order');
  if (events.length) {
    const items = [...new Set(events.map(entry => entry.item))];
    const promises: PlanPromise[] = items.map((item, index) => ({ id: index + 1, rev: 1, item, count: 1, use: '試験', state: 'open', ledger: [] }));
    const before: Record<string, number> = Object.fromEntries(items.map(item => [item, 100]));
    const after: Record<string, number> = { ...before };
    for (const entry of events) after[entry.item] = (after[entry.item] ?? 0) + (entry.reason === 'reflex_armor' ? 0 : entry.count);
    const frame = (seq: number, inventory: Record<string, number>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: seq, stateAt: AT, receivedAt: AT, connected: true,
      state: { world: { inventory, dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }, bodyRun: { bodyBoot: 'bb-1', connectionId: 'c-1' } } as never, facts: {} });
    const seqs = events.map(entry => (Number.isFinite(entry.obsSeq) ? entry.obsSeq : 0)), maxSeq = Math.max(...seqs);
    // the look before the command is older than every event of it
    const first = applyLedger(promises, emptyLedgerSeen(), { events: [], observation: frame(Math.min(...seqs) - 1, before), at: AT });
    const second = applyLedger(first.promises, first.ledgerSeen, { events, observation: frame(maxSeq + 1, after), at: AT });
    const unexplained = second.added.filter(line => line.kind === 'unexplained');
    if (unexplained.length) problems.push(`${unexplained.length} unexplained line(s): ${unexplained.map(line => `${line.promise}:${line.reason}`).join(',')}`);
    for (const promise of second.promises) if (promise.have !== after[promise.item]) problems.push(`have of ${promise.item} is ${promise.have}, the observation says ${after[promise.item]}`);
    const again = applyLedger(second.promises, second.ledgerSeen, { events, observation: frame(maxSeq + 1, after), at: AT });
    if (again.added.length) problems.push('the same events were put to the ledger twice');
  }
  return reading(name, problems, `${events.length} event(s)`);
}

/** 4. The hand lines' goal, end and progress, through `readActResult` and the contract's own rules. */
function readHandLines(receipt: ReceiptShape): Reading {
  const name = 'hand lines goal/end/progress';
  const problems: string[] = [];
  if (receipt.result === undefined) return reading(name, [], 'no result in this receipt');
  const result = readActResult(receipt.result);
  if (!result) return reading(name, ['the result is not read'], '');
  const PROGRESS_UNITS = ['step', 'block', 'item', 'meter', 'blow', 'second'];
  for (const line of result.lines) {
    const at = `hand ${line.i} ${line.do}`;
    if (!GOAL_OUTCOMES.includes(line.goal!) || !RUN_ENDS.includes(line.end!)) problems.push(`${at}: goal ${line.goal} / end ${line.end} is not a closed word`);
    else if (!allowedOutcome(line.goal!, line.end!)) problems.push(`${at}: (${line.goal}, ${line.end}) is a pair the table does not allow`);
    if (line.status === 'skipped' && line.motorOps !== undefined) problems.push(`${at}: a skipped hand has no motorOps`);
    if (line.status !== 'skipped' && !Number.isSafeInteger(line.motorOps)) problems.push(`${at}: no motorOps`);
    if (line.goal === 'not_started' && line.end !== 'not_run' && (line.motorOps ?? 0) > 0) problems.push(`${at}: not_started with ${line.motorOps} operations (it is failed)`);
    if (line.progress && (!PROGRESS_UNITS.includes(line.progress.unit) || !Number.isFinite(line.progress.done) || !(line.progress.left === null || Number.isFinite(line.progress.left)))) problems.push(`${at}: a progress that is not read`);
    if (line.progress?.seen && (line.progress.seen.length > 8 || line.progress.seen.some(entry => typeof entry.block !== 'string' || !Number.isFinite(entry.at?.x)))) problems.push(`${at}: seen is not 8 at most of {block, at}`);
    if (line.code === 'cancelled' && /failed|失敗/u.test(handFacts(line).join(''))) problems.push(`${at}: a cancelled hand is told as failed`);
    handFacts(line);
  }
  if (result.outcome) {
    const outcome = actOutcomeOf(result);
    const worked = aggregateGoal(result.lines.map(line => ({ goal: line.goal!, motorOps: line.motorOps ?? 0 })), result.doneMet !== undefined);
    if (worked !== result.outcome.goal) problems.push(`the act's goal ${result.outcome.goal} is not the contract's order over the hands (${worked})`);
    if (outcome.goal !== result.outcome.goal || outcome.end !== result.outcome.end) problems.push('actOutcomeOf() is not the body\'s outcome');
    if (!allowedOutcome(result.outcome.goal, result.outcome.end)) problems.push(`the act's (${result.outcome.goal}, ${result.outcome.end}) is not allowed`);
    if (receipt.unit && (receipt.unit.goal !== result.outcome.goal || receipt.unit.end !== result.outcome.end)) problems.push(`the receipt's unit (${receipt.unit.goal}, ${receipt.unit.end}) is not the result's (${result.outcome.goal}, ${result.outcome.end})`);
  }
  actFacts(result);
  return reading(name, problems, `${result.lines.length} hand(s)`);
}

/**
 * The readers the continue contract adds, connected to the real code. Each takes a receipt and returns `{ ok, detail }`; the tests below run all four on every expected
 * receipt of the fixtures and on every receipt of every produced file.
 */
export const HEAD_READERS: { reader: string; read: (receipt: ReceiptShape) => Reading }[] = [
  { reader: 'unit -> operation state / hold state', read: readUnitInStore },
  { reader: 'unit -> queue item state and the result sentence', read: readUnitInQueue },
  { reader: 'result events -> ledger', read: readEventsInLedger },
  { reader: 'hand lines goal/end/progress', read: readHandLines },
];
export const readWithHeadReaders = (receipt: ReceiptShape): Reading[] => HEAD_READERS.map(entry => entry.read(receipt));

// ---- the produced files --------------------------------------------------------------------------------------------------------------------------------
interface ProducedFile {
  producedBy?: string; bench?: string; bodyRevision?: string; madeAt?: string; answers?: string | null; fixtureSha256?: string | null; substitute?: string; note?: string;
  output?: Record<string, any>; [key: string]: unknown;
}
const readProduced = (dir: string, name: string): ProducedFile => JSON.parse(readFileSync(join(dir, name), 'utf8')) as ProducedFile;
const producedNames = (dir: string): string[] => readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'PRODUCED.json').sort();

/** Everything wrong with a produced directory; an empty list is the only pass. A version that does not match is a problem like any other, never a warning. */
export function problemsOfProduced(dir: string, fixtures: string = FIXTURES): string[] {
  const problems: string[] = [];
  const indexPath = join(dir, 'PRODUCED.json');
  if (!existsSync(indexPath)) return [`${indexPath} is missing: the files were not copied by scripts/sync-body-produced.sh`];
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { bodyRev?: string; madeBy?: string; files?: Record<string, string> };
  if (!/^[0-9a-f]{40}$/u.test(index.madeBy ?? '')) problems.push('PRODUCED.json: madeBy is not a full git revision');
  const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
  const names = producedNames(dir);
  if (names.length === 0) problems.push('there are no produced files');
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(index.files ?? {}).sort())) problems.push(`PRODUCED.json lists ${Object.keys(index.files ?? {}).join(',')} but the directory holds ${names.join(',')}`);
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (index.files?.[name] !== sha256(text)) problems.push(`${name}: its sha256 is not the one in PRODUCED.json (edited after the copy)`);
    let file: ProducedFile;
    try { file = JSON.parse(text) as ProducedFile; } catch { problems.push(`${name}: not JSON`); continue; }
    if (!file.bodyRevision) { problems.push(`${name}: bodyRevision is missing`); continue; }
    if (!index.madeBy || !(index.madeBy.startsWith(file.bodyRevision) || file.bodyRevision.startsWith(index.madeBy))) problems.push(`${name}: made by body ${file.bodyRevision}, PRODUCED.json says ${index.madeBy} (a produced file of another version is a fail)`);
    if (typeof file.bench !== 'string' || !(isRecord(file.output) || Array.isArray(file.offered))) problems.push(`${name}: no bench, or neither an output nor a catalog`);
    if (file.answers) {
      const fixturePath = join(fixtures, `${file.answers}.json`);
      if (!existsSync(fixturePath)) problems.push(`${name}: the fixture ${file.answers} is not in the head`);
      else {
        const have = sha256(readFileSync(fixturePath));
        if (file.fixtureSha256 !== have) problems.push(`${name}: fixtureSha256 is not that of the head's ${file.answers}.json`);
        if (manifest.files[`${file.answers}.json`] !== have) problems.push(`${file.answers}.json: the head's file differs from manifest.json`);
      }
    } else if (file.fixtureSha256) problems.push(`${name}: a fixtureSha256 without a fixture it answers`);
  }
  return problems;
}

/** The receipts a produced file carries (its `result` and the unit it came with), in the shape the head reads; the receipt's `bodyTimes` apart (see `bodyTimesOf`). */
export function receiptsOfProduced(name: string, file: ProducedFile): ReceiptShape[] {
  const out = file.output ?? {};
  const holders = [out, out.receipt, out.trial, out.oldCommand].filter(isRecord);
  const unit = holders.map(holder => holder.unit ?? holder.receiptUnit).find(isRecord) as ItemOutcome | undefined;
  const result = isRecord(out.result) ? out.result : undefined;
  if (!unit && !result) return [];
  const own = holders.find(holder => typeof holder.outcome === 'string' && holder !== out.result);
  const outcome = (own?.outcome as ReceiptShape['outcome'] | undefined) ?? (unit ? outcomeOf(unit) : result?.ok === true ? 'completed' : 'failed');
  const failureType = holders.map(holder => holder.failureType).find(item => typeof item === 'string') as string | undefined;
  return [{ id: `skill:${name.replace(/\.json$/u, '')}`, connectionId: 'conn-1', outcome, inputsReleased: unit?.released ?? true, observedAt: new Date().toISOString(),
    ...(result ? { result: JSON.stringify(result) } : {}), ...(unit ? { unit } : {}), ...(failureType ? { failureType } : {}) }];
}
/** The `bodyTimes` a produced file carries (beside its unit, or in its receipt). */
export const bodyTimesOf = (file: ProducedFile): Record<string, unknown> | undefined =>
  [file.output, file.output?.receipt, file.output?.trial].filter(isRecord).map(holder => holder.bodyTimes).find(isRecord);

// ---- the tests -----------------------------------------------------------------------------------------------------------------------------------------
const EXPECTED_PATHS = ['result/r43-reflex-ate-first.json', 'result/r45-hold1-go-partial.json', 'result/r45-resume1-dig-already-go-no-floor.json', 'result/act-not-started-reflex-late.json'];

describe('the expected receipts of the fixtures, through the head\'s readers', () => {
  const now = new Date('2026-10-28T04:00:00.000Z');
  for (const path of EXPECTED_PATHS) {
    it(`${path}: readActResult reads the result and validControlPoll takes the poll`, () => {
      const receipt = expectedReceiptOf(path, now);
      expect(receipt, 'the fixture has an expected receipt').not.toBeNull();
      const readings = readWithToday(receipt!, now);
      expect(readings.filter(item => !item.ok), JSON.stringify(readings)).toEqual([]);
      expect(readings.length).toBeGreaterThanOrEqual(1);
    });
  }
  it('the lines the body sends keep their count and order through readActResult', () => {
    const receipt = expectedReceiptOf('result/r45-hold1-go-partial.json', now)!;
    const read = readActResult(receipt.result)!;
    expect(read.lines.map(line => line.i)).toEqual([1, 2]);
    expect(read.lines.map(line => line.status)).toEqual(['done', 'stopped']);
    expect(read.done).toBe(1);
  });
  it('the old words of a receipt and the fixture\'s unit agree where the old words can say it (unitFromOutcome)', () => {
    const receipt = expectedReceiptOf('result/r43-reflex-ate-first.json', now)!;
    expect(unitFromOutcome(receipt.outcome, receipt.inputsReleased)).toEqual({ goal: 'done', end: 'finished', released: true });
  });
  it('a result over 16,000 chars is refused by validControlPoll (the limit stays)', () => {
    const receipt = { ...expectedReceiptOf('result/r43-reflex-ate-first.json', now)!, result: 'x'.repeat(16_001) };
    expect(validControlPoll(pollOf([receipt], now), now.getTime())).toBe(false);
  });
  it('the four head readers are connected: none says "not connected", every one has a name, and they are the four the contract adds', () => {
    expect(HEAD_READERS.map(entry => entry.reader)).toEqual(['unit -> operation state / hold state', 'unit -> queue item state and the result sentence', 'result events -> ledger', 'hand lines goal/end/progress']);
    const receipt = expectedReceiptOf('result/r43-reflex-ate-first.json', now)!;
    for (const item of readWithHeadReaders(receipt)) expect(item.detail).not.toBe('not connected');
  });
  // The four it.todo of the first version, now real: each head reader reads every expected receipt.
  for (const entry of HEAD_READERS) {
    it(`${entry.reader} reads every expected receipt of the fixtures`, () => {
      const failures: string[] = [];
      for (const path of EXPECTED_PATHS) {
        const receipt = expectedReceiptOf(path, now);
        expect(receipt, path).not.toBeNull();
        const done = entry.read(receipt!);
        if (!done.ok) failures.push(`${path}: ${done.detail}`);
      }
      expect(failures).toEqual([]);
    });
  }
  it('an unknown receipt is read as settled_unknown by the store and as not ran-ok by the queue (the same reader on the other side of the table)', () => {
    const unknown: ReceiptShape = { id: 'skill:u1', connectionId: 'conn-1', outcome: 'unknown', inputsReleased: false, observedAt: now.toISOString(), unit: { goal: 'unknown', end: 'unknown', released: false } };
    expect(readUnitInStore(unknown)).toMatchObject({ ok: true, detail: 'settled_unknown/none' });
  });
});

describe('problemsOfProduced (a version that does not match is a problem, not a warning)', () => {
  function made(extra: { bodyRevision?: string; sha?: string | null; edit?: boolean; answers?: string | null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'produced-')), rev = 'a'.repeat(40);
    const answers = extra.answers === undefined ? 'result/r43-reflex-ate-first' : extra.answers;
    const fixtureSha = answers ? sha256(readFileSync(join(FIXTURES, `${answers}.json`))) : null;
    const body = JSON.stringify({ producedBy: 'backend/scripts/lab/continue-produce.ts', bench: 'offline', bodyRevision: extra.bodyRevision ?? rev.slice(0, 12), madeAt: AT, answers,
      fixtureSha256: extra.sha === undefined ? fixtureSha : extra.sha, output: { result: {} } });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r43.json'), body);
    writeFileSync(join(dir, 'PRODUCED.json'), JSON.stringify({ bodyRev: 'b'.repeat(40), madeBy: rev, files: { 'r43.json': sha256(body) } }));
    if (extra.edit) writeFileSync(join(dir, 'r43.json'), `${body} `);
    return dir;
  }
  it('passes for a set that is whole and of one version', () => expect(problemsOfProduced(made())).toEqual([]));
  it('passes for a file that answers no fixture (the catalog)', () => expect(problemsOfProduced(made({ answers: null, sha: null }))).toEqual([]));
  it('fails for a file of another body version', () => expect(problemsOfProduced(made({ bodyRevision: 'c'.repeat(12) })).join('\n')).toContain('another version is a fail'));
  it('fails for a file made from another copy of the fixture', () => expect(problemsOfProduced(made({ sha: 'd'.repeat(64) })).join('\n')).toContain('fixtureSha256'));
  it('fails for a file that names no fixture but a sha', () => expect(problemsOfProduced(made({ answers: null, sha: 'd'.repeat(64) })).join('\n')).toContain('a fixtureSha256 without a fixture'));
  it('fails for a file edited after the copy', () => expect(problemsOfProduced(made({ edit: true })).join('\n')).toContain('edited after the copy'));
  it('fails for a directory the sync script did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'produced-'));
    writeFileSync(join(dir, 'x.json'), '{}');
    expect(problemsOfProduced(dir).join('\n')).toContain('PRODUCED.json is missing');
  });
});

describe.skipIf(!existsSync(PRODUCED))('the produced files in the head (copied from the body by scripts/sync-body-produced.sh)', () => {
  const names = existsSync(PRODUCED) ? producedNames(PRODUCED) : [];
  const files = new Map(names.map(name => [name, readProduced(PRODUCED, name)] as const));
  const get = (name: string): ProducedFile => files.get(name)!;
  const out = (name: string): Record<string, any> => get(name).output!;

  it('are whole, of one version, and made from the head\'s own fixtures', () => {
    expect(problemsOfProduced(PRODUCED)).toEqual([]);
  });
  it('are all of one bodyRevision (a produced file of another version is a fail, chapter 9)', () => {
    expect(new Set([...files.values()].map(file => file.bodyRevision)).size).toBe(1);
    const index = JSON.parse(readFileSync(join(PRODUCED, 'PRODUCED.json'), 'utf8')) as { madeBy: string };
    for (const file of files.values()) expect(index.madeBy.startsWith(file.bodyRevision!)).toBe(true);
  });
  it('A-4: every unit the body made is a unit the head reads (code included), and every bodyTimes has acceptedAt and endedAt (all receipts go through the control loop)', () => {
    const units: string[] = [], times: string[] = [];
    const walk = (value: unknown, where: string): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'unit' && inner && typeof inner === 'object') units.push(`${where}.unit`), expect(validUnit(inner), `${where}.unit`).toBe(true);
        if (key === 'bodyTimes' && inner && typeof inner === 'object') times.push(`${where}.bodyTimes`), expect(validBodyTimes(inner), `${where}.bodyTimes`).toBe(true);
        walk(inner, `${where}.${key}`);
      }
    };
    for (const [name, file] of files) walk(file.output, name);
    expect(units.length).toBeGreaterThan(4);
    expect(times.length).toBeGreaterThan(3);
    // the closed codes the amendment names are there as the head reads them
    const codes = new Set<string>();
    const collect = (value: unknown): void => { if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { if (key === 'unit' && inner && typeof (inner as { code?: unknown }).code === 'string') codes.add((inner as { code: string }).code); collect(inner); } };
    for (const file of files.values()) collect(file.output);
    expect([...codes].length).toBeGreaterThan(0);
  });
  it('are the 26 files the body made at that revision', () => {
    expect(names).toHaveLength(26);
  });

  it('their receipts go through the head\'s readers, all four: the unit into the store, the unit into the queue\'s sentence, the events into the ledger, the hand lines', () => {
    const now = new Date();
    const failures: string[] = [];
    let counted = 0;
    for (const [name, file] of files) {
      for (const receipt of receiptsOfProduced(name, file)) {
        counted += 1;
        for (const item of [...readWithToday(receipt, now), ...readWithHeadReaders(receipt)]) if (!item.ok) failures.push(`${name}: ${item.reader}: ${item.detail}`);
      }
    }
    expect(counted).toBeGreaterThanOrEqual(10);
    expect(failures).toEqual([]);
  });
  for (const entry of HEAD_READERS) {
    it(`${entry.reader} reads every receipt of every produced file`, () => {
      const failures: string[] = [];
      for (const [name, file] of files) for (const receipt of receiptsOfProduced(name, file)) { const done = entry.read(receipt); if (!done.ok) failures.push(`${name}: ${done.detail}`); }
      expect(failures).toEqual([]);
    });
  }
  it('the readers have something to read: receipts with a unit, with a result, with events (a pass that read nothing is no pass)', () => {
    const receipts = [...files].flatMap(([name, file]) => receiptsOfProduced(name, file));
    expect(receipts.filter(receipt => receipt.unit).length).toBeGreaterThanOrEqual(9);
    expect(receipts.filter(receipt => receipt.result).length).toBeGreaterThanOrEqual(10);
    const events = receipts.flatMap(receipt => eventsOfReceipt(receipt as unknown as MinecraftControlReceipt).events);
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(new Set(events.map(entry => entry.reason))).toEqual(new Set(['placed', 'picked']));
  });
  it('the hand lines of every produced result keep the contract\'s rules of motorOps (a skipped hand has none; not_started never has operations unless it is not_run)', () => {
    for (const [name, file] of files) for (const receipt of receiptsOfProduced(name, file)) {
      const result = readActResult(receipt.result);
      if (!result) continue;
      for (const line of result.lines) {
        if (line.status === 'skipped') expect(line.motorOps, `${name} hand ${line.i}`).toBeUndefined();
        else expect(line.motorOps, `${name} hand ${line.i}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('bodyTimes: every field the head reads is valid; `acceptedAt` is the one the lab\'s receipts lack (a known mismatch with validBodyTimes, reported, the contract not changed)', () => {
    const seen: string[] = [];
    for (const [name, file] of files) {
      const times = bodyTimesOf(file);
      if (!times) continue;
      seen.push(name);
      // the same times with the missing acceptedAt filled in are valid: nothing else is wrong
      expect(validBodyTimes({ acceptedAt: times.startedAt ?? times.endedAt, ...times }), name).toBe(true);
      // and the whole is either valid or lacks acceptedAt, only that
      expect(validBodyTimes(times) || times.acceptedAt === undefined, `${name}: invalid for another reason than acceptedAt`).toBe(true);
      expect(Date.parse(String(times.endedAt))).toBeGreaterThanOrEqual(Date.parse(String(times.startedAt ?? times.endedAt)));
      if (times.firstMotorAt !== undefined) expect(Date.parse(String(times.firstMotorAt))).toBeGreaterThanOrEqual(Date.parse(String(times.lockAt ?? times.startedAt)));
    }
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it('continue--dependency-table: the body\'s rows are the head\'s table (dependStateOf over each row), and the same rows as the fixture', () => {
    const rows = out('continue--dependency-table.json').rows as Array<{ goal: any; end: any; released: boolean; dependState: string }>;
    for (const row of rows) expect(dependStateOf(unitView({ goal: row.goal, end: row.end, released: row.released })), JSON.stringify(row)).toBe(row.dependState);
    const key = (row: { goal: string; end: string; released: boolean; dependState: string }) => `${row.goal}/${row.end}/${row.released}/${row.dependState}`;
    const theirs = (fixtureJson('continue/dependency-table.json') as unknown as { outcomes: typeof rows }).outcomes ?? (JSON.parse(readFileSync(join(FIXTURES, 'continue/dependency-table.json'), 'utf8')).outcomes as typeof rows);
    expect(rows.map(key).sort()).toEqual(theirs.map(key).sort());
  });
  it('continue--queue-item-depends: what was kept and dropped is what keepDecision says, and the marks are a unit the head reads', () => {
    const made = out('continue--queue-item-depends.json') as { kept: any[]; dropped: any[]; envelopeAccepted: boolean };
    expect(made.envelopeAccepted).toBe(true);
    for (const dropped of made.dropped) {
      expect(validUnit({ goal: 'not_started', end: 'not_run', released: true, droppedBecause: dropped.droppedBecause })).toBe(true);
      expect(keepDecision(['failed'])).toBe(`drop:${dropped.droppedBecause.code}`);
    }
    for (const kept of made.kept) expect(validUnit({ goal: 'done', end: 'finished', released: true, keptDespite: kept.keptDespite })).toBe(true);
    expect(made.kept.length + made.dropped.length).toBeGreaterThanOrEqual(2);
  });

  it('life--*: the life views are the head\'s LifeView; a death is only a rise of deathSeq within an epoch; a portal is no death; an unreadable file moves the epoch, not the deaths', () => {
    const pair = out('life--death-epoch-pair.json') as { first: any; afterDeath: any };
    expect(validLifeView(pair.first) && validLifeView(pair.afterDeath)).toBe(true);
    const counter = (view: any): DeathCounter => ({ deathEpoch: view.deathEpoch, deathSeq: view.deathSeq });
    expect(deathBetween(counter(pair.first), pair.afterDeath).death).toBe(true);
    expect(pair.afterDeath.life).toBeGreaterThan(pair.first.life);
    const portal = out('life--portal-is-not-death.json') as { lifeBefore: number; netherLife: any; afterDeathLife: any; oldCommand: { failureType: string; unit: ItemOutcome } };
    expect(validLifeView(portal.netherLife) && validLifeView(portal.afterDeathLife)).toBe(true);
    expect(portal.netherLife.life).toBe(portal.lifeBefore);
    expect(portal.netherLife.dimension).toBe('the_nether');
    expect(deathBetween(counter(portal.netherLife), portal.netherLife).death).toBe(false);
    expect(deathBetween(counter(portal.netherLife), portal.afterDeathLife).death).toBe(true);
    expect(validUnit(portal.oldCommand.unit)).toBe(true);
    expect(portal.oldCommand.unit).toMatchObject({ goal: 'not_started', end: 'not_run' });
    const unreadable = out('life--life-file-unreadable.json') as { missing: any; corrupt: any; notes: string[] };
    expect(validLifeView(unreadable.missing) && validLifeView(unreadable.corrupt)).toBe(true);
    expect(unreadable.corrupt.advancedBy).toBe('file_unreadable');
    expect(deathBetween(counter(unreadable.missing), unreadable.corrupt).death).toBe(false);
    const dead = out('life--r45-death-then-old-attack.json') as { receipt: any; result: any; lifeBefore: number; lifeAfter: any };
    expect(validLifeView(dead.lifeAfter)).toBe(true);
    expect(dead.lifeAfter.life).toBe(dead.lifeBefore + 1);
    expect(dead.result.outcome).toMatchObject({ goal: 'not_started', end: 'cut', cutBy: 'death' });
    // A-6 5: the life the act began in (the body fixed it: d70dc012bb96).
    expect(dead.result.outcome.life).toBe(dead.lifeBefore);
    expect(dead.result.outcome.life).not.toBe(dead.lifeAfter.life);
  });
  it('life--r45-death-then-old-attack: the old attack the death cut says so in the words the model reads, and is not a failed hand', () => {
    const file = get('life--r45-death-then-old-attack.json');
    const text = readActResult(receiptsOfProduced('life--r45-death-then-old-attack.json', file)[0]!.result)!;
    const facts = text.lines.flatMap(line => handFacts(line)).join('\n');
    expect(facts).toContain('外から止められた（死んだ）');
    expect(facts).not.toMatch(/進んでいない/u);
  });

  it('control--*: a handover is the head\'s Handover, and its words say what the reflex handed over', () => {
    const trial = out('control--r45-attack-waited-6-4s.json') as { trial: any; result: any };
    const handover = trial.result.handover;
    expect(handover).toMatchObject({ from: 'floor-melee', confirmed: true });
    expect(['kept', 'lowered', 'none']).toContain(handover.shield);
    expect(actFacts(readActResult(JSON.stringify(trial.result))!).join('\n')).toContain('反射 floor-melee から引き継いだ');
    expect(trial.trial.unit).toMatchObject({ goal: 'done', end: 'finished', released: true });   // startedAt is there too (the body's own)
    const reservation = out('control--handover-reservation.json') as { cases: Array<{ name: string; handover: any; shieldLowered: boolean; reservationRemoved: boolean }> };
    expect(reservation.cases.map(entry => entry.name)).toEqual(['ok', 'timeout', 'other_holder']);
    for (const entry of reservation.cases) { expect(entry.reservationRemoved).toBe(true); if (entry.handover) expect(['kept', 'lowered', 'none']).toContain(entry.handover.shield); }
    expect(reservation.cases[0]!.handover).toMatchObject({ confirmed: true, shield: 'kept' });
    expect(reservation.cases[1]!.handover).toMatchObject({ confirmed: false, shield: 'lowered' });
    expect(reservation.cases[2]!.handover).toBeNull();
    const stale = out('control--stale-owner-cleanup.json') as { oldRefused: boolean; newKeysKept: boolean };
    expect(stale).toEqual({ oldRefused: true, newKeysKept: true });
    const different = out('control--different-target.json') as { reflexTarget: number; actTarget: number; handover: unknown };
    expect(different.reflexTarget).not.toBe(different.actTarget);
    expect(different.handover).toBeNull();
  });

  it('measure--*: the hand\'s first look has the ids and the holder the head\'s stage rows read; the server tick is a number', () => {
    const start = out('measure--hand-start.json').handStart as Record<string, any>;
    expect(start.kind).toBe('hand_start');   // the contract's {kind, at} (the body's opLog wrote {k, t} before A-4)
    expect(start.k).toBeUndefined();
    expect(start.ids).toMatchObject({ command: expect.any(String), hand: expect.any(Number), life: expect.any(Number), obsSeq: expect.any(Number), obsAt: expect.any(String) });
    expect(['idle', 'command', 'reflex', 'bridge', 'cleanup']).toContain(start.holder.kind);
    expect(start.lastOps).toEqual(expect.any(Array));
    const tick = out('measure--server-tick.json').event as { kind: string; data: { parsedMspt: number; frozen: boolean } };
    expect(tick.kind).toBe('server.tick');
    expect(Number.isFinite(tick.data.parsedMspt)).toBe(true);
    expect(tick.data.frozen).toBe(false);
  });

  it('promise--events-split-delivery: the pages follow each other, the same page is the same page again, and a restart loses the record', () => {
    const made = out('promise--events-split-delivery.json') as { replies: any[]; sameEventsAsFirst: boolean; lostAfterRestart: boolean };
    const [one, two, again] = made.replies;
    expect(two.from).toBe(one.to);
    expect(one.total).toBe(two.total);
    expect(one.done).toBe(false);
    expect(two.done).toBe(true);
    expect(two.nextSeq).toBe(two.total);
    // A-6 9: the pages are the body's real ones: the events are there (not a number), `eventCount` is the count beside them, and each page reads as the head's EventsReply
    for (const page of made.replies) {
      expect(Array.isArray(page.events)).toBe(true);
      expect(page.events).toHaveLength(page.to - page.from);
      expect(page.eventCount).toBe(page.events.length);
      const { eventCount: _count, ...reply } = page;
      expect(readEventsReply(JSON.stringify(reply))?.events.map((item: { id: string }) => item.id)).toEqual(page.events.map((item: { id: string }) => item.id));
      expect(page.events.map((item: { deliverySeq: number }) => item.deliverySeq)).toEqual(Array.from({ length: page.to - page.from }, (_, index) => page.from + index));
    }
    expect(new Set(made.replies.flatMap(page => page.events.map((item: { id: string }) => item.id))).size).toBe(220);   // the third reply is the first again
    expect(again).toEqual(one);
    expect(made.sameEventsAsFirst).toBe(true);
    expect(made.lostAfterRestart).toBe(true);
  });
  it('promise--table-crafted-placed-picked: the events the lines carry; fetched again by  they are gone (lost), and the page is an EventsReply the head reads', () => {
    const made = out('promise--table-crafted-placed-picked.json') as { result: any; page: any };
    const reply = readEventsReply(JSON.stringify(made.page));
    expect(reply).not.toBeNull();
    expect(reply!.events).toHaveLength(reply!.to - reply!.from);
    const carried = readActResult(JSON.stringify(made.result))!.lines.flatMap(line => line.delta ?? []).map(entry => entry.id);
    expect(carried.length).toBeGreaterThan(0);
    // A4: the events the receipt already carried were acknowledged; fetching them again by `events` finds the body's record gone (`lost`), and the page says so (it is
    // what the receipt of the `events` command carries in its `result`, as the head reads it: minecraftControlRecovery.ts). Nothing is invented for them.
    expect(reply).toMatchObject({ lost: true, events: [], from: 0, to: 0, total: 0, done: false });
  });

  it('vertical--*: every stop is one of the 14 closed codes with words; the four numbers of work are there; the time of the next one is estimated from the body\'s msPerUnit', () => {
    // the boundary-2 scene is not a receipt: its own test below
    const verticals = names.filter(name => name.startsWith('vertical--') && name !== 'vertical--boundary2-evidence.json');
    expect(verticals).toHaveLength(3);
    for (const name of verticals) {
      const result = readActResult(JSON.stringify(out(name).result))!;
      const hand = result.lines[0]!;
      expect(hand.do, name).toBe('vertical');
      if (hand.status === 'stopped') {
        expect(Object.keys(VERTICAL_STOP_WORDS), name).toContain(hand.code);
        expect(handFacts(hand).join('\n'), name).toContain(`止まった理由 ${hand.code}:`);
      }
      const work = hand.progress!.work!;
      for (const key of ['dug', 'placeAttempts', 'stockUsed', 'placedConfirmed'] as const) expect(Number.isFinite(work[key]), `${name} ${key}`).toBe(true);
      expect(hand.progress!.unit).toBe('step');
      const shape = name.includes('stairs') ? 'stairs' : name.includes('shaft') ? 'shaft' : 'pillar';
      const next: ActInput = { hands: [{ do: 'vertical', dir: shape === 'pillar' ? 'up' : 'down', shape, ...(shape === 'stairs' ? { toward: 'south' as const } : {}), toY: 10, canDig: ['stone'], liquid: 'stop' }], why: 'x' } as ActInput;
      expect(actExpectedMilliseconds(next, { x: 0, y: 30, z: 0 }, { [shape]: hand.progress!.msPerUnit })).toBeGreaterThan(0);
    }
  });
  it('vertical--boundary2-evidence: a real block_update row keeps its own ISO at and the cell in pos; the correction it made is the one progress.corrected names (A-5 3)', () => {
    const output = (get('vertical--boundary2-evidence.json') as unknown as { output: { corrected: { at: { x: number; y: number; z: number }; now: string; step: number }[]; evidenceRows: Record<string, unknown>[]; done: number } }).output;
    expect(output.evidenceRows.length).toBeGreaterThan(0);
    for (const row of output.evidenceRows) {
      expect(typeof row.at).toBe('string');
      expect(Number.isFinite(Date.parse(String(row.at)))).toBe(true);
      expect(row.pos).toMatchObject({ x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) });
    }
    expect(output.corrected[0]!.at).toEqual(output.evidenceRows[0]!.pos);
    const facts = placementCorrections('q16', JSON.stringify({ v: 1, ok: true, done: 1, of: 1, ms: 1, at: { x: 0, y: 98, z: 1 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'vertical', status: 'done', line: '', progress: { unit: 'step', done: output.done, left: 0, corrected: output.corrected } }] }));
    expect(facts).toHaveLength(output.corrected.length);
    expect(facts[0]!.text).toContain('が無くなった');
  });
  it('vertical--r45-hold7-pillar-up: the four numbers of work agree (A-3: eight placed, eight confirmed, eight of the stock used)', () => {
    const hand = readActResult(JSON.stringify(out('vertical--r45-hold7-pillar-up.json').result))!.lines[0]!;
    expect(hand.progress!.work).toMatchObject({ placeAttempts: 8, placedConfirmed: 8, stockUsed: 8 });
    expect(hand.delta).toEqual([expect.objectContaining({ item: 'cobblestone', count: -8, reason: 'placed' })]);
  });
  it('vertical--r45-hold1-stairs-down: it stopped for no_floor (not displaced, not no_foothold), and the words say which', () => {
    const hand = readActResult(JSON.stringify(out('vertical--r45-hold1-stairs-down.json').result))!.lines[0]!;
    expect(hand.code).toBe('no_floor');
    expect(handFacts(hand).join('\n')).toContain('下りる先に立てる床が無い');
  });

  it('catalog.json: the body\'s whole catalog passes the head\'s own validSkills(), the act has vertical and the 49 fields, and the poll\'s bodyVersion is read', () => {
    const catalog = out('catalog.json') ?? (get('catalog.json') as unknown as Record<string, any>);
    const whole = get('catalog.json') as unknown as { offered: Array<{ name: string; inputSchema: Record<string, any> }>; catalogHash: string; bodyRevision: string; actHandFieldCount: number; internal: string[]; runnable: string[] };
    void catalog;
    expect(validSkills(whole.offered)).toBe(true);
    const act = whole.offered.find(skill => skill.name === 'act')!;
    expect(skillSchema(act.inputSchema)).toBe(true);
    const hand = act.inputSchema.properties.hands.items.properties as Record<string, any>;
    expect(Object.keys(hand)).toHaveLength(whole.actHandFieldCount);
    expect(Object.keys(hand).length).toBeLessThanOrEqual(56);
    expect(hand.do.enum).toContain('vertical');
    expect([...hand.do.enum].sort()).toEqual([...HAND_KINDS].sort());
    expect(Object.keys(hand).sort()).toEqual(Object.keys(ACT_INPUT_SCHEMA.properties.hands.items.properties).sort());
    expect(validBodyVersion({ revision: whole.bodyRevision, catalogHash: whole.catalogHash })).toBe(true);
    expect(whole.internal).toEqual(['events']);
    expect(whole.runnable).toContain('act');
    // the poll that carries the catalog and a receipt is taken whole
    const poll = { ...pollOf([], new Date()), skills: whole.offered, bodyVersion: { revision: whole.bodyRevision, catalogHash: whole.catalogHash } };
    expect(validControlPoll(poll, Date.now())).toBe(true);
  });
});
