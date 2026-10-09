import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { ActionDraft, ActionLease, ActionView } from '@shannon/mind';
import type { ActionExecution } from '../infra/context/actionExecution.js';
export type { ActionDraft, ActionLease, ActionView } from '@shannon/mind';
/** A canonical own-time report, containing closed IDs/codes and known usage only. It cannot start or resume work. */
export interface ActionAcknowledgement {
  id:string;scopeKey:string;lease:ActionLease;reservationId:string|null;actual:number;
  state:'budget'|'checkpoint'|'completed'|'failed'|'cancelled';code:string;failureCode?:string;
}
export interface ActionThreads {
  /** Respond only: enqueue and claim atomically, returning rights only after the durable commit. */
  admitRespond(draft:ActionDraft):Promise<ActionView|null>;
  enqueue(draft: ActionDraft): Promise<ActionView>;
  claim(id: string): Promise<ActionView|null>;
  renew(lease: ActionLease,progress?: string): Promise<ActionView|null>;
  dispatch(lease: ActionLease,resources?: readonly string[]): Promise<boolean>;
  finish(lease: ActionLease,state: 'completed'|'failed'|'cancelled'|'unknown',code: string): Promise<ActionView|null>;
  /** Exact canonical receipt read. Unlike the bounded presentation list, it retains original IDs through recovery. */
  get(scopeKey: string,id: string): Promise<ActionView|null>;
  list(scopeKey: string): Promise<ActionView[]>;
  acknowledgeNotice(scopeKey: string,id: string,notificationId: string,requestId: string): Promise<boolean>;
  stop(scopeKey: string,id: string|null,requestId: string): Promise<ActionView[]>;
  resume(scopeKey: string,id: string): Promise<boolean>;
  reconcile(lease:ActionLease,state:'completed'|'failed'|'cancelled',code:string):Promise<boolean>;
  /** A canonical release proof for one dynamic resource of the immediately previous unknown attempt. */
  reconcileResource(lease:ActionLease,resource:string,acknowledgementId:string):Promise<boolean>;
  checkpoint(lease:ActionLease,progress:string,failureCode?:string):Promise<boolean>;
  reserve(lease:ActionLease,reservationId:string,day:string,yen:number,cap:number,spent:number):Promise<boolean>;
  settle(lease:ActionLease,reservationId:string,actual:number|null):Promise<boolean>;
  acknowledge(report:ActionAcknowledgement):Promise<boolean>;
}
/** Keys identify an authority plus a normalized target; paths and names never enter the scheduler journal. */
export function actionResource(host: string,target: string): string {
  if(!host || !target || /[\u0000-\u001f]/u.test(host+target))throw new Error('ACTION_RESOURCE');
  const windows=/^[A-Za-z]:[\\/]/u.test(target)||target.startsWith('\\\\');
  const normalized=windows?win32.normalize(target).toLowerCase():posix.normalize(target);
  return `res:${createHash('sha256').update(host).update('\0').update(normalized).digest('hex')}`;
}
export function leaseOf(view: ActionView):ActionLease {
  if(!view.holder)throw new Error('ACTION_NOT_CLAIMED');
  return {id:view.id,generation:view.generation,holder:view.holder};
}
export interface RunningAction {
  view:ActionView;execution:ActionExecution;stop():void;
  finish(state:'completed'|'failed'|'cancelled'|'unknown',code:string):Promise<void>;
}
export interface ActionStepPort {
  begin(scopeKey:string,cycleId:string,ownerInformed:boolean,signal?:AbortSignal):Promise<RunningAction|null>;
  reserve(lease:ActionLease,id:string,day:string,yen:number,cap:number,spent:number):Promise<boolean>;
  checkpoint(lease:ActionLease,id:string,actual:number|null,code:string,failureCode?:string):Promise<boolean>;
  recover(reports:readonly ActionAcknowledgement[]):Promise<readonly string[]>;
  end(state:'completed'|'failed'|'cancelled'|'unknown',code:string):Promise<void>;
}

/** Existing Minecraft claim/progress/report handshake supplies the body acknowledgement. */
export interface MinecraftExecutionPort {
  admit(scopeKey:string,id:string,deviceId:string):Promise<boolean>;
  heartbeat(scopeKey:string,id:string):Promise<boolean>;
  acknowledge(scopeKey:string,id:string,state:'completed'|'failed'|'cancelled'):Promise<void>;
}
