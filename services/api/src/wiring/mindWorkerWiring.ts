import { configuredActionResourceProof } from './configuredActionResourceProof.js';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_ID, type ActionDraft, type ActionLease } from '@shannon/mind';
import { SQLiteActionStore } from '../mind/action/threads/store/actionStore.js';
import type { MindHost } from '../mind/workspace/workspacePorts.js';
import { serveMindSocket } from '../infra/ipc/mindSocket.js';
import { mindSocketPath } from '../infra/config/stage4.js';
import { checkedMindEvent } from '../mind/perception/perceptionPorts.js';
import type { ActionAcknowledgement } from '../contracts/actionThreadContract.js';
/** Worker-only database and dispatcher; the API never opens the scheduler's writer. */
export async function configuredMindWorker(values:Readonly<Record<string,string|undefined>>,databasePath:string,hostFactory:()=>{host:MindHost;close():void},now:()=>string) {
  const db=new DatabaseSync(databasePath);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;');
  const actions=new SQLiteActionStore(db, configuredActionResourceProof(values, db));
  let host:MindHost;
  let closeHost:()=>void;
  const projection=(scopeKey:string)=>({...host.projection(scopeKey),faulted:host.faulted,faults:host.faultCount,busy:host.busyCount});
  let socket:Awaited<ReturnType<typeof serveMindSocket>>;
  try { socket=await serveMindSocket(mindSocketPath(values,databasePath),(method,input)=>{
    if(!input || typeof input!=='object'||Array.isArray(input))throw new Error('MIND_ARGS');
    const a=input as Record<string,unknown>,at=now();
    const text=(key:string)=>{const value=a[key];if(typeof value!=='string'||!ACTION_ID.test(value))throw new Error('MIND_ID');return value;};
    const lease=()=>{
      const l=a.lease as ActionLease;
      if(!l||typeof l.id!=='string'||typeof l.holder!=='string'||!ACTION_ID.test(l.id)||!ACTION_ID.test(l.holder)||!Number.isSafeInteger(l.generation)||l.generation<1)throw new Error('MIND_LEASE');
      return l;
    };
    switch(method){
      case 'mind.perceive':{
        const event=checkedMindEvent(a.event,{copyAudience:true});if(typeof event==='string')throw new Error('MIND_EVENT');
        const scopeKey=text('scopeKey');
        const detail=a.detail as {code?:string;tool?:string;reason?:string}|undefined;
        if(detail && Object.values(detail).some(v=>v!=null&&(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(v))))throw new Error('MIND_DETAIL');
        const item=host.perceive(scopeKey,event,detail);return {item,projection:projection(scopeKey)};
      }
      case 'mind.bind':{const scopeKey=text('scopeKey');host.bind(scopeKey,text('itemId'),text('ref'));return projection(scopeKey);}
      case 'mind.flush':host.tick();return true;
      case 'action.admitRespond':return actions.admitRespond(a.draft as ActionDraft,text('holder'),at);
      case 'action.enqueue':return actions.enqueue(a as unknown as ActionDraft,at);
      case 'action.claim':return actions.claim(text('id'),text('holder'),at);
      case 'action.renew':return actions.renew(lease(),at,a.progress as string|undefined);
      case 'action.dispatch':return actions.dispatch(lease(),at,(a.resources??[]) as string[]);
      case 'action.checkpoint':return actions.checkpoint(lease(),String(a.progress),at,a.failureCode as string|undefined);
      case 'action.finish':{
        if(!['completed','failed','cancelled','unknown'].includes(String(a.state)))throw new Error('ACTION_STATE');
        return actions.finish(lease(),a.state as 'completed'|'failed'|'cancelled'|'unknown',String(a.code),at);
      }
      case 'action.list':return actions.list(text('scopeKey'));
      case 'action.get':{const scope=text('scopeKey'),action=actions.get(text('id'));return action?.scopeKey===scope?action:null;}
      case 'action.stop':return actions.stop(text('scopeKey'),a.id===null?null:text('id'),text('requestId'),at);
      case 'action.resume':return actions.resume(text('scopeKey'),text('id'),at);
      case 'action.reconcile':{
        if(!['completed','failed','cancelled'].includes(String(a.state)))throw new Error('ACTION_STATE');
        return actions.reconcile(lease(),a.state as 'completed'|'failed'|'cancelled',String(a.code),at);
      }
      case 'action.reserve':return actions.reserve(lease(),text('reservationId'),String(a.day),Number(a.yen),Number(a.cap),Number(a.spent),at);
      case 'action.reconcileResource':return actions.reconcileResource(lease(),String(a.resource),text('acknowledgementId'));
      case 'action.settle':return actions.settle(lease(),text('reservationId'),a.actual===null?null:Number(a.actual),at);
      case 'action.acknowledge':return actions.acknowledge(a as unknown as ActionAcknowledgement,at);
      default:throw new Error('MIND_METHOD');
    }
  });
  } catch(error) { db.close();throw error; }
  try { const owned=hostFactory();host=owned.host;closeHost=owned.close; } catch(error) { await socket.close();db.close();throw error; }
  const sweep=setInterval(()=>actions.transaction(()=>actions.sweep(now())),1_000);sweep.unref();
  return {actions,close:async()=>{clearInterval(sweep);await socket.close();closeHost();db.close();}};
}
