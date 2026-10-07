import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { actionResource, leaseOf, type ActionDraft, type ActionThreads, type RunningAction, type ActionLease, type ActionAcknowledgement } from '../contracts/actionThreadContract.js';
import { inActionExecution } from '../infra/context/actionExecution.js';
export async function acquireAction(actions:ActionThreads,draft:ActionDraft,signal?:AbortSignal):Promise<RunningAction|null> {
  const view=draft.kind==='respond'?await actions.admitRespond(draft):await actions.claim((await actions.enqueue(draft)).id);
  if(!view)return null;
  const controller=new AbortController(),lease=leaseOf(view);
  const externalStop=()=>controller.abort();signal?.addEventListener('abort',externalStop,{once:true});if(signal?.aborted)controller.abort();
  let renewing=false;
  const heartbeat=setInterval(()=>{
    if(renewing)return;renewing=true;
    void actions.renew(lease).then(next=>{if(!next)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});
  },5_000);heartbeat.unref();
  const stop=()=>{clearInterval(heartbeat);signal?.removeEventListener('abort',externalStop);};
  return {view,execution:{lease,signal:controller.signal,checkpoint:code=>actions.checkpoint(lease,code),permit:async(resources=[])=>{
    if(controller.signal.aborted)return false;
    try{
      do {
        if(await actions.dispatch(lease,resources))return true;
        if(!await actions.renew(lease)){controller.abort();return false;}
        await wait(25,undefined,{signal:controller.signal});
      }while(!controller.signal.aborted);
      return false;
    }catch{controller.abort();return false;}
  }},stop,finish:async(state,code)=>{stop();await actions.finish(lease,state,code);}};
}
/** Foreground serialization is scope-wide, including text/voice/platform. A queued turn has no side effects. */
export function foregroundRunner(actions:ActionThreads){
  const turns=new Map<string,Promise<void>>();
  const run=async<T>(scopeKey:string,work:()=>Promise<T>):Promise<T>=>{
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
    if(!active)throw new Error('ACTION_FOREGROUND_BUSY');
    try{
      // The admission deadline must not expire an accepted long-running turn.
      const value=await inActionExecution(active.execution,work);
      await active.finish('completed','responded').catch(()=>{});return value;
    }catch(error){await active.finish('unknown','response_interrupted').catch(()=>{});throw error;}
  };
  return async<T>(scopeKey:string,work:()=>Promise<T>):Promise<T>=>{
    const previous=turns.get(scopeKey) ?? Promise.resolve();
    let release!:()=>void;
    const current=new Promise<void>(resolve=>{release=resolve;});
    turns.set(scopeKey,current);
    await previous;
    try{return await run(scopeKey,work);}finally{release();if(turns.get(scopeKey)===current)turns.delete(scopeKey);}
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
  close():void{this.active?.stop();this.active=null;}
}
