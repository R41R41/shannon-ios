import { createHash } from 'node:crypto';
import { isOwnerOnly, ownerSpoke, visibleMemoryText, type CompanionStateStore, type MemoryControl } from '@shannon/cognition';
import type { FeedbackSource, FeedbackPorts } from '../../contracts/feedbackContract.js';
import type { ConversationStore, StoredConversationMessage } from './conversationContract.js';
import { MemoryWithholding } from './memoryVisibility.js';

export interface FeedbackSourceProjectionDependencies {
  conversationStore:ConversationStore;
  stateStore:Pick<CompanionStateStore,'snapshot'>;
  currentMemoryControls?(scopeKey:string):readonly MemoryControl[];
}
/** Exact full-history lookup, never the bounded display window. No private text or trace leaves this projection. */
export function feedbackSourceProjection(dependencies:FeedbackSourceProjectionDependencies,scopeKey:string,threadId:string,id:string):FeedbackSource|null {
  if (!dependencies.conversationStore.assistantMessage) return null;
  const message=dependencies.conversationStore.assistantMessage(scopeKey,threadId,id);
  if (!message) return {kind:'turn',status:'deleted',replyDigest:'',ownerAlone:false};
  const state=dependencies.stateStore.snapshot(scopeKey),controls=dependencies.currentMemoryControls?.(scopeKey);
  const current=controls?{...state,memoryControls:controls}:state;
  const withheld=new MemoryWithholding(current,dependencies.conversationStore,scopeKey);
  const digest=createHash('sha256').update(`shannon-feedback-reply\n${message.content.trim()}`).digest('hex');
  const sourceId=message.sourceExperienceId;
  const taskNote=sourceId===`agent-task-result:${message.id}`;
  if(taskNote) {
    const forgotten=visibleMemoryText(current,message.id,message.content)===null||visibleMemoryText(current,sourceId,message.content)===null||withheld.withholdsMessage(message);
    return {kind:'task-note',status:forgotten?'forgotten':message.noteOwnerAlone===true?'visible':'hidden',replyDigest:digest,ownerAlone:message.noteOwnerAlone===true};
  }
  if(!sourceId||!dependencies.conversationStore.experiencesById)return null;
  const experience=dependencies.conversationStore.experiencesById(scopeKey,[sourceId]).find(item=>item.id===sourceId);
  if(!experience)return {kind:'turn',status:'deleted',replyDigest:'',ownerAlone:false};
  const ownerAlone=isOwnerOnly(experience.disclosure?.audience)&&ownerSpoke(experience.disclosure);
  const forgotten=visibleMemoryText(current,experience.id,experience.summary)===null||withheld.withholdsExperience(experience)||withheld.withholdsMessage(message);
  const exact=experience.shannonReply.trim()===message.content.trim();
  return {kind:'turn',status:forgotten?'forgotten':ownerAlone&&exact?'visible':'hidden',replyDigest:digest,ownerAlone};
}

/** Optional reply metadata only; stale stored fields and user messages never become feedback buttons. */
export function attachConversationFeedback(messages:readonly StoredConversationMessage[],feedback:Pick<FeedbackPorts,'project'>|undefined,scopeKey:string,threadId:string,ownerAlone?:(scopeKey:string)=>boolean):readonly StoredConversationMessage[] {
  let alone=false;try {alone=ownerAlone?.(scopeKey)===true;}catch{/* Unknown denies private task-note display. */}
  return Object.freeze(messages.flatMap(message=>{
    const {feedback:_stale,noteOwnerAlone:_privateAudience,...plain}=message;
    if(message.sourceExperienceId?.startsWith('agent-task-result:')&&!alone)return [];
    if(message.role!=='assistant'||!feedback)return [Object.freeze(plain)];
    const id=message.sourceExperienceId?.startsWith('agent-task-result:')?message.id:message.sourceExperienceId;
    let state=null;try {state=id?feedback.project(scopeKey,threadId,id):null;}catch{/* Unknown projection never guesses eligibility. */}
    return [Object.freeze({...plain,...(state?{feedback:state}:{})})];
  }));
}
