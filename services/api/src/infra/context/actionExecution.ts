import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
export interface ActionExecution {
  lease:ActionLease; signal:AbortSignal;
  /** Transient acknowledgement of this step's model request; never persisted or exposed. */
  modelOutcome?:'unknown'|'acknowledged';
  modelUsage?:{inputTokens:number;outputTokens:number};
  /** Content-free measurement of the decision's request (`fca_decision_metrics`): estimates and the provider's usage counts. Never persisted. */
  modelMetrics?:{storedTokens:number;tailTokens:number;inputNew:number;inputRead:number;inputWrite:number;outputTokens:number;
    inputTransformations:number;obsMode?:'transient';
    /** A transient request: the estimate of its live state's tokens (the part after the last cache breakpoint). */
    liveTokens?:number;
    /** Syzygy ADR-0014 D8: the model id that answered, the time to its first token (null: the transport does not stream), and the estimate
     * of the input by layer (`llmcTokens`; counts only). */
    model?:string;ttftMs?:number|null;
    layers?:{policy:number;tools:number;history:number;task:number;live:number;retrieved:number};
    /** A transient request: how it was shortened to fit (levels in characters, null: not cut), content-free. */
    cuts?:{catalog:number|null;state:number|null;live:number|null;trim:number|null;over:boolean;replayRelaxed:boolean;deferred:boolean;
      parts:number;items:number}};
  /** Syzygy ADR-0014 D8 (measurement only): whose model call this is and of which kind (`fcaTaskTelemetry.ts`). Never persisted. */
  telemetry?:{taskId:string;kind:'main'|'urgent'|'lookahead'|'first_plan'|'summary'};
  /**
   * An FCA step asked its model for its decision (`fcaRunner.ts`). Before that, a step has run only internal work and model calls
   * whose results it keeps (recall, tool selection, history summaries): a hold there may be retried (`heldBeforeAnyEffect`).
   */
  decisionRequested?:boolean;
  /**
   * When the FCA scheduler took this step up and what its admission spent before the step ran (`taskRuntimeWiring.ts`, measurement only,
   * read by `fca_decision_metrics`): `previousEndAt` is when the task's previous step finished (epoch ms; null for its first step here).
   */
  admission?:{previousEndAt:number|null;startedAt:number;acquireMs:number;beginMs:number;budgetMs:number;portsMs:number};
  /** A bounded executor's acknowledgement, separate from a model call nested inside that step. */
  stepOutcome?:'unknown'|'acknowledged';
  /** A write tool of a conversation turn ran and has not returned an acknowledged result: an interruption leaves its outcome unknown. */
  writeInFlight?:boolean;
  /** A sentence of the reply was handed to the device (a voice stream): an interruption closes the turn as interrupted after speech. */
  spoken?:boolean;
  /** The caller of a conversation turn went away (hung up, or spoke over her) while the turn ran. */
  interrupted?:boolean;
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
