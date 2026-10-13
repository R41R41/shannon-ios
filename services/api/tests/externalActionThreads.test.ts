import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { externalActionWiring } from '../src/wiring/externalActionWiring.js';
import { publicActionThreads } from '../src/infra/http/actionThreadRoutes.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { SLOT_LIMITS_TODAY } from '@shannon/mind';
import { useSlotLimits } from './support/slotLimits.js';
const cleanups:Array<()=>void>=[];
afterEach(()=>cleanups.splice(0).reverse().forEach(close=>close()));
const at='2026-10-07T12:00:00.000Z';
// Written against the S3 limits (two background slots); since S6 the limits are data.
function harness(){let clock=at;const h=actionHarness(()=>clock),tasks=new SQLiteAgentTaskStore(':memory:');cleanups.push(()=>tasks.close(),h.close);useSlotLimits(h.db,SLOT_LIMITS_TODAY);
  const wiring=externalActionWiring(h.actions,tasks,'owner',()=>clock);
  return {...h,tasks,wiring,now:()=>clock,advance:()=>{clock='2026-10-07T12:00:31.000Z';}};
}
describe('canonical outside work under mind execution rights',()=>{
  it('keeps a trusted self task in the autonomy lane and preserves a prior canonical owner admission',async()=>{
    const h=actionHarness(()=>at),tasks=new SQLiteAgentTaskStore(':memory:',{taskTreeEnabled:true});cleanups.push(()=>tasks.close(),h.close);
    const wiring=externalActionWiring(h.actions,tasks,'owner',()=>at);
    const authority={origin:'own_time' as const,budgetLane:'autonomy' as const,ownerInformed:false,permissionId:'proposal:self'};
    const task=tasks.create('owner',{idempotencyKey:'self',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary',taskAuthority:authority},at).task;
    await wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'host-one',actionThreads:1}});
    expect(h.store.list('owner').find(item=>item.sourceId===task.id)).toMatchObject({origin:'own_time',ownerInformed:false});
    const another=tasks.create('owner',{idempotencyKey:'prior',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary',hostHint:'host-two',taskAuthority:authority},at).task;
    await h.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:another.id,ownerInformed:true});
    await wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'host-two',actionThreads:1}});
    expect(h.store.list('owner').find(item=>item.sourceId===another.id)).toMatchObject({origin:'owner_request',ownerInformed:true});
  });
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
    expect(await externalActionWiring(null,h.tasks,'owner',h.now).beforeHost(request)).toBeUndefined();
  });
  it('keeps a lost outside result locked, acknowledges command receipt separately, and closes only on the original turn result',async()=>{
    const h=harness();h.tasks.heartbeat({hostId:'mac',displayName:'Mac',kind:'local',capabilities:[],projects:[],models:[]},at);
    const task=h.tasks.create('owner',{idempotencyKey:'uncertain',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary'},at).task;
    const command=(await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}}))!.body as {command:{id:string;actionLease:ReturnType<typeof leaseOf>}};
    const send=async(event:{eventId:string;type:'progress'|'command_completed'|'paused';payload:Record<string,unknown>})=>{
      const request=await h.wiring.filterHostEvents({method:'POST',path:'/v1/agent/host/events',body:{hostId:'mac',events:[{...event,taskId:task.id,title:'synthetic',occurredAt:at,payload:{...event.payload,actionLease:command.command.actionLease}}]}});
      h.tasks.recordHostEvents('mac',(request.body as {events:import('../src/mind/action/agentTasks/agentTasksPorts.js').HostAgentEvent[]}).events,h.now());
      await h.wiring.afterHost(request,{status:200,body:{}});
    };
    await send({eventId:'uncertain',type:'progress',payload:{executionUncertain:true}});
    await send({eventId:'receipt',type:'command_completed',payload:{commandId:command.command.id}});
    const action=h.store.list('owner').find(v=>v.kind==='agentTask')!;
    expect(action.state).toBe('unknown');expect(h.tasks.get('owner',task.id)?.status).toBe('running');
    const foreground=await h.actions.claim((await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'write'})).id);
    expect(await h.actions.dispatch(leaseOf(foreground!),[actionResource('owner','folder:mac')])).toBe(false);
    h.advance();expect(h.tasks.claim('mac',h.now())).toBeNull(); // Receipt prevents automatic command replay.
    await send({eventId:'ack',type:'paused',payload:{pauseReason:'owner'}});
    expect(h.store.get(action.id)?.state).toBe('cancelled');
    const fresh=await h.actions.claim((await h.actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'fresh-write'})).id);
    expect(await h.actions.dispatch(leaseOf(fresh!),[actionResource('owner','folder:mac')])).toBe(true);
  });
  it('re-admits a known paused task when the owner sends a new instruction',async()=>{
    const h=harness(),task=h.tasks.create('owner',{idempotencyKey:'steer',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary'},at).task;
    const response=(await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}}))!.body as {command:{actionLease:ReturnType<typeof leaseOf>}};
    const ack={eventId:'paused',taskId:task.id,type:'paused' as const,title:'paused',occurredAt:at,payload:{actionLease:response.command.actionLease,pauseReason:'owner'}};
    h.tasks.recordHostEvents('mac',[ack],at);await h.wiring.afterHost({method:'POST',path:'/v1/agent/host/events',body:{events:[ack]}},{status:200,body:{}});
    h.tasks.enqueue('owner',task.id,{idempotencyKey:'new-instruction',type:'steer',payload:{instruction:'Continue with this condition'}},at);
    expect((await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}}))?.body).toMatchObject({command:{type:'steer',actionLease:{generation:2}}});
    const late=await h.wiring.filterHostEvents({method:'POST',path:'/v1/agent/host/events',body:{hostId:'mac',events:[{...ack,eventId:'late-old-ack'}]}});
    expect((late.body as {events:unknown[]}).events).toEqual([]);
    expect(h.store.get(response.command.actionLease.id)?.state).toBe('running');
  });
  it('withdraws execution rights for the existing canonical task pause immediately',async()=>{
    const h=harness(),task=h.tasks.create('owner',{idempotencyKey:'pause',conversationThreadID:'talk',title:'task',goal:'goal',summary:'summary'},at).task;
    const response=(await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/commands/claim',body:{hostId:'mac',actionThreads:1}}))!.body as {command:{actionLease:ReturnType<typeof leaseOf>}};
    h.tasks.enqueue('owner',task.id,{idempotencyKey:'legacy-pause',type:'interrupt',payload:{}},at);
    expect((await h.wiring.beforeHost({method:'POST',path:'/v1/agent/host/actions/permit',body:{hostId:'mac',taskId:task.id,lease:response.command.actionLease}}))?.body).toEqual({allowed:false});
    expect(h.store.get(response.command.actionLease.id)?.state).toBe('stopping');
  });
  it('discloses only closed summaries, and no task details at all with others present',async()=>{
    const h=harness();await h.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'secret-source',ownerInformed:true});
    const owner=publicActionThreads(h.store.list('owner'),at,false),others=publicActionThreads(h.store.list('owner'),at,true);
    expect(JSON.stringify(owner)).not.toContain('secret-source');expect(owner.threads[0]).not.toHaveProperty('resources');
    expect(others.threads).toEqual([]);expect(others.count).toBe(1);
  });
});
