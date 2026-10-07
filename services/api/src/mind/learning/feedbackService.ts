import { createHash } from 'node:crypto';
import { FEEDBACK_POLICY } from '@shannon/learning';
import type { ValueReader } from './choiceLedger.js';
import type { FeedbackEvidenceReader, FeedbackEvidenceSnapshot, FeedbackPorts, FeedbackReaction, FeedbackSource, FeedbackState, FeedbackTaskProof, FeedbackTurnDraft } from '../../contracts/feedbackContract.js';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL } from '../../contracts/cognitionLedgerContract.js';
import { ownerDayKey, underWriteLock, type SqliteConnection } from '../../infra/sqlite/lockWaits.js';
import { SQLiteChoiceLedger, type StoredChoice } from './store/sqliteChoiceLedger.js';
import { SQLiteFeedback, type FeedbackTarget } from './store/sqliteFeedback.js';
import { TaskFeedbackChoices } from './taskFeedbackChoices.js';
import type { FeedbackTaskDispatch, FeedbackTaskProofStatus } from '../../contracts/feedbackContract.js';

export const feedbackDigest = (reply: string) => createHash('sha256').update(`shannon-feedback-reply\n${reply.trim()}`).digest('hex');
export type FeedbackError = 'FEEDBACK_NOT_FOUND' | 'FEEDBACK_CONFLICT' | 'FEEDBACK_OPERATION_REUSED';
export interface FeedbackDependencies {
  database: SqliteConnection; createSchema?: boolean; ownerScopeKey: string; now: () => string;
  ownerAlone(scopeKey:string):boolean;
  /** The canonical memory projection: existence, current forgetting/disclosure and exact assistant reply. Exceptions fail closed. */
  source(scopeKey: string, threadId: string, turnId: string): FeedbackSource | null;
  /** Executed calls from the stored turn's authoritative trace. No target, paths, arguments, names, or raw results. */
  toolEvidence(scopeKey: string, threadId: string, turnId: string): readonly { tool: string; ok: boolean; withheld?: boolean }[];
  /** Legacy null is ambiguous and never permanently invalidates an existing target. */
  taskProof?(scopeKey: string, taskId: string): FeedbackTaskProof | null;
  taskProofStatus?(scopeKey:string,taskId:string):FeedbackTaskProofStatus;
  values?:ValueReader;
}

