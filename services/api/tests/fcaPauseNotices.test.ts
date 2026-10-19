import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionLease } from '../src/contracts/actionThreadContract.js';
import {
  BODY_ABSENT_SUMMARY, createFcaBodyRecovery, FCA_BODY_RELEASE_ATTEMPTS, RECOVERY_LIMIT_SUMMARY, RELEASE_UNPROVEN_SUMMARY, releaseBackoffMs, STALE_SUMMARY,
} from '../src/wiring/fcaBodyRecovery.js';
import { pausedSummary } from '../src/wiring/taskPauseNotice.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { TaskBodyRecoveryStore } from '../src/mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import type { TaskAuthority } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { bodyOperations } from '../src/surfaces/minecraft/store/minecraftOperationReconcile.js';
import { BODY_ID, minecraftWorld } from './support/fcaBodyRecoveryWorld.js';

/**
 * Fourth round on the FCA recovery (integration review of release/19b): a pause of a Minecraft request tells the owner once (M-2) and
 * says nothing of itself once he resumed it (M-1); a recovery pass reads only body tasks' steps (L-1) and finds the tasks that owe a
 * notice without matching text (L-2); a pass that does not pause says so nowhere, and one task's failure stops no other (L-5).
 */
const worlds: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const world of worlds.splice(0).reverse()) await world.close(); });
const MINUTE = 60_000;
function world(options: Parameters<typeof minecraftWorld>[0] = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const w = minecraftWorld(options);
  worlds.push(w);
  return w;
}
type World = ReturnType<typeof world>;
const skillCommands = <T extends { kind: string }>(body: { commands: T[] }) => body.commands.filter(command => command.kind === 'skill');
const releaseCommands = (body: { commands: Array<{ kind: string }> }) => body.commands.filter(command => command.kind === 'release');
async function ticks(api: ReturnType<World['startApi']>, count: number) {
  for (let i = 0; i < count; i++) {
    await api.driver.tick();
    await delay(2);
  }
}
/** A request whose first step sent the body one skill, which it holds without ever answering, when the API dies; and the API started again. */
async function strandedSkill(w: World) {
  const first = w.startApi();
  const task = w.createTask(first);
  const body = w.connectBody(first, 'c1', 'hold');
  w.script.push(() => w.moves());
  await w.until(first, () => skillCommands(body).length === 1, 'the skill is sent to the body');
  await w.crash(first, body);
  return { task, api: w.startApi() };
}
const reportOf = (w: World, api: ReturnType<World['startApi']>) => api.driver.runtime.progress!('owner', w.task.id)?.report;
/** How many reports (`fca.result`) were written for the task: a tool's own progress is not counted. */
const observed = (w: World) => (w.db.prepare("SELECT COUNT(*) AS n FROM agent_task_events WHERE task_id=? AND event_type='fca_progress_observed' AND json_extract(payload_json,'$.tool')='fca.result'")
  .get(w.task.id) as { n: number }).n;
const REPORT = (summary: string) => `「マイクラ」は、${summary}`;

