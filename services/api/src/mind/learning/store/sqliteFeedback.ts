import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FeedbackChoiceLink, FeedbackReaction, FeedbackState, FeedbackTurnDraft } from '../../../contracts/feedbackContract.js';

/** Content-free immutable turn provenance and versioned owner reactions. Only the Stage5 API/worker creates these tables. */
export function ensureFeedbackSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shannon_feedback_drafts (
      scope_key TEXT NOT NULL, record_id TEXT NOT NULL, thread_id TEXT NOT NULL, reply_digest TEXT NOT NULL,
      surface TEXT NOT NULL, owner_alone INTEGER NOT NULL, usable INTEGER NOT NULL, choice_links_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, record_id)
    );
    CREATE TABLE IF NOT EXISTS shannon_feedback_targets (
      target_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      source_digest TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT, task_id TEXT, attempt_id TEXT, revoked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope_key, thread_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS shannon_feedback_versions (
      scope_key TEXT NOT NULL, seq INTEGER NOT NULL, target_id TEXT NOT NULL, revision INTEGER NOT NULL,
      reaction TEXT, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, seq), UNIQUE(scope_key, operation_id), UNIQUE(target_id, revision)
    );
    CREATE TABLE IF NOT EXISTS shannon_feedback_seq (scope_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS shannon_feedback_target_scope ON shannon_feedback_targets(scope_key, thread_id, turn_id);
    CREATE UNIQUE INDEX IF NOT EXISTS shannon_feedback_one_turn ON shannon_feedback_targets(scope_key,record_id) WHERE record_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS shannon_feedback_one_task ON shannon_feedback_targets(scope_key,task_id,attempt_id) WHERE kind='task';
  `);
}
export interface FeedbackTarget {
  targetId: string; scopeKey: string; threadId: string; turnId: string; sourceDigest: string;
  kind: 'tool' | 'task'; recordId: string | null; taskId: string | null; attemptId: string | null; revoked: boolean;
}
export interface FeedbackVersion { seq: number; revision: number; reaction: FeedbackReaction; operationId: string; requestDigest: string; }

export class SQLiteFeedback {
  constructor(private readonly db: DatabaseSync, createSchema = false) { if (createSchema) ensureFeedbackSchema(db); }
  capture(scopeKey: string, draft: FeedbackTurnDraft): void {
    this.db.prepare(`INSERT OR IGNORE INTO shannon_feedback_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scopeKey,draft.recordId,draft.threadId,draft.replyDigest,draft.surface,draft.ownerAlone?1:0,draft.usable?1:0,JSON.stringify(draft.choices),draft.at);
  }
  draft(scopeKey: string, id: string): FeedbackTurnDraft | null {
    const row = this.db.prepare('SELECT * FROM shannon_feedback_drafts WHERE scope_key=? AND record_id=?').get(scopeKey,id) as Record<string,unknown> | undefined;
    if (!row) return null;
    let choices: FeedbackChoiceLink[] = [];
    try { choices=JSON.parse(String(row.choice_links_json)); } catch { return null; }
    if (!Array.isArray(choices)) return null;
    return { recordId:String(row.record_id),threadId:String(row.thread_id),replyDigest:String(row.reply_digest),surface:row.surface as 'text'|'voice',
      ownerAlone:row.owner_alone===1,usable:row.usable===1,choices,at:String(row.created_at) };
  }
  insertTarget(input: Omit<FeedbackTarget,'targetId'|'revoked'>): FeedbackTarget | null {
    const targetId=randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO shannon_feedback_targets(target_id,scope_key,thread_id,turn_id,source_digest,kind,record_id,task_id,attempt_id,revoked) VALUES(?,?,?,?,?,?,?,?,?,0)`)
      .run(targetId,input.scopeKey,input.threadId,input.turnId,input.sourceDigest,input.kind,input.recordId,input.taskId,input.attemptId);
    return this.forTurn(input.scopeKey,input.threadId,input.turnId);
  }
  forTurn(scopeKey: string, threadId: string, turnId: string): FeedbackTarget | null {
    const row=this.db.prepare('SELECT * FROM shannon_feedback_targets WHERE scope_key=? AND thread_id=? AND turn_id=?').get(scopeKey,threadId,turnId) as Record<string,unknown>|undefined;
    return row ? target(row) : null;
  }
  get(scopeKey: string, targetId: string): FeedbackTarget | null {
    const row=this.db.prepare('SELECT * FROM shannon_feedback_targets WHERE scope_key=? AND target_id=?').get(scopeKey,targetId) as Record<string,unknown>|undefined;
    return row ? target(row) : null;
  }
  targets(scopeKey: string): FeedbackTarget[] {
    return (this.db.prepare('SELECT * FROM shannon_feedback_targets WHERE scope_key=? AND revoked=0 ORDER BY target_id').all(scopeKey) as Array<Record<string,unknown>>).map(target);
  }
  current(scopeKey: string, targetId: string, upTo=Number.MAX_SAFE_INTEGER): FeedbackVersion | null {
    const row=this.db.prepare('SELECT * FROM shannon_feedback_versions WHERE scope_key=? AND target_id=? AND seq<=? ORDER BY revision DESC LIMIT 1').get(scopeKey,targetId,upTo) as Record<string,unknown>|undefined;
    return row ? version(row) : null;
  }
  operation(scopeKey: string, operationId: string): (FeedbackVersion & { targetId:string }) | null {
    const row=this.db.prepare('SELECT * FROM shannon_feedback_versions WHERE scope_key=? AND operation_id=?').get(scopeKey,operationId) as Record<string,unknown>|undefined;
    return row ? {...version(row),targetId:String(row.target_id)} : null;
  }
  lastSeq(scopeKey: string): number {
    const row=this.db.prepare('SELECT last_seq FROM shannon_feedback_seq WHERE scope_key=?').get(scopeKey) as {last_seq:number}|undefined;
    return row?.last_seq ?? 0;
  }
  append(scopeKey: string,targetId: string,revision: number,reaction: FeedbackReaction,operationId: string,requestDigest: string,at: string): FeedbackVersion {
    const seq=this.lastSeq(scopeKey)+1;
    this.db.prepare('INSERT INTO shannon_feedback_versions VALUES(?,?,?,?,?,?,?,?)').run(scopeKey,seq,targetId,revision,reaction,operationId,requestDigest,at);
    this.db.prepare('INSERT INTO shannon_feedback_seq VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET last_seq=excluded.last_seq').run(scopeKey,seq);
    return {seq,revision,reaction,operationId,requestDigest};
  }
  revoke(item: FeedbackTarget,at: string): void {
    if (item.revoked) return;
    const changed=this.db.prepare('UPDATE shannon_feedback_targets SET revoked=1 WHERE target_id=? AND scope_key=? AND revoked=0').run(item.targetId,item.scopeKey);
    if (!Number(changed.changes)) return;
    const previous=this.current(item.scopeKey,item.targetId);
    this.append(item.scopeKey,item.targetId,(previous?.revision??0)+1,null,`revoke:${item.targetId}`,'source_revoked',at);
  }
  state(item: FeedbackTarget): FeedbackState {
    const row=this.current(item.scopeKey,item.targetId);
    return {targetId:item.targetId,threadId:item.threadId,turnId:item.turnId,revision:row?.revision??0,reaction:row?.reaction??null,operationId:row?.operationId??null};
  }
}
function target(row: Record<string,unknown>): FeedbackTarget {
  const nullable=(value:unknown)=>value==null?null:String(value);
  return {targetId:String(row.target_id),scopeKey:String(row.scope_key),threadId:String(row.thread_id),turnId:String(row.turn_id),sourceDigest:String(row.source_digest),
    kind:row.kind as 'tool'|'task',recordId:nullable(row.record_id),taskId:nullable(row.task_id),attemptId:nullable(row.attempt_id),revoked:row.revoked===1};
}
function version(row:Record<string,unknown>): FeedbackVersion {
  return {seq:Number(row.seq),revision:Number(row.revision),reaction:row.reaction as FeedbackReaction,operationId:String(row.operation_id),requestDigest:String(row.request_digest)};
}
