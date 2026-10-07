import { createHash } from 'node:crypto';
import { ROOT_VALUE, settle } from '@shannon/learning';
import type { ValueReader } from './choiceLedger.js';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL, dayBand } from '../../contracts/cognitionLedgerContract.js';
import type { FeedbackTaskDispatch, FeedbackTaskProof } from '../../contracts/feedbackContract.js';
import type { SQLiteChoiceLedger } from './store/sqliteChoiceLedger.js';

/** Trusted dispatch and whole-task proof only. Never called from a thumb, model argument or historical result. */
export class TaskFeedbackChoices {
  constructor(private readonly choices:SQLiteChoiceLedger,private readonly values?:ValueReader){}
  private id(scope:string,task:string,attempt:string):string {return createHash('sha256').update(JSON.stringify(['task_feedback',scope,task,attempt])).digest('hex');}
  dispatch(scope:string,input:FeedbackTaskDispatch):void {
    if (![input.taskId,input.attemptId].every(id=>PREDICTION_SOURCE_ID.test(id))||!Number.isFinite(Date.parse(input.at))) return;
    const choiceId=this.id(scope,input.taskId,input.attemptId);
    if (this.choices.get(scope,choiceId)) return;
    const presence=input.expectation?.presence??input.presence;
    if(!['alone','others','away','unknown'].includes(presence))return;
    const context=`${dayBand(input.at)}.${presence}`,choice='task.execute';
    const value=input.expectation===undefined?(this.values?.(scope,choice,context)??ROOT_VALUE):input.expectation.value;
    if(!value||![value.mean,value.variance,value.noise,value.n].every(Number.isFinite)||value.variance<0||value.noise<0||!Number.isSafeInteger(value.n)||value.n<0
      ||!PREDICTION_SOURCE_ID.test(value.version)||!PREDICTION_SYMBOL.test(value.level))return;
    this.choices.insert({surface:'text',choice,context,sourceKind:'step',sourceId:input.attemptId,choiceId,scopeKey:scope,chosenAt:input.at,
      valueVersion:value.version,expected:value.mean,expectedSd:Math.sqrt(Math.max(0,value.variance)),expectedNoise:value.noise,expectedLevel:value.level,expectedN:value.n,
      status:'pending',success:null,subjectKind:null,subjectId:null,world:null,serve:null,growth:null,costYen:0,reward:null,delta:null,unexpected:null,
      settleCode:null,settledAt:null,moodClaimedAt:null,moodCode:null});
    this.choices.attachTask(scope,choiceId,input.taskId);
  }
  verified(scope:string,taskId:string,attemptId:string,at:string,costYen:number,proof:FeedbackTaskProof|null):void {
    if (!proof||proof.taskId!==taskId||proof.attemptId!==attemptId||proof.status!=='verified'||!proof.evidenceIds.length||!Number.isFinite(costYen)||costYen<0) return;
    const choiceId=this.id(scope,taskId,attemptId),choice=this.choices.get(scope,choiceId);
    if (!choice||choice.status!=='pending'||choice.subjectKind!=='task'||choice.subjectId!==taskId||choice.sourceId!==attemptId) return;
    this.choices.report(scope,choiceId,{success:1,costYen,subject:{kind:'task',id:taskId}});
    this.choices.settle(scope,choiceId,settle({world:0,serve:1,growth:1},{mean:choice.expected,variance:choice.expectedSd**2,noise:choice.expectedNoise}),'task_verified',at);
  }
  unusable(scope:string,taskId:string,attemptId:string,at:string):void {
    const choice=this.choices.get(scope,this.id(scope,taskId,attemptId));
    if (choice?.status==='pending'&&choice.subjectKind==='task'&&choice.subjectId===taskId) this.choices.settle(scope,choice.choiceId,null,'void',at);
  }
}
