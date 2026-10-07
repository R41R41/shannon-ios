import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ACTION_CODE, ACTION_ID, ACTION_LIMITS, ACTION_TERMINAL, validActionDraft, type ActionDraft, type ActionLease, type ActionState, type ActionView } from '@shannon/mind';
import type { ActionAcknowledgement } from '../../../../contracts/actionThreadContract.js';

/** The mind worker alone owns scheduling. BEGIN IMMEDIATE also fences another worker during recovery. No words here. */
export class SQLiteActionStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mind_actions (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, source_id TEXT NOT NULL,
        parent_id TEXT, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, holder TEXT, last_holder TEXT, lease_until TEXT,
        resources_json TEXT NOT NULL, base_resources_json TEXT NOT NULL, owner_informed INTEGER NOT NULL, deadline TEXT, progress TEXT, result TEXT,
        sent INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(scope_key, kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS mind_actions_scope ON mind_actions(scope_key,state,created_at);
      CREATE TABLE IF NOT EXISTS mind_action_budget (
        reservation_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, generation INTEGER NOT NULL, scope_key TEXT NOT NULL,
        day TEXT NOT NULL, yen REAL NOT NULL CHECK(yen >= 0), state TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        UNIQUE(action_id,generation,reservation_id)
      );
      CREATE TABLE IF NOT EXISTS mind_action_controls (
        request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mind_action_acknowledgements (
        id TEXT PRIMARY KEY,report_json TEXT NOT NULL
      );
    `);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): ActionView | null {
    const row = this.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id);
    return row ? view(row) : null;
  }
  list(scopeKey: string): ActionView[] {
    return this.db.prepare(`SELECT * FROM mind_actions WHERE scope_key=? AND
      (state IN ('queued','running','waiting','stopping') OR (state='unknown' AND (kind!='respond' OR resources_json!='[]')))
      UNION ALL SELECT * FROM (SELECT * FROM mind_actions WHERE scope_key=? AND kind!='respond'
      AND state IN ('completed','failed','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 40)
      ORDER BY created_at,id`).all(scopeKey,scopeKey).map(view);
  }
  enqueue(draft: ActionDraft, at: string): ActionView {
    if (!validActionDraft(draft)) throw new Error('ACTION_DRAFT');
    return this.transaction(() => {
      const known = this.db.prepare('SELECT * FROM mind_actions WHERE scope_key=? AND kind=? AND source_id=?').get(draft.scopeKey,draft.kind,draft.sourceId);
      if (known) {
        const existing = view(known);
        if (existing.origin !== draft.origin || existing.parentId !== (draft.parentId ?? null)) throw new Error('ACTION_ORIGIN');
        if(draft.ownerInformed && !existing.ownerInformed){
          this.db.prepare('UPDATE mind_actions SET owner_informed=1,updated_at=? WHERE id=?').run(at,existing.id);
          return this.get(existing.id)!;
        }
        return existing;
      }
      const parent = draft.parentId ? this.get(draft.parentId) : null;
      if (draft.parentId && (!parent || parent.scopeKey !== draft.scopeKey || parent.origin !== draft.origin || ACTION_TERMINAL.includes(parent.state) || parent.state === 'stopping')) throw new Error('ACTION_PARENT');
      const id = randomUUID();
      const keys=JSON.stringify([...new Set(draft.resources ?? [])].sort());
      this.db.prepare(`INSERT INTO mind_actions(id,scope_key,kind,origin,source_id,parent_id,state,resources_json,base_resources_json,owner_informed,deadline,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(id,draft.scopeKey,draft.kind,draft.origin,draft.sourceId,draft.parentId ?? null,
          keys,keys,parent?.ownerInformed || draft.ownerInformed ? 1 : 0,draft.deadline ?? null,at,at);
      return this.get(id)!;
    });
  }
  claim(id: string, holder: string, at: string): ActionView | null {
    if (!ACTION_ID.test(holder)) throw new Error('ACTION_HOLDER');
    return this.transaction(() => {
      this.sweep(at);
      const action = this.get(id);
      if (!action || action.state !== 'queued' || action.failures >= ACTION_LIMITS.consecutiveFailures) return null;
      const live = this.list(action.scopeKey).filter(item => ['running','waiting','stopping'].includes(item.state)
        || item.kind!=='respond'&&item.state==='unknown'&&item.sent);
      const foreground = action.kind === 'respond';
      if (live.filter(item => (item.kind === 'respond') === foreground).length >= (foreground ? 1 : 2)) return null;
      if (this.list(action.scopeKey).some(item => item.id!==action.id && (['running','waiting','stopping'].includes(item.state)||(item.state==='unknown'&&item.sent)) && item.resources.some(key => action.resources.includes(key)))) return null;
      const until = new Date(Date.parse(at)+ACTION_LIMITS.leaseMs).toISOString();
      this.db.prepare(`UPDATE mind_actions SET state='running',generation=generation+1,holder=?,last_holder=?,lease_until=?,sent=0,deadline=CASE WHEN kind='respond' THEN NULL ELSE deadline END,updated_at=? WHERE id=?`).run(holder,holder,until,at,id);
      return this.get(id);
    });
  }
  check(lease: ActionLease, at: string): ActionView | null {
    const action = this.get(lease.id);
    return action && action.generation === lease.generation && action.holder === lease.holder
      && action.leaseUntil !== null && Date.parse(action.leaseUntil) > Date.parse(at)
      && ['running','waiting'].includes(action.state) && (!action.deadline || Date.parse(action.deadline)>Date.parse(at)) ? action : null;
  }
  renew(lease: ActionLease, at: string, progress?: string): ActionView | null {
    if (progress && !ACTION_CODE.test(progress)) throw new Error('ACTION_PROGRESS');
    return this.transaction(() => {
      if (!this.check(lease,at)) return null;
      this.db.prepare('UPDATE mind_actions SET lease_until=?,progress=COALESCE(?,progress),updated_at=? WHERE id=?')
        .run(new Date(Date.parse(at)+ACTION_LIMITS.leaseMs).toISOString(),progress ?? null,at,lease.id);
      return this.get(lease.id);
    });
  }
  /** Linearized just before the outside operation. Already dispatched work keeps its resources until acknowledged/expired. */
  dispatch(lease: ActionLease, at: string, resources: readonly string[] = []): boolean {
    if (resources.length > ACTION_LIMITS.resources || resources.some(key=>!/^res:[a-f0-9]{64}$/u.test(key))) return false;
    return this.transaction(() => {
      const action = this.check(lease,at); if (!action) return false;
      const keys = [...new Set([...action.resources,...resources])].sort();
      if (keys.length > ACTION_LIMITS.resources) return false;
      if (this.list(action.scopeKey).some(other=>other.id!==action.id && (['running','waiting','stopping'].includes(other.state)||(other.state==='unknown'&&other.sent)) && other.resources.some(key=>keys.includes(key)))) return false;
      this.db.prepare("UPDATE mind_actions SET sent=1,state='running',resources_json=?,updated_at=? WHERE id=?").run(JSON.stringify(keys),at,lease.id);
      return true;
    });
  }
  finish(lease: ActionLease, state: 'completed'|'failed'|'cancelled'|'unknown', code: string, at: string): ActionView | null {
    if (!ACTION_CODE.test(code)) throw new Error('ACTION_RESULT');
    return this.transaction(() => {
      const action = this.get(lease.id);
      if (!action || action.generation!==lease.generation || action.holder!==lease.holder || !action.leaseUntil
        || Date.parse(action.leaseUntil)<=Date.parse(at) || !['running','waiting','stopping'].includes(action.state)) return null;
      const failures = state==='failed' ? (action.lastFailure===code ? action.failures+1 : 1) : 0;
      this.db.prepare('UPDATE mind_actions SET state=?,result=?,failures=?,last_failure=?,generation=generation+?,holder=NULL,lease_until=NULL,updated_at=? WHERE id=?')
        .run(state,code,failures,state==='failed'?code:null,state==='unknown'?1:0,at,lease.id);
      // Unknown/failed calls never release an estimate. Only a known not-sent cancellation returns a reservation.
      this.db.prepare("UPDATE mind_action_budget SET state='held' WHERE action_id=? AND state='reserved'").run(lease.id);
      return this.get(lease.id);
    });
  }
  checkpoint(lease:ActionLease,progress:string,at:string,failureCode?:string):boolean {
    if(!ACTION_CODE.test(progress) || failureCode && !ACTION_CODE.test(failureCode))return false;
    return this.transaction(()=>{
      const action=this.check(lease,at);if(!action)return false;
      const failures=failureCode ? action.lastFailure===failureCode ? action.failures+1 : 1 : 0;
      this.db.prepare("UPDATE mind_actions SET failures=?,last_failure=? WHERE id=?").run(failures,failureCode ?? null,lease.id);
      if(failures>=ACTION_LIMITS.consecutiveFailures){
        this.db.prepare("UPDATE mind_actions SET state='failed',result='repeated_failure',sent=0,resources_json=base_resources_json,holder=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at,lease.id);
        return false;
      }
      this.db.prepare("UPDATE mind_actions SET sent=0,state='waiting',resources_json=base_resources_json,progress=?,updated_at=? WHERE id=?").run(progress,at,lease.id);
      return true;
    });
  }
  stop(scopeKey: string, targetId: string | null, requestId: string, at: string): ActionView[] {
    if (!ACTION_ID.test(requestId)) throw new Error('ACTION_REQUEST');
    return this.transaction(() => {
      const known=this.db.prepare('SELECT scope_key,target_id FROM mind_action_controls WHERE request_id=?').get(requestId) as {scope_key:string;target_id:string|null}|undefined;
      if (known && (known.scope_key!==scopeKey || known.target_id!==targetId)) throw new Error('ACTION_REQUEST_CONFLICT');
      if (!known) {
        const all=this.list(scopeKey), ids=new Set(all.filter(a=>a.kind!=='respond' && (!targetId || a.id===targetId)).map(a=>a.id));
        let grew=true; while(grew) { grew=false; for(const a of all) if(a.kind!=='respond' && a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {ids.add(a.id);grew=true;} }
        for(const action of all) if(ids.has(action.id) && !ACTION_TERMINAL.includes(action.state)) {
          const state=action.state==='queued'?'cancelled':'stopping';
          this.db.prepare('UPDATE mind_actions SET state=?,updated_at=? WHERE id=?').run(state,at,action.id);
        }
        this.db.prepare('INSERT INTO mind_action_controls VALUES(?,?,?,?)').run(requestId,scopeKey,targetId,at);
      }
      return this.list(scopeKey);
    });
  }
  /** Re-start only explicitly, after a known failed/not-sent attempt. Unknown external results are never replayed. */
  resume(scopeKey: string, id: string, at: string): boolean {
    return this.transaction(()=>{
      const action=this.get(id);
      if(!action || action.scopeKey!==scopeKey || action.failures>=5 || !['failed','cancelled'].includes(action.state)) return false;
      if(action.parentId) {const parent=this.get(action.parentId);if(!parent || ACTION_TERMINAL.includes(parent.state) || parent.state==='stopping')return false;}
      this.db.prepare("UPDATE mind_actions SET state='queued',sent=0,progress=NULL,result=NULL,updated_at=? WHERE id=?").run(at,id);
      return true;
    });
  }
  reserve(lease: ActionLease, reservationId: string, day: string, yen: number, cap: number, spent: number, at: string): boolean {
    if(!ACTION_ID.test(reservationId) || !/^\d{4}-\d{2}-\d{2}$/u.test(day) || ![yen,cap,spent].every(v=>Number.isFinite(v)&&v>=0)) return false;
    return this.transaction(()=>{
      const action=this.check(lease,at); if(!action || action.origin!=='own_time')return false;
      const prior=this.db.prepare('SELECT * FROM mind_action_budget WHERE reservation_id=?').get(reservationId) as {action_id:string;generation:number;yen:number;day:string;state:string}|undefined;
      if(prior)return prior.action_id===action.id && prior.generation===lease.generation && prior.yen===yen && prior.day===day && prior.state==='reserved';
      const reserved=this.db.prepare("SELECT COALESCE(SUM(yen),0) AS yen FROM mind_action_budget WHERE scope_key=? AND day=? AND state IN ('reserved','held')").get(action.scopeKey,day) as {yen:number};
      if(spent+reserved.yen+yen>cap)return false;
      this.db.prepare('INSERT INTO mind_action_budget(reservation_id,action_id,generation,scope_key,day,yen,state) VALUES(?,?,?,?,?,?,\'reserved\')').run(reservationId,action.id,lease.generation,action.scopeKey,day,yen);
      return true;
    });
  }
  settle(lease: ActionLease, reservationId: string, actual: number | null, at: string): boolean {
    if(actual!==null && (!Number.isFinite(actual)||actual<0))return false;
    return this.transaction(()=>{
      this.sweep(at);
      const action=this.get(lease.id);
      if(!action)return false;
      const live=action.generation===lease.generation && action.holder===lease.holder && action.leaseUntil!==null
        && action.leaseUntil>at && ['running','waiting','stopping'].includes(action.state);
      // A late canonical report can settle only this immediately previous attempt, never a newer holder's charge.
      const acknowledged=actual!==null && action.generation===lease.generation+1 && action.lastHolder===lease.holder
        && (action.state==='unknown' || action.state==='cancelled' && !action.sent && actual===0);
      if(!live && !acknowledged)return false;
      const row=this.db.prepare("SELECT state FROM mind_action_budget WHERE reservation_id=? AND action_id=? AND generation=?").get(reservationId,lease.id,lease.generation) as {state:string}|undefined;
      if(!row || row.state!=='reserved' && !(acknowledged && row.state==='held'))return false;
      // The caller's canonical spend ledger records actual usage before this reservation is released.
      this.db.prepare('UPDATE mind_action_budget SET state=? WHERE reservation_id=?').run(actual===null?'held':'settled',reservationId);
      return true;
    });
  }
  /** Only the adapter with an acknowledged, canonical outside result calls this. It never starts an attempt. */
  reconcile(lease:ActionLease,state:'completed'|'failed'|'cancelled',code:string,at:string):boolean {
    if(!ACTION_CODE.test(code))return false;
    return this.transaction(()=>{
      this.sweep(at);
      const action=this.get(lease.id);
      if(!action || action.state!=='unknown' || action.generation!==lease.generation+1 || action.lastHolder!==lease.holder)return false;
      this.db.prepare('UPDATE mind_actions SET state=?,result=?,sent=0,updated_at=? WHERE id=?').run(state,code,at,lease.id);
      return true;
    });
  }
  /** Idempotent delivery of a canonical report. An expired/stopped attempt closes; it never receives fresh execution rights. */
  acknowledge(report:ActionAcknowledgement,at:string):boolean {
    const {lease}=report;
    if(!lease||typeof report.id!=='string'||typeof report.scopeKey!=='string'||typeof lease.id!=='string'||typeof lease.holder!=='string'
      ||!ACTION_ID.test(report.id)||!ACTION_ID.test(report.scopeKey)||!ACTION_ID.test(lease.id)||!ACTION_ID.test(lease.holder)
      || !Number.isSafeInteger(lease.generation)||lease.generation<1||!Number.isFinite(report.actual)||report.actual<0
      || report.reservationId!==null&&(typeof report.reservationId!=='string'||!ACTION_ID.test(report.reservationId))
      || !['budget','checkpoint','completed','failed','cancelled'].includes(report.state)||typeof report.code!=='string'||!ACTION_CODE.test(report.code)
      || report.failureCode!==undefined&&(typeof report.failureCode!=='string'||!ACTION_CODE.test(report.failureCode)))return false;
    return this.transaction(()=>{
      const encoded=JSON.stringify({id:report.id,scopeKey:report.scopeKey,lease:{id:lease.id,generation:lease.generation,holder:lease.holder},
        reservationId:report.reservationId,actual:report.actual,state:report.state,code:report.code,...(report.failureCode?{failureCode:report.failureCode}:{})});
      const receipt=this.db.prepare('SELECT report_json FROM mind_action_acknowledgements WHERE id=?').get(report.id);
      if(receipt)return receipt.report_json===encoded;
      this.sweep(at);
      const action=this.get(lease.id);
      if(!action||action.scopeKey!==report.scopeKey||action.kind!=='ownTime'||action.origin!=='own_time'||action.lastHolder!==lease.holder)return false;
      const live=action.generation===lease.generation&&action.holder===lease.holder&&['running','waiting','stopping'].includes(action.state);
      const expired=action.generation===lease.generation+1&&['unknown','cancelled'].includes(action.state);
      const closed=action.generation===lease.generation&&['completed','failed','cancelled'].includes(action.state);
      // An explicit resume can precede delivery of the old known ACK. It has
      // granted no new holder yet: collect only that attempt's budget/receipt.
      const resumed=action.state==='queued'&&!action.holder&&!action.sent
        &&(action.generation===lease.generation||action.generation===lease.generation+1);
      if(!live&&!expired&&!closed&&!resumed)return false;
      if(report.reservationId){
        const reservation=this.db.prepare('SELECT state FROM mind_action_budget WHERE reservation_id=? AND action_id=? AND generation=?')
          .get(report.reservationId,lease.id,lease.generation);
        if(reservation && ['reserved','held'].includes(String(reservation.state)))
          this.db.prepare("UPDATE mind_action_budget SET state='settled' WHERE reservation_id=?").run(report.reservationId);
      }
      if(report.state!=='budget'&&(live||action.state==='unknown')){
        const checkpoint=report.state==='checkpoint'&&live&&action.state!=='stopping';
        const failures=report.failureCode?(action.lastFailure===report.failureCode?action.failures+1:1):0;
        const state=checkpoint?(failures>=5?'failed':'waiting'):report.state==='checkpoint'?'cancelled':report.state;
        const code=checkpoint?(failures>=5?'repeated_failure':null):report.state==='checkpoint'?'step_acknowledged':report.code;
        this.db.prepare(`UPDATE mind_actions SET state=?,sent=0,resources_json=base_resources_json,progress=?,result=?,
          failures=?,last_failure=?,holder=CASE WHEN ?='waiting' THEN holder ELSE NULL END,
          lease_until=CASE WHEN ?='waiting' THEN lease_until ELSE NULL END,updated_at=? WHERE id=?`)
          .run(state,checkpoint?report.code:null,code,failures,report.failureCode??null,state,state,at,action.id);
      }
      this.db.prepare('INSERT INTO mind_action_acknowledgements VALUES(?,?)').run(report.id,encoded);
      return true;
    });
  }
  sweep(at: string): void {
    for(const row of this.db.prepare("SELECT * FROM mind_actions WHERE state IN ('running','waiting','stopping') AND (lease_until<=? OR (deadline IS NOT NULL AND deadline<=?))").all(at,at)) {
      const action=view(row);
      this.db.prepare("UPDATE mind_actions SET state=CASE WHEN sent=1 THEN 'unknown' ELSE 'cancelled' END,result='lease_expired',holder=NULL,lease_until=NULL,generation=generation+1,updated_at=? WHERE id=?").run(at,action.id);
      this.db.prepare("UPDATE mind_action_budget SET state='held' WHERE action_id=? AND state='reserved'").run(action.id);
    }
    this.db.prepare("UPDATE mind_actions SET state='cancelled',result='deadline',updated_at=? WHERE state='queued' AND deadline IS NOT NULL AND deadline<=?").run(at,at);
  }
}
function view(input: object): ActionView {
  const r=input as Record<string,unknown>;
  return {id:String(r.id),scopeKey:String(r.scope_key),kind:r.kind as ActionView['kind'],origin:r.origin as ActionView['origin'],sourceId:String(r.source_id),parentId:r.parent_id as string|null,
    state:r.state as ActionState,generation:Number(r.generation),holder:r.holder as string|null,lastHolder:r.last_holder as string|null,leaseUntil:r.lease_until as string|null,resources:JSON.parse(String(r.resources_json)),ownerInformed:r.owner_informed===1,
    deadline:r.deadline as string|null,progress:r.progress as string|null,result:r.result as string|null,sent:r.sent===1,failures:Number(r.failures),lastFailure:r.last_failure as string|null,createdAt:String(r.created_at),updatedAt:String(r.updated_at)};
}