describe('every pause of a Minecraft request tells the owner once (M-2)', () => {
  it('body_not_returned: the report names the reason and that it can be resumed, and is not repeated while it stays paused', async () => {
    const w = world();
    const { task, api } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    expect(reportOf(w, api)).toBeUndefined(); // an unknown request is not a paused one: nothing yet
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    expect(api.driver.runtime.progress!('owner', task.id)).toMatchObject({ currentStep: 'fca.result', status: 'failed' });
    expect(reportOf(w, api)?.text).toBe(REPORT(BODY_ABSENT_SUMMARY)); // without the operator's hint, which is in the summary only
    expect(reportOf(w, api)?.text).toContain('再開できます');
    expect(reportOf(w, api)?.id.startsWith('paused:body_not_returned:')).toBe(true);
    await ticks(api, 20);
    w.advance(10 * MINUTE);
    await ticks(api, 20);
    expect(observed(w)).toBe(1);
  });

  it('stale: tells the owner once', async () => {
    const w = world();
    const first = w.startApi();
    w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    w.kill(body);
    w.advance(8 * 60 * MINUTE);
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'stopped', 'paused as stale');
    expect(reportOf(w, api)?.text).toBe(REPORT(STALE_SUMMARY));
    expect(reportOf(w, api)?.id.startsWith('paused:stale:')).toBe(true);
    await ticks(api, 20);
    expect(observed(w)).toBe(1);
  });

  it('recovery_limit: tells the owner once', async () => {
    const w = world({ limit: { count: 2, withinMs: 60 * MINUTE } });
    let api = w.startApi();
    w.createTask(api);
    let body = w.connectBody(api, 'c1', 'complete');
    for (let round = 1; round <= 3; round++) {
      w.script.push(w.hangs);
      await w.until(api, () => w.modelInputs.length === round, `decision ${round} is asked`);
      await w.crash(api, body);
      api = w.startApi();
      body = w.connectBody(api, `c${round + 1}`, 'complete');
      if (round < 3) await w.until(api, () => w.events().filter(event => event === 'fca_body_recovered').length === round, `recovery ${round}`);
    }
    await w.until(api, () => w.phase(api) === 'stopped', 'paused at the limit');
    expect(reportOf(w, api)?.text).toBe(REPORT(RECOVERY_LIMIT_SUMMARY));
    expect(reportOf(w, api)?.id.startsWith('paused:recovery_limit:')).toBe(true);
    await ticks(api, 20);
    expect(observed(w)).toBe(1);
  });

  it('fca_body_release_unproven: tells the owner once, after the last ask', async () => {
    const w = world({ windowMs: 600 * MINUTE });
    const { api } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'unknown-release');
    await w.until(api, () => releaseCommands(body).length === 1, 'the first release is asked');
    await api.recovery.idle();
    for (let asked = 1; asked < FCA_BODY_RELEASE_ATTEMPTS; asked++) {
      w.advance(releaseBackoffMs(asked) + 1_000);
      await w.until(api, () => releaseCommands(body).length === asked + 1, `release ${asked + 1} is asked`);
      await api.recovery.idle();
    }
    await w.until(api, () => w.phase(api) === 'stopped', 'paused when the attempts are used up');
    expect(reportOf(w, api)?.text).toBe(REPORT(RELEASE_UNPROVEN_SUMMARY));
    expect(reportOf(w, api)?.id.startsWith('paused:fca_body_release_unproven:')).toBe(true);
    await ticks(api, 20);
    expect(observed(w)).toBe(1);
  }, 30_000);

  it('a resumed request stopped again for want of its body tells the owner again, once, in place of the report he resumed away', async () => {
    const w = world();
    const { task, api } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    expect(api.driver.runtime.progress!('owner', task.id)).toBeNull();
    await ticks(api, 10);
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'stopped when the window ran out');
    expect(reportOf(w, api)?.text).toBe(REPORT(BODY_ABSENT_SUMMARY));
    expect(reportOf(w, api)?.id.startsWith('paused:body_not_returned:')).toBe(true);
    await ticks(api, 20);
    expect(observed(w)).toBe(2); // the first pause, and this one
  });
});

describe('what a pause said is gone when the owner resumes the request (M-1)', () => {
  it('clears the summary and the report at the resume, and the result he gets is the task\'s own', async () => {
    const w = world();
    const { task, api } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    expect(pausedSummary(api.driver.runtime.get('owner', task.id)!.summary)).toBe(true); // with the operator's hint
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe('');
    expect(api.driver.runtime.progress!('owner', task.id)).toBeNull();
    w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.phase(api) === 'completed', 'goes on once the body is back');
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe('done');
    expect(reportOf(w, api)?.text).toBe('done'); // not the pause report: a report already there would have stayed the result
  });

  it('recognises the words of the pauses and nothing else', () => {
    expect([BODY_ABSENT_SUMMARY, RECOVERY_LIMIT_SUMMARY, STALE_SUMMARY, RELEASE_UNPROVEN_SUMMARY].every(pausedSummary)).toBe(true);
    expect(pausedSummary('「採掘」は、確定していない利用料の見積りを含めると上限（2000円）に近づいたので、いったん止めました。再開できます。')).toBe(true);
    expect(pausedSummary('')).toBe(false);
    expect(pausedSummary('石を3個集めました。')).toBe(false);
    expect(pausedSummary('「採掘」は1件の上限（300円・40歩）に達したので、ここで止めました。')).toBe(false); // a failure's words stay
  });
});

