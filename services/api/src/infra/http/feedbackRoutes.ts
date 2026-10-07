import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedbackReaction } from '../../contracts/feedbackContract.js';
import type { FeedbackService } from '../../mind/learning/feedbackService.js';
import { PREDICTION_SOURCE_ID } from '../../contracts/cognitionLedgerContract.js';
import { readJson, sendJson } from './serverHttp.js';

export const FEEDBACK_PATH='/v1/feedback';
export interface FeedbackRouteDependencies {
  feedback:Pick<FeedbackService,'get'|'getOperation'|'change'>|null;
  ownerScopeKey:string;
  /** Current authoritative audience; unknown/errors deny. Never inferred from the body. */
  ownerAlone(scopeKey:string):boolean;
}
const id=(value:unknown):value is string=>typeof value==='string'&&PREDICTION_SOURCE_ID.test(value);
export function createFeedbackRoute(dependencies:FeedbackRouteDependencies) {
  return async(request:IncomingMessage,response:ServerResponse,principal:{scopeKey:string}|null):Promise<void>=>{
    if (!principal || principal.scopeKey!==dependencies.ownerScopeKey) return sendJson(response,403,{error:'FEEDBACK_OWNER_ONLY'});
    if (!dependencies.feedback) return sendJson(response,404,{error:'FEEDBACK_DISABLED'});
    const allowed=()=>{try{return dependencies.ownerAlone(principal.scopeKey)===true;}catch{return false;}};
    if (!allowed()) return sendJson(response,403,{error:'FEEDBACK_OWNER_ALONE_REQUIRED'});
    try {
      const url=new URL(request.url??'/', 'http://localhost');
      if (url.pathname!==FEEDBACK_PATH) return sendJson(response,404,{error:'NOT_FOUND'});
      if (request.method==='GET') {
        const targetId=url.searchParams.get('targetId'),threadId=url.searchParams.get('threadId'),operationId=url.searchParams.get('operationId');
        if (!id(targetId)||!id(threadId)||(operationId!==null&&!id(operationId))) return sendJson(response,400,{error:'FEEDBACK_INPUT_INVALID'});
        const feedback=dependencies.feedback.get(principal.scopeKey,targetId,threadId);
        const operation=feedback&&operationId?dependencies.feedback.getOperation(principal.scopeKey,targetId,threadId,operationId):null;
        if (!allowed()) return sendJson(response,403,{error:'FEEDBACK_OWNER_ALONE_REQUIRED'});
        return feedback?sendJson(response,200,{feedback,...(operationId?{operation}: {})}):sendJson(response,404,{error:'FEEDBACK_NOT_FOUND'});
      }
      if (request.method!=='POST') return sendJson(response,405,{error:'METHOD_NOT_ALLOWED'});
      const raw=await readJson(request,4096);
      if (!raw||typeof raw!=='object'||Array.isArray(raw)) return sendJson(response,400,{error:'FEEDBACK_INPUT_INVALID'});
      const body=raw as Record<string,unknown>;
      if (Object.keys(body).some(key=>!['targetId','threadId','expectedRevision','operationId','reaction'].includes(key))
        ||!id(body.targetId)||!id(body.threadId)||!id(body.operationId)||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0
        ||![null,'good','bad'].includes(body.reaction as null|string)) return sendJson(response,400,{error:'FEEDBACK_INPUT_INVALID'});
      if (!allowed()) return sendJson(response,403,{error:'FEEDBACK_OWNER_ALONE_REQUIRED'});
      const changed=dependencies.feedback.change(principal.scopeKey,{targetId:body.targetId,threadId:body.threadId,operationId:body.operationId,
        expectedRevision:Number(body.expectedRevision),reaction:body.reaction as FeedbackReaction});
      if (!allowed()) return sendJson(response,403,{error:'FEEDBACK_OWNER_ALONE_REQUIRED'});
      if (typeof changed==='string') return sendJson(response,changed==='FEEDBACK_NOT_FOUND'?404:409,{error:changed});
      return sendJson(response,200,{feedback:changed});
    } catch { return sendJson(response,503,{error:'FEEDBACK_UNAVAILABLE'}); }
  };
}
