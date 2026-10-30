import { afterEach, describe, expect, it } from 'vitest';
import { actionHarness } from './support/actionThreadHarness.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { createOperatorMinecraft, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
const at = '2026-10-31T00:00:00.000Z', closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
function fixture() {
  const h = actionHarness(() => at); closes.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at,
    leaseValid: () => true, conversationLeaseValid: () => true });
  const root = runtime.ensureRoot('owner'); let serial = 0;
  const child = (parent = root.id) => runtime.createChild('owner', parent, { title: `trial-${++serial}`, goal: 'game' }, `r-${serial}`);
  return { ...h, runtime, root, child };
}
describe('run53: stopped history does not exhaust live task capacity', () => {
  it('admits after the production-shaped 51 confirmed stops and 13 live root children, preserving every stopped record', () => {
    const f = fixture(); const stopped = Array.from({ length: 51 }, () => { const t = f.child(); f.runtime.stop('owner', t.id, 'operator_minecraft_stop'); return t.id; });
    const before = stopped.map(id => f.runtime.get('owner', id));
    Array.from({ length: 13 }, () => f.child());
    expect(f.child().phase).toBe('ready');
    expect(stopped.map(id => f.runtime.get('owner', id))).toEqual(before);
    expect(before.every(t => t?.status === 'paused' && t.phase === 'stopped')).toBe(true);
  });
  it('keeps the 64 live-child limit, and checks it before an explicit resume changes a stopped task', () => {
    const f = fixture(), held = f.child(); f.runtime.stop('owner', held.id, 'stop');
    const live = Array.from({ length: 64 }, () => f.child());
    expect(() => f.child()).toThrow('FCA_CHILD_LIMIT');
    const before = f.runtime.get('owner', held.id);
    expect(() => f.runtime.resume('owner', held.id)).toThrow('FCA_CHILD_LIMIT');
    expect(f.runtime.get('owner', held.id)).toEqual(before);
    f.runtime.stop('owner', live[0]!.id, 'stop');
    expect(f.runtime.resume('owner', held.id)?.phase).toBe('ready');
    expect(() => f.child()).toThrow('FCA_CHILD_LIMIT');
  });
  it.each(['stopping', 'unknown'] as const)('continues counting a %s task whose inputs have not been confirmed stopped', phase => {
    const f = fixture(), pending = f.child();
    const step = f.runtime.beginStep('owner', pending.id, { id: 'action', generation: 1, holder: 'test' });
    expect(step).not.toBeNull();
    if (phase === 'stopping') f.runtime.stop('owner', pending.id, 'stop');
    else f.runtime.recover('owner', () => 'unknown');
    expect(f.runtime.get('owner', pending.id)?.phase).toBe(phase);
    Array.from({ length: 63 }, () => f.child());
    expect(() => f.child()).toThrow('FCA_CHILD_LIMIT');
  });
  it('keeps the global 256 live-task limit for admission and resume', () => {
    const f = fixture(), held = f.child(); f.runtime.stop('owner', held.id, 'stop');
    const parents = Array.from({ length: 4 }, () => f.child());
    for (let i = 0; i < 251; i++) f.child(parents[Math.floor(i / 64)]!.id);
    expect(() => f.child(parents[3]!.id)).toThrow('FCA_ACTIVE_TASK_LIMIT');
    expect(() => f.runtime.resume('owner', held.id)).toThrow('FCA_ACTIVE_TASK_LIMIT');
    expect(f.runtime.get('owner', held.id)?.phase).toBe('stopped');
  });
  it.each(['FCA_CHILD_LIMIT', 'FCA_ACTIVE_TASK_LIMIT'])('audits %s as a capacity refusal without starting a task or model', async code => {
    const f = fixture(), audit = new OperatorAuditStore(f.db);
    let wakes = 0;
    const parts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => at, audit,
      lifecycle: null, lifecycleUnresolved: () => false, actions: { list: async () => [] }, activity: () => {}, note: () => {},
      requests: { body: () => 'minecraft:home', get: () => null, admit: () => { throw Error(code); }, wake: () => { wakes++; } } } as unknown as OperatorMinecraftParts;
    const answer = await createOperatorMinecraft(parts).handle({ v: 1, operator: 'run53', domain: 'minecraft', op: 'request', args: { goal: 'defeat the dragon', maxMinutes: 45, budgetYen: 1600, holdOnFailure: true } });
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ outcome: 'refused', code: 'minecraft_busy' });
    expect(audit.recent('owner')[0]).toMatchObject({ event: 'refused', code: 'minecraft_busy', taskId: null });
    expect(wakes).toBe(0);
    expect(f.runtime.list('owner')).toHaveLength(1);
  });
});
