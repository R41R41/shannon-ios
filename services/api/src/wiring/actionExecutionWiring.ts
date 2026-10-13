import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { actionResource, leaseOf, type ActionDraft, type ActionThreads, type RunningAction, type ActionLease, type ActionAcknowledgement } from '../contracts/actionThreadContract.js';
import { inActionExecution } from '../infra/context/actionExecution.js';
import { ACTION_LIMITS } from '@shannon/mind';
const RENEW_INTERVAL_MS=5_000;
/** Stop renewing optimistically this long before the last confirmed lease would end. */
const RENEW_SAFETY_MS=5_000;
export async function acquireAction(actions:ActionThreads,draft:ActionDraft,signal?:AbortSignal):Promise<RunningAction|null> {
  const view=draft.kind==='respond'?await actions.admitRespond(draft):await actions.claim((await actions.enqueue(draft)).id);
  if(!view)return null;
  const controller=new AbortController(),lease=leaseOf(view);
  const externalStop=()=>controller.abort();signal?.addEventListener('abort',externalStop,{once:true});if(signal?.aborted)controller.abort();
  let renewing=false,failures=0,renewedAt=Date.now();
  const heartbeat=setInterval(()=>{
    if(renewing)return;renewing=true;
    void actions.renew(lease).then(next=>{
      // A definitive "not yours any more" ends the attempt at once.
      if(!next){controller.abort();return;}
      failures=0;renewedAt=Date.now();
    }).catch(()=>{
      // A missed IPC deadline or a busy database is transient: keep working while the lease is certainly still valid.
      failures+=1;
      if(failures>ACTION_LIMITS.renewFailuresTolerated||Date.now()-renewedAt>=ACTION_LIMITS.leaseMs-RENEW_SAFETY_MS)controller.abort();
    }).finally(()=>{renewing=false;});
  },RENEW_INTERVAL_MS);heartbeat.unref();
  const stop=()=>{clearInterval(heartbeat);signal?.removeEventListener('abort',externalStop);};
  return {view,execution:{lease,signal:controller.signal,checkpoint:code=>actions.checkpoint(lease,code),permit:async(resources=[],localSignal)=>{
    const waitingSignal=localSignal?AbortSignal.any([controller.signal,localSignal]):controller.signal;
    while(!waitingSignal.aborted){
      try{
        const dispatched=await actions.dispatch(lease,resources);
        // A cancelled local waiter cannot adopt a late grant. The original action still owns any grant.
        if(waitingSignal.aborted)return false;
        if(dispatched)return true;
        if(!await actions.renew(lease)){controller.abort();return false;}
      }catch{controller.abort();return false;}
      try{await wait(25,undefined,{signal:waitingSignal});}
      catch{if(!localSignal?.aborted)controller.abort();return false;}
    }
    return false;
  }},stop,finish:async(state,code)=>{stop();await actions.finish(lease,state,code);}};
}
/**
 * How long a turn waits behind the scope's earlier turn before it gives up with `ACTION_FOREGROUND_BUSY` (logged as
 * `queue_timeout`). The durable respond slot still serializes: a turn that stops waiting here never runs beside the earlier one.
 */
// Longer than the longest foreground turn (text deadline 50 s after admission, plus its writes), so a queued turn waits for it.
export const FOREGROUND_QUEUE_WAIT_MS=75_000;
const log=(line:string)=>{
  try{console.warn(line);}catch{/* logging never fails a turn */}
};
const refused=(reason:'slot'|'queue_timeout',waitedMs:number)=>{
  log(`Shannon foreground turn refused code=ACTION_FOREGROUND_BUSY reason=${reason} waitedMs=${waitedMs}`);
  return new Error('ACTION_FOREGROUND_BUSY');
};
/** Whether the scope's earlier turn settled within the bound. */
async function settledWithin(previous:Promise<void>,milliseconds:number):Promise<boolean>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const late=new Promise<false>(resolve=>{
    timer=setTimeout(()=>resolve(false),milliseconds);
  });
  try{
    return await Promise.race([previous.then(()=>true),late]);
  }finally{
    clearTimeout(timer);
  }
}
/**
 * How a turn that threw is closed. Interrupted by its caller (the call hung up or he spoke over her) with nothing of uncertain
 * outcome (no model or step outcome unknown, no write tool that did not return acknowledged), it is closed at once as cancelled,
 * `response_interrupted_spoken` when a sentence had reached the device (what was said is in his history) or `response_interrupted`;
 * the owner's Windows call of 2026-10-14 showed such turns left `unknown` for the ten minutes of the unknown exit. Anything else
 * stays `unknown` as before: an outcome nobody knows is never closed by a guess.
 */
