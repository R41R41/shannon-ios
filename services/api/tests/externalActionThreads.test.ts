import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { externalActionWiring } from '../src/wiring/externalActionWiring.js';
import { minecraftActionPort } from '../src/wiring/minecraftActionWiring.js';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import { publicActionThreads } from '../src/infra/http/actionThreadRoutes.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
const cleanups:Array<()=>void>=[];
afterEach(()=>cleanups.splice(0).reverse().forEach(close=>close()));
const at='2026-10-07T12:00:00.000Z';
function harness(){let clock=at;const h=actionHarness(()=>clock),tasks=new SQLiteAgentTaskStore(':memory:');cleanups.push(()=>tasks.close(),h.close);
  const wiring=externalActionWiring(h.actions,tasks,null,'owner',()=>clock);
  return {...h,tasks,wiring,now:()=>clock,advance:()=>{clock='2026-10-07T12:00:31.000Z';}};
}
describe('canonical outside work under mind execution rights',()=>{
  it('leaves a third task queued without leasing its canonical command, and admits it when a slot ends',async()=>{
    const h=harness();
    const slots=[];
    for(const sourceId of ['one','two'])slots.push(await h.actions.claim((await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId})).id));
    const task=h.tasks.create('owner',{idempotencyKey:'task',conversationThreadID:'talk',title:'private title',goal:'private goal',summary:'summary'},at).task;
    const claim={method:'POST' as const,path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}};
    expect((await h.wiring.beforeHost(claim))?.body).toEqual({command:null});
    expect(h.tasks.peekCommand('mac',at)?.attempts).toBe(0);
    await h.actions.finish(leaseOf(slots[0]!), 'completed','done');
    const response=await h.wiring.beforeHost(claim);
    expect(response?.body).toMatchObject({command:{taskId:task.id,attempts:1,actionLease:{generation:1}}});
    expect(h.tasks.list('owner')).toHaveLength(1); // No second task authority.
  });
  it('shares the Mac folder lock between a local host task and conversation writes',async()=>{
    const h=harness();
    h.tasks.heartbeat({hostId:'mac',displayName:'Mac',kind:'local',capabilities:[],projects:[],models:[]},at);
    h.tasks.create('owner',{idempotencyKey:'task',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary'},at);
    const response=await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}});
    const lease=(response!.body as {command:{actionLease:ReturnType<typeof leaseOf>}}).command.actionLease;
    const foreground=await h.actions.claim((await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'talk-write'})).id);
    expect(await h.actions.dispatch(leaseOf(foreground!),[actionResource('owner','folder:mac')])).toBe(false);
    await h.actions.finish(lease,'completed','host_completed');
    expect(await h.actions.dispatch(leaseOf(foreground!),[actionResource('owner','folder:mac')])).toBe(true);
  });
  it('denies a stop/lost lease immediately, fences late progress, and waits for the host stop acknowledgement',async()=>{
    const h=harness(),task=h.tasks.create('owner',{idempotencyKey:'task',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary'},at).task;
    const response=await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}});
    const command=(response!.body as {command:{actionLease:ReturnType<typeof leaseOf>}}).command;
    const view=h.store.list('owner')[0]!;
    const views=await h.actions.stop('owner',view.id,'stop');await h.wiring.stopOutside(views,'stop');
    expect((await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/actions/permit',body:{hostId:'mac',taskId:task.id,lease:command.actionLease}}))?.body).toEqual({allowed:false});
    expect(h.store.get(view.id)?.state).toBe('stopping');
    h.advance();h.store.transaction(()=>h.store.sweep(h.now()));
    const late={eventId:'late',taskId:task.id,type:'progress',title:'old runner',occurredAt:at,payload:{actionLease:command.actionLease}};
    const filtered=await h.wiring.filterHostEvents({method:'POST',path:'/v1/agent/host/events',body:{hostId:'mac',events:[late]}});
    expect((filtered.body as {events:unknown[]}).events).toEqual([]);
    const ack={...late,eventId:'ack',type:'paused' as const,payload:{actionLease:command.actionLease,pauseReason:'owner'}};
    const request=await h.wiring.filterHostEvents({method:'POST',path:'/v1/agent/host/events',body:{hostId:'mac',events:[ack]}});
    h.tasks.recordHostEvents('mac',[ack],h.now());await h.wiring.afterHost(request,{status:200,body:{}});
    expect(h.store.get(view.id)?.state).toBe('cancelled');
  });
  it('does not deliver work to an un-upgraded host, and OFF retains the original claim route',async()=>{
    const h=harness(),request={method:'POST' as const,path:'/v1/agent/host/commands/claim',body:{hostId:'mac'}};
    expect((await h.wiring.beforeHost(request))?.status).toBe(503);
    expect(await externalActionWiring(null,h.tasks,null,'owner',h.now).beforeHost(request)).toBeUndefined();
  });
  it('never marks Minecraft claimed when admission is blocked, propagates cancellation, and closes only after a body result',async()=>{
    const h=harness(),folder=mkdtempSync(join(tmpdir(),'shannon-stage4-body-'));cleanups.push(()=>rmSync(folder,{recursive:true,force:true}));
    const queue=new MinecraftBodyRequests(join(folder,'body.sqlite'),{ownerScopeKey:'owner',deviceId:'body'},h.now);cleanups.push(()=>queue.close());
    queue.execution=minecraftActionPort(h.actions);
    await queue.claim('owner','body',{waitSeconds:0,holding:[]});
    const asked=queue.enqueue('owner',{goal:'collect wood',origin:{surface:'text'},dedupeKey:'one'});
    if(asked.kind!=='queued')throw new Error('fixture');
    const slots=[];for(const sourceId of ['a','b'])slots.push(await h.actions.claim((await h.actions.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId})).id));
    expect(await queue.claim('owner','body',{waitSeconds:0,holding:[]})).toEqual({request:null,cancel:[]});
    expect(queue.recent('owner')[0]?.state).toBe('queued');
    await h.actions.finish(leaseOf(slots[0]!), 'completed','done');
    expect(await queue.claim('owner','body',{waitSeconds:0,holding:[]})).toMatchObject({request:{id:asked.request.id}});
    const action=h.store.list('owner').find(item=>item.kind==='minecraft')!;
    await h.actions.stop('owner',action.id,'body-stop');
    expect(await queue.claim('owner','body',{waitSeconds:0,holding:[asked.request.id]})).toMatchObject({cancel:[asked.request.id]});
    expect(h.store.get(action.id)?.state).toBe('stopping');
    queue.report('owner','body',asked.request.id,{outcome:'stopped',code:'stopped',gained:[]});
    await queue.acknowledgeExecution('owner',asked.request.id,'cancelled');
    expect(h.store.get(action.id)?.state).toBe('cancelled');
  });
  it('discloses only closed summaries, and no task details at all with others present',async()=>{
    const h=harness();await h.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'secret-source',ownerInformed:true});
    const owner=publicActionThreads(h.store.list('owner'),at,false),others=publicActionThreads(h.store.list('owner'),at,true);
    expect(JSON.stringify(owner)).not.toContain('secret-source');expect(owner.threads[0]).not.toHaveProperty('resources');
    expect(others.threads).toEqual([]);expect(others.count).toBe(1);
  });
});
