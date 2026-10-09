import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
export interface ActionExecution {
  lease:ActionLease; signal:AbortSignal;
  /** Transient acknowledgement of this step's model request; never persisted or exposed. */
  modelOutcome?:'unknown'|'acknowledged';
  modelUsage?:{inputTokens:number;outputTokens:number};
  /** A bounded executor's acknowledgement, separate from a model call nested inside that step. */
  stepOutcome?:'unknown'|'acknowledged';
  /** Rechecked immediately before an outside call. Never grants a tool permission. */
  permit(resources?:readonly string[], signal?:AbortSignal):Promise<boolean>;
  checkpoint?(code:string):Promise<boolean>;
}
const executions=new AsyncLocalStorage<ActionExecution>();
export function inActionExecution<T>(execution:ActionExecution,work:()=>Promise<T>):Promise<T>{return executions.run(execution,work);}
export function currentActionExecution():ActionExecution|undefined{return executions.getStore();}
export async function actionPermit(resources:readonly string[]=[]):Promise<void>{
  const execution=currentActionExecution();
  if(execution && (execution.signal.aborted || !await execution.permit(resources)))throw new Error('ACTION_STOPPED');
}
