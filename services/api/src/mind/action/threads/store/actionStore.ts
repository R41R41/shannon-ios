import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ACTION_CODE, ACTION_ID, ACTION_LIMITS, ACTION_TERMINAL, LEASE_RULES, actionEffectClass, instantAfter, leaseLive, slotAdmissible,
  unknownDue, unknownExit, validActionDraft, type ActionDraft, type ActionLease, type ActionView,
} from '@shannon/mind';
import type { ActionAcknowledgement } from '../../../../contracts/actionThreadContract.js';
import {
  knownRelease, recordRetained, releaseRetained, retainedActionIds, retainedOf, type RetainedRelease,
} from './retainedResourceStore.js';
import { actionView as view } from './actionLeaseReader.js';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { ACTION_THREADS_STEP } from '../../../../infra/sqlite/migrations/executionSteps.js';
import {
  ACTION_SLOT_STEPS, actionSlotColumns, actionTaskLink, liveSlotClasses, readSlotLimits, slotClassOfRow,
} from './actionSlotColumns.js';
export type ActionResourceReconciliationAllowed=(lease:ActionLease,resource:string,acknowledgementId:string)=>boolean;
/**
 * A resource that only a release proof may free, even after the unknown deadline: a closing canonical report, or a domain proof
 * through `reconcileResource`. Base or dispatch-added; `resources` is the action's whole set (`retainedResources.ts`).
 */
export type ActionResourceRetained=(resource:string,resources:readonly string[],action?:Pick<ActionView,'kind'|'sourceId'>)=>boolean;
/** Whether an unknown action's original work is settled elsewhere (its Agent Host task ended), which releases its retained keys. */
export type ActionRetainedReleaseProof=(action:ActionView)=>boolean;

