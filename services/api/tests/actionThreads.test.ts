import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { SLOT_LIMITS_TODAY } from '@shannon/mind';
import { useSlotLimits } from './support/slotLimits.js';
const databases:DatabaseSync[]=[];
const at='2026-10-07T12:00:00.000Z';
const later='2026-10-07T12:00:31.000Z';
// These cases were written against the S3 limits (one foreground, two background slots); since S6 the limits are data.
function store(){const db=new DatabaseSync(':memory:');databases.push(db);const s=new SQLiteActionStore(db);useSlotLimits(db,SLOT_LIMITS_TODAY);return s;}
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
describe('atomic foreground admission',()=>{
  const draft=(sourceId:string)=>({scopeKey:'owner',kind:'respond' as const,origin:'owner_request' as const,sourceId});
  it('uses one immediate transaction and durable commit and does not reacquire a running or completed attempt',()=>{
    const s=store(),exec=vi.spyOn(databases.at(-1)!,'exec');
    const running=s.admitRespond({...draft('talk'),deadline:later},'api',at)!;
    expect(exec.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN IMMEDIATE','COMMIT']);exec.mockRestore();
    expect(running).toMatchObject({state:'running',generation:1,holder:'api',deadline:null});
    expect(s.admitRespond(draft('talk'),'other-api',at)).toBeNull();expect(s.get(running.id)).toEqual(running);
    s.finish(leaseOf(running),'completed','responded',at);
    expect(s.admitRespond(draft('talk'),'api',at)).toBeNull();expect(s.get(running.id)?.generation).toBe(1);
  });
  it('commits a competing queued turn and later admits that same identity after the foreground releases',()=>{
    const s=store(),first=s.admitRespond(draft('first'),'api',at)!;
    expect(s.admitRespond(draft('second'),'other-api',at)).toBeNull();
    const queued=s.list('owner').find(action=>action.sourceId==='second')!;
    expect(queued).toMatchObject({state:'queued',generation:0,holder:null});
    s.finish(leaseOf(first),'completed','responded',at);
    expect(s.admitRespond({...draft('second'),ownerInformed:true},'other-api',at)).toMatchObject({id:queued.id,state:'running',generation:1,ownerInformed:true});
    expect(s.list('owner').filter(action=>action.sourceId==='second')).toHaveLength(1);
  });
  it('sweeps expired leases and deadlines while retaining uncertain resource exclusion',()=>{
    const s=store(),resource=actionResource('synthetic','folder');
    const old=s.admitRespond({...draft('old'),resources:[resource]},'old-api',at)!;s.dispatch(leaseOf(old),at);
    expect(s.admitRespond({...draft('blocked'),resources:[resource]},'new-api',later)).toBeNull();
    expect(s.get(old.id)).toMatchObject({state:'unknown',generation:2,sent:true,resources:[resource]});
    expect(s.admitRespond({...draft('expired'),deadline:at},'new-api',later)).toBeNull();
    expect(s.list('owner').some(action=>action.sourceId==='expired')).toBe(false);
    expect(databases.at(-1)!.prepare("SELECT state,result FROM mind_actions WHERE source_id='expired'").get()).toEqual({state:'cancelled',result:'deadline'});
    expect(s.admitRespond(draft('independent'),'new-api',later)).toMatchObject({state:'running',generation:1});
  });
  it('validates kind, draft, holder and parent without inserting a failed admission',()=>{
    const s=store();
    expect(()=>s.admitRespond({...draft('background'),kind:'agentTask'},'api',at)).toThrow('ACTION_RESPOND');
    expect(()=>s.admitRespond({...draft('invalid'),origin:'own_time'},'api',at)).toThrow('ACTION_DRAFT');
    expect(()=>s.admitRespond({...draft('invalid'),resources:['private-path']},'api',at)).toThrow('ACTION_DRAFT');
    expect(()=>s.admitRespond(draft('invalid'),'bad holder',at)).toThrow('ACTION_HOLDER');
    const parent=s.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'parent',ownerInformed:true},at);
    expect(s.admitRespond({...draft('child'),parentId:parent.id},'api',at)).toMatchObject({parentId:parent.id,ownerInformed:true});
    s.stop('owner',parent.id,'parent-stop',at);
    expect(()=>s.admitRespond({...draft('rejected-child'),parentId:parent.id},'api',at)).toThrow('ACTION_PARENT');
    expect(()=>s.admitRespond({...draft('child'),parentId:null},'api',at)).toThrow('ACTION_ORIGIN');
    expect(databases.at(-1)!.prepare("SELECT source_id FROM mind_actions WHERE source_id NOT IN ('parent','child')").all()).toEqual([]);
  });
  it('rolls back the inserted draft if claim fails before commit',()=>{
    const s=store(),db=databases.at(-1)!;
    db.exec("CREATE TRIGGER reject_admission BEFORE UPDATE ON mind_actions WHEN NEW.source_id='failing' AND NEW.state='running' BEGIN SELECT RAISE(ABORT,'injected_claim_failure'); END;");
    expect(()=>s.admitRespond(draft('failing'),'api',at)).toThrow('injected_claim_failure');
    expect(db.prepare("SELECT id FROM mind_actions WHERE source_id='failing'").all()).toEqual([]);
    db.exec('DROP TRIGGER reject_admission');
    expect(s.admitRespond(draft('failing'),'api',at)).toMatchObject({state:'running',generation:1});
  });
});
describe('one foreground and two background threads',()=>{
  it('keeps the third background queued and gives the foreground its independent slot',()=>{
    const s=store(), make=(sourceId:string,kind:'ownTime'|'respond'='ownTime')=>s.enqueue({scopeKey:'owner',sourceId,kind,origin:kind==='ownTime'?'own_time':'owner_request'},at);
    const first=s.claim(make('one').id,'a',at)!;s.claim(make('two').id,'b',at);
    const third=make('three');expect(s.claim(third.id,'c',at)).toBeNull();
    expect(s.claim(make('talk','respond').id,'d',at)?.state).toBe('running');
    expect(s.claim(make('talk2','respond').id,'e',at)).toBeNull();
    s.finish(leaseOf(first),'completed','done',at);expect(s.claim(third.id,'c',at)?.state).toBe('running');
  });
  it('fences an expired runner, preserves unknown results, and does not run them again',()=>{
    const s=store(),draft={scopeKey:'owner',sourceId:'one',kind:'ownTime' as const,origin:'own_time' as const};
    const first=s.claim(s.enqueue(draft,at).id,'runner',at)!;
    expect(s.dispatch(leaseOf(first),at)).toBe(true);
    expect(s.claim(first.id,'new',later)).toBeNull();
    expect(s.get(first.id)?.state).toBe('unknown');
    expect(s.finish(leaseOf(first),'completed','done',later)).toBeNull();
    expect(s.enqueue(draft,later).state).toBe('unknown');
    expect(s.resume('owner',first.id,later)).toBe(false);
  });
  it('retains an uncertain sent background slot until its canonical acknowledgement while allowing conversation',()=>{
    const s=store(),make=(sourceId:string,kind:'agentTask'|'respond'='agentTask')=>s.enqueue({scopeKey:'owner',kind,origin:'owner_request',sourceId},at);
    const a=s.claim(make('lost').id,'a',at)!;s.dispatch(leaseOf(a),at);
    s.transaction(()=>s.sweep(later));expect(s.get(a.id)?.state).toBe('unknown');
    expect(s.claim(make('second').id,'b',later)).not.toBeNull();
    const third=make('third');expect(s.claim(third.id,'c',later)).toBeNull();
    expect(s.claim(make('talk','respond').id,'api',later)?.state).toBe('running');
    expect(s.reconcile(leaseOf(a),'cancelled','outside_stopped',later)).toBe(true);
    expect(s.claim(third.id,'c',later)).not.toBeNull();
  });
  it('holds competing resources through a stop until the runner acknowledges it',()=>{
    const s=store(),resource=actionResource('mac','/notes/a');
    const a=s.claim(s.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'one',resources:[resource]},at).id,'a',at)!;
    const b=s.enqueue({scopeKey:'owner',kind:'minecraft',origin:'owner_request',sourceId:'two',resources:[resource]},at);
    s.stop('owner',a.id,'request',at);
    expect(s.claim(b.id,'b',at)).toBeNull();expect(s.dispatch(leaseOf(a),at)).toBe(false);
    s.finish(leaseOf(a),'cancelled','stopped',at);expect(s.claim(b.id,'b',at)).not.toBeNull();
  });
  it('stops descendants while leaving the conversation running and rejects cross-scope requests',()=>{
    const s=store(),parent=s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'parent',ownerInformed:true},at);
    const child=s.enqueue({scopeKey:'owner',kind:'minecraft',origin:'own_time',sourceId:'child',parentId:parent.id},at);
    expect(child.ownerInformed).toBe(true);
    const talk=s.claim(s.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'talk'},at).id,'api',at)!;
    s.stop('owner',parent.id,'stop',at);expect(s.get(child.id)?.state).toBe('cancelled');expect(s.get(talk.id)?.state).toBe('running');
    expect(()=>s.stop('guest',null,'stop',at)).toThrow('ACTION_REQUEST_CONFLICT');
  });
  it('reserves the daily budget atomically across two threads and never refunds an unknown charge',()=>{
    const s=store(),make=(sourceId:string)=>s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId},at).id,sourceId,at)!;
    const a=leaseOf(make('a')),b=leaseOf(make('b'));
    expect(s.reserve(a,'call-a','2026-10-07',1_200,2_000,0,at)).toBe(true);
    expect(s.reserve(b,'call-b','2026-10-07',1_000,2_000,0,at)).toBe(false);
    expect(s.settle(a,'call-a',null,at)).toBe(true);
    expect(s.reserve(b,'call-b','2026-10-07',1_000,2_000,0,at)).toBe(false);
    expect(s.reserve(a,'call-a','2026-10-07',1_200,2_000,0,at)).toBe(false);
  });
  it('returns acknowledged step resources and halts the actual thread on its fifth identical step failure',()=>{
    const s=store(),draft={scopeKey:'owner',kind:'ownTime' as const,origin:'own_time' as const,sourceId:'steps'};
    const first=s.claim(s.enqueue(draft,at).id,'runner',at)!, lease=leaseOf(first),resource=actionResource('owner','study');
    for(let index=0;index<5;index++){
      expect(s.dispatch(lease,at,[resource])).toBe(true);
      expect(s.checkpoint(lease,'note',at,'provider_failed')).toBe(index<4);
      expect(s.get(first.id)?.resources).not.toContain(resource);
    }
    expect(s.get(first.id)).toMatchObject({state:'failed',failures:5,result:'repeated_failure'});
    expect(s.dispatch(lease,at)).toBe(false);
    expect(s.resume('owner',first.id,at)).toBe(false);
  });
  it('settles known usage after a stop but retains an unknown operation until a canonical acknowledgement',()=>{
    const s=store(),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'one'},at).id,'a',at)!;
    const token=leaseOf(a);s.reserve(token,'budget','2026-10-07',100,2000,0,at);s.dispatch(token,at);s.stop('owner',a.id,'stop',at);
    expect(s.settle(token,'budget',42,at)).toBe(true);expect(s.settle(token,'budget',42,at)).toBe(false);
    s.transaction(()=>s.sweep(later));expect(s.get(a.id)?.state).toBe('unknown');
    expect(s.reconcile(token,'cancelled','outside_stopped',later)).toBe(true);
    expect(s.reconcile(token,'completed','late_duplicate',later)).toBe(false);
  });
  it('settles an expired estimate only from its original acknowledged attempt before reconciling it',()=>{
    const s=store(),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'late'},at).id,'a',at)!;
    const token=leaseOf(a);
    expect(s.reserve(token,'late-budget','2026-10-07',1200,2000,0,at)).toBe(true);
    expect(s.dispatch(token,at)).toBe(true);s.stop('owner',a.id,'late-stop',at);
    // Settlement must normalize an expired lease even before the one-second sweep has run.
    expect(s.settle({...token,holder:'wrong'},'late-budget',400,later)).toBe(false);
    expect(s.get(a.id)?.state).toBe('unknown');
    expect(s.settle(token,'late-budget',null,later)).toBe(false);
    expect(s.settle({...token,generation:token.generation+1},'late-budget',400,later)).toBe(false);
    const b=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'other'},later).id,'b',later)!;
    expect(s.reserve(leaseOf(b),'other-budget','2026-10-07',1000,2000,400,later)).toBe(false);
    expect(s.settle(token,'late-budget',400,later)).toBe(true);
    expect(s.settle(token,'late-budget',400,later)).toBe(false);
    expect(s.reserve(leaseOf(b),'other-budget','2026-10-07',1000,2000,400,later)).toBe(true);
    expect(s.reconcile(token,'cancelled','stop_acknowledged',later)).toBe(true);
    expect(s.resume('owner',a.id,later)).toBe(true);
    expect(s.claim(a.id,'new-holder',later)?.generation).toBe(3);
    expect(s.reconcile(token,'completed','stale_ack',later)).toBe(false);
  });
  it('returns only known unused reservations after a not-sent lease expires',()=>{
    const s=store(),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'unused'},at).id,'a',at)!;
    const token=leaseOf(a);s.reserve(token,'unused-budget','2026-10-07',100,2000,0,at);
    expect(s.settle(token,'unused-budget',42,later)).toBe(false);
    expect(s.get(a.id)?.state).toBe('cancelled');
    expect(s.settle(token,'unused-budget',0,later)).toBe(true);
  });
  it('receipts a known late acknowledgement without granting execution or accepting a different report',()=>{
    const s=store(),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'ack'},at).id,'a',at)!;
    const lease=leaseOf(a),report={id:'ack-one',scopeKey:'owner',lease,reservationId:'ack-budget',actual:400,state:'checkpoint' as const,code:'think'};
    s.reserve(lease,'ack-budget','2026-10-07',1200,2000,0,at);s.dispatch(lease,at);
    expect(s.acknowledge({...report,lease:{...lease,holder:'wrong'}},later)).toBe(false);
    expect(s.acknowledge(report,later)).toBe(true);
    expect(s.get(a.id)).toMatchObject({state:'cancelled',generation:2,result:'step_acknowledged',holder:null,sent:false});
    expect(s.resume('owner',a.id,later)).toBe(true);const resumed=s.claim(a.id,'new',later)!;
    expect(s.acknowledge(report,later)).toBe(true);expect(s.get(a.id)).toEqual(resumed);
    expect(s.acknowledge({...report,actual:399},later)).toBe(false);
    expect(s.acknowledge({...report,id:'different-ack'},later)).toBe(false);
  });
  it('counts an acknowledged failure once despite lost replies and ends at the fifth identical failure',()=>{
    const s=store(),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'ack-fail'},at).id,'a',at)!;
    const lease=leaseOf(a);
    for(let index=0;index<5;index++){
      const report={id:`failure-${index}`,scopeKey:'owner',lease,reservationId:null,actual:0,state:'checkpoint' as const,code:'think',failureCode:'provider_failed'};
      s.dispatch(lease,at);expect(s.acknowledge(report,at)).toBe(true);expect(s.acknowledge(report,at)).toBe(true);
      expect(s.get(a.id)?.failures).toBe(index+1);
    }
    expect(s.get(a.id)).toMatchObject({state:'failed',result:'repeated_failure',failures:5});
    expect(s.resume('owner',a.id,at)).toBe(false);
  });
  it('settles known model usage without acknowledging an uncertain outside write or releasing its lock',()=>{
    const s=store(),resource=actionResource('owner','study'),a=s.claim(s.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'uncertain-write',resources:[resource]},at).id,'a',at)!;
    const lease=leaseOf(a);s.reserve(lease,'known-model','2026-10-07',100,2000,0,at);s.dispatch(lease,at);
    s.transaction(()=>s.sweep(later));
    expect(s.acknowledge({id:'usage-only',scopeKey:'owner',lease,reservationId:'known-model',actual:42,state:'budget',code:'model_usage_known'},later)).toBe(true);
    expect(s.get(a.id)).toMatchObject({state:'unknown',sent:true,resources:[resource]});
    expect(s.resume('owner',a.id,later)).toBe(false);
    const competing=s.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'competing',resources:[resource]},later);
    expect(s.claim(competing.id,'other',later)).toBeNull();
  });
  it('stops after five consecutive identical failures and preserves the origin',()=>{
    const s=store(),draft={scopeKey:'owner',kind:'ownTime' as const,origin:'own_time' as const,sourceId:'fail'};
    const action=s.enqueue(draft,at);
    for(let i=0;i<5;i++){
      const claimed=s.claim(action.id,'runner',at)!;expect(claimed).not.toBeNull();s.finish(leaseOf(claimed),'failed','network',at);
      expect(s.resume('owner',action.id,at)).toBe(i<4);
    }
    expect(s.get(action.id)?.failures).toBe(5);
    expect(()=>s.enqueue({...draft,origin:'owner_request'},at)).toThrow();
    expect(actionResource('pc','C:\\work\\a\\..\\B')).toBe(actionResource('pc','c:\\work\\b'));
  });
});
