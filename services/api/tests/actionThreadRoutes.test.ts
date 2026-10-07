import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createActionThreadRoute } from '../src/infra/http/actionThreadRoutes.js';
import { actionHarness } from './support/actionThreadHarness.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(others=false){
  const now=()=>new Date().toISOString(),h=actionHarness(now);cleanups.push(h.close);
  const route=createActionThreadRoute(h.actions,'owner',async()=>{},now,()=>others);
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
it('reads back an idempotent stop, keeps foreground running, and refuses unknown resume',async()=>{
  const h=await fixture(),own=await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'cycle'});
  const active=await h.actions.claim(own.id),talk=await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'talk'});
  await h.actions.claim(talk.id);
  for(let n=0;n<2;n++){expect((await h.call('/stop-all',{requestId:'same-stop',scopeKey:'guest'})).status).toBe(200);}
  const views=await h.actions.list('owner');expect(views.find(v=>v.id===own.id)?.state).toBe('stopping');expect(views.find(v=>v.id===talk.id)?.state).toBe('running');
  await h.actions.finish({id:active!.id,holder:active!.holder!,generation:active!.generation},'unknown','lost');
  expect((await h.call(`/${own.id}/resume`,{requestId:'resume'})).status).toBe(409);
});
