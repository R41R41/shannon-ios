import { observeAsync, observerHandoff, withObserverRun, withObserverRunSync, withScopedObserverTask } from '../infra/observer/observerContext.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { actionResource, type ActionThreads, type ActionLease, type RunningAction } from '../contracts/actionThreadContract.js';
import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaTouchDirective, FcaTouchInput, FcaTouchPort, FcaTouchResult, FcaTouchSelector } from '../mind/action/reflex/fcaTouchPorts.js';
import { acquireAction } from './actionExecutionWiring.js';
import { inActionExecution } from '../infra/context/actionExecution.js';

interface Row {
  operation_id: string; scope_key: string; device_id: string; touch_id: string; input_json: string; target_id: string;
  state: string; gesture: string | null; lease_json: string | null; expires_at: string; issued: number;
  observed_delivered: number; result_delivered: number; reaction_json: string | null; reaction_delivered: number;
}
/** One leased candidate selection and one device invocation. No speech, emotion or experience writer. */
export function createFcaTouchWiring(parts: {
  db: DatabaseSync; runtime: TaskRuntime; actions: ActionThreads; selector: FcaTouchSelector;
  ownerScope: string; now?(): string;
  /** Fresh device registration and current capability, checked both before inference and command claim. */
  allowed(scope: string, device: string, gesture?: string): boolean;
  sourceVisible(scope: string, experienceId: string): boolean;
  threadId(scope: string): string | null;
}) {
  const now = parts.now ?? (() => new Date().toISOString()), db = parts.db;
  db.exec(`CREATE TABLE IF NOT EXISTS fca_touch_receipts (
    operation_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,device_id TEXT NOT NULL,touch_id TEXT NOT NULL,input_json TEXT NOT NULL,
    target_id TEXT NOT NULL,state TEXT NOT NULL,gesture TEXT,lease_json TEXT,expires_at TEXT NOT NULL,issued INTEGER NOT NULL DEFAULT 0,
    observed_delivered INTEGER NOT NULL DEFAULT 0,result_delivered INTEGER NOT NULL DEFAULT 0,
    reaction_json TEXT,reaction_delivered INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_key,touch_id));`);
  const jobs = new Map<string, { controller: AbortController; done: Promise<void>; action?: RunningAction }>();
  let closing = false;
  const row = (id: string) => db.prepare('SELECT * FROM fca_touch_receipts WHERE operation_id=?').get(id) as unknown as Row | undefined;
  const byTouch = (scope: string, id: string) => db.prepare('SELECT * FROM fca_touch_receipts WHERE scope_key=? AND touch_id=?').get(scope, id) as unknown as Row | undefined;
  const rootAllows = () => !['stopped', 'stopping', 'unknown'].includes(parts.runtime.ensureRoot(parts.ownerScope).phase);
  const sourcesVisible = (input: FcaTouchInput) => [input.experienceId, ...input.stanceSourceIds].every(id => parts.sourceVisible(input.scopeKey, id));
  const usable = (input: FcaTouchInput, gesture?: string) => !closing && input.scopeKey === parts.ownerScope && rootAllows()
    && parts.allowed(input.scopeKey, input.deviceId, gesture) && sourcesVisible(input);
  // A restarted process cannot prove whether its old command reached the renderer. Never issue it again.
  db.prepare("UPDATE fca_touch_receipts SET state='unknown' WHERE state IN ('selecting','ready','claimed')").run();
  async function acknowledge(saved: Row): Promise<void> {
    if (!saved.lease_json || !['applied', 'not_applied', 'unknown', 'none'].includes(saved.state)) return;
    const lease = JSON.parse(saved.lease_json) as ActionLease;
    const state = saved.state === 'unknown' ? 'unknown' : saved.state === 'not_applied' ? 'cancelled' : 'completed';
    const result = `fca_touch_${saved.state}`;
    try {
      const finished = await parts.actions.finish(lease, state, result);
      if (!finished && state !== 'unknown') await parts.actions.reconcile(lease, state, result);
    } catch { /* Retry only this original receipt, not selection or the gesture. */ }
  }
  function deliver(saved: Row) {
    const input = JSON.parse(saved.input_json) as FcaTouchInput;
    if (!sourcesVisible(input)) return;
    const send = (phase: string, payload: unknown) => withObserverRunSync({ scopeKey: saved.scope_key, surface: 'reflex_touch_receipt',
      audience: input.audience === 'owner' ? 'owner' : 'others' }, () => withScopedObserverTask(saved.scope_key, { taskId: saved.target_id }, () => parts.runtime.observeExternal(saved.scope_key, saved.target_id, {
      eventId: `${saved.operation_id}:${phase}`, experienceIds: [input.experienceId, ...input.stanceSourceIds], observedAt: input.observedAt,
      text: JSON.stringify({ kind: 'body.touch', eventId: input.touchId, experienceId: input.experienceId, phase, toucher: 'unknown',
        touch: input.touch, ...payload as object, instruction: 'Observed body event only. Existing touch reaction already owns feeling, memory and any speech. Do not repeat it.' }),
    })));
    try {
      if (!saved.observed_delivered) { send('observed', { immediateReflex: input.touch.reflex ?? 'not_reported' }); db.prepare('UPDATE fca_touch_receipts SET observed_delivered=1 WHERE operation_id=?').run(saved.operation_id); }
      if (!saved.result_delivered && ['applied', 'not_applied', 'unknown', 'none'].includes(saved.state)) {
        send(`result:${saved.state}`, { gesture: saved.gesture, outcome: saved.state, meaning: 'applied means renderer accepted one invocation, not completed motion or speech' });
        db.prepare('UPDATE fca_touch_receipts SET result_delivered=1 WHERE operation_id=?').run(saved.operation_id);
      }
      if (!saved.reaction_delivered && saved.reaction_json) { send('reaction', JSON.parse(saved.reaction_json)); db.prepare('UPDATE fca_touch_receipts SET reaction_delivered=1 WHERE operation_id=?').run(saved.operation_id); }
    } catch { /* Durable external event remains pending; source/target authority is never bypassed. */ }
  }
  async function choose(input: FcaTouchInput, id: string, controller: AbortController) {
    let active: RunningAction | null = null;
    try {
      if (!usable(input)) return;
      active = await acquireAction(parts.actions, { scopeKey: input.scopeKey, kind: 'agentTask', origin: 'owner_request', sourceId: id,
        resources: [actionResource(input.scopeKey, `avatar:${input.deviceId}`)], deadline: row(id)!.expires_at }, controller.signal);
      if (!active) return;
      jobs.get(id)!.action = active;
      db.prepare('UPDATE fca_touch_receipts SET lease_json=? WHERE operation_id=?').run(JSON.stringify(active.execution.lease), id);
      if (!usable(input) || !await active.execution.permit()) return;
      observerHandoff('reflex', 'reflexJev', { phase: 'touch_select', candidateCount: input.gestures.length });
      const gesture = await inActionExecution(active.execution, () => observeAsync('reflexJev', { phase: 'touch_select', candidateCount: input.gestures.length },
        () => parts.selector.select(input, active!.execution.signal), value => ({ selected: value !== null })));
      observerHandoff('reflexJev', 'reflex', { phase: 'touch_selection_result', selected: gesture !== null });
      if (!usable(input, gesture ?? undefined) || active.execution.signal.aborted || row(id)!.expires_at <= now()
        || !await active.execution.permit()) return;
      const selected = gesture !== null && input.gestures.includes(gesture) ? gesture : null;
      db.prepare("UPDATE fca_touch_receipts SET state=?,gesture=? WHERE operation_id=? AND state='selecting'").run(selected ? 'ready' : 'none', selected, id);
    } catch { /* An unknown selection never grants a body command or triggers a retry. */ }
    finally {
      if (row(id)?.state === 'selecting') db.prepare("UPDATE fca_touch_receipts SET state='unknown' WHERE operation_id=?").run(id);
      const saved = row(id)!;
      if (saved.state !== 'ready') { await acknowledge(saved); active?.stop(); jobs.delete(id); }
      deliver(saved);
    }
  }
  const port: FcaTouchPort = {
    observe(input) {
      if (!usable(input) || Date.parse(now()) - Date.parse(input.observedAt) > 5_000 || Date.parse(input.observedAt) > Date.parse(now()) + 5_000) return;
      const existing = byTouch(input.scopeKey, input.touchId); if (existing) return;
      const id = `touch:${createHash('sha256').update(input.scopeKey).update('\0').update(input.touchId).digest('hex')}`;
      const thread = parts.threadId(input.scopeKey), task = thread ? db.prepare("SELECT task_id FROM agent_tasks WHERE scope_key=? AND fca_kind='conversation' AND start_idempotency_key=?")
        .get(input.scopeKey, `fca:conversation:${thread}`) : null;
      const target = typeof task?.task_id === 'string' ? parts.runtime.get(input.scopeKey, task.task_id) : null;
      const targetId = target && !['stopped', 'stopping', 'completed', 'failed', 'unknown'].includes(target.phase) ? target.id : parts.runtime.ensureRoot(input.scopeKey).id;
      db.prepare("INSERT INTO fca_touch_receipts(operation_id,scope_key,device_id,touch_id,input_json,target_id,state,expires_at) VALUES(?,?,?,?,?,?,'selecting',?)")
        .run(id, input.scopeKey, input.deviceId, input.touchId, JSON.stringify(input), targetId, new Date(Date.parse(now()) + 5_000).toISOString());
      deliver(row(id)!);
      const controller = new AbortController(), job = { controller, done: Promise.resolve() };
      jobs.set(id, job); job.done = withObserverRun({ scopeKey: input.scopeKey, surface: 'reflex_touch', taskId: targetId, audience: input.audience === 'owner' ? 'owner' : 'others' }, () =>
        withScopedObserverTask(input.scopeKey, { taskId: targetId }, () => observeAsync('reflex', { phase: 'touch_selection' }, () => choose(input, id, controller))));
    },
    reacted(scope, device, touchId, result) {
      const saved = byTouch(scope, touchId); if (!saved || saved.device_id !== device) return;
      db.prepare('UPDATE fca_touch_receipts SET reaction_json=? WHERE operation_id=? AND reaction_json IS NULL').run(JSON.stringify(result), saved.operation_id);
      deliver(row(saved.operation_id)!);
    },
    async claim(scope, device, touchId) {
      const saved = byTouch(scope, touchId); if (!saved || saved.device_id !== device) return null;
      await jobs.get(saved.operation_id)?.done;
      const latest = row(saved.operation_id)!;
      const input = JSON.parse(latest.input_json) as FcaTouchInput, active = jobs.get(saved.operation_id)?.action;
      if (latest.state !== 'ready' || !latest.gesture || latest.expires_at <= now() || !usable(input, latest.gesture)
        || !active || !await active.execution.permit()) return null;
      if (row(saved.operation_id)!.state !== 'ready' || !usable(input, latest.gesture) || latest.expires_at <= now()) return null;
      const changed = db.prepare("UPDATE fca_touch_receipts SET state='claimed',issued=1 WHERE operation_id=? AND state='ready'").run(saved.operation_id).changes;
      return changed ? { operationId: saved.operation_id, touchId, gesture: latest.gesture, expiresAt: latest.expires_at } satisfies FcaTouchDirective : null;
    },
    async report(scope, device, id, result) {
      if (!['applied', 'not_applied', 'unknown'].includes(result)) return false;
      const saved = row(id); if (!saved || saved.scope_key !== scope || saved.device_id !== device || !saved.issued) return false;
      if (saved.state === result) { await acknowledge(saved); return true; }
      if (!['claimed', 'unknown'].includes(saved.state)) return false;
      db.prepare('UPDATE fca_touch_receipts SET state=?,result_delivered=0 WHERE operation_id=?').run(result, id);
      jobs.get(id)?.action?.stop(); jobs.delete(id);
      await acknowledge(row(id)!); deliver(row(id)!); return true;
    },
  };
  return { ...port, async tick() {
    for (const saved of db.prepare('SELECT * FROM fca_touch_receipts WHERE scope_key=?').all(parts.ownerScope) as unknown as Row[]) {
      if (['selecting', 'ready', 'claimed'].includes(saved.state) && (!rootAllows() || saved.expires_at <= now())) {
        const job = jobs.get(saved.operation_id); job?.controller.abort(); await job?.done;
        db.prepare("UPDATE fca_touch_receipts SET state='unknown' WHERE operation_id=? AND state IN ('selecting','ready','claimed')").run(saved.operation_id);
        job?.action?.stop(); jobs.delete(saved.operation_id);
      }
      await acknowledge(row(saved.operation_id)!); deliver(row(saved.operation_id)!);
    }
  }, async close() { closing = true; for (const job of jobs.values()) job.controller.abort(); await Promise.all([...jobs.values()].map(job => job.done));
    for (const [id, job] of jobs) { db.prepare("UPDATE fca_touch_receipts SET state='unknown' WHERE operation_id=? AND state IN ('selecting','ready','claimed')").run(id); job.action?.stop(); await acknowledge(row(id)!); } jobs.clear(); } };
}
