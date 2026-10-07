import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeedbackRoute, type FeedbackRouteDependencies } from '../src/infra/http/feedbackRoutes.js';
import { feedbackHarness } from './support/feedbackHarness.js';
let h:ReturnType<typeof feedbackHarness>,server:Server;
afterEach(async()=>{if(server)await new Promise<void>(done=>server.close(()=>done()));h?.close();});
async function serve(overrides:Partial<FeedbackRouteDependencies>={},scope='owner') {
  const route=createFeedbackRoute({feedback:h.feedback,ownerScopeKey:'owner',ownerAlone:()=>h.clock.alone,...overrides});
  server=createServer((request,response)=>{void route(request,response,{scopeKey:scope});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as AddressInfo).port;
  return (method:string,path:string,body?:unknown)=>new Promise<{status:number;body:Record<string,unknown>}>((done,fail)=>{
    const request=httpRequest({host:'127.0.0.1',port,path,method,headers:{'content-type':'application/json'}},response=>{let text='';response.on('data',chunk=>{text+=String(chunk);});response.on('end',()=>done({status:response.statusCode??0,body:JSON.parse(text)}));});
    request.on('error',fail);request.end(body===undefined?undefined:JSON.stringify(body));
  });
}
describe('owner feedback HTTP boundary',()=>{
  it('acknowledges an unknown original operation separately from a newer device revision, without replay',async()=>{
    h=feedbackHarness();const target=h.seed().target!,call=await serve(),operationId=randomUUID();
    const first={targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId,reaction:'good'};
    expect((await call('POST','/v1/feedback',first)).body).toMatchObject({feedback:{revision:1,reaction:'good'}});
    expect((await call('POST','/v1/feedback',{...first,operationId:randomUUID(),expectedRevision:1,reaction:'bad'})).status).toBe(200);
    const read=await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=talk&operationId=${operationId}`);
    expect(read).toMatchObject({status:200,body:{feedback:{revision:2,reaction:'bad'},operation:{revision:1,reaction:'good',operationId}}});
    expect((await call('POST','/v1/feedback',first)).body).toMatchObject({feedback:{revision:1,reaction:'good'}});
    expect(h.feedback.store.lastSeq('owner')).toBe(2);
    expect(JSON.stringify(read.body)).not.toMatch(/synthetic-private|架空|choiceId|replyDigest|recordId|arguments/);
    expect((await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=other`)).status).toBe(404);
    expect((await call('POST','/v1/feedback',{...first,eligible:true})).status).toBe(400);
  });
  it('fails closed if the audience changes while GET projection runs',async()=>{
    h=feedbackHarness();const target=h.seed().target!;
    const call=await serve({feedback:{get(scope,id,thread){const result=h.feedback.get(scope,id,thread);h.clock.alone=false;return result;},getOperation:()=>null,change:(scope,input)=>h.feedback.change(scope,input)}});
    expect(await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=talk`)).toMatchObject({status:403,body:{error:'FEEDBACK_OWNER_ALONE_REQUIRED'}});
  });
  it.each(['others','error'] as const)('rechecks the audience after delayed POST body parsing: %s',async mode=>{
    h=feedbackHarness();const target=h.seed().target!;let checks=0;
    const call=await serve({ownerAlone(){if(++checks===1)return true;if(mode==='error')throw new Error('unknown');return false;}});
    expect((await call('POST','/v1/feedback',{targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId:randomUUID(),reaction:'bad'})).status).toBe(403);
    expect(h.feedback.store.lastSeq('owner')).toBe(0);
  });
  it('does not leak accepted state if audience becomes unknown after the mutation',async()=>{
    h=feedbackHarness();const target=h.seed().target!;
    const call=await serve({feedback:{get:(scope,id,thread)=>h.feedback.get(scope,id,thread),getOperation:(scope,id,thread,operation)=>h.feedback.getOperation(scope,id,thread,operation),change(scope,input){const result=h.feedback.change(scope,input);h.clock.alone=false;return result;}}});
    const operationId=randomUUID();
    expect((await call('POST','/v1/feedback',{targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId,reaction:'good'})).status).toBe(403);
    expect(h.feedback.store.lastSeq('owner')).toBe(1);
    h.clock.alone=true;
    expect((await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=talk&operationId=${operationId}`)).body).toMatchObject({operation:{operationId,revision:1}});
  });
  it('keeps owner scope, OFF and forgotten source fail closed',async()=>{
    h=feedbackHarness();const target=h.seed().target!;const call=await serve({},'guest');
    expect((await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=talk`)).status).toBe(403);
    h.db.prepare("DELETE FROM conversation_messages WHERE scope_key='owner'").run();
    expect(h.feedback.getOperation('owner',target.targetId,'talk','unknown')).toBeNull();
    expect(createFeedbackRoute({feedback:null,ownerScopeKey:'owner',ownerAlone:()=>true})).toBeTypeOf('function');
  });
  it('reports an unknown source as unavailable so read-back never claims an uncertain operation was definitely absent',async()=>{
    h=feedbackHarness();const target=h.seed().target!,call=await serve();
    h.clock.unknown=true;
    expect((await call('GET',`/v1/feedback?targetId=${target.targetId}&threadId=talk&operationId=uncertain-op`)).status).toBe(503);
    expect((await call('POST','/v1/feedback',{targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId:'uncertain-op',reaction:'good'})).status).toBe(503);
    expect(h.feedback.store.lastSeq('owner')).toBe(0);
  });
});
