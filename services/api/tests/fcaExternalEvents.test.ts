import { afterEach, describe, expect, it } from 'vitest';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { actionHarness } from './support/actionThreadHarness.js';

const stops: Array<() => void> = [], at = '2026-10-09T00:00:00.000Z';
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function fixture() {
  const h = actionHarness(() => at); stops.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at, leaseValid: () => true, conversationLeaseValid: () => true });
  const root = runtime.ensureRoot('owner');
  return { ...h, runtime, root };
}
const event = { eventId: 'touch:one', experienceIds: ['existing-experience'], observedAt: at, text: 'Observed one touch, existing reaction already handled.' };

describe('source-bound external task events', () => {
  it('atomically delivers once into exactly one target and preserves the existing canonical memory identity', () => {
    const f = fixture(), task = f.runtime.createChild('owner', f.root.id, { title: 'Watch', goal: 'Watch' }, 'watch');
    f.runtime.wait('owner', task.id, task.revision);
    expect(f.runtime.observeExternal('owner', task.id, event)).toMatchObject({ accepted: true, duplicate: false, task: { phase: 'ready' } });
    expect(f.runtime.observeExternal('owner', task.id, event)).toMatchObject({ accepted: true, duplicate: true });
    expect(f.runtime.snapshot('owner', task.id)?.messages).toHaveLength(1);
    expect(f.runtime.snapshot('owner', f.root.id)?.messages).toEqual([]);
    expect(f.runtime.taskSources('owner', task.id)).toMatchObject([{ kind: 'memory', recalledMemoryIds: ['existing-experience'], observedAt: at }]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM agent_task_events WHERE event_type='fca_external_event'").get()).toEqual({ n: 1 });
    expect(() => f.runtime.observeExternal('owner', f.root.id, event)).toThrow('CONFLICT');
    expect(() => f.runtime.observeExternal('owner', task.id, { ...event, experienceIds: ['different'] })).toThrow('CONFLICT');
    expect(f.runtime.snapshot('owner', task.id)?.messages).toHaveLength(1);
    // This ingress is not a second experience writer.
    expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='experience_events'").get()).toBeUndefined();
  });

  it('rejects cross-scope delivery, preserves stop intent and carries only consumed evidence into descendants', () => {
    const f = fixture(), task = f.runtime.createChild('owner', f.root.id, { title: 'Watch', goal: 'Watch' }, 'watch');
    expect(() => f.runtime.observeExternal('other', task.id, event)).toThrow('NOT_FOUND');
    f.runtime.stop('owner', task.id, 'stop');
    f.runtime.observeExternal('owner', task.id, event);
    expect(f.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(f.runtime.readyTasks('owner').some(item => item.id === task.id)).toBe(false);
  });

  it('reserves foreground delivery for the existing conversation pipeline', () => {
    const f = fixture();
    const step = f.runtime.beginConversation('owner', 'thread', { id: 'respond', holder: 'test', generation: 1 })!;
    f.runtime.observeExternal('owner', step.taskId, event);
    expect(f.runtime.snapshot('owner', step.taskId)?.messages).toHaveLength(1);
    expect(f.runtime.readyTasks('owner').some(item => item.id === step.taskId)).toBe(false);
    // An event arriving after begin is not retroactively attributed to that model snapshot.
    expect(step.messageIds).toEqual([]);
    expect(step.snapshot.sources).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'memory' })]));
  });
});
