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
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const at='2026-10-07T12:00:00.000Z',now=()=>at;
const on={SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE4:'on'};
function location(){const dir=mkdtempSync(join(tmpdir(),'shannon-ipc-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'db.sqlite')};}
function ownerHost(path:string){const mind=configuredMind(on,{role:'worker',databasePath:path,now,schedule:work=>work()})!;return {host:mind.host!,close:mind.close};}
describe('one mind across the process boundary',()=>{
  it('acquires the socket before constructing its owner, and rejects a second owner without constructing it',async()=>{
    const {path}=location();const worker=await configuredMindWorker(on,path,()=>ownerHost(path),now);cleanups.push(worker.close);
    let constructed=false;
    await expect(configuredMindWorker(on,path,()=>{constructed=true;return ownerHost(path);},now)).rejects.toThrow('MIND_IPC_ALREADY_RUNNING');
    expect(constructed).toBe(false);
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
