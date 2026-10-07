import type { ActionStepPort } from '../../../contracts/actionThreadContract.js';
import type { ActionExecution } from '../../../infra/context/actionExecution.js';
import type { SQLiteAutonomyStore } from './store/autonomyStore.js';
import type { AutonomyLoopCycle, AutonomyLoopStep } from './store/autonomyLoopState.js';
import type { StepResult } from './autonomyLoopSteps.js';

/** Persisted beside canonical usage, never a model/tool request to replay. */
export function saveStepAcknowledgement(store:SQLiteAutonomyStore,scopeKey:string,row:AutonomyLoopStep,reservationId:string,
  result:StepResult,actual:number,execution:ActionExecution|undefined):void {
  if(!execution||execution.modelOutcome==='unknown')return;
  if(execution.stepOutcome==='unknown'){
    if(execution.modelOutcome==='acknowledged')store.recordActionAcknowledgement({id:reservationId,scopeKey,lease:execution.lease,
      reservationId,actual,state:'budget',code:'model_usage_known'});
    return;
  }
  if(row.step.kind!=='think'&&execution.stepOutcome!=='acknowledged')return;
  const failureCode=actionFailureCode(result,execution);
  store.recordActionAcknowledgement({id:reservationId,scopeKey,lease:execution.lease,reservationId,actual,
    state:execution.signal.aborted?'cancelled':'checkpoint',code:execution.signal.aborted?'stop_acknowledged':row.step.kind,
    ...(failureCode?{failureCode}:{}),});
}
export function saveCycleAcknowledgement(store:SQLiteAutonomyStore,cycle:AutonomyLoopCycle,execution:ActionExecution|undefined):void {
  if(!execution||execution.modelOutcome==='unknown'||execution.stepOutcome==='unknown')return;
  store.recordActionAcknowledgement({id:`end-${cycle.id}`,scopeKey:cycle.scopeKey,lease:execution.lease,
    reservationId:null,actual:0,state:'completed',code:'cycle_ended'});
}
export function actionFailureCode(result:StepResult,execution:ActionExecution):string|undefined {
  return result.outcome==='failed'&&!execution.signal.aborted
    ? /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(result.reasonCode??'')?result.reasonCode:'step_failed':undefined;
}
/** Success means every bounded operation returned; uncertain failures and an unwatched call remain fenced. */
export function stepAcknowledged(kind:string,result:StepResult,execution:ActionExecution):boolean {
  if(execution.modelOutcome==='unknown')return false;
  if(result.acknowledged!==undefined)return result.acknowledged;
  if(result.reasonCode==='unwatched')return false;
  if(result.outcome==='done')return true;
  const code=result.reasonCode??'';
  if(code.startsWith('aether_'))return ['aether_stale_version','aether_outside_shannon_folder','aether_not_found','aether_invalid_request',
    'aether_idempotency_key_reused','aether_unauthorized','aether_outside_audience','aether_owner_informed','aether_too_long'].includes(code);
  if(kind==='tool')return ['not_offered','invalid_input','refused','not_found','conflict','limit'].includes(code);
  if(kind==='look')return result.usage===undefined;
  return ['think','note','draft','revise','jot','reach_out','show','copy','put_away','rest'].includes(kind);
}
export async function recoverActionAcknowledgements(store:SQLiteAutonomyStore,runner:ActionStepPort,scopeKey:string):Promise<boolean> {
  const pending=store.pendingActionAcknowledgements(scopeKey);
  if(!pending.length)return true;
  try {
    const delivered=await runner.recover(pending);
    for(const id of delivered)store.deliveredActionAcknowledgement(id);
    return delivered.length===pending.length;
  }catch{return false;}
}
