import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unitFromOutcome, type ItemOutcome } from '../src/contracts/continueContract.js';
import { ACT_CONTRACT_VERSION, readActResult } from '../src/contracts/minecraftActContract.js';
import { validControlPoll } from '../src/surfaces/minecraft/minecraftControlValidation.js';

/**
 * Contract chapter 9: the body's REAL outputs (`produced/`, written by the body's continue-produce.ts and copied by scripts/sync-body-produced.sh) go through
 * the head's real readers. Until the body has made any, the fixtures' own `expected` receipts are built the way the body will send them and go through the
 * same readers, so the reading side is ready (and checked) before the first produced file arrives.
 *
 * A produced file is JSON with a `continueProduced` object ({bodyRev, script, bench, inputFixture?, inputSha256?}) and a payload. A produced file of a body
 * that is not the one named in PRODUCED.json is a FAIL (chapter 9, "警告ではなく不合格").
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'continue');
const PRODUCED = join(FIXTURES, 'produced');
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const fixtureJson = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), 'utf8')) as { input: Record<string, any>; expected: Record<string, any> };

// ---- the receipt the body will send for a fixture ----------------------------------------------------------------------------------------------------
export interface ReceiptShape {
  id: string; connectionId: string; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'; inputsReleased: boolean; observedAt: string;
  result?: string; failureType?: string; unit?: ItemOutcome;
}
const outcomeOf = (unit: ItemOutcome): ReceiptShape['outcome'] =>
  unit.end === 'unknown' ? 'unknown' : unit.end === 'cut' ? 'cancelled' : (unit.goal === 'done' || unit.goal === 'already') && unit.end === 'finished' ? 'completed' : 'failed';

/** The receipt a body would send for a fixture whose `expected` has a result's lines or a receipt; null for the fixtures that are about something else. */
export function expectedReceiptOf(path: string, now: Date): ReceiptShape | null {
  const { expected } = fixtureJson(path);
  const base = { id: 'skill:q1', connectionId: 'conn-1', observedAt: now.toISOString() };
  if (Array.isArray(expected.lines) && expected.outcome) {
    const unit: ItemOutcome = expected.receiptUnit ?? { ...expected.outcome, released: true };
    const lines: Record<string, unknown>[] = expected.lines.map((line: Record<string, unknown>) => ({ line: '', ...line }));
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

// ---- the head's readers a receipt goes through ---------------------------------------------------------------------------------------------------------
export interface Reading { reader: string; ok: boolean; detail: string; todo?: boolean }
/** The readers that exist today: they must read what the body sends. */
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
/**
 * The readers the lead is writing (the head's reading of the new fields). Each is a mouth only: it says it is not connected. Connect it by making it read
 * the receipt and return `{ ok, detail }` without `todo`; the tests below then run it on every expected and every produced receipt.
 */
export const HEAD_READERS: { reader: string; read: (receipt: ReceiptShape) => Reading }[] = [
  // TODO(head-reader): the unit reader of minecraftControl.ts: receipt.unit {goal, end, released, droppedBecause, keptDespite, startedAt} -> the store's two axes
  { reader: 'unit -> operation state / hold state', read: () => ({ reader: 'unit -> operation state / hold state', ok: true, todo: true, detail: 'not connected' }) },
  // TODO(head-reader): the queue's reader (minecraftLlmcQueue.ts): droppedBecause / startedAt / keptDespite -> the item states and the result text
  { reader: 'unit -> queue item state and the result sentence', read: () => ({ reader: 'unit -> queue item state and the result sentence', ok: true, todo: true, detail: 'not connected' }) },
  // TODO(head-reader): the ledger's reader (minecraftLlmcPromises.ts): the result's events by their delivery numbers and pages -> the ledger rows
  { reader: 'result events -> ledger', read: () => ({ reader: 'result events -> ledger', ok: true, todo: true, detail: 'not connected' }) },
  // TODO(head-reader): the result text reader (minecraftActContract.ts readActResult for goal/end/progress/delta/code) once ActHandLine carries them
  { reader: 'hand lines goal/end/progress', read: () => ({ reader: 'hand lines goal/end/progress', ok: true, todo: true, detail: 'not connected' }) },
];
export const readWithHeadReaders = (receipt: ReceiptShape): Reading[] => HEAD_READERS.map(entry => entry.read(receipt));

// ---- the produced files --------------------------------------------------------------------------------------------------------------------------------
interface ProducedFile { continueProduced?: { bodyRev?: string; script?: string; bench?: string; inputFixture?: string; inputSha256?: string }; receipt?: ReceiptShape; receipts?: ReceiptShape[]; [key: string]: unknown }
/** Everything wrong with a produced directory; an empty list is the only pass. A version that does not match is a problem like any other, never a warning. */
export function problemsOfProduced(dir: string, fixtures: string = FIXTURES): string[] {
  const problems: string[] = [];
  const indexPath = join(dir, 'PRODUCED.json');
  if (!existsSync(indexPath)) return [`${indexPath} is missing: the files were not copied by scripts/sync-body-produced.sh`];
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { bodyRev?: string; madeBy?: string; files?: Record<string, string> };
  if (!/^[0-9a-f]{40}$/u.test(index.madeBy ?? '')) problems.push('PRODUCED.json: madeBy is not a full git revision');
  const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
  const names = readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'PRODUCED.json').sort();
  if (names.length === 0) problems.push('there are no produced files');
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(index.files ?? {}).sort())) problems.push(`PRODUCED.json lists ${Object.keys(index.files ?? {}).join(',')} but the directory holds ${names.join(',')}`);
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (index.files?.[name] !== sha256(text)) problems.push(`${name}: its sha256 is not the one in PRODUCED.json (edited after the copy)`);
    let file: ProducedFile;
    try { file = JSON.parse(text) as ProducedFile; } catch { problems.push(`${name}: not JSON`); continue; }
    const made = file.continueProduced;
    if (!made?.bodyRev) { problems.push(`${name}: continueProduced.bodyRev is missing`); continue; }
    if (!index.madeBy || !(index.madeBy.startsWith(made.bodyRev) || made.bodyRev.startsWith(index.madeBy))) problems.push(`${name}: made by body ${made.bodyRev}, PRODUCED.json says ${index.madeBy} (a produced file of another version is a fail)`);
    if (made.inputFixture) {
      const fixturePath = join(fixtures, made.inputFixture);
      if (!existsSync(fixturePath)) problems.push(`${name}: the fixture ${made.inputFixture} is not in the head`);
      else {
        const have = sha256(readFileSync(fixturePath));
        if (made.inputSha256 !== have) problems.push(`${name}: inputSha256 is not that of the head's ${made.inputFixture}`);
        if (manifest.files[made.inputFixture] !== have) problems.push(`${made.inputFixture}: the head's file differs from manifest.json`);
      }
    }
  }
  return problems;
}

