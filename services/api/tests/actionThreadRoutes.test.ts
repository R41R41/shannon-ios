import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionThreadRoute } from '../src/infra/http/actionThreadRoutes.js';
import { actionHarness } from './support/actionThreadHarness.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(others:boolean|(()=>boolean)=false){
  const now=()=>new Date().toISOString(),h=actionHarness(now);cleanups.push(h.close);
  const route=createActionThreadRoute(h.actions,'owner',async()=>{},now,typeof others==='function'?others:()=>others);
  const server=createServer((req,res)=>{void route(req,res,req.headers['x-test-scope'] ? {deviceId:'phone',scopeKey:String(req.headers['x-test-scope'])}:null,new URL(req.url!,'http://localhost').pathname);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/action-threads`;
  const call=(path='',body?:unknown,scope='owner')=>fetch(base+path,{method:body?'POST':'GET',headers:{'x-test-scope':scope,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {...h,call};
}
it('requires the authenticated owner and uses server audience even if a client requests private detail',async()=>{
  const h=await fixture(true);await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'private-source'});
  expect((await h.call('',undefined,'guest')).status).toBe(403);
  const response=await h.call('?audience=owner'),body=await response.json();
  expect(body).toMatchObject({count:1,othersPresent:true,threads:[]});expect(JSON.stringify(body)).not.toContain('private-source');
});
it.each(['GET','POST'] as const)('%s rechecks the server audience after the action IPC wait',async method=>{
  let others=false;
  const h=await fixture(()=>others),own=await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'cycle'});
  let release!:()=>void,entered!:()=>void,listCalls=0;
  const held=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const list=h.actions.list;
  vi.spyOn(h.actions,'list').mockImplementation(async scope=>{
    if(++listCalls===(method==='GET'?1:2)){entered();await held;}
    return list(scope);
  });
  const pending=method==='GET'?h.call('?audience=owner'):h.call(`/${own.id}/stop`,{requestId:'audience-stop'});
  await waiting;others=true;release();
  const response=await pending,body=await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({othersPresent:true,threads:[]});
  if(method==='POST')expect(h.store.get(own.id)?.state).toBe('cancelled');
});
it.each(['throws','unknown'] as const)('withholds detail when the server audience %s at delivery',async outcome=>{
  const h=await fixture(()=>{if(outcome==='throws')throw new Error('audience unavailable');return undefined as unknown as boolean;});
  await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'cycle'});
  expect(await (await h.call('?audience=owner')).json()).toMatchObject({othersPresent:true,threads:[]});
});
it('reads back an idempotent stop, keeps foreground running, and refuses unknown resume',async()=>{
  const h=await fixture(),own=await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'cycle'});
  const active=await h.actions.claim(own.id),talk=await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'talk'});
  await h.actions.claim(talk.id);
  for(let n=0;n<2;n++){expect((await h.call('/stop-all',{requestId:'same-stop',scopeKey:'guest'})).status).toBe(200);}
  const views=await h.actions.list('owner');expect(views.find(v=>v.id===own.id)?.state).toBe('stopping');expect(views.find(v=>v.id===talk.id)?.state).toBe('running');
  await h.actions.finish({id:active!.id,holder:active!.holder!,generation:active!.generation},'unknown','lost');
  expect((await h.call(`/${own.id}/resume`,{requestId:'resume'})).status).toBe(409);
});
it('lets the owner release what a lost unknown action retains, naming the device, and says when nothing is held (ADR-0009 §9)', async () => {
  const h = await fixture();
  const own = await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'lost-task' });
  const calls: unknown[][] = [];
  let released: number | null = 2;
  h.actions.releaseRetained = async (...args) => { calls.push(args); return released; };
  const ok = await h.call(`/${own.id}/release-retained`, { requestId: 'release-1' });
  expect(ok.status).toBe(200);
  expect(calls).toEqual([['owner', own.id, 'release-1', 'phone']]);
  released = null;
  expect((await h.call(`/${own.id}/release-retained`, { requestId: 'release-2' })).status).toBe(409);
  expect((await h.call(`/${own.id}/release-retained`, { requestId: 'release-3' }, 'guest')).status).toBe(403);
});
