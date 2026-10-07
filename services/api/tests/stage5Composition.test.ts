import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_VALUE } from '@shannon/learning';
import type { ActionThreads, ActionView } from '../src/contracts/actionThreadContract.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteAgentTaskStore, type HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';
import type { TaskTreeLearningCallbacks } from '../src/mind/action/agentTasks/taskTreePorts.js';
import { taskTestCommandHash } from '../src/integrations/agentHost/codexTaskProjection.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/inhibitionPorts.js';
import { configuredServerStage5 } from '../src/wiring/serverStage5Wiring.js';
import { configuredStage5Feedback } from '../src/wiring/stage5FeedbackWiring.js';
import { configuredWorkerFeedback } from '../src/wiring/configuredWorkerFeedback.js';
import { stage5MemoryStoreOptions } from '../src/wiring/stage5MemoryWiring.js';
import { taskFeedbackWiring, VERIFIED_TASK_REPLY } from '../src/wiring/taskFeedbackWiring.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
const now = () => '2026-10-08T03:00:00.000Z';
const lease = {id:'canonical-action',generation:1,holder:'original-host-holder'};
function temporary() {
  const directory=mkdtempSync(join(tmpdir(),'shannon-stage5-composition-'));
  cleanups.push(() => rmSync(directory,{recursive:true,force:true}));
  return join(directory,'shannon.sqlite');
}
function composedTask(origin: 'owner_request'|'own_time' = 'owner_request') {
  const path=temporary();
  const store=new SQLiteShannonStore({path,now,choiceLedger:true,predictionLedger:true,cognitionDefer:task=>task(),predictionShadowDefer:task=>task()});
  cleanups.push(()=>store.close());
  let linked: ReturnType<typeof taskFeedbackWiring> | null = null;
  const callbacks: TaskTreeLearningCallbacks = {
    dispatchContext:()=>({presence:'alone',value:{...ROOT_VALUE,mean:0.2,version:'original-V'}}),
    taskDispatched:(scope,input)=>linked?.callbacks.taskDispatched(scope,input)??false,
    taskVerified:(scope,proof,at)=>linked?.callbacks.taskVerified(scope,proof,at)??false,
    taskUnusable:(scope,input)=>linked?.callbacks.taskUnusable(scope,input)??false,
  };
  const tasks=new SQLiteAgentTaskStore(path,{taskTreeEnabled:true,taskTreeCallbacks:callbacks});
  cleanups.push(()=>tasks.close());
  const feedback=configuredStage5Feedback({SHANNON_ADR8_STAGE5:'on'},{store,tasks,ownerScope:'owner',now,ownerAlone:()=>alone})!;
  let alone=true, unavailable=false;
  let views: ActionView[] = [{id:lease.id,scopeKey:'owner',kind:'agentTask',sourceId:'real-task',origin,
    state:'running',generation:1,holder:lease.holder,lastHolder:lease.holder} as ActionView];
  // The canonical action port is a read-only external boundary in this test; task/proof/choice/note are real SQLite paths.
  const actions={get:async(scope:string,id:string)=>{if(unavailable)throw new Error('IPC unavailable');return views.find(view=>view.scopeKey===scope&&view.id===id)??null;}} as unknown as ActionThreads;
  linked=taskFeedbackWiring({tasks,conversation:store,actions,ownerScope:'owner',now,ownerAlone:()=>alone,
    feedback:()=>feedback.feedback,flush:()=>tasks.taskTrees!.flushLearning()});
  tasks.create('owner',{taskId:'real-task',idempotencyKey:'task-original',conversationThreadID:'talk',title:'確認する',goal:'履歴を保つ',summary:'確認する',
    taskAuthority:{origin,budgetLane:origin==='owner_request'?'owner':'autonomy',ownerInformed:true,permissionId:'original-permission'},
    plan:[{id:'test-node',title:'元の試験',status:'pending'}]},now());
  const trees=tasks.taskTrees!, tree=trees.get('owner','real-task')!;
  const nodes=tree.nodes.map(node=>({...node,contract:{result:'履歴を保つ',checks:[{id:'check',kind:'test' as const,target:'pnpm test'}],constraints:['履歴を保つ'],boundary:['元の権限'],stop:['所有者の停止']}}));
  const proposal=trees.propose('owner','real-task',tree.revision,{goal:tree.goal,content:tree.content,deadline:null,nodes},now());
  trees.approve('owner','real-task',proposal.id,tree.revision,proposal.diffHash,now());
  const command=tasks.claim('real-host',now())!;
  const complete:HostAgentEvent={eventId:'original-completion',taskId:'real-task',type:'completed',title:'合成の結果',occurredAt:now(),payload:{
    actionLease:lease,executionTurnId:'original-turn',summary:'SENTINEL-HOST-PROSE',tests:[{id:'actual-test',name:'pnpm test',status:'passed',
      execution:{turnId:'original-turn',actionLease:lease,commandHash:taskTestCommandHash('pnpm test'),exitCode:0}}]}};
  return {path,store,tasks,feedback,command,complete,
    refresh:()=>linked!.refresh(), bind:()=>tasks.bindActionLease(command.id,lease),
    receipt:(state:ActionView['state'],generation=1,holder=lease.holder)=>{views=[{...views[0]!,state,generation,lastHolder:holder,holder:state==='running'?holder:null}];},
    loseIPC:()=>{unavailable=true;},restoreIPC:()=>{unavailable=false;},others:()=>{alone=false;}};
}

