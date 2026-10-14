import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { WAITING_WITH_INBOX_SQL } from '../src/mind/action/taskRuntime/store/taskInboxRedelivery.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { round } from './support/fcaIntegratedHarness.js';

/**
 * The lost-wakeup sweep (`wakePendingInboxes`) runs every tick inside the write lock, and `fca_task_messages` is never pruned.
 * Review of 6bb8d9ff: the first sweep scanned every message of the scope (200k messages, 528 ms a tick). It must start from the
 * scope's running tasks and ask only the inbox index whether an unconsumed message exists.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function fixture() {
  const now = () => '2026-10-14T03:00:00.000Z';
  // A small page puts `consumed_by` (after `text`) on overflow pages, as production's long texts do, at a test-sized table.
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA page_size=1024');
  const h = actionHarness(now, ':memory:', db);
  const model: FcaModel = { decide: async () => round({ kind: 'wait', summary: 'waiting' }), toolResults: results => ({ results }) };
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now });
  cleanups.push(async () => { await driver.close(); db.close(); });
  const root = driver.runtime.ensureRoot('owner');
  return { ...h, driver, root, now };
}

/** Consumed history like production's: a large text column puts `consumed_by` on overflow pages for a table scan. */
function fillConsumed(f: ReturnType<typeof fixture>, count: number, targetId: string): void {
  const insert = f.db.prepare(`INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at,consumed_by)
    VALUES('owner',?,?,?,?,?,'step-old')`);
  const text = 'x'.repeat(1200);
  f.db.exec('BEGIN');
  for (let i = 0; i < count; i++) insert.run(`history-${i}`, targetId, targetId, text, f.now());
  f.db.exec('COMMIT');
}

function plan(f: ReturnType<typeof fixture>): string[] {
  return f.db.prepare(`EXPLAIN QUERY PLAN ${WAITING_WITH_INBOX_SQL}`).all('owner').map(row => String(row.detail));
}

describe('the lost-wakeup sweep reads the inbox index, never the message table', () => {
  it('plans a covering lookup of fca_task_inbox and no scan of the messages, before and after ANALYZE', () => {
    const f = fixture();
    fillConsumed(f, 2_000, f.root.id);
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const details = plan(f);
      expect(details.some(detail => /^SEARCH m (EXISTS )?USING COVERING INDEX fca_task_inbox \(target_task_id=\? AND consumed_by=\?\)$/u.test(detail)), details.join('\n')).toBe(true);
      expect(details.some(detail => /SCAN m\b|SCAN fca_task_messages|sqlite_autoindex_fca_task_messages/u.test(detail)), details.join('\n')).toBe(false);
    }
  });

  it('stays fast with a large never-pruned message table, and still wakes the one waiting task', () => {
    const f = fixture();
    fillConsumed(f, 30_000, f.root.id);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting'); // a candidate: its inbox is asked every sweep
    const timings: number[] = [];
    for (let i = 0; i < 21; i++) {
      const at = performance.now();
      expect(f.driver.runtime.wakePendingInboxes!('owner')).toEqual([]);
      timings.push(performance.now() - at);
    }
    timings.sort((a, b) => a - b);
    // What reading the scope's messages costs here (the first sweep's shape): the sweep must cost a small fraction of it.
    const scans: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      f.db.prepare("SELECT count(*) AS n FROM fca_task_messages WHERE scope_key='owner' AND consumed_by IS NULL").get();
      scans.push(performance.now() - at);
    }
    scans.sort((a, b) => a - b);
    expect(timings[10]!, `sweep median ${timings[10]} ms, scope scan median ${scans[2]} ms`).toBeLessThan(scans[2]! / 10);
    // The lost wakeup the sweep exists for: one unconsumed message, the root waiting for messages, nothing woke it.
    f.db.prepare(`INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at)
      VALUES('owner','result:pending',?,?,'child: failed',?)`).run(f.root.id, f.root.id, f.now());
    expect(f.driver.runtime.wakePendingInboxes!('owner').map(task => task.id)).toEqual([f.root.id]);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('ready');
  });
});