/** Optional reactions are evidence for the next value version, never an instruction to finish a task or replay a mood. */
export class FeedbackService implements FeedbackPorts, FeedbackEvidenceReader {
  readonly store: SQLiteFeedback;
  private readonly choices: SQLiteChoiceLedger;
  private readonly taskChoices:TaskFeedbackChoices;
  constructor(private readonly dependencies: FeedbackDependencies) {
    this.store=new SQLiteFeedback(dependencies.database,dependencies.createSchema);
    this.choices=new SQLiteChoiceLedger(dependencies.database,{createSchema:false});
    this.taskChoices=new TaskFeedbackChoices(this.choices,dependencies.values);
  }
  captureTurn(scopeKey: string,draft: FeedbackTurnDraft): void {
    if (scopeKey!==this.dependencies.ownerScopeKey || !draft.ownerAlone || !draft.usable) return;
    if (![draft.recordId,draft.threadId].every(id=>PREDICTION_SOURCE_ID.test(id)) || !/^[a-f0-9]{64}$/u.test(draft.replyDigest)) return;
    const choices=draft.choices.filter(link=>PREDICTION_SOURCE_ID.test(link.choiceId)&&PREDICTION_SYMBOL.test(link.tool)&&typeof link.ok==='boolean').slice(0,64);
    if (!choices.length || !Number.isFinite(Date.parse(draft.at))) return;
    this.write(()=>this.store.capture(scopeKey,{...draft,choices}));
  }
  bindTurn(scopeKey: string,binding: {recordId:string;threadId:string;turnId:string;reply:string}): FeedbackState|null {
    if (scopeKey!==this.dependencies.ownerScopeKey) return null;
    const draft=this.store.draft(scopeKey,binding.recordId);
    if (!draft?.ownerAlone || !draft.usable || draft.threadId!==binding.threadId || draft.replyDigest!==feedbackDigest(binding.reply)) return null;
    const source=this.dependencies.source(scopeKey,binding.threadId,binding.turnId);
    if (source?.kind!=='turn'||!this.sourceMatches(source,draft.replyDigest)) return null;
    if (!this.toolChoices(scopeKey,draft,binding.turnId).length) return null;
    return this.write(()=>{
      const item=this.store.insertTarget({scopeKey,threadId:binding.threadId,turnId:binding.turnId,sourceDigest:draft.replyDigest,kind:'tool',recordId:draft.recordId,taskId:null,attemptId:null});
      if (!item || item.recordId!==draft.recordId || item.sourceDigest!==draft.replyDigest) return null;
      return this.project(scopeKey,binding.threadId,binding.turnId);
    });
  }
  bindTaskReply(scopeKey: string,binding: {taskId:string;threadId:string;messageId:string;reply:string}): FeedbackState|null {
    if (scopeKey!==this.dependencies.ownerScopeKey) return null;
    const proof=this.proofStatus(scopeKey,binding.taskId);const verified=proof.status==='verified'?proof.proof:null;
    const digest=feedbackDigest(binding.reply);
    const source=this.dependencies.source(scopeKey,binding.threadId,binding.messageId);
    if (!verified || verified.taskId!==binding.taskId || verified.status!=='verified' || !verified.evidenceIds.length || verified.threadId!==binding.threadId || source?.kind!=='task-note' || !this.sourceMatches(source,digest)) return null;
    if (!this.choices.forSubject(scopeKey,'task',binding.taskId).some(choice=>choice.sourceId===verified.attemptId&&choice.choice==='task.execute'&&choice.settleCode==='task_verified'&&usableChoice(choice))) return null;
    return this.write(()=>{
      const item=this.store.insertTarget({scopeKey,threadId:binding.threadId,turnId:binding.messageId,sourceDigest:digest,kind:'task',recordId:null,taskId:binding.taskId,attemptId:verified.attemptId});
      if (!item || item.taskId!==binding.taskId || item.attemptId!==verified.attemptId || item.sourceDigest!==digest) return null;
      return this.project(scopeKey,binding.threadId,binding.messageId);
    });
  }
  taskDispatched(scopeKey:string,dispatch:FeedbackTaskDispatch):void {
    if (scopeKey===this.dependencies.ownerScopeKey) this.write(()=>this.taskChoices.dispatch(scopeKey,dispatch));
  }
  taskVerified(scopeKey:string,taskId:string,attemptId:string,at:string,costYen:number):void {
    if (scopeKey===this.dependencies.ownerScopeKey) this.write(()=>{const proof=this.proofStatus(scopeKey,taskId);this.taskChoices.verified(scopeKey,taskId,attemptId,at,costYen,proof.status==='verified'?proof.proof:null);});
  }
  taskUnusable(scopeKey:string,taskId:string,attemptId:string,at:string):void {
    if (scopeKey===this.dependencies.ownerScopeKey) this.write(()=>this.taskChoices.unusable(scopeKey,taskId,attemptId,at));
  }
  project(scopeKey: string,threadId: string,turnId: string): FeedbackState|null {
    if (scopeKey!==this.dependencies.ownerScopeKey) return null;
    try { if (this.dependencies.ownerAlone(scopeKey)!==true) return null; } catch { return null; }
    const item=this.store.forTurn(scopeKey,threadId,turnId);
    return item && this.eligible(item) ? this.store.state(item) : null;
  }
  get(scopeKey: string,targetId: string,threadId: string): FeedbackState|null {
    if (!this.ownerAllowed(scopeKey)) return null;
    const item=this.store.get(scopeKey,targetId);
    return scopeKey===this.dependencies.ownerScopeKey && item?.threadId===threadId && this.eligible(item,true) ? this.store.state(item) : null;
  }
  /** Read-back of an uncertain request remains distinct from the current revision on another device. */
  getOperation(scopeKey:string,targetId:string,threadId:string,operationId:string):FeedbackState|null {
    const current=this.get(scopeKey,targetId,threadId);
    if (!current) return null;
    const operation=this.store.operation(scopeKey,operationId);
    return operation?.targetId===targetId?{...current,revision:operation.revision,reaction:operation.reaction,operationId:operation.operationId}:null;
  }
  change(scopeKey:string,input:{targetId:string;threadId:string;expectedRevision:number;operationId:string;reaction:FeedbackReaction}): FeedbackState|FeedbackError {
    if (!this.ownerAllowed(scopeKey)) return 'FEEDBACK_NOT_FOUND';
    if (![input.targetId,input.threadId,input.operationId].every(id=>PREDICTION_SOURCE_ID.test(id))||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||![null,'good','bad'].includes(input.reaction)) return 'FEEDBACK_NOT_FOUND';
    return this.write(()=>{
      const item=this.store.get(scopeKey,input.targetId);
      if (!item || item.threadId!==input.threadId || !this.eligible(item,true)) return 'FEEDBACK_NOT_FOUND';
      const requestDigest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const operation=this.store.operation(scopeKey,input.operationId);
      if (operation) return operation.targetId===item.targetId&&operation.requestDigest===requestDigest
        ? {...this.store.state(item),revision:operation.revision,reaction:operation.reaction,operationId:operation.operationId} : 'FEEDBACK_OPERATION_REUSED';
      const previous=this.store.state(item);
      if (previous.revision!==input.expectedRevision) return 'FEEDBACK_CONFLICT';
      this.store.append(scopeKey,item.targetId,previous.revision+1,input.reaction,input.operationId,requestDigest,this.dependencies.now());
      return this.store.state(item);
    });
  }
  snapshot(scopeKey:string):FeedbackEvidenceSnapshot {
    if (scopeKey!==this.dependencies.ownerScopeKey) return {seq:0,policy:FEEDBACK_POLICY.id,reactions:new Map()};
    return this.write(()=>{
      const reactions=new Map<string,'good'|'bad'>();
      for (const item of this.store.targets(scopeKey)) {
        if (!this.eligible(item,true)) continue;
        const current=this.store.current(scopeKey,item.targetId);
        if (current?.reaction) for (const choice of this.linkedChoices(item)) if (usableChoice(choice)) reactions.set(choice.choiceId,current.reaction);
      }
      return {seq:this.store.lastSeq(scopeKey),policy:FEEDBACK_POLICY.id,reactions};
    });
  }
  private eligible(item:FeedbackTarget,strict=false):boolean {
    if (item.revoked) return false;
    const source=this.dependencies.source(item.scopeKey,item.threadId,item.turnId);
    if (!source&&strict) throw new Error('FEEDBACK_SOURCE_UNAVAILABLE');
    if (source?.status==='forgotten'||source?.status==='deleted') { this.write(()=>this.store.revoke(item,this.dependencies.now())); return false; }
    if (!this.sourceMatches(source,item.sourceDigest)) return false;
    if(source?.kind!==(item.kind==='task'?'task-note':'turn')){if(strict)throw new Error('FEEDBACK_SOURCE_KIND_UNAVAILABLE');return false;}
    if (item.kind==='task') {
      const status=this.proofStatus(item.scopeKey,item.taskId!);
      if (status.status==='unknown') {if(strict)throw new Error('FEEDBACK_TASK_PROOF_UNAVAILABLE');return false;}
      const proof=status.status==='verified'?status.proof:null;
      const valid=proof?.status==='verified' && proof.taskId===item.taskId && proof.threadId===item.threadId && proof.attemptId===item.attemptId && proof.evidenceIds.length;
      if (!valid) {this.write(()=>this.store.revoke(item,this.dependencies.now()));return false;}
      return this.linkedChoices(item).some(usableChoice);
    }
    return this.linkedChoices(item).length>0;
  }
  private linkedChoices(item:FeedbackTarget):StoredChoice[] {
    if (item.kind==='task') return this.choices.forSubject(item.scopeKey,'task',item.taskId!).filter(choice=>choice.sourceId===item.attemptId&&choice.choice==='task.execute'&&choice.settleCode==='task_verified');
    const draft=this.store.draft(item.scopeKey,item.recordId!);
    if (!draft?.ownerAlone || !draft.usable || draft.threadId!==item.threadId || draft.replyDigest!==item.sourceDigest) return [];
    // Creating a target validated this exact saved turn against its real execution trace. The immutable closed choice
    // links survive the existing 30-day raw-trace retention; no private trace is copied or needed by later value folds.
    return this.toolChoices(item.scopeKey,draft);
  }
  private toolChoices(scopeKey:string,draft:FeedbackTurnDraft,turnId?:string):StoredChoice[] {
    const evidence=turnId?this.dependencies.toolEvidence(scopeKey,draft.threadId,turnId):null;
    return draft.choices.flatMap(link=>{
      if (evidence&&!evidence.some(call=>!call.withheld&&call.tool===link.tool&&call.ok===link.ok)) return [];
      const choice=this.choices.get(scopeKey,link.choiceId);
      return choice && choice.status!=='void' && !['lost','void'].includes(choice.settleCode??'') && choice.surface===draft.surface && choice.subjectKind==='talk' && choice.subjectId===draft.threadId
        && ((choice.sourceKind==='tool_call'&&choice.choice===`tool.${link.tool}`)||(choice.sourceKind==='skill'&&choice.choice==='skill.use'&&link.tool==='skill.read')) ? [choice] : [];
    });
  }
  private sourceMatches(source:FeedbackSource|null,digest:string):boolean { return source?.status==='visible'&&source.ownerAlone&&source.replyDigest===digest; }
  private proofStatus(scopeKey:string,taskId:string):FeedbackTaskProofStatus {
    if(this.dependencies.taskProofStatus)return this.dependencies.taskProofStatus(scopeKey,taskId);
    const proof=this.dependencies.taskProof?.(scopeKey,taskId);return proof?{status:'verified',proof}:{status:'unknown'};
  }
  private ownerAllowed(scopeKey:string):boolean { try {return scopeKey===this.dependencies.ownerScopeKey&&this.dependencies.ownerAlone(scopeKey)===true;}catch{return false;} }
  private write<T>(operation:()=>T):T { return underWriteLock(this.dependencies.database,null,ownerDayKey(this.dependencies.now()),operation,'shannon_feedback'); }
}
function usableChoice(choice:StoredChoice):boolean {
  return choice.status==='settled' && choice.reward!==null && choice.serve!==null && choice.world!==null && choice.growth!==null
    && !['void','lost'].includes(choice.settleCode??'') && !choice.choice.startsWith('tier.');
}
