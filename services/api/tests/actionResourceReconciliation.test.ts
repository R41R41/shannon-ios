import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { configuredMindWorker } from '../src/wiring/mindWorkerWiring.js';
import { actionThreadsClient } from '../src/wiring/actionThreadsWiring.js';
import { MindSocketClient } from '../src/infra/ipc/mindSocket.js';
import { createMindHost } from '../src/mind/workspace/workspacePorts.js';
import { lifecycleResourceAcknowledgement } from '../src/wiring/configuredActionResourceProof.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import { MinecraftLifecycleStore } from '../src/surfaces/minecraft/store/minecraftLifecycleStore.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt } from '../src/contracts/minecraftLifecycleContract.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const at='2026-10-09T00:00:00.000Z',later='2026-10-09T00:00:31.000Z';
const body=actionResource('minecraft','body'),base=actionResource('mind','cycle'),other=actionResource('document','draft');
function fixture(path=':memory:') {
  const db=new DatabaseSync(path);cleanups.push(()=>db.close());const store=new SQLiteActionStore(db,()=>true);
  const view=store.claim(store.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'original',resources:[base]},at).id,'original-holder',at)!;
  const lease=leaseOf(view);
  store.reserve(lease,'original-budget','2026-10-09',1200,2000,0,at);store.dispatch(lease,at,[body,other]);
  return {db,store,lease,expire:()=>store.transaction(()=>store.sweep(later))};
}
describe('narrow original unknown resource release',()=>{
  it('releases only the dynamic body and preserves the complete original action and held paid reservation',()=>{
    const f=fixture();f.expire();
    const actionBefore=f.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(f.lease.id)!;
    const budgetBefore=f.db.prepare('SELECT * FROM mind_action_budget').all();
    expect(f.store.reconcileResource(f.lease,body,'native-release')).toBe(true);
    const actionAfter=f.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(f.lease.id)!;
    expect({...actionAfter,resources_json:actionBefore.resources_json}).toEqual(actionBefore);
    expect(f.store.get(f.lease.id)).toMatchObject({state:'unknown',sent:true,resources:[base,other].sort(),result:'lease_expired'});
    expect(f.db.prepare('SELECT * FROM mind_action_budget').all()).toEqual(budgetBefore);
    expect(budgetBefore[0]).toMatchObject({state:'held',yen:1200});
    expect(f.store.resume('owner',f.lease.id,later)).toBe(false);
    expect(f.store.dispatch(f.lease,later,[body])).toBe(false);
  });
  it('permits new body use while keeping other resource exclusions and the original paid cap',()=>{
    const f=fixture();f.expire();
    const next=f.store.claim(f.store.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'next'},later).id,'new-holder',later)!;
    const lease=leaseOf(next);
    expect(f.store.dispatch(lease,later,[body])).toBe(false);
    expect(f.store.reconcileResource(f.lease,body,'body-released')).toBe(true);
    expect(f.store.dispatch(lease,later,[body])).toBe(true);
    expect(f.store.dispatch(lease,later,[other])).toBe(false);
    expect(f.store.dispatch(lease,later,[base])).toBe(false);
    const second=f.store.claim(f.store.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:'second'},later).id,'second-holder',later)!;
    expect(f.store.reserve(leaseOf(second),'second-budget','2026-10-09',1000,2000,0,later)).toBe(false);
    expect(f.store.get(f.lease.id)).toMatchObject({state:'unknown',sent:true});
  });
  it('refuses running, stopping, absent resources, base claims, wrong holders and wrong generations',()=>{
    const f=fixture();
    expect(f.store.reconcileResource(f.lease,body,'running-release')).toBe(false);
    f.store.stop('owner',f.lease.id,'stop',at);
    expect(f.store.reconcileResource(f.lease,body,'stopping-release')).toBe(false);
    f.expire();
    for(const lease of [{...f.lease,holder:'wrong'}, {...f.lease,generation:0}, {...f.lease,generation:f.lease.generation+1}, {...f.lease,id:'missing'}])
      expect(f.store.reconcileResource(lease,body,'invalid-lease')).toBe(false);
    expect(f.store.reconcileResource(f.lease,base,'base-release')).toBe(false);
    expect(f.store.reconcileResource(f.lease,actionResource('unused','body'),'absent-release')).toBe(false);
    expect(f.store.reconcileResource(f.lease,'private-path','invalid-resource')).toBe(false);
    expect(f.db.prepare('SELECT * FROM mind_action_resource_acknowledgements').all()).toEqual([]);
  });
  it('keeps immutable receipt identity across reconnect and cannot mutate a new holder on replay',()=>{
    const directory=mkdtempSync(join(tmpdir(),'resource-receipt-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,'db.sqlite'),f=fixture(path);f.expire();
    expect(f.store.reconcileResource(f.lease,body,'release')).toBe(true);
    const reopenedDb=new DatabaseSync(path);cleanups.push(()=>reopenedDb.close());const reopened=new SQLiteActionStore(reopenedDb,()=>true);
    expect(reopened.reconcileResource(f.lease,body,'release')).toBe(true);
    expect(reopened.reconcileResource(f.lease,other,'release')).toBe(false);
    expect(reopened.reconcileResource({...f.lease,holder:'wrong'},body,'release')).toBe(false);
    expect(reopened.reconcile(f.lease,'cancelled','all_operations_known',later)).toBe(true);
    expect(reopened.resume('owner',f.lease.id,later)).toBe(true);
    const newer=reopened.claim(f.lease.id,'new-holder',later)!;reopened.dispatch(leaseOf(newer),later,[body]);
    const before=reopened.get(f.lease.id);
    expect(reopened.reconcileResource(f.lease,body,'release')).toBe(true);
    expect(reopened.reconcileResource(f.lease,body,'fresh-stale-release')).toBe(false);
    expect(reopened.get(f.lease.id)).toEqual(before);
    reopened.finish(leaseOf(newer),'unknown','later_unknown',later);
    expect(reopened.reconcileResource(f.lease,body,'wrong-generation')).toBe(false);
    expect(reopened.get(f.lease.id)?.resources).toContain(body);
  });
  it('commits receipt and resource removal atomically',()=>{
    const f=fixture();f.expire();const before=f.store.get(f.lease.id);
    f.db.exec("CREATE TRIGGER reject_resource_receipt BEFORE INSERT ON mind_action_resource_acknowledgements BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END;");
    expect(()=>f.store.reconcileResource(f.lease,body,'failed-commit')).toThrow('injected_receipt_failure');
    expect(f.store.get(f.lease.id)).toEqual(before);expect(f.db.prepare('SELECT * FROM mind_action_resource_acknowledgements').all()).toEqual([]);
    f.db.exec('DROP TRIGGER reject_resource_receipt');expect(f.store.reconcileResource(f.lease,body,'failed-commit')).toBe(true);
  });
  it('denies without a trusted proof and checks a changing domain proof within the writer transaction',()=>{
    const f=fixture();f.expire();const before=f.store.get(f.lease.id);
    expect(new SQLiteActionStore(f.db).reconcileResource(f.lease,body,'unproven-release')).toBe(false);
    f.db.exec("CREATE TABLE physical_release_guard(pending INTEGER);INSERT INTO physical_release_guard VALUES(0);");
    let calls=0;
    const guarded=new SQLiteActionStore(f.db,(lease,resource,id)=>{
      calls++;expect(f.db.isTransaction).toBe(true);expect(lease).toEqual(f.lease);expect(resource).toBe(body);expect(id).toBe('proven-release');
      return f.db.prepare('SELECT pending FROM physical_release_guard').get()!.pending===0;
    });
    // A cleanup command inserted after API proof collection, before the worker acquires its transaction.
    f.db.prepare('UPDATE physical_release_guard SET pending=1').run();
    expect(guarded.reconcileResource(f.lease,body,'proven-release')).toBe(false);expect(guarded.get(f.lease.id)).toEqual(before);
    expect(f.db.prepare('SELECT * FROM mind_action_resource_acknowledgements').all()).toEqual([]);
    f.db.prepare('UPDATE physical_release_guard SET pending=0').run();expect(guarded.reconcileResource(f.lease,body,'proven-release')).toBe(true);
    const acceptedCalls=calls;f.db.prepare('UPDATE physical_release_guard SET pending=1').run();
    expect(guarded.reconcileResource(f.lease,body,'proven-release')).toBe(true);expect(calls).toBe(acceptedCalls);
  });
  it('uses the real ActionThreads IPC owner without granting new execution or whole-action rights',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'resource-ipc-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,'db.sqlite'),socket=join(directory,'mind.sock');
    const values={SHANNON_MIND_SOCKET:socket,SHANNON_MINECRAFT_LIFECYCLE:'on',SHANNON_MINECRAFT_BODY_JSON:JSON.stringify({deviceId:'operator',servers:[{serverId:'home',title:'Home',onlineMode:true,ownerUuid:'b9191317-c52d-4d67-85fe-ab831e6db146'}]})};
    const worker=await configuredMindWorker(values,path,()=>{
      const host=createMindHost({switches:{attention:false,workspace:false,dataFrames:false},journal:null,inbox:null,now:()=>at});
      return {host,close:()=>host.close()};
    },()=>at);cleanups.push(worker.close);
    const client=new MindSocketClient(socket);cleanups.push(()=>client.close());const actions=actionThreadsClient(client.call,'ipc-holder');
    const view=await actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'ipc-original'}),lease=leaseOf(view!);
    const physical=actionResource('operator','minecraft-body');
    expect(await actions.dispatch(lease,[physical,other])).toBe(true);
    expect(await actions.reconcileResource(lease,physical,'premature')).toBe(false);
    await actions.finish(lease,'unknown','outside_unknown');
    expect(await actions.reconcileResource(lease,physical,'unproven')).toBe(false);
    const nativeDb=new DatabaseSync(path);cleanups.push(()=>nativeDb.close());const nativeStore=new MinecraftLifecycleStore(nativeDb);
    const command:MinecraftLifecycleCommand={schemaVersion:1,id:'lifecycle:original',connectionId:'connection',serverId:'home',action:'login',authority:{scopeKey:'owner',origin:'owner_request',executionId:lease.id,lease,sourceIds:[]},issuedAt:at,deadlineAt:'2026-10-09T00:01:00.000Z'};
    nativeStore.insert(command);nativeStore.deliver(command.id);
    const service=new MinecraftLifecycle(nativeStore,configuredMinecraftBody(values)!,{now:()=>Date.parse(at),allowed:()=>false});
    const receipt:MinecraftLifecycleReceipt={id:command.id,connectionId:'connection',serverId:'home',action:'login',outcome:'completed',code:'changed',observedAt:at,inputsReleased:true,state:{serverId:'home',observedAt:at,running:'running',bot:'joined',otherPlayers:0}};
    expect(service.poll({scopeKey:'owner',deviceId:'operator'},{schemaVersion:1,connectionId:'connection',sequence:0,states:[receipt.state],receipts:[receipt]}).acknowledged).toEqual([command.id]);
    const acknowledgement=lifecycleResourceAcknowledgement(nativeDb.prepare('SELECT id,receipt_json FROM minecraft_lifecycle_operations ORDER BY id').all());
    expect(await actions.reconcileResource({...lease,holder:'wrong'},physical,acknowledgement)).toBe(false);
    expect(await actions.reconcileResource(lease,physical,'wrong-evidence')).toBe(false);
    expect(await actions.reconcileResource(lease,physical,acknowledgement)).toBe(true);
    expect(await actions.reconcileResource(lease,physical,acknowledgement)).toBe(true);
    expect(await actions.reconcileResource(lease,other,acknowledgement)).toBe(false);
    expect(await actions.get('owner',lease.id)).toMatchObject({state:'unknown',sent:true,resources:[other],result:'outside_unknown'});
    expect(await actions.renew(lease)).toBeNull();expect(await actions.resume('owner',lease.id)).toBe(false);
  });
});
