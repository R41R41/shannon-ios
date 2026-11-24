import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskMessage, TaskRecord } from '../taskRuntimePorts.js';
import type { SpokenWords, TaskExternalEvent } from '../taskExternalEventPorts.js';

/** The speaker's fields of a message row (`speaker_json`): none for a message that came without them or whose stored value cannot be read. */
export function speakerFields(stored: unknown): Pick<TaskMessage, 'speakerName' | 'speakerWords' | 'spokenAt' | 'speakerPos'> {
  if (typeof stored !== 'string' || !stored) return {};
  try {
    const said = JSON.parse(stored) as Partial<SpokenWords>;
    if (!said || typeof said.speakerName !== 'string' || typeof said.speakerWords !== 'string') return {};
    return { speakerName: said.speakerName, speakerWords: said.speakerWords, ...(typeof said.spokenAt === 'string' ? { spokenAt: said.spokenAt } : {}),
      ...(said.speakerPos && typeof said.speakerPos === 'object' ? { speakerPos: said.speakerPos } : {}) };
  } catch {
    return {};
  }
}

/** Trusted ingress only. The existing experience remains the source; no additional experience is written. */
export function observeExternalEvent(db: DatabaseSync, authority: TaskAuthority, scope: string, rootId: string,
  target: string, input: TaskExternalEvent, at: string): { duplicate: boolean; task: TaskRecord } {
  if (!/^[^\s\p{Cc}]{1,200}$/u.test(input.eventId) || !Number.isFinite(Date.parse(input.observedAt))
    || !input.text || input.text.length > 16_000 || !Array.isArray(input.experienceIds) || !input.experienceIds.length
    || input.experienceIds.length > 5000 || input.experienceIds.some(id => !/^[^\s\p{Cc}]{1,240}$/u.test(id))) throw new Error('FCA_EXTERNAL_EVENT');
  const hash = createHash('sha256').update(scope).update('\0').update(input.eventId).digest('hex');
  const id = `external:${hash}`, sourceId = `event:${hash}`, ids = JSON.stringify([...new Set(input.experienceIds)].sort());
  return authority.transaction(() => {
    const task = authority.get(scope, target); if (!task) throw new Error('FCA_TASK_NOT_FOUND');
    const known = db.prepare('SELECT * FROM fca_task_messages WHERE scope_key=? AND message_id=?').get(scope, id);
    if (known) {
      const source = db.prepare('SELECT * FROM fca_task_sources WHERE step_id=?').get(sourceId);
      if (known.target_task_id !== target || known.text !== input.text || source?.recalled_ids_json !== ids
        || source.observed_at !== input.observedAt) throw new Error('FCA_EXTERNAL_EVENT_CONFLICT');
      return { duplicate: true, task };
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('FCA_TARGET_FINISHED');
    db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,state,source_kind) VALUES(?,?,'',?,?,'bound','memory')")
      .run(sourceId, scope, input.observedAt, ids);
    db.prepare('INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at,speaker_json) VALUES(?,?,?,?,?,?,?)')
      .run(scope, id, rootId, target, input.text, at, input.said ? JSON.stringify(input.said) : null);
    db.prepare('INSERT INTO fca_task_source_links(task_id,step_id,message_id) VALUES(?,?,?)').run(target, sourceId, id);
    const checkpoint = db.prepare('SELECT * FROM fca_task_checkpoints WHERE task_id=?').get(target)!;
    const unbound = db.prepare("SELECT 1 FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id WHERE l.task_id=? AND l.message_id='' AND s.state!='bound' LIMIT 1").get(target);
    const wake = !checkpoint.step_id && !checkpoint.stop_requested && task.status !== 'paused' && task.kind !== 'conversation' && !unbound;
    if (wake) db.prepare('UPDATE fca_task_checkpoints SET wait_reason=NULL WHERE task_id=?').run(target);
    return { duplicate: false, task: authority.event(scope, target, 'fca_external_event', at, wake ? { status: 'queued' } : {}, { eventId: input.eventId, messageId: id }) };
  });
}