describe('a recovery pass reads the steps of body tasks only (L-1)', () => {
  async function lostStep() {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    return { w, task };
  }

  it('asks the question of the step\'s task before the per-step queries, and leaves a task that is not wanted out', async () => {
    const { w, task } = await lostStep();
    const reader = new ActionLeaseReader(w.db);
    const asked: string[] = [];
    expect(reader.lostFcaSteps('owner', w.now(), id => { asked.push(id); return false; })).toEqual([]);
    expect(asked).toEqual([task.id]);
    const spy = vi.spyOn(w.db, 'prepare');
    reader.lostFcaSteps('owner', w.now(), () => false);
    expect(spy.mock.calls.filter(([sql]) => String(sql).includes('fca_step_started'))).toHaveLength(0);
    spy.mockClear();
    expect(reader.lostFcaSteps('owner', w.now(), id => id === task.id)).toHaveLength(1);
    expect(spy.mock.calls.filter(([sql]) => String(sql).includes('fca_step_started')).length).toBeGreaterThan(0);
    expect(reader.lostFcaSteps('owner', w.now())).toHaveLength(1); // without a question, every step, as before
  });

  it('finds a task\'s body operations by the task first (indexed), and the same ones as without it', async () => {
    const w = world();
    const { task, api } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const row = w.db.prepare("SELECT command_json FROM fca_body_operations WHERE json_extract(command_json,'$.kind')='skill'").get() as { command_json: string };
    const lease = (JSON.parse(row.command_json) as { lease: ActionLease }).lease;
    expect(bodyOperations(w.db, lease, 'owner', task.id)).toHaveLength(1);
    expect(bodyOperations(w.db, lease, 'owner', task.id)).toEqual(bodyOperations(w.db, lease, 'owner'));
    expect(bodyOperations(w.db, lease, 'owner', 'another-task')).toEqual([]);
    const indexes = (w.db.prepare("PRAGMA index_list('fca_body_operations')").all() as Array<{ name: string }>).map(index => index.name);
    expect(indexes).toContain('fca_body_operations_task');
    const plan = w.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM fca_body_operations WHERE task_id=? AND json_extract(command_json,'$.lease.id')=?").all('t', 'l') as Array<{ detail: string }>;
    expect(plan.map(step => step.detail).join(' ')).toContain('fca_body_operations_task');
  });
});

describe('the tasks that owe a notice are found by their checkpoint\'s key, not by text (L-2)', () => {
  it('counts a task whose checkpoint holds the notices, and no task whose checkpoint only mentions the word', () => {
    const w = world();
    const api = w.startApi();
    const root = api.driver.runtime.ensureRoot('owner');
    const make = (name: string) => api.driver.runtime.createChild('owner', root.id, { title: name, goal: name }, name).id;
    const [owing, mention, empty, broken, none] = ['owing', 'mention', 'empty', 'broken', 'none'].map(make) as [string, string, string, string, string];
    const set = (id: string, json: string | null) => w.db.prepare('UPDATE fca_task_checkpoints SET checkpoint_json=? WHERE task_id=?').run(json, id);
    set(owing, JSON.stringify({ fcaBodyRecoveries: [], fcaOwedNotices: [{ actionId: 'a1', lease: null, startedAt: null, lostAt: null }] }));
    set(mention, JSON.stringify({ note: 'the key fcaOwedNotices is only named here', fcaOwedNotices_other: [1] }));
    set(empty, JSON.stringify({ fcaOwedNotices: [] }));
    set(broken, '{ fcaOwedNotices');
    set(none, null);
    expect(new TaskBodyRecoveryStore(w.db).owingTaskIds('owner')).toEqual([owing]);
  });
});

