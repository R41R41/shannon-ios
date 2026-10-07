import { feedbackSourceProjection, type FeedbackSourceProjectionDependencies } from '../mind/memory/memoryPorts.js';

/** Root gives the canonical memory stores; loops and HTTP never receive their raw database. */
export function feedbackSourceReader(dependencies:FeedbackSourceProjectionDependencies) {
  return (scopeKey:string,threadId:string,id:string)=>feedbackSourceProjection(dependencies,scopeKey,threadId,id);
}