/** The mind worker alone owns scheduling. BEGIN IMMEDIATE also fences another worker during recovery. No words here. */
export class SQLiteActionStore {
  private readonly refusals=new Map<string,number>();
  constructor(private readonly db: DatabaseSync,private readonly resourceReconciliationAllowed?:ActionResourceReconciliationAllowed,
    private readonly retainedAfterRelease:ActionResourceRetained=()=>false,
    private readonly retainedReleaseProof:ActionRetainedReleaseProof=()=>false) {
    applySchemaSteps(db,[ACTION_THREADS_STEP,...ACTION_SLOT_STEPS]);
  }
  /** Claims refused since this process started, by closed reason (ADR-0009 stage 1: `GET /v1/ops`). */
  claimRefusals():Readonly<Record<string,number>> {
    return Object.freeze(Object.fromEntries(this.refusals));
  }
  private refused(reason:string):null {
    this.refusals.set(reason,(this.refusals.get(reason)??0)+1);
    return null;
  }
  /** The owner's explicit release of an unknown action's retained keys (ADR-0009 §9): audited, idempotent by request id. */
  releaseRetainedByOwner(scopeKey:string,id:string,requestId:string,by:string,at:string):number|null {
    if(![scopeKey,id,requestId,by].every(value=>typeof value==='string'&&ACTION_ID.test(value)))return null;
    return this.transaction(()=>{
      const known=knownRelease(this.db,requestId);
      if(known)return known.scopeKey===scopeKey&&known.actionId===id?known.count:null;
      const action=this.get(id);
      if(!action||action.scopeKey!==scopeKey||action.state!=='unknown')return null;
      const released=this.endRetained(action,{requestId,scopeKey,actionId:id,releasedBy:by,reason:'owner_release',at});
      return released.length?released.length:null;
    });
  }
  private endRetained(action:ActionView,release:RetainedRelease,only?:readonly string[]):string[] {
    const released=releaseRetained(this.db,release,only);
    if(!released.length)return released;
    const resources=action.resources.filter(key=>!released.includes(key));
    this.db.prepare('UPDATE mind_actions SET resources_json=? WHERE id=?').run(JSON.stringify(resources),action.id);
    return released;
  }
  /** Ends the retained records whose action closed, or whose original task settled elsewhere (ADR-0009 §9). */
  private settleRetained(at:string):void {
    for(const id of retainedActionIds(this.db)){
      const action=this.get(id);
      if(!action||action.state!=='unknown'){
        const scopeKey=action?.scopeKey??'unknown';
        releaseRetained(this.db,{requestId:`closed:${id}:${at}`,scopeKey,actionId:id,releasedBy:'scheduler',reason:'action_closed',at});
        continue;
      }
      if(!this.retainedReleaseProof(action))continue;
      const release:RetainedRelease={requestId:`settled:${id}:${at}`,scopeKey:action.scopeKey,actionId:id,
        releasedBy:'scheduler',reason:'task_settled',at};
      this.endRetained(action,release);
    }
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): ActionView | null {
    const row = this.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id);
    return row ? this.withNotification(view(row)) : null;
  }
  list(scopeKey: string): ActionView[] {
    return this.db.prepare(`SELECT * FROM mind_actions WHERE scope_key=? AND
      (state IN ('queued','running','waiting','stopping') OR (state='unknown' AND (kind!='respond' OR resources_json!='[]')))
      UNION ALL SELECT * FROM (SELECT * FROM mind_actions WHERE scope_key=? AND kind!='respond'
      AND state IN ('completed','failed','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 40)
      ORDER BY created_at,id`).all(scopeKey,scopeKey).map(row=>this.withNotification(view(row)));
  }
  private withNotification(action:ActionView):ActionView {
    if(action.state!=='unknown'||action.kind==='respond')return action;
    const id=createHash('sha256').update(JSON.stringify([action.id,action.generation,action.result])).digest('hex');
    const receipt=this.db.prepare(`SELECT MIN(acknowledged_at) AS at FROM mind_action_notice_receipts
      WHERE scope_key=? AND action_id=? AND notification_id=?`).get(action.scopeKey,action.id,id) as {at:string|null};
    return {...action,notification:{id,acknowledgedAt:receipt.at}};
  }
  /** Owner read receipt only: deliberately does not sweep, reconcile, stop or update the original attempt. */
  acknowledgeNotice(scopeKey:string,id:string,notificationId:string,requestId:string,at:string):boolean {
    if(!ACTION_ID.test(scopeKey)||!ACTION_ID.test(id)||!ACTION_ID.test(requestId)||!/^([a-f0-9]{64})$/u.test(notificationId))return false;
    return this.transaction(()=>{
      const known=this.db.prepare('SELECT scope_key,action_id,notification_id FROM mind_action_notice_receipts WHERE request_id=?')
        .get(requestId) as {scope_key:string;action_id:string;notification_id:string}|undefined;
      if(known&&(known.scope_key!==scopeKey||known.action_id!==id||known.notification_id!==notificationId))return false;
      const action=this.get(id);
      if(!action||action.scopeKey!==scopeKey||action.state!=='unknown'||action.kind==='respond'||action.notification?.id!==notificationId)return false;
      if(!known)this.db.prepare('INSERT INTO mind_action_notice_receipts VALUES(?,?,?,?,?)').run(requestId,scopeKey,id,notificationId,at);
      return true;
    });
  }
  enqueue(draft: ActionDraft, at: string): ActionView {
    if (!validActionDraft(draft)) throw new Error('ACTION_DRAFT');
    return this.transaction(() => this.enqueueInTransaction(draft,at));
  }
  private enqueueInTransaction(draft:ActionDraft,at:string):ActionView {
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
    const slot=actionSlotColumns(this.db,draft);
    this.db.prepare(`INSERT INTO mind_actions(id,scope_key,kind,origin,source_id,parent_id,state,resources_json,base_resources_json,owner_informed,deadline,
      created_at,updated_at,task_id,slot_class,effect_sent)
      VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,0)`).run(id,draft.scopeKey,draft.kind,draft.origin,draft.sourceId,draft.parentId ?? null,
        keys,keys,parent?.ownerInformed || draft.ownerInformed ? 1 : 0,draft.deadline ?? null,at,at,slot.taskId,slot.slotClass);
    return this.get(id)!;
  }
  claim(id: string, holder: string, at: string): ActionView | null {
    if (!ACTION_ID.test(holder)) throw new Error('ACTION_HOLDER');
    return this.transaction(() => this.claimInTransaction(id,holder,at));
  }
  private claimInTransaction(id:string,holder:string,at:string):ActionView|null {
    this.sweep(at);
    const action = this.get(id);
    if (!action || action.state !== 'queued') return this.refused('not_queued');
    if (action.failures >= ACTION_LIMITS.consecutiveFailures) return this.refused('failures');
    // ADR-0009 stage 1, S6: the slot class of the action against its pool and class limits, as the slot tables hold them.
    const slotClass = slotClassOfRow(this.db, this.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id)!);
    const verdict = slotAdmissible(slotClass, liveSlotClasses(this.db, action.scopeKey), readSlotLimits(this.db));
    if (!verdict.ok) return this.refused(verdict.reason);
    const others = this.list(action.scopeKey).filter(item => item.id!==action.id);
    if (others.some(item => this.heldResources(item).some(key => action.resources.includes(key)))) return this.refused('resource_held');
    const until = new Date(Date.parse(at)+ACTION_LIMITS.leaseMs).toISOString();
    this.db.prepare(`UPDATE mind_actions SET state='running',generation=generation+1,holder=?,last_holder=?,lease_until=?,sent=0,effect_sent=0,deadline=CASE WHEN kind='respond' THEN NULL ELSE deadline END,updated_at=? WHERE id=?`).run(holder,holder,until,at,id);
    return this.get(id);
  }
  /** Foreground admission has one durable commit; no execution right leaves an uncommitted transaction. */
  admitRespond(draft:ActionDraft,holder:string,at:string):ActionView|null {
    if(!draft || typeof draft!=='object' || Array.isArray(draft) || !validActionDraft(draft))throw new Error('ACTION_DRAFT');
    if(draft.kind!=='respond')throw new Error('ACTION_RESPOND');
    if(typeof holder!=='string'||!ACTION_ID.test(holder))throw new Error('ACTION_HOLDER');
    return this.transaction(()=>this.claimInTransaction(this.enqueueInTransaction(draft,at).id,holder,at));
  }
  check(lease: ActionLease, at: string): ActionView | null {
    const action = this.get(lease.id);
    return action && leaseLive(action,lease,at,LEASE_RULES.store) ? action : null;
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
      if (this.list(action.scopeKey).some(other=>other.id!==action.id && this.heldResources(other).some(key=>keys.includes(key)))) return false;
      this.db.prepare("UPDATE mind_actions SET sent=1,effect_sent=1,state='running',resources_json=?,updated_at=? WHERE id=?").run(JSON.stringify(keys),at,lease.id);
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
      this.db.prepare(`UPDATE mind_actions SET state=?,result=?,failures=?,last_failure=?,generation=generation+?,holder=NULL,lease_until=NULL,
        effect_sent=CASE WHEN sent=1 OR ?='unknown' THEN 1 ELSE 0 END,updated_at=? WHERE id=?`)
        .run(state,code,failures,state==='failed'?code:null,state==='unknown'?1:0,state,at,lease.id);
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
        this.db.prepare("UPDATE mind_actions SET state='failed',result='repeated_failure',sent=0,effect_sent=0,resources_json=base_resources_json,holder=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(at,lease.id);
        return false;
      }
      this.db.prepare("UPDATE mind_actions SET sent=0,effect_sent=0,state='waiting',resources_json=base_resources_json,progress=?,updated_at=? WHERE id=?").run(progress,at,lease.id);
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
      this.db.prepare("UPDATE mind_actions SET state='queued',sent=0,effect_sent=0,progress=NULL,result=NULL,updated_at=? WHERE id=?").run(at,id);
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
      const live=leaseLive(action,lease,at,LEASE_RULES.live);
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
      this.db.prepare('UPDATE mind_actions SET state=?,result=?,sent=0,effect_sent=0,updated_at=? WHERE id=?').run(state,code,at,lease.id);
      return true;
    });
  }
  /** Exact original release proof removes only a dynamic exclusion; the action itself remains unknown. */
  reconcileResource(lease:ActionLease,resource:string,acknowledgementId:string,at=new Date().toISOString()):boolean {
    if(!lease||typeof lease.id!=='string'||typeof lease.holder!=='string'||!ACTION_ID.test(lease.id)||!ACTION_ID.test(lease.holder)
      ||!Number.isSafeInteger(lease.generation)||lease.generation<1||typeof acknowledgementId!=='string'||!ACTION_ID.test(acknowledgementId)
      ||typeof resource!=='string'||!/^res:[a-f0-9]{64}$/u.test(resource))return false;
    return this.transaction(()=>{
      const encoded=JSON.stringify({lease:{id:lease.id,generation:lease.generation,holder:lease.holder},resource});
      const receipt=this.db.prepare('SELECT report_json FROM mind_action_resource_acknowledgements WHERE id=?').get(acknowledgementId);
      if(receipt)return receipt.report_json===encoded;
      const action=this.get(lease.id);
      if(!action||action.state!=='unknown'||action.generation!==lease.generation+1||action.lastHolder!==lease.holder||action.holder!==null)return false;
      const row=this.db.prepare('SELECT base_resources_json FROM mind_actions WHERE id=?').get(lease.id)!;
      const base=JSON.parse(String(row.base_resources_json)) as string[];
      if(!action.resources.includes(resource))return false;
      // A base key is released only while it is recorded as retained (a release before the record existed stays free).
      if(base.includes(resource)&&!retainedOf(this.db,lease.id).has(resource))return false;
      // Re-read the domain's original immutable proof under this writer lock, fencing late native cleanup insertion.
      if(!this.resourceReconciliationAllowed?.(lease,resource,acknowledgementId))return false;
      // Do not settle paid calls, finish the task, clear sent, or release any other operation's exclusion.
      this.db.prepare('UPDATE mind_actions SET resources_json=? WHERE id=?').run(JSON.stringify(action.resources.filter(key=>key!==resource)),lease.id);
      this.db.prepare('INSERT INTO mind_action_resource_acknowledgements VALUES(?,?)').run(acknowledgementId,encoded);
      const release:RetainedRelease={requestId:`proof:${acknowledgementId}`,scopeKey:action.scopeKey,actionId:lease.id,
        releasedBy:'domain',reason:'domain_proof',at};
      releaseRetained(this.db,release,[resource]);
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
        this.db.prepare(`UPDATE mind_actions SET state=?,sent=0,effect_sent=0,resources_json=base_resources_json,progress=?,result=?,
          failures=?,last_failure=?,holder=CASE WHEN ?='waiting' THEN holder ELSE NULL END,
          lease_until=CASE WHEN ?='waiting' THEN lease_until ELSE NULL END,updated_at=? WHERE id=?`)
          .run(state,checkpoint?report.code:null,code,failures,report.failureCode??null,state,state,at,action.id);
      }
      this.db.prepare('INSERT INTO mind_action_acknowledgements VALUES(?,?)').run(report.id,encoded);
      return true;
    });
  }
  /** Returns how many unknown actions reached their exit in this sweep. Every time is compared as a parsed instant (S5). */
  sweep(at: string): number {
    for(const row of this.db.prepare("SELECT * FROM mind_actions WHERE state IN ('running','waiting','stopping')").all()) {
      const action=view(row);
      const leaseEnded=action.leaseUntil!==null&&!instantAfter(action.leaseUntil,at);
      if(!leaseEnded&&!(action.deadline&&!instantAfter(action.deadline,at)))continue;
      this.db.prepare("UPDATE mind_actions SET state=CASE WHEN sent=1 THEN 'unknown' ELSE 'cancelled' END,effect_sent=sent,result='lease_expired',holder=NULL,lease_until=NULL,generation=generation+1,updated_at=? WHERE id=?").run(at,action.id);
      this.db.prepare("UPDATE mind_action_budget SET state='held' WHERE action_id=? AND state='reserved'").run(action.id);
    }
    for(const row of this.db.prepare("SELECT id,deadline FROM mind_actions WHERE state='queued' AND deadline IS NOT NULL AND deadline<>''").all()){
      if(instantAfter(String(row.deadline),at))continue;
      this.db.prepare("UPDATE mind_actions SET state='cancelled',result='deadline',updated_at=? WHERE id=?").run(at,String(row.id));
    }
    const exited=this.exitUnknown(at);
    this.settleRetained(at);
    return exited;
  }
  /**
   * The one unknown exit of an action (ADR-0009 stage 1, S5; `unknownExit`). An unknown outcome is never replayed and never
   * resumable; what kept the scheduler blocked was `sent=1`: a live slot and every resource of the attempt. After
   * `UNKNOWN_EXIT_MS` the slot is freed (`sent` cleared, `effect_sent` kept) and the result says how it left: the step of a
   * model-only task is retired (`unknown_retired`), anything that may act outside is closed (`outcome_unknown_closed`). A
   * retained resource (`retainedResources.ts`: an Agent Host lock with its folder lock, the Minecraft body, base or added) stays
   * excluded until a release proof or the owner's release; other added locks (study, folders alone) have no such proof and are
   * released with the slot. The state stays `unknown`, a closed state: held budget stays held, and a late canonical
   * acknowledgement or reconcile can still close the original attempt (and so prove a retained release).
   */
  private exitUnknown(at:string):number {
    let exited=0;
    for(const row of this.db.prepare("SELECT * FROM mind_actions WHERE state='unknown' AND sent=1").all()){
      const action=view(row);
      const link=actionTaskLink(this.db,action);
      const base=JSON.parse(String(row.base_resources_json)) as string[];
      const retained=(key:string)=>this.retainedAfterRelease(key,action.resources,action);
      if(!unknownDue(String(row.updated_at),at,link.taskKind))continue;
      // A step that holds a resource only a release proof frees (the Minecraft body, an Agent Host) may have acted outside: it is
      // closed as such, whatever its task's kind (Minecraft run 6, 2026-10-14: a body-moving step was retired as effect `none`).
      const exit=unknownExit(action.resources.some(retained)?'external':actionEffectClass(link.taskKind),link.taskKind);
      const kept=action.resources.filter(key=>base.includes(key)||retained(key));
      this.db.prepare("UPDATE mind_actions SET sent=0,effect_sent=1,resources_json=?,result=?,updated_at=? WHERE id=?").run(JSON.stringify(kept),exit.code,at,action.id);
      // The retained keys are recorded now: only a recorded key keeps excluding others (retainedResourceStore.ts).
      recordRetained(this.db,action.id,kept.filter(retained),at);
      exited+=1;
    }
    return exited;
  }
  /** What an action excludes others from: everything while live or sent-unknown; after release, unproven additions and recorded keys. */
  private heldResources(action:ActionView):readonly string[] {
    if(['running','waiting','stopping'].includes(action.state)||(action.state==='unknown'&&action.sent))return action.resources;
    if(action.state!=='unknown')return [];
    const row=this.db.prepare('SELECT base_resources_json FROM mind_actions WHERE id=?').get(action.id);
    const base=JSON.parse(String(row?.base_resources_json??'[]')) as string[];
    const recorded=retainedOf(this.db,action.id);
    return action.resources.filter(key=>!base.includes(key)||recorded.has(key));
  }
}
