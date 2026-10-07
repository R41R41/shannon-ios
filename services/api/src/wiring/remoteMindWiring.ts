import { MindSocketClient } from '../infra/ipc/mindSocket.js';
import { mindSocketPath } from '../infra/config/stage4.js';
import { actionThreadsClient } from './actionThreadsWiring.js';
import { foregroundRunner } from './actionExecutionWiring.js';
import { mindSwitches } from '@shannon/mind';
import { WorkspaceTextReader, workspaceBlocks, type MindHost, type WorkspaceTurn, type WorkspaceScope } from '../mind/workspace/workspacePorts.js';
import type { MindEvent } from '@shannon/mind';
import type { PerceivedDetail, PerceivedItem } from '../mind/perception/perceptionPorts.js';
export const MIND_TURN_IPC_MS=10;
type Projection={scope:WorkspaceScope;texts:Record<string,string>;faulted:boolean;faults:number;busy:number};
/** API projection only: no reducer, no journal, no second mind. Disclosure is always evaluated in the current API turn. */
export function configuredRemoteMind(values:Readonly<Record<string,string|undefined>>,databasePath:string) {
  const projections=new Map<string,{value:Projection;at:number}>();
  const inflight=new Set<Promise<void>>();
  const client=new MindSocketClient(mindSocketPath(values,databasePath),()=>projections.clear());
  let faults=0,busy=0,open=false;
  const update=(scopeKey:string,value:Projection)=>{projections.set(scopeKey,{value,at:Date.now()});faults=value.faults;busy=value.busy;open=value.faulted;};
  const note=(operation:Promise<void>)=>{inflight.add(operation);void operation.finally(()=>inflight.delete(operation)).catch(()=>{});};
  const actions=actionThreadsClient(client.call);
  const host:MindHost & {sync():Promise<void>;foreground:ReturnType<typeof foregroundRunner>}={
    foreground:foregroundRunner(actions),
    get dataFrames(){return mindSwitches(values).dataFrames && !open;},get faulted(){return open || !client.connected;},get faultCount(){return faults+client.faultCount;},get busyCount(){return busy;},
    perceive:(scopeKey:string,event:MindEvent|null,detail?:PerceivedDetail|null):PerceivedItem|null=>{
      if(!event)return null;
      const started=Date.now();
      note(client.call<{item:PerceivedItem|null;projection:Projection}>('mind.perceive',{scopeKey,event,detail},MIND_TURN_IPC_MS)
        .then(reply=>{if(Date.now()-started<=MIND_TURN_IPC_MS)update(scopeKey,reply.projection);})
        .catch(()=>{projections.delete(scopeKey);}));
      return {itemId:event.id,salience:0,verdict:'admitted'};
    },
    sync:async()=>{
      if(!inflight.size)return;
      let timer:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([Promise.allSettled([...inflight]),new Promise<void>(resolve=>{timer=setTimeout(resolve,MIND_TURN_IPC_MS);})]);
      if(timer)clearTimeout(timer);
    },
    render:(turn:WorkspaceTurn)=>{
      const cached=projections.get(turn.scopeKey);if(!cached || open || Date.now()-cached.at>2_000)return '';
      const reader=new WorkspaceTextReader(turn.snapshotNow?.() ?? turn.snapshot,turn.store,turn.scopeKey,turn.present);
      return workspaceBlocks(cached.value.scope,{surface:turn.surface,present:turn.present,at:turn.at,current:turn.current,currentItemId:turn.currentItemId,
        dataFrames:host.dataFrames,text:item=>reader.read(item,cached.value.texts[item.id]??null),noticeVisible:item=>reader.noticeVisible(item)});
    },
    bind:(scopeKey:string,itemId:string,ref:string)=>{
      note(client.call<Projection>('mind.bind',{scopeKey,itemId,ref}).then(value=>update(scopeKey,value)).catch(()=>{projections.delete(scopeKey);}));
    },
    turnEnded:()=>{void client.call('mind.flush',{}).catch(()=>{});},tick:()=>{void client.call('mind.flush',{}).catch(()=>{});},
    view:(scopeKey:string,_at:string)=>{const cached=projections.get(scopeKey);const p=cached && !open && Date.now()-cached.at<=2_000?cached.value.scope:undefined;return {held:p?.held.map(item=>({id:item.id,kind:item.kind,surface:item.surface,salience:item.initial,ref:item.ref}))??[],notices:p?.notices.map(item=>item.id)??[],summary:p?.summary.count??0};},
    projection:(_scopeKey:string)=>{throw new Error('MIND_PROJECTION_OWNER');},
    close:()=>{client.close();projections.clear();},
  };
  return {mind:host,host,actions,client,close:()=>host.close()};
}
