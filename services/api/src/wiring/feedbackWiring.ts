import { createFeedbackRoute } from '../infra/http/feedbackRoutes.js';
import { FeedbackService, type FeedbackDependencies } from '../mind/learning/feedbackService.js';
import type { FeedbackPorts } from '../contracts/feedbackContract.js';

/** Root composition decides Stage5's switch. OFF opens/creates nothing and returns no optional metadata. */
export function createFeedbackWiring(options:FeedbackDependencies&{enabled:boolean;defer?:(task:()=>void)=>void}) {
  if (!options.enabled) return null;
  const feedback=new FeedbackService({...options,createSchema:options.createSchema??true});
  const defer=options.defer??((task:()=>void)=>setImmediate(task));
  const later=(task:()=>void)=>defer(()=>{try{task();}catch{/* Metadata never fails a turn; there is no guessed eligibility. */}});
  const ports:FeedbackPorts={
    captureTurn:(scope,draft)=>later(()=>feedback.captureTurn(scope,draft)),
    bindTurn:(scope,binding)=>{later(()=>feedback.bindTurn(scope,binding));return null;},
    bindTaskReply:(scope,binding)=>{later(()=>feedback.bindTaskReply(scope,binding));return null;},
    taskDispatched:(scope,dispatch)=>later(()=>feedback.taskDispatched(scope,dispatch)),
    taskVerified:(scope,task,attempt,at,cost)=>later(()=>feedback.taskVerified(scope,task,attempt,at,cost)),
    taskUnusable:(scope,task,attempt,at)=>later(()=>feedback.taskUnusable(scope,task,attempt,at)),
    project:(scope,thread,turn)=>{try{return feedback.project(scope,thread,turn);}catch{return null;}},
  };
  return {feedback,ports,evidence:feedback,route:createFeedbackRoute({feedback,ownerScopeKey:options.ownerScopeKey,ownerAlone:options.ownerAlone})};
}
