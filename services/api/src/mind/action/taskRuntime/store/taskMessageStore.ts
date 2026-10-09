import type { DatabaseSync } from 'node:sqlite';

/** Called inside the task authority transaction. An original id can never acquire a new author or body. */
export function insertTaskMessage(db: DatabaseSync, input: { scope: string; source: string; target: string; text: string; id: string; at: string; finished: boolean }): boolean {
  const known = db.prepare('SELECT * FROM fca_task_messages WHERE scope_key=? AND message_id=?').get(input.scope, input.id);
  if (known) {
    if (known.source_task_id !== input.source || known.target_task_id !== input.target || known.text !== input.text) throw new Error('FCA_MESSAGE_CONFLICT');
    return false;
  }
  if (input.finished) throw new Error('FCA_TARGET_FINISHED');
  db.prepare('INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at) VALUES(?,?,?,?,?,?)')
    .run(input.scope, input.id, input.source, input.target, input.text, input.at);
  return true;
}
