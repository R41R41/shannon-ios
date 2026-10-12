import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LEASE_RULES, classifyLease, leaseLive, leaseOutcome, leaseUnsent, type ActionLease, type ActionState, type ActionView } from '@shannon/mind';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import type { MinecraftLifecycleAuthority } from '../src/contracts/minecraftLifecycleContract.js';
import { ActionLeaseReader, actionView, fcaTaskIdOf } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import {
  bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid, conversationLeaseValid, fcaStepLeaseLive, fcaTaskLeaseValid, lifecycleLeaseHeld,
  lostAdmissionExpired,
} from '../src/wiring/actionLeaseRules.js';
import * as old from './support/actionLeaseFixtures.js';

// Syzygy ADR-0009 stage 1, S1: every lease reader moved onto ActionLeaseReader and the one pure `leaseLive`. This table proves,
// for every combination of the lease's columns, that each new reader answers exactly what the predicate it replaced answered.
// The old predicates are copied verbatim from 66a08cd3 into support/actionLeaseFixtures.ts.

type Row = Record<string, unknown>;

const SCOPE = 'owner';
const TASK = 't1';
const LEASE: ActionLease = { id: '', generation: 2, holder: 'h1' };
const ATS = ['2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00Z'];
const TIMES = [null, '2026-10-12T09:59:59.000Z', '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:30.000Z', '2026-10-12T10:00:00Z',
  '2026-10-12T18:59:00+09:00'];
const DEADLINES = [null, '', '2026-10-12T09:00:00.000Z', '2026-10-12T11:00:00.000Z', '2026-10-12T19:30:00+09:00'];
const STATES: ActionState[] = ['queued', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'];
const GENERATIONS = [1, 2, 3, 4];
const HOLDERS = ['h1', 'h2', null];
const LAST_HOLDERS = ['h1', 'h2', null, ''];
const RESULTS = ['lease_expired', 'fca_stop_acknowledged', 'other', null];
const BODY = actionResource('device', 'minecraft-body');
const OWN = actionResource(SCOPE, `fca:${TASK}`);

interface Identity { scope: string; kind: string; origin: string; source: (n: number) => string; parent: string | null; base: string[]; extra: string[] }
const SOURCES = [(n: number) => `fca:${TASK}:${n}`, (n: number) => `fca:${TASK}:x${n}`, (n: number) => `fca:t10:${n}`, (n: number) => `ops:c${n}`,
  (n: number) => `fca:${TASK}::${n}`];
const IDENTITIES: Identity[] = [];
for (const scope of [SCOPE, 'other'])
  for (const kind of ['agentTask', 'respond', 'minecraft', 'ownTime'])
    for (const origin of ['owner_request', 'maintenance', 'own_time'])
      for (const source of SOURCES)
        for (const parent of [null, 'p'])
          for (const base of [[OWN], [], [OWN, BODY].sort()])
            for (const extra of [[], [BODY]]) IDENTITIES.push({ scope, kind, origin, source, parent, base, extra });

interface LeaseColumns { state: ActionState; generation: number; holder: string | null; lastHolder: string | null; sent: number;
  leaseUntil: string | null; deadline: string | null; result: string | null }
function* leaseColumns(): Generator<LeaseColumns> {
  for (const state of STATES) for (const generation of GENERATIONS) for (const holder of HOLDERS) for (const lastHolder of LAST_HOLDERS)
    for (const sent of [0, 1]) for (const leaseUntil of TIMES) for (const deadline of DEADLINES) for (const result of RESULTS)
      yield { state, generation, holder, lastHolder, sent, leaseUntil, deadline, result };
}
/** Lease columns under which some question answers yes, crossed below with every identity (scope, kind, origin, source...). */
const FUTURE = TIMES[3]!;
const PICKED: LeaseColumns[] = [
  { state: 'running', generation: 2, holder: 'h1', lastHolder: 'h1', sent: 0, leaseUntil: FUTURE, deadline: null, result: null },
  { state: 'running', generation: 2, holder: 'h1', lastHolder: 'h1', sent: 1, leaseUntil: FUTURE, deadline: DEADLINES[3]!, result: null },
  { state: 'waiting', generation: 2, holder: 'h1', lastHolder: 'h1', sent: 0, leaseUntil: FUTURE, deadline: null, result: null },
  { state: 'unknown', generation: 3, holder: null, lastHolder: 'h1', sent: 1, leaseUntil: null, deadline: null, result: 'fca_result_unknown' },
  { state: 'cancelled', generation: 3, holder: null, lastHolder: 'h1', sent: 0, leaseUntil: null, deadline: null, result: 'lease_expired' },
  { state: 'cancelled', generation: 2, holder: null, lastHolder: 'h1', sent: 0, leaseUntil: null, deadline: null, result: 'fca_stop_acknowledged' },
];
/** Every lease combination with a rotating identity, then every identity with the picked lease columns. */
function* table(): Generator<{ lease: LeaseColumns; identity: Identity }> {
  let index = 0;
  for (const lease of leaseColumns()) yield { lease, identity: IDENTITIES[(index++ * 7919) % IDENTITIES.length]! };
  for (const identity of IDENTITIES) for (const lease of PICKED) yield { lease, identity };
}

function database() {
  const db = new DatabaseSync(':memory:');
  const store = new SQLiteActionStore(db);
  db.exec(`CREATE TABLE fca_task_checkpoints (task_id TEXT PRIMARY KEY, step_id TEXT, lease_json TEXT, stop_requested INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE minecraft_lifecycle_operations (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, command_json TEXT NOT NULL, receipt_json TEXT);`);
  const insert = db.prepare(`INSERT INTO mind_actions(id,scope_key,kind,origin,source_id,parent_id,state,generation,holder,last_holder,lease_until,
    resources_json,base_resources_json,owner_informed,deadline,progress,result,sent,failures,last_failure,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,?,?,0,NULL,'2026-10-12T00:00:00.000Z',?)`);
  const ids: string[] = [];
  db.exec('BEGIN');
  let n = 0;
  for (const { lease, identity } of table()) {
    const id = `a${n}`;
    const resources = [...new Set([...identity.base, ...identity.extra])].sort();
    insert.run(id, identity.scope, identity.kind, identity.origin, identity.source(n), identity.parent, lease.state, lease.generation, lease.holder,
      lease.lastHolder, lease.leaseUntil, JSON.stringify(resources), JSON.stringify(identity.base), lease.deadline, lease.result, lease.sent,
      `2026-10-12T00:00:${String(n % 60).padStart(2, '0')}.000Z`);
    ids.push(id);
    n += 1;
  }
  db.exec('COMMIT');
  return { db, store, ids, reader: new ActionLeaseReader(db) };
}

const raw = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id) as Row | undefined;
/** The answers each question gave, so that the table is shown to reach every answer (not only `false`). */
const answers = new Map<string, Set<unknown>>();
let compared = 0;
function same(name: string, before: unknown, after: unknown, id: string, at: string) {
  answers.set(name, (answers.get(name) ?? new Set()).add(before));
  compared += 1;
  if (before !== after) expect.fail(`${name} differs for ${id} at ${at}: before ${String(before)}, after ${String(after)}`);
}

