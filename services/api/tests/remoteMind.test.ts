import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, createInitialCompanionState } from '@shannon/cognition';
import { configuredMind } from '../src/wiring/mindWiring.js';
import { configuredMindWorker } from '../src/wiring/mindWorkerWiring.js';
import { configuredRemoteMind } from '../src/wiring/remoteMindWiring.js';
import { textPerception } from '../src/mind/perception/perceptionPorts.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { serveMindSocket } from '../src/infra/ipc/mindSocket.js';
import { MindSocketClient } from '../src/infra/ipc/mindSocket.js';
import { actionThreadsClient } from '../src/wiring/actionThreadsWiring.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const at='2026-10-07T12:00:00.000Z',now=()=>at;
const on={SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE4:'on'};
function location(){const dir=mkdtempSync(join(tmpdir(),'shannon-ipc-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'db.sqlite')};}
/** The worker's calls as the test makes them: production's 1 s bound, but at least 10 s here (a whole suite on many workers starts the worker slowly). */
const patient=(client:MindSocketClient)=>(<T>(method:string,args:unknown,timeoutMs?:number)=>client.call<T>(method,args,Math.max(timeoutMs??0,10_000)));
function ownerHost(path:string){const mind=configuredMind(on,{role:'worker',databasePath:path,now,schedule:work=>work()})!;return {host:mind.host!,close:mind.close};}
describe('one mind across the process boundary',()=>{
  it('admits the real foreground through one RPC and keeps a competing turn queued',async()=>{
    const {path,dir}=location(),worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
    const client=new MindSocketClient(join(dir,'mind-runtime','mind.sock'));cleanups.push(()=>client.close());
    const methods:string[]=[],actions=actionThreadsClient(async(method,args)=>{methods.push(method);return patient(client)(method,args);},'api');
    const draft={scopeKey:'owner',kind:'respond' as const,origin:'owner_request' as const,sourceId:'first'};
    const first=await acquireAction(actions,draft);expect(first).not.toBeNull();
    expect(methods).toEqual(['action.admitRespond']);
    expect(await acquireAction(actions,{...draft,sourceId:'second'})).toBeNull();
    const queued=(await actions.list('owner')).find(action=>action.sourceId==='second')!;expect(queued.state).toBe('queued');
    await first!.finish('completed','responded');
    const second=await acquireAction(actions,{...draft,sourceId:'second'});expect(second?.view).toMatchObject({id:queued.id,state:'running',generation:1});
    await second!.finish('completed','responded');
    expect(methods).not.toContain('action.enqueue');expect(methods).not.toContain('action.claim');
  });
  it('acquires the socket before constructing its owner, and rejects a second owner without constructing it',async()=>{
    const {path}=location();const worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
    let constructed=false;
    await expect(configuredMindWorker(on,path,()=>{constructed=true;return ownerHost(path);},now)).rejects.toThrow('MIND_IPC_ALREADY_RUNNING');
    expect(constructed).toBe(false);
  });
  it('reads an exact canonical receipt beyond the terminal presentation window and fences its scope',async()=>{
    const {path,dir}=location(),worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
    const client=new MindSocketClient(join(dir,'mind-runtime','mind.sock'));cleanups.push(()=>client.close());
    const actions=actionThreadsClient(patient(client),'api');
    let original='';
    for(let index=0;index<41;index++){
      const action=worker.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:`canonical-${index}`},
        new Date(Date.parse(at)+index).toISOString());
      const running=worker.actions.claim(action.id,'original-host',at)!;
      worker.actions.finish({id:running.id,generation:running.generation,holder:running.holder!},'completed','done',
        new Date(Date.parse(at)+index).toISOString());
      if(index===0)original=action.id;
    }
    expect(await actions.list('owner')).toHaveLength(40);
    expect((await actions.list('owner')).some(action=>action.id===original)).toBe(false);
    expect(await actions.get('owner',original)).toMatchObject({id:original,state:'completed',sourceId:'canonical-0'});
    expect(await actions.get('other-scope',original)).toBeNull();
    expect(await actions.get('owner','missing-original')).toBeNull();
    await expect(actions.get('owner','malformed id')).rejects.toThrow('MIND_IPC_REMOTE');
  });
  it('rechecks forgetting after IPC, does not persist owner words, and exposes no owner text to others',async()=>{
    const {path}=location(),store=new SQLiteShannonStore({path,now});cleanups.push(()=>store.close());
    store.apply('owner',{type:'user-fact-upserted',source:'conversation',fact:{id:'key',statement:'ユーザーは合鍵を植木鉢の下に置いている',confidence:0.95,observedAt:at,evidence:'合鍵は植木鉢の下'}});
    const worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
    const remote=configuredRemoteMind(on,path);cleanups.push(remote.close);
    remote.host.perceive('owner',textPerception({threadId:'other',message:'合鍵は植木鉢の下にあるよ',present:OWNER_AUDIENCE,alone:true,at}));
    await remote.host.sync();
    const captured=store.snapshot('owner');
    const turn={scopeKey:'owner',surface:'text' as const,present:OWNER_AUDIENCE,at,currentItemId:null,current:null,snapshot:captured,snapshotNow:()=>store.snapshot('owner'),store};
    expect(remote.host.render(turn)).toContain('植木鉢');
    store.apply('owner',{type:'memory-control-upserted',control:{memoryId:'key',kind:'user-fact',status:'forgotten',pinned:false,updatedAt:at,changeReason:'user'}});
    expect(remote.host.render(turn)).not.toContain('植木鉢');
    expect(remote.host.render({...turn,present:UNKNOWN_GUEST_PRESENCE})).not.toContain('植木鉢');
    expect(remote.host.view('owner',at).held.length).toBeGreaterThan(0);
    const wall=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(wall+2_001);
    try { expect(remote.host.view('owner',at).held).toEqual([]);expect(remote.host.render(turn)).toBe(''); }
    finally { clock.mockRestore(); }
    await worker.close();cleanups.splice(cleanups.indexOf(worker.close),1);
    const db=new DatabaseSync(path);cleanups.push(()=>db.close());
    const words=JSON.stringify(db.prepare('SELECT * FROM mind_workspace_journal').all())+JSON.stringify(db.prepare('SELECT * FROM mind_workspace_snapshots').all());
    expect(words).not.toContain('植木鉢');
  });
  it('drops late perceptions without mixing them into the next turn and clears the cache on disconnect',async()=>{
    const {path}=location(),socket=join(location().dir,'mind.sock');
    const server=await serveMindSocket(socket,async()=>{await new Promise(resolve=>setTimeout(resolve,30));return {item:null,projection:{scope:{held:[],notices:[],summary:{count:0}},texts:{},faulted:false,faults:0,busy:0}};});cleanups.push(server.close);
    const remote=configuredRemoteMind({...on,SHANNON_MIND_SOCKET:socket},path);cleanups.push(remote.close);
    remote.host.perceive('owner',textPerception({threadId:'old',message:'old private words',present:OWNER_AUDIENCE,alone:true,at}));
    await remote.host.sync();await new Promise(resolve=>setTimeout(resolve,45));
    expect(remote.host.render({scopeKey:'owner',surface:'text',present:OWNER_AUDIENCE,at,currentItemId:null,current:null,snapshot:createInitialCompanionState('owner',at),store:null})).toBe('');
  });
  it('OFF keeps the stage 3 in-process owner and no action runner',()=>{
    const {path}=location(),mind=configuredMind({...on,SHANNON_ADR8_STAGE4:'off'},{databasePath:path,now})!;cleanups.push(mind.close);
    expect('actions' in mind).toBe(false);expect('foreground' in mind.host!).toBe(false);
    expect(mind.host!.perceive('owner',textPerception({threadId:'same',message:'hey',present:OWNER_AUDIENCE,alone:true,at}))).not.toBeNull();
  });
});

it('records an unknown notice receipt through the single worker IPC without changing execution rows',async()=>{
  const {path,dir}=location(),worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
  const client=new MindSocketClient(join(dir,'mind-runtime','mind.sock'));cleanups.push(()=>client.close());
  const actions=actionThreadsClient(patient(client),'api');
  const draft=await actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'maintenance',sourceId:'synthetic-maintenance'});
  const active=(await actions.claim(draft.id))!,lease={id:active.id,generation:active.generation,holder:active.holder!};
  await actions.dispatch(lease);const original=(await actions.finish(lease,'unknown','fca_result_unknown'))!;
  expect(await actions.acknowledgeNotice('guest',original.id,original.notification!.id,'read-guest')).toBe(false);
  expect(await actions.acknowledgeNotice('owner',original.id,original.notification!.id,'read-owner')).toBe(true);
  const read=(await actions.get('owner',original.id))!;
  expect({...read,notification:undefined}).toEqual({...original,notification:undefined});
  expect(read.notification).toEqual({id:original.notification!.id,acknowledgedAt:at});
});
