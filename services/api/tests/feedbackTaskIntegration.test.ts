import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAgentTaskStore, type HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { FeedbackService } from '../src/mind/learning/feedbackService.js';
import { taskTestCommandHash } from '../src/integrations/agentHost/codexTaskProjection.js';
import { ROOT_VALUE } from '@shannon/learning';
import type { TaskTreeLearningCallbacks } from '../src/mind/action/agentTasks/taskTreePorts.js';
import { feedbackHarness } from './support/feedbackHarness.js';
let h:ReturnType<typeof feedbackHarness>,tasks:SQLiteAgentTaskStore;
afterEach(()=>{tasks?.close();h?.close();});
const lease={id:'canonical-action',holder:'mind-owner',generation:1};
function setup(options:{delayDispatch?:boolean}={}) {
  let ready=!options.delayDispatch,mean=0.2,reads=0;
  h=feedbackHarness();let feedback:FeedbackService;
  const callbacks={
    dispatchContext(){reads++;return {presence:'alone' as const,value:{...ROOT_VALUE,mean,version:'at-original-dispatch'}};},
    taskDispatched(scope,input){if(!ready)return false;feedback.taskDispatched(scope,{...input,presence:'others'});return true;},
    taskVerified(scope,proof,at){feedback.taskVerified(scope,proof.taskId,proof.attemptId,at,3);
      const note=h.store.appendNoteOnce(scope,proof.threadId,`task-result:${proof.attemptId}`,'作業が完了しました。確認も通りました。',at,'agent-task-result',true);
      feedback.bindTaskReply(scope,{taskId:proof.taskId,threadId:proof.threadId,messageId:note.id,reply:note.content});},
    taskUnusable(scope,input){if(input.reason!=='unknown')feedback.taskUnusable(scope,input.taskId,input.attemptId,input.at);},
  } satisfies TaskTreeLearningCallbacks;
  tasks=new SQLiteAgentTaskStore(h.path,{taskTreeEnabled:true,taskTreeCallbacks:callbacks});
  feedback=new FeedbackService({database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>h.clock.alone,source:h.source,toolEvidence:h.toolEvidence,
    taskProofStatus:(scope,id)=>tasks.taskTrees!.proofStatus(scope,id)});
  tasks.create('owner',{taskId:'real-task',idempotencyKey:'new-task',conversationThreadID:'talk',title:'確認する',goal:'履歴を保つ',summary:'確認する',
    taskAuthority:{origin:'owner_request',budgetLane:'owner',ownerInformed:true,permissionId:'task:real-task'},plan:[{id:'child',title:'試験',status:'pending'}]},h.clock.at);
  const trees=tasks.taskTrees!,tree=trees.get('owner','real-task')!;
  const nodes=tree.nodes.map(node=>({...node,contract:{result:'履歴を保つ',checks:[{id:'local-check',kind:'test' as const,target:'pnpm test'}],constraints:['履歴を保つ'],boundary:['元の権限'],stop:['所有者の停止']}}));
  const proposal=trees.propose('owner','real-task',tree.revision,{goal:tree.goal,content:tree.content,deadline:null,nodes},h.clock.at);
  trees.approve('owner','real-task',proposal.id,tree.revision,proposal.diffHash,h.clock.at);
  const command=tasks.claim('real-host',h.clock.at)!;tasks.bindActionLease(command.id,lease);
  const event=(eventId:string,payload:Record<string,unknown>,type:HostAgentEvent['type']='completed'):HostAgentEvent=>({eventId,taskId:'real-task',type,title:'合成の作業結果',occurredAt:h.clock.at,payload:{executionTurnId:'original-turn',actionLease:lease,...payload}});
  const test={id:'actual-command',name:'pnpm test',status:'passed',execution:{turnId:'original-turn',actionLease:lease,commandHash:taskTestCommandHash('pnpm test'),exitCode:0}};
  return {feedback,trees,command,event,test,release(){mean=0.8;ready=true;tasks.taskTrees!.flushLearning();},reads:()=>reads,restart(){tasks.close();tasks=new SQLiteAgentTaskStore(h.path,{taskTreeEnabled:true,taskTreeCallbacks:callbacks});}};
}
describe('task tree original proof to feedback integrated SQLite path',()=>{
  it('freezes original V/context in the durable dispatch before delayed callback and restart',()=>{
    const run=setup({delayDispatch:true});expect(h.choices.rows('owner')).toHaveLength(0);expect(run.reads()).toBe(1);
    run.restart();run.release();
    expect(h.choices.rows('owner')).toHaveLength(1);expect(h.choices.rows('owner')[0]).toMatchObject({expected:0.2,valueVersion:'at-original-dispatch',context:'morning.alone'});
    tasks.taskTrees!.flushLearning();expect(run.reads()).toBe(1);expect(h.choices.rows('owner')).toHaveLength(1);
  });
  it('does not accept prose/foreign evidence, holds unknown, then binds the exact original verified ACK and saved reply once',()=>{
    const {feedback,trees,command,event,test}=setup();
    expect(h.choices.rows('owner')).toHaveLength(1);
    tasks.recordHostEvents('real-host',[event('uncertain',{executionUncertain:true},'progress')],h.clock.at);
    expect(h.choices.rows('owner')[0]!.status).toBe('pending');expect(feedback.store.targets('owner')).toHaveLength(0);
    tasks.recordHostEvents('real-host',[event('foreign',{actionLease:{...lease,generation:2},tests:[test],summary:'完了した'})],h.clock.at);
    expect(trees.proofForTask('owner','real-task')).toBeNull();
    const completed=event('original-completion',{tests:[test],summary:'/synthetic/private/path は完了'});
    tasks.recordHostEvents('real-host',[completed],h.clock.at);tasks.recordHostEvents('real-host',[completed],h.clock.at);
    const target=feedback.store.targets('owner')[0]!;
    expect(target).toMatchObject({taskId:'real-task',attemptId:command.id,turnId:`task-result:${command.id}`});
    expect(h.choices.rows('owner')).toHaveLength(1);expect(h.choices.rows('owner')[0]).toMatchObject({status:'settled',costYen:3,serve:1,growth:1});
    expect(feedback.change('owner',{targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId:'real-thumb',reaction:'bad'})).toMatchObject({revision:1});
    expect(feedback.snapshot('owner').reactions.size).toBe(1);
    expect(JSON.stringify(h.store.conversationHistory('owner','talk'))).not.toContain('/synthetic/private/path');
    expect(trees.proofForTask('owner','real-task')?.attemptId).toBe(command.id);
  });
});
