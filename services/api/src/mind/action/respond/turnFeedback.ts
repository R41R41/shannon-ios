import type { FeedbackPorts, FeedbackState } from '../../../contracts/feedbackContract.js';

/** Metadata failures never fail or delay a reply; the history projection retries the read after deferred choices are stored. */
export function bindCompletedFeedback(feedback:FeedbackPorts|null|undefined,scopeKey:string,recordId:string|undefined,threadId:string,turnId:string,reply:string):FeedbackState|null {
  if (!feedback||!recordId) return null;
  try { return feedback.bindTurn(scopeKey,{recordId,threadId,turnId,reply}); } catch { return null; }
}