describe('one lease read path (ADR-0009 stage 1, S1)', () => {
  const fixture = database();
  const { db, store, ids, reader } = fixture;

  it('reads the same action view as the action store did', () => {
    for (const id of ids) {
      const row = raw(db, id)!;
      const record = reader.get(id)!;
      const { baseResources, ...view } = record;
      expect(view).toEqual(old.storeView(row));
      expect(actionView(row)).toEqual(old.storeView(row));
      expect(baseResources).toEqual(JSON.parse(String(row.base_resources_json)));
    }
    expect(reader.get('missing')).toBeNull();
  });

  it('answers every lease question as the replaced predicates did, for every lease combination', () => {
    for (const id of ids) {
      const row = raw(db, id)!;
      const record = reader.get(id)!;
      const lease = { ...LEASE, id };
      const inScope = reader.inScope(id, SCOPE);
      for (const at of ATS) {
        const view: ActionView = old.storeView(row);
        same('store.check', old.storeCheck(view, lease, at), store.check(lease, at) !== null, id, at);
        same('store.settle.live', old.settleLive(view, lease, at), leaseLive(record, lease, at, LEASE_RULES.live), id, at);
        same('taskRuntime.leaseValid', old.taskLeaseValid(row, SCOPE, TASK, lease, at), fcaTaskLeaseValid(record, SCOPE, TASK, lease, at), id, at);
        same('taskRuntime.conversationLeaseValid', old.conversationLeaseValid(row, SCOPE, lease, at),
          conversationLeaseValid(record, SCOPE, lease, at), id, at);
        same('taskRuntime.classify', old.classify(row, SCOPE, lease, at), leaseOutcome(classifyLease(inScope, lease, at)), id, at);
        same('fcaBody.leaseKnown', old.bodyLeaseKnown(row, SCOPE, lease, TASK, BODY),
          bodyLeaseKnown(bodyLeaseAttempt(record, SCOPE, lease, TASK), BODY), id, at);
        same('fcaBody.leaseValid', old.bodyLeaseValid(row, SCOPE, lease, TASK, BODY, at),
          bodyLeaseValid(bodyLeaseAttempt(record, SCOPE, lease, TASK), lease, BODY, at), id, at);
        for (const origin of ['owner_request', 'own_time'] as const) {
          const authority: MinecraftLifecycleAuthority = { scopeKey: SCOPE, origin, executionId: id, lease, sourceIds: [] };
          same(`lifecycle.allowed.${origin}`, old.lifecycleLease(row, authority, SCOPE, at), lifecycleLeaseHeld(record, authority, SCOPE, at), id, at);
        }
      }
      same('taskRuntime.unsent', old.unsent(row, SCOPE, lease), !!inScope && leaseUnsent(inScope, lease), id, '');
      for (const origin of ['owner_request', 'maintenance']) {
        same(`taskRuntime.recoverAdmission.${origin}`, old.recoverAdmission(row, origin, SCOPE, TASK),
          lostAdmissionExpired(record, origin, SCOPE, TASK), id, '');
      }
    }
    for (const [name, seen] of answers) expect({ name, answers: seen.size }).toEqual({ name, answers: name.endsWith('classify') ? 3 : 2 });
    expect(answers.size).toBe(12);
    expect(compared).toBeGreaterThan(1_000_000);
    // About a million comparisons: ~26 s on a laptop, more on a 2-core CI runner.
  }, 180_000);

  it('finds the action of a task revision and the task of an FCA action as before', () => {
    for (const id of ids.filter((_, index) => index % 13 === 0)) {
      const row = raw(db, id)!;
      for (const kind of ['agentTask', 'respond'] as const) {
        const before = db.prepare('SELECT * FROM mind_actions WHERE scope_key=? AND kind=? AND source_id=?').get(SCOPE, kind, String(row.source_id));
        expect(reader.bySource(SCOPE, kind, String(row.source_id))?.id ?? null).toBe(before ? before.id : null);
      }
      for (const scope of [SCOPE, 'other']) expect(reader.fcaTaskOf(id, scope)).toBe(old.lifecycleTask(db, id, scope));
      expect(fcaTaskIdOf(String(row.source_id))).toBe(old.fcaTaskIdOf(String(row.source_id)));
    }
  });

  it('judges the checkpointed FCA step as the joined row did', () => {
    const variants = [
      { step_id: 's1', lease: (id: string) => JSON.stringify({ ...LEASE, id }), stop: 0 },
      { step_id: 's1', lease: (id: string) => JSON.stringify({ ...LEASE, id }), stop: 1 },
      { step_id: 's2', lease: (id: string) => JSON.stringify({ ...LEASE, id }), stop: 0 },
      { step_id: 's1', lease: (id: string) => JSON.stringify({ ...LEASE, id, holder: 'h2' }), stop: 0 },
      { step_id: 's1', lease: () => 'not json', stop: 0 },
      { step_id: 's1', lease: () => null, stop: 0 },
      { step_id: null, lease: () => null, stop: 0 },
    ];
    for (const id of ids.filter((_, index) => index % 11 === 0)) {
      for (const variant of variants) {
        db.prepare('INSERT OR REPLACE INTO fca_task_checkpoints VALUES(?,?,?,?)').run(TASK, variant.step_id, variant.lease(id), variant.stop);
        const step = { id: 's1', scopeKey: SCOPE, taskId: TASK, lease: { ...LEASE, id } };
        for (const at of ATS) same('fcaShared.stepIsLive', old.fcaStepIsLive(db, step, at), fcaStepLeaseLive(reader.checkpointed(id, TASK), step, at), id, at);
      }
    }
    expect(answers.get('fcaShared.stepIsLive')?.size).toBe(2);
    expect(reader.checkpointed('missing', TASK)).toBeNull();
    expect(reader.checkpointed(ids[0]!, 'no-task')).toBeNull();
  });

  it('lists the unknown lifecycle commands as the joined query did', () => {
    const unknown = ids.filter(id => raw(db, id)!.state === 'unknown').slice(0, 400);
    unknown.forEach((id, index) => {
      const row = raw(db, id)!;
      const generation = Number(row.generation) - (index % 3 === 0 ? 0 : 1);
      const holder = index % 5 === 0 ? 'h9' : row.last_holder;
      const command = { authority: { scopeKey: SCOPE, executionId: id, lease: { id, generation, holder } } };
      db.prepare('INSERT INTO minecraft_lifecycle_operations VALUES(?,?,?,NULL)').run(`o${index}`, id, JSON.stringify(command));
    });
    const before = old.unknownLifecycleCommands(db, BODY);
    expect(before.length).toBeGreaterThan(0);
    expect(reader.unknownLifecycleCommands(BODY)).toEqual(before);
  });
});
