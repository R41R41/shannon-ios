import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_VALUE } from '@shannon/learning';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteAgentTaskStore, type HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';
import type { TaskTreeLearningCallbacks } from '../src/mind/action/agentTasks/taskTreePorts.js';
import { taskFeedbackWiring, VERIFIED_TASK_REPLY } from '../src/wiring/taskFeedbackWiring.js';
import { configuredStage5Feedback } from '../src/wiring/stage5FeedbackWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { taskTestCommandHash } from '../src/integrations/agentHost/codexTaskProjection.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const started='2026-10-08T03:00:00.000Z';
function recoveryFixture() {
  const directory=mkdtempSync(join(tmpdir(),'shannon-feedback-recovery-'));
  cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'state.sqlite');
  let at=started,alone=true,ready=false,frozenReads=0,crash:'before-note'|'after-note'|null=null;
  let link:ReturnType<typeof taskFeedbackWiring>|null=null;
  const now=()=>at;
  const callbacks:TaskTreeLearningCallbacks={
    dispatchContext:()=>{frozenReads++;return {presence:'alone',value:{...ROOT_VALUE,mean:0.2,version:'original-V'}};},
    taskDispatched:(scope,input)=>ready?link!.callbacks.taskDispatched(scope,input):false,
    taskVerified:(scope,proof,time)=>ready?link!.callbacks.taskVerified(scope,proof,time):false,
    taskUnusable:(scope,input)=>ready?link!.callbacks.taskUnusable(scope,input):false,
  };
  const open=()=>{
    const memory=new SQLiteShannonStore({path,now,choiceLedger:true,predictionLedger:true,cognitionDefer:work=>work(),predictionShadowDefer:work=>work()});
    const tasks=new SQLiteAgentTaskStore(path,{taskTreeEnabled:true,taskTreeCallbacks:callbacks});
    const scheduler=actionHarness(now,path);
    const feedback=configuredStage5Feedback({SHANNON_ADR8_STAGE5:'on'},{store:memory,tasks,ownerScope:'owner',now,ownerAlone:()=>alone})!;
    const conversation=new Proxy(memory,{get(target,key,receiver){
      if(key==='appendNoteOnce')return (...args:Parameters<SQLiteShannonStore['appendNoteOnce']>)=>{
        if(crash==='before-note'){crash=null;throw new Error('simulated restart before note commit');}
        const note=target.appendNoteOnce(...args);
        if(crash==='after-note'){crash=null;throw new Error('simulated restart after note commit');}
        return note;
      };
      return Reflect.get(target,key,receiver);
    }});
    link=taskFeedbackWiring({tasks,conversation,actions:scheduler.actions,ownerScope:'owner',now,ownerAlone:()=>alone,
      feedback:()=>feedback.feedback,flush:()=>tasks.taskTrees!.flushLearning()});
    const close=()=>{if(scheduler.db.isOpen)scheduler.close();tasks.close();memory.close();};
    cleanup.push(close);
    return {memory,tasks,scheduler,feedback,close};
  };
  let process=open();
  const action=process.scheduler.store.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'old-task',ownerInformed:true},at);
  const running=process.scheduler.store.claim(action.id,'original-host-holder',at)!;
  const lease=leaseOf(running);process.scheduler.store.dispatch(lease,at);
  process.tasks.create('owner',{taskId:'old-task',idempotencyKey:'old-original',conversationThreadID:'talk',title:'確認',goal:'履歴を保つ',summary:'確認',
    taskAuthority:{origin:'owner_request',budgetLane:'owner',ownerInformed:true,permissionId:'original-permission'},
    plan:[{id:'test-node',title:'元の試験',status:'pending'}]},at);
  const trees=process.tasks.taskTrees!,tree=trees.get('owner','old-task')!;
  const nodes=tree.nodes.map(node=>({...node,contract:{result:'履歴を保つ',checks:[{id:'required-test',kind:'test' as const,target:'pnpm test'}],constraints:[],boundary:['元の権限'],stop:['所有者の停止']}}));
  const proposal=trees.propose('owner','old-task',tree.revision,{goal:tree.goal,content:tree.content,deadline:null,nodes},at);
  trees.approve('owner','old-task',proposal.id,tree.revision,proposal.diffHash,at);
  const command=process.tasks.claim('real-host',at)!;process.tasks.bindActionLease(command.id,lease);
  const complete:HostAgentEvent={eventId:'canonical-old-completion',taskId:'old-task',type:'completed',title:'結果',occurredAt:at,payload:{
    actionLease:lease,executionTurnId:'original-turn',summary:'SENTINEL-HOST-PROSE',tests:[{id:'original-test',name:'pnpm test',status:'passed',
      execution:{turnId:'original-turn',actionLease:lease,commandHash:taskTestCommandHash('pnpm test'),exitCode:0}}]}};
  process.tasks.recordHostEvents('real-host',[complete],at);
  process.scheduler.store.finish(lease,'unknown','lost_response',at);
  process.scheduler.store.reconcile(lease,'completed','outside_completed',at);
  for(let index=1;index<=40;index++){
    at=new Date(Date.parse(started)+index*1000).toISOString();
    const next=process.scheduler.store.enqueue({scopeKey:'owner',kind:'ownTime',origin:'own_time',sourceId:`newer-${index}`},at);
    const held=process.scheduler.store.claim(next.id,'another-holder',at)!;
    process.scheduler.store.finish(leaseOf(held),'completed','done',at);
  }
  return {
    get current(){return process;},actionId:action.id,
    get frozenReads(){return frozenReads;},
    others:()=>{alone=false;},alone:()=>{alone=true;},
    crash:(point:'before-note'|'after-note')=>{crash=point;},
    restart:()=>{process.close();process=open();ready=true;},
    refresh:()=>link!.refresh(),
  };
}

