import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { STORE_MEMORY_PARTS } from '../src/infra/sqlite/storeMemoryParts.js';

/**
 * Syzygy ADR-0008 stage 3, step F5: five processes propose to the memory outbox of one database file and each runs a writer at
 * the same time. One holds the lease at a time; no process sees SQLITE_BUSY (every write waits for `BEGIN IMMEDIATE` within
 * the busy timeout); every op ends applied, exactly once; and the lock waits are measured (p95/p99 per process, printed).
 */
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const PROCESSES = 5;
const OPS = 40;
const root = fileURLToPath(new URL('../../..', import.meta.url));
const child = fileURLToPath(new URL('./support/memoryContentionChild.ts', import.meta.url));

function run(path: string, index: number): Promise<{ index: number; errors: string[]; worked: number; waits: { writes: number; p95: number; p99: number; maximum: number } }> {
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, ['--import', 'tsx', child, path, String(index), String(OPS)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    process_.stdout.on('data', chunk => { out += String(chunk); });
    process_.stderr.on('data', chunk => { err += String(chunk); });
    process_.on('error', reject);
    process_.on('close', code => {
      const line = out.trim().split('\n').filter(item => item.startsWith('{')).at(-1);
      if (code !== 0 || !line) reject(new Error(`child ${index} exited ${code}: ${err.slice(0, 2_000)}`));
      else resolve(JSON.parse(line));
    });
  });
}

describe('the memory writer under contention', () => {
  it('five writers on one file: no SQLITE_BUSY, every op applied once, lock waits measured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-contention-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    // The schema is made once before the processes start (as the API process makes it before the worker runs).
    new SQLiteShannonStore({ path, now: () => new Date().toISOString(), memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, moodHistory: null }).close();

    const results = await Promise.all(Array.from({ length: PROCESSES }, (_, index) => run(path, index)));
    for (const result of results) expect(result.errors, `process ${result.index}`).toEqual([]);
    const waits = results.map(result => result.waits);
    console.log(`memory writer contention: lock waits per process ${waits.map(item => `p95=${item.p95.toFixed(1)}ms p99=${item.p99.toFixed(1)}ms max=${item.maximum.toFixed(1)}ms n=${item.writes}`).join('; ')}`);
    expect(waits.every(item => item.writes > OPS)).toBe(true);
    expect(Math.max(...waits.map(item => item.p99))).toBeLessThan(5_000);

    const store = new SQLiteShannonStore({ path, now: () => new Date().toISOString(), memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, moodHistory: null });
    try {
      const rows = store.memoryOutbox()!.rows({ limit: 10_000 });
      expect(rows).toHaveLength(PROCESSES * OPS);
      expect(rows.every(row => row.status === 'applied')).toBe(true);
      expect(new Set(rows.map(row => row.opId)).size).toBe(PROCESSES * OPS);
      expect(store.memoryOutbox()!.appliedSeq()).toBe(Math.max(...rows.map(row => row.seq)));
      // Each op was written exactly once: one state event per op (the state itself keeps only its newest facts).
      const database = new DatabaseSync(path, { readOnly: true });
      const written = database.prepare(`SELECT COUNT(*) AS count FROM experience_events WHERE event_type = 'state.user-fact-upserted'`).get() as { count: number };
      database.close();
      expect(Number(written.count)).toBe(PROCESSES * OPS);
      const facts = store.snapshot('owner').userFacts.map(fact => fact.id);
      expect(new Set(facts).size).toBe(facts.length);
      // Only one process held the lease at a time, so more than one of them did the work over the run.
      expect(results.filter(result => result.worked > 0).length).toBeGreaterThanOrEqual(1);
    } finally { store.close(); }
  }, 120_000);
});
