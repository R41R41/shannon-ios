import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_LIMITS } from '@shannon/mind';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { readActionExecutionCounts } from '../src/mind/action/threads/store/actionMetrics.js';
import { countTasksUnknownSince } from '../src/mind/action/taskRuntime/store/taskUnknownMetrics.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { executionDailyLine, startExecutionMonitor, withExecution } from '../src/wiring/executionOpsWiring.js';

/** ADR-0009 stage 1, step 1: the execution metrics of `GET /v1/ops` and the daily log line. */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

const AT = '2026-10-12T00:00:00.000Z';
const later = (milliseconds: number) => new Date(Date.parse(AT) + milliseconds).toISOString();

function store() {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  return { db, actions: new SQLiteActionStore(db) };
}

function claimed(actions: SQLiteActionStore, kind: 'agentTask' | 'ownTime', source: string, resources: string[] = [], at = AT) {
  const origin = kind === 'ownTime' ? 'own_time' : 'owner_request';
  const queued = actions.enqueue({ scopeKey: 'owner', kind, origin, sourceId: source, resources }, at);
  return actions.claim(queued.id, 'runner', at);
}

describe('action execution counts', () => {
  it('count live actions per kind, overdue sent unknowns, and FCA tasks with two live steps', () => {
    const { db, actions } = store();
    expect(readActionExecutionCounts(db, AT)).toEqual({ unknownSentOverdue: 0, liveByKind: {}, sharedResources: 0, multiSegmentTasks: 0,
      retained: { held: 0, oldestAt: null } });
    claimed(actions, 'agentTask', 'fca:task-1:1');
    claimed(actions, 'agentTask', 'fca:task-1:2');
    expect(readActionExecutionCounts(db, AT)).toMatchObject({ liveByKind: { agentTask: 2 }, multiSegmentTasks: 1 });
    // A shared resource is refused by the scheduler; a row that holds one anyway is counted.
    db.prepare("UPDATE mind_actions SET resources_json = ? WHERE kind = 'agentTask'").run(JSON.stringify([actionResource('owner', 'study')]));
    expect(readActionExecutionCounts(db, AT).sharedResources).toBe(1);
  });

  it('count an unknown that still holds its slot past the cutoff', () => {
    const { db, actions } = store();
    const view = claimed(actions, 'ownTime', 'cycle', [actionResource('owner', 'ownTime')])!;
    expect(actions.dispatch(leaseOf(view), AT)).toBe(true);
    // The lease expires; nothing sweeps the released slot yet (the worker is away).
    db.prepare("UPDATE mind_actions SET state = 'unknown', holder = NULL, lease_until = NULL").run();
    expect(readActionExecutionCounts(db, later(ACTION_LIMITS.unknownReleaseMs)).unknownSentOverdue).toBe(1);
    expect(readActionExecutionCounts(db, later(-1)).unknownSentOverdue).toBe(0);
  });

  it('count claim refusals by closed reason in the scheduler\'s process', () => {
    const { actions } = store();
    claimed(actions, 'agentTask', 'one');
    claimed(actions, 'agentTask', 'two');
    expect(claimed(actions, 'agentTask', 'three')).toBeNull();
    const first = claimed(actions, 'ownTime', 'held', [actionResource('owner', 'study')]);
    expect(first).toBeNull();
    expect(actions.claimRefusals()).toEqual({ background_slot: 2 });
  });
});

describe('FCA tasks unknown too long', () => {
  it('count paused fca_unknown tasks by their latest recovery event', () => {
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    expect(countTasksUnknownSince(db, AT)).toBe(0);
    db.exec(`CREATE TABLE agent_tasks (task_id TEXT PRIMARY KEY, status TEXT, pause_reason TEXT, updated_at TEXT);
      CREATE TABLE agent_task_events (task_id TEXT, event_type TEXT, occurred_at TEXT);
      INSERT INTO agent_tasks VALUES ('old', 'paused', 'fca_unknown', '${AT}'), ('new', 'paused', 'fca_unknown', '${AT}'),
        ('stopped', 'paused', 'fca_stopped', '${AT}');
      INSERT INTO agent_task_events VALUES ('new', 'fca_recovery_unknown', '${later(5 * 60_000)}');`);
    expect(countTasksUnknownSince(db, later(60_000))).toBe(1);
    expect(countTasksUnknownSince(db, later(6 * 60_000))).toBe(2);
  });
});

describe('the execution monitor', () => {
  it('shows the counts, the scheduler\'s refusals, sleep and own time, and logs one line a day', async () => {
    const { db } = store();
    const lines: string[] = [];
    const clock = { at: AT };
    const scheduler = { metrics: async () => ({ claimRefusals: { resource_held: 3 }, since: AT }) };
    const liveness = { sleep: { lastCompletedAt: '2026-10-11T18:00:00.000Z' }, ownTime: { lastSessionAt: '2026-10-11T20:00:00.000Z' } };
    const monitor = startExecutionMonitor({ database: db, scheduler: () => scheduler, liveness: () => liveness as never,
      now: () => clock.at, log: line => lines.push(line), intervalMs: null });
    monitor.view();
    await new Promise(resolve => setImmediate(resolve));
    const view = monitor.view();
    expect(view).toMatchObject({ unknownBacklog: { actions: 0, tasks: 0 }, claimRefusals: { since: AT, byReason: { resource_held: 3 } },
      sharedResources: 0, multiSegmentTasks: 0, sleepLastCompletedAt: '2026-10-11T18:00:00.000Z', ownTimeLastSessionAt: '2026-10-11T20:00:00.000Z' });
    monitor.check();
    monitor.check();
    clock.at = '2026-10-13T00:01:00.000Z';
    monitor.check();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Shannon execution daily: unknownActions=0 unknownTasks=0 live=none refusals=resource_held:3 /u);
    expect(executionDailyLine(view, '2026-10-12')).toContain('cacheReadTurns=none');
    expect(withExecution(null, view, {})).toBeNull();
    expect(withExecution({ a: 1 }, view, { days: {} })).toEqual({ a: 1, execution: view, modelCache: { days: {} } });
  });
});

describe('the owner\'s ops server view', () => {
  it('composes self-description, liveness, switch findings, execution and model cache for the owner only', async () => {
    const { configuredOpsServer } = await import('../src/wiring/opsServerWiring.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-ops-server-'));
    const lines: string[] = [];
    const ops = configuredOpsServer({ environment: { SHANNON_FCA_RUNTIME: 'on' }, databasePath: join(directory, 'db.sqlite'), ownerScope: 'owner',
      ownTime: { enabled: false, timeZone: 'Asia/Tokyo' }, describe: scope => scope === 'owner' ? { revision: 'r' } : null,
      mind: () => null, outbox: null, now: () => AT, log: line => lines.push(line) });
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => ops.close());
    expect(lines).toEqual(['Shannon switches: requires_off SHANNON_FCA_RUNTIME needs=SHANNON_ADR8_STAGE4']);
    const view = ops.view('owner') as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(['execution', 'liveness', 'modelCache', 'revision', 'switches']);
    expect(ops.view('guest')).toBeNull();
  });
});