describe('original task receipt recovery independent of bounded action lists',()=>{
  it('reopens and settles the original ACK beyond 40 newer terminal actions, preserving outbox order and original V',async()=>{
    const run=recoveryFixture();
    expect(run.current.scheduler.store.list('owner')).toHaveLength(40);
    expect(run.current.scheduler.store.list('owner').some(action=>action.id===run.actionId)).toBe(false);
    expect(run.current.scheduler.store.get(run.actionId)).toMatchObject({state:'completed',generation:2});
    expect(run.current.memory.choiceLedger()!.rows('owner')).toEqual([]);
    run.restart();await run.refresh();await run.refresh();
    const {memory,feedback}=run.current;
    expect(run.frozenReads).toBe(1);
    expect(memory.choiceLedger()!.rows('owner')).toMatchObject([{status:'settled',serve:1,growth:1,expected:0.2,valueVersion:'original-V'}]);
    expect(feedback.feedback.store.targets('owner')).toHaveLength(1);
    expect(memory.conversationHistory('owner','talk')).toMatchObject([{content:VERIFIED_TASK_REPLY,noteOwnerAlone:true}]);
    expect(memory.composeLearning(db=>db.prepare('SELECT delivered FROM agent_task_tree_learning ORDER BY rowid').all())).toEqual([{delivered:1},{delivered:1}]);
  });

  it.each([true,false])('survives a partial note commit and preserves the original audience %s through retry',async initialAlone=>{
    const run=recoveryFixture();run.restart();if(!initialAlone)run.others();
    run.crash('after-note');await run.refresh();
    expect(run.current.memory.choiceLedger()!.rows('owner')).toMatchObject([{status:'settled'}]);
    expect(run.current.feedback.feedback.store.targets('owner')).toHaveLength(0);
    expect(run.current.memory.conversationHistory('owner','talk')).toHaveLength(1);
    run.restart();if(initialAlone)run.others();else run.alone();
    await run.refresh();await run.refresh();
    const {memory,feedback}=run.current;
    expect(memory.choiceLedger()!.rows('owner')).toHaveLength(1);
    expect(memory.conversationHistory('owner','talk')).toMatchObject([{noteOwnerAlone:initialAlone}]);
    expect(JSON.stringify(memory.conversationHistory('owner','talk'))).not.toContain('SENTINEL-HOST-PROSE');
    expect(feedback.feedback.store.targets('owner')).toHaveLength(initialAlone?1:0);
    if(initialAlone){
      const target=feedback.feedback.store.targets('owner')[0]!;
      expect(feedback.feedback.project('owner','talk',target.turnId)).toBeNull();
      run.alone();expect(feedback.feedback.project('owner','talk',target.turnId)).not.toBeNull();
    }
  });

  it('does not invent a pre-crash note audience when only the original settlement had committed',async()=>{
    const run=recoveryFixture();run.restart();run.crash('before-note');await run.refresh();
    expect(run.current.memory.choiceLedger()!.rows('owner')).toMatchObject([{status:'settled'}]);
    expect(run.current.memory.conversationHistory('owner','talk')).toEqual([]);
    run.restart();run.others();await run.refresh();
    expect(run.current.memory.conversationHistory('owner','talk')).toMatchObject([{noteOwnerAlone:false}]);
    expect(run.current.feedback.feedback.store.targets('owner')).toHaveLength(0);
  });
});