describe('a pass that does not pause says nothing of it, and one task\'s failure stops no other (L-5)', () => {
  /** A recovery of the world's database whose authority can be made to answer as if another pass had got there first, or to fail for one task. */
  function lone(w: World, api: ReturnType<World['startApi']>) {
    const real = new SQLiteFcaTaskAuthority(w.db);
    const logs: string[] = [];
    const control: { inTransaction: number; moved: boolean; failFor: string | null } = { inTransaction: 0, moved: false, failFor: null };
    const authority = new Proxy(real, { get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'transaction') {
        return (work: () => unknown) => {
          control.inTransaction++;
          try { return target.transaction(work); } finally { control.inTransaction--; }
        };
      }
      if (property === 'get') {
        return (scope: string, id: string) => {
          if (control.failFor === id && control.inTransaction === 0) throw new Error('FCA_STORE_BUSY');
          const task = target.get(scope, id);
          return task && control.moved && control.inTransaction > 0 ? { ...task, pauseReason: null } : task; // the pause finds the task no longer unknown
        };
      }
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    } }) as unknown as TaskAuthority;
    const recovery = createFcaBodyRecovery({ db: w.db, authority, runtime: api.driver.runtime, actions: w.actions, scopeKey: 'owner', now: w.now, running: () => false,
      passMs: 0, log: line => logs.push(line),
      body: { bound: () => BODY_ID, connected: () => false, release: async () => ({ code: 'recheck_busy', actionIds: [], detail: '' }) } });
    const unknown = (id: string) => real.event('owner', id, 'fca_recovery_unknown', w.now(), { status: 'paused', pauseReason: 'fca_unknown' }, {});
    return { logs, control, recovery, unknown };
  }
  const child = (api: ReturnType<World['startApi']>, name: string) => {
    const root = api.driver.runtime.ensureRoot('owner');
    return api.driver.runtime.createChild('owner', root.id, { title: name, goal: name }, name);
  };

  it('logs no pause, writes no report and changes no state when the task is not unknown by the time the pause looks', () => {
    const w = world();
    const api = w.startApi();
    const task = child(api, 'one');
    const f = lone(w, api);
    f.unknown(task.id);
    w.advance(31 * MINUTE);
    f.control.moved = true;
    f.recovery.expire();
    expect(f.logs.filter(line => line.includes('code=paused'))).toEqual([]);
    expect(api.driver.runtime.progress!('owner', task.id)).toBeNull();
    f.control.moved = false;
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_unknown' });
    f.recovery.expire(); // and when it is still unknown, it is paused and said so, once
    expect(f.logs.filter(line => line.includes(`task=${task.id} code=paused reason=body_not_returned`))).toHaveLength(1);
    expect(api.driver.runtime.get('owner', task.id)?.phase).toBe('stopped');
  });

  it('pauses the other tasks when the pause of one fails, and says which failed', () => {
    const w = world();
    const api = w.startApi();
    const one = child(api, 'one'), two = child(api, 'two'), three = child(api, 'three');
    const f = lone(w, api);
    for (const task of [one, two, three]) f.unknown(task.id);
    w.advance(31 * MINUTE);
    f.control.failFor = two.id;
    f.recovery.expire();
    expect(api.driver.runtime.get('owner', one.id)?.phase).toBe('stopped');
    expect(api.driver.runtime.get('owner', three.id)?.phase).toBe('stopped');
    expect(api.driver.runtime.get('owner', two.id)?.phase).toBe('unknown');
    expect(f.logs).toContain(`Shannon FCA body recovery task=${two.id} code=expire_failed`);
    expect(f.logs.join('\n')).not.toContain('goal');
    f.control.failFor = null;
    f.recovery.expire(); // the next tick tries the failed one again
    expect(api.driver.runtime.get('owner', two.id)?.phase).toBe('stopped');
  });
});
