import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { FeedbackService, feedbackDigest } from '../../src/mind/learning/feedbackService.js';
import { feedbackSourceReader } from '../../src/wiring/feedbackSourceWiring.js';
import { recordTurn } from '../../src/wiring/turnRoutingWiring.js';
import { ValueVersions } from '../../src/mind/learning/valueTable.js';
import type { FeedbackTaskProof } from '../../src/contracts/feedbackContract.js';

export function feedbackHarness(options:{maximumDisplayedConversationItems?:number}={}) {
  const directory=mkdtempSync(join(tmpdir(),'shannon-feedback-'));
  const path=join(directory,'feedback.sqlite');
  const clock={at:'2026-10-08T00:00:00.000Z',alone:true,unknown:false};
  const store=new SQLiteShannonStore({path,now:()=>clock.at,predictionLedger:true,choiceLedger:true,cognitionDefer:task=>task(),predictionShadowDefer:task=>task(),...options});
  const db=new DatabaseSync(path); db.exec('PRAGMA busy_timeout=50;PRAGMA journal_mode=WAL;');
  const choices=store.choiceLedger()!;
  const tasks=new Map<string,FeedbackTaskProof>();
  const readSource=feedbackSourceReader({conversationStore:store,stateStore:store});
  const source=(scope:string,thread:string,id:string)=>clock.unknown?null:readSource(scope,thread,id);
  const toolEvidence=(scope:string,thread:string,id:string)=>store.toolTraces(scope,thread,{turnIds:[id]}).flatMap(trace=>trace.calls.map(call=>({tool:call.tool,ok:call.ok,withheld:call.failure==='denied'})));
  const feedback=new FeedbackService({database:db,createSchema:true,ownerScopeKey:'owner',now:()=>clock.at,ownerAlone:()=>clock.alone,source,toolEvidence,taskProof:(_scope,id)=>tasks.get(id)??null,
    taskProofStatus:(_scope,id)=>clock.unknown?{status:'unknown'}:tasks.has(id)?{status:'verified',proof:tasks.get(id)!}:{status:'invalid'}});
  const values=new ValueVersions({database:db,createsSchema:false,conversation:true,feedback});
  const seed=(options:{scope?:string;thread?:string;surface?:'text'|'voice';presence?:'alone'|'others';withheld?:boolean;outOfTime?:boolean;described?:boolean;tools?:boolean;reply?:string}={})=>{
    const scope=options.scope??'owner',thread=options.thread??'talk',recordId=randomUUID(),reply=options.reply??'読みものを確かめました。';
    const tool=options.tools===false?[]:[{name:'study.list',ok:true,...(options.withheld?{withheld:true}:{})}];
    recordTurn(choices,null,scope,{talk:thread,surface:options.surface??'text',presence:options.presence??'alone',tier:{served:'luna',kind:'lookup'},tools:tool,
      inDeadline:!options.outOfTime,verified:true,doing:options.described?'described_not_done':null,feedback:{recordId,threadId:thread,replyDigest:feedbackDigest(reply)}},clock.at,null,feedback);
    const experience=store.appendTurn(scope,thread,'読みものを調べて。',reply,clock.at);
    if (tool.length) store.saveToolTrace(scope,{turnId:experience.id,threadId:thread,recordedAt:clock.at,asked:true,calls:[{tool:'study.list',ok:true,target:'/synthetic-private-path',names:['架空の私的なタイトル']}]});
    const target=feedback.bindTurn(scope,{recordId,threadId:thread,turnId:experience.id,reply});
    return {scope,thread,recordId,reply,turnId:experience.id,target};
  };
  const change=(targetId:string,expectedRevision:number,reaction:'good'|'bad'|null,operationId=randomUUID(),threadId='talk')=>feedback.change('owner',{targetId,threadId,expectedRevision,reaction,operationId});
  return {path,db,store,choices,values,feedback,clock,tasks,source,toolEvidence,seed,change,close:()=>{store.close();db.close();rmSync(directory,{recursive:true,force:true});}};
}
