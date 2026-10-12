import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionThreadRoute, publicActionThreads } from '../src/infra/http/actionThreadRoutes.js';
import { actionHarness } from './support/actionThreadHarness.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const at='2026-10-11T01:00:00.000Z',now=()=>at,key=`res:${'a'.repeat(64)}`;
async function unknown(h:ReturnType<typeof actionHarness>,source='cycle'){
  const action=await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:source,resources:[key],ownerInformed:true});
  const running=await h.actions.claim(action.id),lease={id:action.id,generation:running!.generation,holder:running!.holder!};
  await h.actions.reserve(lease,`budget-${source}`,'2026-10-11',200,2000,0);await h.actions.dispatch(lease);
  const result=(await h.actions.finish(lease,'unknown','model_result_unknown'))!;
  return {action:result,lease,notificationId:result.notification!.id};
}
function rows(h:ReturnType<typeof actionHarness>){
  return {actions:h.db.prepare('SELECT * FROM mind_actions ORDER BY id').all(),budget:h.db.prepare('SELECT * FROM mind_action_budget ORDER BY reservation_id').all()};
}
it('keeps every original action and budget field unchanged, remains unknown and retains resource exclusion',async()=>{
  const h=actionHarness(now);cleanups.push(h.close);const a=await unknown(h),before=rows(h);
  expect(await h.actions.acknowledgeNotice('owner',a.action.id,a.notificationId,'read-one')).toBe(true);
  expect(rows(h)).toEqual(before);
  expect(h.store.get(a.action.id)).toMatchObject({state:'unknown',sent:true,ownerInformed:true,resources:[key],notification:{id:a.notificationId,acknowledgedAt:at}});
  const other=await h.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'blocked',resources:[key]});
  expect(await h.actions.claim(other.id)).toBeNull();
  expect(await h.actions.resume('owner',a.action.id)).toBe(false);
  expect(publicActionThreads(await h.actions.list('owner'),at,false).threads.some(row=>row.id===a.action.id&&row.state==='unknown')).toBe(true);
});
it('compares exact scope, action, unknown episode and request payload without changing execution',async()=>{
  const h=actionHarness(now);cleanups.push(h.close);const a=await unknown(h),before=rows(h);
  for(const [scope,id,token,request] of [['guest',a.action.id,a.notificationId,'other-owner'],['owner','missing',a.notificationId,'missing'],['owner',a.action.id,'b'.repeat(64),'stale']])
    expect(await h.actions.acknowledgeNotice(scope!,id!,token!,request!)).toBe(false);
  expect(await h.actions.acknowledgeNotice('owner',a.action.id,a.notificationId,'original-read')).toBe(true);
  expect(await h.actions.acknowledgeNotice('owner',a.action.id,a.notificationId,'original-read')).toBe(true);
  expect(await h.actions.acknowledgeNotice('owner',a.action.id,'b'.repeat(64),'original-read')).toBe(false);
  expect(h.db.prepare('SELECT * FROM mind_action_notice_receipts').all()).toHaveLength(1);expect(rows(h)).toEqual(before);
  await h.actions.reconcile(a.lease,'failed','known');await h.actions.resume('owner',a.action.id);
  const next=(await h.actions.claim(a.action.id))!;
  const later=(await h.actions.finish({id:next.id,generation:next.generation,holder:next.holder!},'unknown','model_result_unknown'))!;
  expect(later.notification!.id).not.toBe(a.notificationId);expect(later.notification!.acknowledgedAt).toBeNull();
  expect(await h.actions.acknowledgeNotice('owner',a.action.id,a.notificationId,'old-episode')).toBe(false);
});
it('persists the owner receipt across restart while preserving unknown attempt fields',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shannon-notice-')),path=join(dir,'db.sqlite');cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const first=actionHarness(now,path),a=await unknown(first),before=rows(first);
  await first.actions.acknowledgeNotice('owner',a.action.id,a.notificationId,'read');first.close();
  const second=actionHarness(now,path);cleanups.push(second.close);
  expect(rows(second)).toEqual(before);expect((await second.actions.list('owner'))[0]!.notification).toEqual({id:a.notificationId,acknowledgedAt:at});
});
it('never creates owner notice receipts for foreground respond',async()=>{
  const h=actionHarness(now);cleanups.push(h.close);
  const a=await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'talk'}),active=(await h.actions.claim(a.id))!;
  const ended=(await h.actions.finish({id:a.id,generation:active.generation,holder:active.holder!},'unknown','lost'))!;
  expect(ended.notification).toBeUndefined();expect(publicActionThreads([ended],at,false).threads).toEqual([]);
  expect(await h.actions.acknowledgeNotice('owner',a.id,'a'.repeat(64),'read')).toBe(false);
});
async function httpFixture(audience:()=>boolean=()=>false){
  const h=actionHarness(now);cleanups.push(h.close);const stop=vi.fn(async()=>{}),route=createActionThreadRoute(h.actions,'owner',stop,now,audience);
  const server=createServer((req,res)=>{void route(req,res,{deviceId:'phone',scopeKey:String(req.headers['x-scope']??'owner')},new URL(req.url!,'http://localhost').pathname);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanups.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/action-threads`;
  const post=(id:string,token:string,scope='owner')=>fetch(`${base}/${id}/acknowledge-notice`,{method:'POST',headers:{'content-type':'application/json','x-scope':scope},body:JSON.stringify({requestId:'read-http',notificationId:token,scopeKey:'guest'})});
  return {...h,post,stop};
}
it('authenticates owner scope, exposes only notification receipt and never calls outside stop',async()=>{
  const h=await httpFixture(),a=await unknown(h);
  expect((await h.post(a.action.id,a.notificationId,'guest')).status).toBe(403);
  const response=await h.post(a.action.id,a.notificationId),body=await response.json() as ReturnType<typeof publicActionThreads>;
  expect(response.status).toBe(200);expect(body).toMatchObject({threads:[{state:'unknown',notification:{id:a.notificationId,acknowledgedAt:at}}]});
  expect(JSON.stringify(body)).not.toContain(key);expect(JSON.stringify(body)).not.toContain('ownerInformed');expect(h.stop).not.toHaveBeenCalled();
});
it('rechecks audience after the original read before recording a receipt',async()=>{
  let others=false;const h=await httpFixture(()=>others),a=await unknown(h),get=h.actions.get;
  vi.spyOn(h.actions,'get').mockImplementation(async(scope,id)=>{const value=await get(scope,id);others=true;return value;});
  expect((await h.post(a.action.id,a.notificationId)).status).toBe(403);
  expect(h.db.prepare('SELECT * FROM mind_action_notice_receipts').all()).toEqual([]);
});
it('withholds detail if audience changes during the acknowledgement wait',async()=>{
  let others=false;const h=await httpFixture(()=>others),a=await unknown(h),ack=h.actions.acknowledgeNotice;
  vi.spyOn(h.actions,'acknowledgeNotice').mockImplementation(async(...args)=>{const success=await ack(...args);others=true;return success;});
  const response=await h.post(a.action.id,a.notificationId);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({othersPresent:true,threads:[]});
});
it('lists an unknown outcome while its notice awaits the owner, and lets it age out once read or when it has no notice', () => {
  const base = { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 's', state: 'unknown', progress: null, result: null,
    failures: 0, generation: 1, sent: false, resources: [], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
  const awaiting = { ...base, id: 'awaiting', notification: { id: 'n1', acknowledgedAt: null } };
  const read = { ...base, id: 'read', notification: { id: 'n2', acknowledgedAt: '2026-10-10T01:00:00.000Z' } };
  const silent = { ...base, id: 'silent' };
  const fresh = { ...base, id: 'fresh', updatedAt: '2026-10-11T00:30:00.000Z' };
  const views = [awaiting, read, silent, fresh] as unknown as Parameters<typeof publicActionThreads>[0];
  expect(publicActionThreads(views, at, false).threads.map(row => row.id)).toEqual(['awaiting', 'fresh']);
});