export function interruptedTurn(active:Pick<RunningAction,'execution'>,error:unknown):['cancelled'|'unknown',string]{
  const execution=active.execution;
  const aborted=(execution.interrupted===true||error instanceof Error&&error.name==='AbortError')&&!execution.signal.aborted;
  const known=execution.modelOutcome!=='unknown'&&execution.stepOutcome!=='unknown'&&!execution.writeInFlight;
  if(!aborted||!known)return ['unknown','response_interrupted'];
  return ['cancelled',execution.spoken?'response_interrupted_spoken':'response_interrupted'];
}
/** Foreground serialization is scope-wide, including text/voice/platform. A queued turn has no side effects. */
export function foregroundRunner(actions:ActionThreads,options:{queueWaitMs?:number}={}){
  const turns=new Map<string,Promise<void>>();
  const queueWaitMs=options.queueWaitMs??FOREGROUND_QUEUE_WAIT_MS;
  const run=async<T>(scopeKey:string,work:()=>Promise<T>):Promise<T>=>{
    const admissionStartedAt=Date.now();
    const deadline=new Date(Date.now()+4_000).toISOString();
    const draft:ActionDraft={scopeKey,kind:'respond',origin:'owner_request',sourceId:`turn-${randomUUID()}`,deadline};
    let active:RunningAction|null=null;
    while(Date.now()<Date.parse(deadline)){
      try {active=await acquireAction(actions,draft);}catch{
        // Temporary conversation recovery: reads/chat still work, new external writes wait for the mind to reconnect.
        return inActionExecution({lease:{id:'recovering',holder:'api',generation:0},signal:new AbortController().signal,permit:async keys=>!keys?.length},work);
      }
      if(active)break;
      await wait(10);
    }
    if(!active)throw refused('slot',Date.now()-admissionStartedAt);
    const admittedAt=Date.now();
    // A lost respond lease (renewals refused, or none could run: a blocked event loop) is named once, with how long it was held,
    // instead of surfacing only as a model call that was never permitted.
    const leaseLost=()=>log(`Shannon foreground lease lost code=ACTION_LEASE_LOST heldMs=${Date.now()-admittedAt}`);
    active.execution.signal.addEventListener('abort',leaseLost,{once:true});
    try{
      // The admission deadline must not expire an accepted long-running turn.
      const value=await inActionExecution(active.execution,work);
      const unknown = active.execution.modelOutcome === 'unknown' || active.execution.stepOutcome === 'unknown';
      await active.finish(unknown ? 'unknown' : 'completed', unknown ? 'tool_outcome_unknown' : 'responded').catch(()=>{});return value;
    }catch(error){await active.finish(...interruptedTurn(active,error)).catch(()=>{});throw error;}
    finally{active.execution.signal.removeEventListener('abort',leaseLost);}
  };
  return async<T>(scopeKey:string,work:()=>Promise<T>):Promise<T>=>{
    const previous=turns.get(scopeKey) ?? Promise.resolve();
    let release!:()=>void;
    const current=new Promise<void>(resolve=>{release=resolve;});
    turns.set(scopeKey,current);
    try{
      if(!await settledWithin(previous,queueWaitMs))throw refused('queue_timeout',queueWaitMs);
      return await run(scopeKey,work);
    }finally{release();if(turns.get(scopeKey)===current)turns.delete(scopeKey);}
  };
}
/** The real loop/cycle remains the progress notebook. The scheduler only owns execution rights. */
export class OwnTimeActionRunner {
  private active:RunningAction|null=null;
  constructor(private readonly actions:ActionThreads){}
  async begin(scopeKey:string,cycleId:string,ownerInformed:boolean,signal?:AbortSignal):Promise<RunningAction|null>{
    if(ownerInformed)await this.actions.enqueue({scopeKey,kind:'ownTime',origin:'own_time',sourceId:cycleId,ownerInformed:true});
    if(this.active?.view.sourceId===cycleId && !this.active.execution.signal.aborted
      && await this.actions.renew(this.active.execution.lease))return this.active;
    if(this.active){
      await this.active.finish('cancelled','stop_acknowledged').catch(()=>{});
      this.active=null;
    }
    this.active=await acquireAction(this.actions,{scopeKey,kind:'ownTime',origin:'own_time',sourceId:cycleId,ownerInformed,
      resources:[actionResource(scopeKey,'ownTime')]},signal);
    return this.active;
  }
  async reserve(lease:ActionLease,id:string,day:string,yen:number,cap:number,spent:number):Promise<boolean>{return this.actions.reserve(lease,id,day,yen,cap,spent);}
  async checkpoint(lease:ActionLease,id:string,actual:number|null,code:string,failureCode?:string):Promise<boolean>{
    if(this.active?.execution.lease.id===lease.id && (this.active.execution.modelOutcome==='unknown' || this.active.execution.stepOutcome==='unknown')){
      await this.actions.settle(lease,id,this.active.execution.modelOutcome==='unknown'?null:actual);
      await this.end('unknown',this.active.execution.modelOutcome==='unknown'?'model_result_unknown':'step_result_unknown');
      return false;
    }
    if(this.active && actual!==null && (code==='think'||this.active.execution.stepOutcome==='acknowledged')){
      const stopping=this.active.execution.signal.aborted;
      return this.actions.acknowledge({id,scopeKey:this.active.view.scopeKey,lease,reservationId:id,actual,
        state:stopping?'cancelled':'checkpoint',code:stopping?'stop_acknowledged':code,...(failureCode?{failureCode}:{})});
    }
    await this.actions.settle(lease,id,actual);
    await this.actions.checkpoint(lease,code,failureCode);
    return false;
  }
  async recover(reports:readonly ActionAcknowledgement[]):Promise<readonly string[]>{
    const delivered:string[]=[];
    for(const report of reports){if(!await this.actions.acknowledge(report))break;delivered.push(report.id);}
    return delivered;
  }
  async end(state:'completed'|'failed'|'cancelled'|'unknown',code:string):Promise<void>{
    if(this.active){
      const active=this.active;this.active=null;await active.finish(state,code);
      // end is called only after the loop's canonical report/acknowledgement. A lease expiry is not a lost result.
      if(state!=='unknown')await this.actions.reconcile(active.execution.lease,state,code);
    }
  }
  /**
   * The session's own action can never run again, so its cycle is closed unreplayed: unknown past the release deadline, or
   * cancelled by an expired lease before anything was sent (ADR-0009 §9: a claim of that cancelled action is refused forever).
   */
  async abandoned(scopeKey:string,cycleId:string):Promise<boolean>{
    const own=(await this.actions.list(scopeKey)).find(action=>action.kind==='ownTime'&&action.sourceId===cycleId);
    if(!own||own.sent)return false;
    // An older build's release says `unknown_expired`; the one unknown exit (S5) says how it left.
    const exited=['unknown_expired','unknown_retired','outcome_unknown_closed'].includes(own.result??'');
    return (own.state==='unknown'&&exited)||(own.state==='cancelled'&&own.result==='lease_expired');
  }
  close():void{this.active?.stop();this.active=null;}
}
