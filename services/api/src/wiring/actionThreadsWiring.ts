import { randomUUID } from 'node:crypto';
import type { MindCall } from '../infra/ipc/mindSocket.js';
import type { ActionThreads, ActionDraft, ActionLease, ActionView } from '../contracts/actionThreadContract.js';
export function actionThreadsClient(call:MindCall,holder=`runner-${randomUUID()}`):ActionThreads {
  return {
    admitRespond:(draft:ActionDraft)=>call('action.admitRespond',{draft,holder}),
    enqueue:(draft:ActionDraft)=>call('action.enqueue',draft),claim:(id:string)=>call('action.claim',{id,holder}),
    renew:(lease:ActionLease,progress?:string)=>call('action.renew',{lease,progress}),
    dispatch:(lease:ActionLease,resources?:readonly string[])=>call('action.dispatch',{lease,resources}),
    finish:(lease:ActionLease,state:string,code:string)=>call('action.finish',{lease,state,code}),
    list:(scopeKey:string)=>call<ActionView[]>('action.list',{scopeKey}),
    stop:(scopeKey:string,id:string|null,requestId:string)=>call('action.stop',{scopeKey,id,requestId}),
    resume:(scopeKey,id)=>call('action.resume',{scopeKey,id}),
    reconcile:(lease,state,code)=>call('action.reconcile',{lease,state,code}),
    checkpoint:(lease,progress,failureCode)=>call('action.checkpoint',{lease,progress,failureCode}),
    reserve:(lease,reservationId,day,yen,cap,spent)=>call('action.reserve',{lease,reservationId,day,yen,cap,spent}),
    settle:(lease,reservationId,actual)=>call('action.settle',{lease,reservationId,actual}),
    acknowledge:report=>call('action.acknowledge',report),
  };
}