describe('Stage5 actual process composition',()=>{
  it('OFF preserves the previous memory options and creates none of the Stage5 persistence or worker ports',()=>{
    const path=temporary();
    const previous=stage5MemoryStoreOptions({SHANNON_ADR8_STAGE3:'on'});
    expect(stage5MemoryStoreOptions({SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE5:'off'})).toEqual(previous);
    const store=new SQLiteShannonStore({path,now,...previous,choiceLedger:true,predictionLedger:true});cleanups.push(()=>store.close());
    const parts={path,store,ownerScope:'owner',now};
    const server=configuredServerStage5({},parts);cleanups.push(()=>server.close());
    expect(server.feedback).toBeNull();expect(server.tasks.taskTrees).toBeUndefined();expect(server.capabilities).toBeUndefined();
    expect(configuredWorkerFeedback({},parts)).toBeNull();expect(store.selfInterests()).toBeNull();
    const names=store.composeLearning(db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));
    expect(names.filter(name=>/self_interests|task_tree|shannon_feedback|self_rewrite/u.test(name))).toEqual([]);
  });

  it('freezes unknown audience as unknown/null V, rather than borrowing the others-context value',async()=>{
    for (const presence of ['unknown','others','throws'] as const) {
      const path=temporary(), environment={SHANNON_ADR8_STAGE5:'on'};
      const store=new SQLiteShannonStore({path,now,choiceLedger:true,predictionLedger:true});cleanups.push(()=>store.close());
      const server=configuredServerStage5(environment,{path,store,ownerScope:'owner',now});
      const autonomyStore=createAutonomyStore(path);cleanups.push(()=>autonomyStore.close());
      const config=configuredAutonomy({});const autonomy=createInMemoryAutonomyService(now,{store:autonomyStore,config});
      const actions={get:async(scope:string,id:string)=>scope==='owner'&&id===lease.id?{id:lease.id,scopeKey:'owner',kind:'agentTask',sourceId:'audience-task',origin:'owner_request',
        state:'running',generation:1,holder:lease.holder,lastHolder:lease.holder}:null} as unknown as ActionThreads;
      server.attach({ownerAlone:()=>false,presence:()=>{if(presence==='throws')throw new Error('unreadable');return presence;},actions,autonomy,autonomyStore,config});
      cleanups.push(()=>server.close());await server.afterHost();
      server.tasks.create('owner',{taskId:'audience-task',idempotencyKey:'audience-original',conversationThreadID:'talk',title:'確認',goal:'確認',summary:'確認',
        taskAuthority:{origin:'owner_request',budgetLane:'owner',ownerInformed:true,permissionId:'original-permission'},plan:[]},now());
      const command=server.tasks.claim('real-host',now())!;server.tasks.bindActionLease(command.id,lease);await server.afterHost();
      const choices=store.choiceLedger()!.rows('owner');
      if(presence==='others'){expect(choices).toHaveLength(1);expect(choices[0]!.context).toMatch(/\.others$/u);}
      else expect(choices).toHaveLength(0);
    }
  });

  it('waits for canonical completion, then credits the original verified attempt and exact closed note once',async()=>{
    const run=composedTask();await run.refresh();run.bind();await run.refresh();
    expect(run.store.choiceLedger()!.rows('owner')).toHaveLength(1);
    expect(run.store.choiceLedger()!.rows('owner')[0]).toMatchObject({expected:0.2,valueVersion:'original-V',status:'pending'});
    run.receipt('unknown');await run.refresh();
    run.tasks.recordHostEvents('real-host',[run.complete],now());
    expect(run.feedback.feedback.store.targets('owner')).toHaveLength(0);
    expect(run.store.choiceLedger()!.rows('owner')[0]!.status).toBe('pending');
    run.receipt('completed',2);await run.refresh();await run.refresh();
    const target=run.feedback.feedback.store.targets('owner')[0]!;
    expect(run.feedback.feedback.store.targets('owner')).toHaveLength(1);
    expect(run.store.choiceLedger()!.rows('owner')).toHaveLength(1);
    expect(run.store.choiceLedger()!.rows('owner')[0]).toMatchObject({serve:1,growth:1,status:'settled',expected:0.2});
    const messages=run.store.conversationHistory('owner','talk');expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({id:target.turnId,content:VERIFIED_TASK_REPLY,sourceExperienceId:`agent-task-result:${target.turnId}`,noteOwnerAlone:true});
    expect(JSON.stringify(messages)).not.toContain('SENTINEL-HOST-PROSE');
    expect(run.feedback.feedback.change('owner',{targetId:target.targetId,threadId:'talk',operationId:'thumb-once',expectedRevision:0,reaction:'bad'})).toMatchObject({revision:1});
    expect(run.store.choiceLedger()!.rows('owner')).toHaveLength(1);
    const worker=configuredWorkerFeedback({SHANNON_ADR8_STAGE5:'on'},{path:run.path,store:run.store,ownerScope:'owner',now})!;
    const version=run.store.valueVersions()!.nightly('owner','2026-10-09T03:00:00.000Z');
    expect(version.decision).toBe('snapshot');worker.close();
    expect(run.feedback.feedback.getOperation('owner',target.targetId,'talk','thumb-once')).toMatchObject({revision:1,reaction:'bad'});
  });

  it('retains pending receipts through IPC uncertainty and does not expose an initially shared task result',async()=>{
    const run=composedTask();await run.refresh();run.bind();run.loseIPC();await run.refresh();
    run.tasks.recordHostEvents('real-host',[run.complete],now());
    expect(run.feedback.feedback.store.targets('owner')).toHaveLength(0);
    run.receipt('completed');run.others();run.restoreIPC();await run.refresh();
    expect(run.store.choiceLedger()!.rows('owner')[0]!.status).toBe('settled');
    expect(run.store.conversationHistory('owner','talk')[0]!.noteOwnerAlone).toBe(false);
    expect(run.feedback.feedback.store.targets('owner')).toHaveLength(0);
    await run.refresh();expect(run.store.conversationHistory('owner','talk')).toHaveLength(1);
  });

  it('never turns self-origin work into an owner-requested task choice or feedback target',async()=>{
    const run=composedTask('own_time');await run.refresh();run.bind();run.receipt('completed');
    run.tasks.recordHostEvents('real-host',[run.complete],now());await run.refresh();
    expect(run.store.choiceLedger()!.rows('owner')).toHaveLength(0);
    expect(run.feedback.feedback.store.targets('owner')).toHaveLength(0);
    expect(run.store.conversationHistory('owner','talk')).toHaveLength(0);
  });
});
