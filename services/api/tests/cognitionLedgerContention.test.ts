import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recomputeLedger, sameDerived } from '@shannon/learning';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

/**
 * Five processes write the cognition ledger at once (Syzygy ADR-0008 stage 1, *Writes and locks*): every write lands, no
 * writer meets SQLITE_BUSY, the lock waits are measured, and the derived values are what a fold of the rows gives.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-cognition-contention-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const writerScript = resolve(import.meta.dirname, 'support/cognitionLedgerWriter.ts');
const repositoryRoot = resolve(import.meta.dirname, '../../..');

function writer(path: string, number: number, rounds: number): Promise<{ failures: string[]; ledger: { writes: number; p99: number }; traces: { writes: number } }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', writerScript, path, String(number), String(rounds)], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.on('error', fail);
    child.on('close', code => {
      if (code !== 0) { fail(new Error(`writer ${number} exited ${code}: ${errors.slice(0, 400)}`)); return; }
      try { done(JSON.parse(output.trim().split('\n').at(-1)!)); } catch (error) { fail(error); }
    });
  });
}

describe('the cognition ledger under five writers', () => {
  it('takes every write without SQLITE_BUSY and keeps its derived values a fold of its rows', async () => {
    const path = join(directory, 'contention.sqlite');
    // The API's store creates the tables, as on the server.
    const api = new SQLiteShannonStore({ path, now: () => new Date().toISOString(), decisionTraces: true, predictionLedger: true });
    const rounds = 60;
    const results = await Promise.all([1, 2, 3, 4, 5].map(number => writer(path, number, rounds)));
    for (const result of results) {
      expect(result.failures).toEqual([]);
      // Each open, settle and trace took the lock once and was measured.
      expect(result.ledger.writes).toBe(rounds * 2);
      expect(result.traces.writes).toBe(rounds);
    }
    const ledger = api.predictionLedger()!;
    const rows = ledger.rows('owner');
    expect(rows).toHaveLength(5 * rounds);
    expect(rows.every(row => row.status === 'matched')).toBe(true);
    // Places in the order of settling are unique and without gaps.
    expect(rows.map(row => row.outcomeSeq).sort((left, right) => left! - right!)).toEqual(Array.from({ length: 5 * rounds }, (_, index) => index + 1));
    const { derived } = recomputeLedger(rows);
    expect(rows.filter(row => !sameDerived(row, derived.get(row.predictionId)!))).toEqual([]);
    expect(api.decisionTraces()!.store.list('owner')).toHaveLength(5 * rounds);
    api.close();
  }, 120_000);
});