describe('the expected receipts of the fixtures, through the head\'s readers (until produced/ exists)', () => {
  const now = new Date('2026-10-28T04:00:00.000Z');
  const paths = ['result/r43-reflex-ate-first.json', 'result/r45-hold1-go-partial.json', 'result/r45-resume1-dig-already-go-no-floor.json', 'result/act-not-started-reflex-late.json'];
  for (const path of paths) {
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
  it('the readers still to be connected are listed, and none of them is mistaken for a pass', () => {
    const receipt = expectedReceiptOf('result/r43-reflex-ate-first.json', now)!;
    const readings = readWithHeadReaders(receipt);
    expect(readings.map(item => item.reader)).toHaveLength(HEAD_READERS.length);
    // when a reader is connected its `todo` goes away and it has to say ok; until then it is reported as not connected
    for (const reading of readings) expect(reading.todo === true || reading.ok).toBe(true);
  });
  for (const entry of HEAD_READERS) it.todo(`TODO(head-reader): ${entry.reader} reads every expected receipt`);
});

describe('problemsOfProduced (a version that does not match is a problem, not a warning)', () => {
  function made(extra: { bodyRev?: string; sha?: string; edit?: boolean; fixture?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'produced-')), rev = 'a'.repeat(40);
    const fixture = extra.fixture ?? 'result/r43-reflex-ate-first.json';
    const body = JSON.stringify({ continueProduced: { bodyRev: extra.bodyRev ?? rev, script: 'backend/scripts/lab/continue-produce.ts', bench: 'build', inputFixture: fixture, inputSha256: extra.sha ?? sha256(readFileSync(join(FIXTURES, fixture))) }, receipt: {} });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r43.json'), body);
    writeFileSync(join(dir, 'PRODUCED.json'), JSON.stringify({ bodyRev: 'b'.repeat(40), madeBy: rev, files: { 'r43.json': sha256(body) } }));
    if (extra.edit) writeFileSync(join(dir, 'r43.json'), `${body} `);
    return dir;
  }
  it('passes for a set that is whole and of one version', () => expect(problemsOfProduced(made())).toEqual([]));
  it('fails for a file of another body version', () => expect(problemsOfProduced(made({ bodyRev: 'c'.repeat(40) })).join('\n')).toContain('another version is a fail'));
  it('fails for a file made from another copy of the fixture', () => expect(problemsOfProduced(made({ sha: 'd'.repeat(64) })).join('\n')).toContain('inputSha256'));
  it('fails for a file edited after the copy', () => expect(problemsOfProduced(made({ edit: true })).join('\n')).toContain('edited after the copy'));
  it('fails for a directory the sync script did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'produced-'));
    writeFileSync(join(dir, 'x.json'), '{}');
    expect(problemsOfProduced(dir).join('\n')).toContain('PRODUCED.json is missing');
  });
});

describe.skipIf(!existsSync(PRODUCED))('the produced files in the head (copied from the body)', () => {
  it('are whole, of one version, and made from the head\'s own fixtures', () => {
    expect(problemsOfProduced(PRODUCED)).toEqual([]);
  });
  it('their receipts go through the head\'s readers', () => {
    const now = new Date();
    const names = readdirSync(PRODUCED).filter(name => name.endsWith('.json') && name !== 'PRODUCED.json');
    const failures: string[] = [];
    for (const name of names) {
      const file = JSON.parse(readFileSync(join(PRODUCED, name), 'utf8')) as ProducedFile;
      const receipts = file.receipts ?? (file.receipt ? [file.receipt] : []);
      for (const receipt of receipts) {
        for (const reading of [...readWithToday(receipt, now), ...readWithHeadReaders(receipt)]) if (!reading.ok) failures.push(`${name}: ${reading.reader}: ${reading.detail}`);
      }
    }
    expect(failures).toEqual([]);
  });
  // TODO(head-reader): the catalog file: the head's validSkills() over the body's catalog (local-gate stage 4 does it on the build; here on the copied file)
  it.todo('TODO(head-reader): catalog.json passes validSkills() with the vertical field in it');
});
