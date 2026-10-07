import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
const databases:DatabaseSync[]=[];
const at='2026-10-07T12:00:00.000Z';
const later='2026-10-07T12:00:31.000Z';
function store(){const db=new DatabaseSync(':memory:');databases.push(db);return new SQLiteActionStore(db);}
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
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
