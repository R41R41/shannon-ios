import { randomUUID } from 'node:crypto';
import type { MindCall } from '../infra/ipc/mindSocket.js';
import type { ActionThreads, ActionDraft, ActionLease, ActionSchedulerMetrics, ActionView } from '../contracts/actionThreadContract.js';
export function actionThreadsClient(call:MindCall,holder=`runner-${randomUUID()}`):ActionThreads {
  return {
    admitRespond:(draft:ActionDraft)=>call('action.admitRespond',{draft,holder}),
    enqueue:(draft:ActionDraft)=>call('action.enqueue',draft),claim:(id:string)=>call('action.claim',{id,holder}),
    renew:(lease:ActionLease,progress?:string)=>call('action.renew',{lease,progress}),
    dispatch:(lease:ActionLease,resources?:readonly string[])=>call('action.dispatch',{lease,resources}),
    finish:(lease:ActionLease,state:string,code:string)=>call('action.finish',{lease,state,code}),
    get:(scopeKey:string,id:string)=>call<ActionView|null>('action.get',{scopeKey,id}),
    list:(scopeKey:string)=>call<ActionView[]>('action.list',{scopeKey}),
    acknowledgeNotice:(scopeKey,id,notificationId,requestId)=>call('action.acknowledgeNotice',{scopeKey,id,notificationId,requestId}),
    stop:(scopeKey:string,id:string|null,requestId:string)=>call('action.stop',{scopeKey,id,requestId}),
    resume:(scopeKey,id)=>call('action.resume',{scopeKey,id}),
    reconcile:(lease,state,code)=>call('action.reconcile',{lease,state,code}),
    reconcileResource:(lease,resource,acknowledgementId)=>call('action.reconcileResource',{lease,resource,acknowledgementId}),
    checkpoint:(lease,progress,failureCode)=>call('action.checkpoint',{lease,progress,failureCode}),
    reserve:(lease,reservationId,day,yen,cap,spent)=>call('action.reserve',{lease,reservationId,day,yen,cap,spent}),
    settle:(lease,reservationId,actual)=>call('action.settle',{lease,reservationId,actual}),
    acknowledge:report=>call('action.acknowledge',report),
    metrics:()=>call<ActionSchedulerMetrics>('action.metrics',{}),
  };
}
