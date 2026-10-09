import { describe, expect, it } from 'vitest';
import { createObserverState, reduceObserverEnvelope, spanState, effectiveObservedSpans, type ObservedSpan } from '../src/infra/observer/web/observer.js';
import { createElapsedClock, observedTasks, taskRunView, timelineRows, timingGroups, timingSummary, streamTimingSummary } from '../src/infra/observer/web/observerAnalysis.js';
import { NODE_SPECS, LINKS, mapLayout, routeIncludes, circuitFor } from '../src/infra/observer/web/observerMap.js';
import { OBSERVER_NODES, type ObserverBatch, type ObserverEvent } from '../src/contracts/observerContract.js';
const at='2026-10-09T00:00:00.000Z';
const span=(id:string,extra:Partial<ObservedSpan>={}):ObservedSpan=>({ id,runId:'r',node:'llm',parentSpanId:null,startedAt:at,endedAt:at,state:'completed',firstSequence:1,lastSequence:2,origin:'server',...extra });
const event=(sequence:number,extra:Partial<ObserverEvent>={}):ObserverEvent=>({sequence,runId:'r',spanId:`s${sequence}`,parentSpanId:null,node:'fca',kind:'span.started',at,...extra});
const batch=(events:ObserverEvent[],extra:Partial<ObserverBatch>={}):ObserverBatch=>({schemaVersion:1,instanceId:'i',events,cursor:events.at(-1)?.sequence??0,oldestCursor:1,gap:false,availability:'ready',generatedAt:at,...extra});
describe('retained FCA observation analysis',()=>{
  it('uses explicit task/parent/step IDs, preserves cross-run span identity and filters a selected loop',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{spanId:'same',taskId:'parent',stepId:'step-a'}),
      event(2,{runId:'other',spanId:'same',taskId:'child',parentTaskId:'parent',stepId:'step-b',actionId:'act'}),
      event(3,{node:'llm',taskId:'child',parentTaskId:'parent',stepId:'step-c'}),
      event(4,{node:'llm',input:{taskId:'not-a-correlation'}}),
    ]));
    expect(observedTasks(state).map(task=>[task.id,task.parentId,task.depth])).toEqual([['parent',null,0],['child','parent',1]]);
    const view=taskRunView(state,'child','step-b');
    expect([...view.spans.values()]).toMatchObject([{id:'same',runId:'other',actionId:'act'}]);
    expect(view.events).toHaveLength(1); expect(taskRunView(state,'parent').spans.size).toBe(1);
    expect(taskRunView(state,'child').events.map(item=>item.sequence)).toEqual([2,3]);
  });
  it('shows only the latest explicit task phase and never assigns a returned child phase to its parent',()=>{
    const initial=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{node:'taskHub',spanId:'parent-state',taskId:'parent',origin:'server',input:{phase:'returned_state'}}),
      event(2,{node:'taskHub',spanId:'parent-state',taskId:'parent',origin:'server',kind:'span.completed',output:{phase:'executing',revision:3}}),
      event(3,{node:'taskHub',spanId:'create-child',taskId:'parent',origin:'server',kind:'span.completed',output:{taskId:'child',phase:'ready',revision:1}}),
      event(4,{node:'llm',taskId:'parent',origin:'server',kind:'span.completed',output:{phase:'failed'}}),
      event(5,{node:'taskHub',spanId:'child-state',taskId:'child',parentTaskId:'parent',origin:'server',input:{phase:'returned_state'}}),
      event(6,{node:'taskHub',spanId:'child-state',taskId:'child',parentTaskId:'parent',origin:'server',kind:'span.completed',output:{phase:'ready',revision:1}}),
    ]));
    expect(observedTasks(initial).map(task=>[task.id,task.phase,task.phaseRevision,task.phaseSequence]))
      .toEqual([['parent','executing',3,2],['child','ready',1,6]]);
    const next=reduceObserverEnvelope(initial,batch([
      event(7,{node:'fca',spanId:'fca-step',taskId:'parent',origin:'server',kind:'span.completed',output:{phase:'waiting',revision:4}}),
      event(8,{node:'store',taskId:'parent',origin:'server',kind:'span.completed',output:{taskId:'parent',phase:'completed',revision:5}}),
      event(9,{node:'taskHub',taskId:'parent',origin:'server',kind:'span.completed',output:{phase:'failed'}}),
      event(10,{node:'fca',spanId:'fca-step',taskId:'parent',origin:'server'}),
    ]));
    expect(observedTasks(next).find(task=>task.id==='parent')).toMatchObject({phase:'completed',phaseRevision:5,phaseSequence:8});
  });
  it('leaves missing, unrecognised and client-authored task phase unobserved',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{taskId:'missing'}),
      event(2,{taskId:'unsupported',node:'fca',origin:'server',kind:'span.completed',output:{phase:'probably_done'}}),
      event(3,{taskId:'client',node:'fca',origin:'client',kind:'span.completed',output:{phase:'completed'}}),
      event(4,{taskId:'observed-unknown',node:'fca',origin:'server',kind:'span.completed',output:{phase:'unknown'}}),
    ]));
    expect(observedTasks(state).map(task=>task.phase)).toEqual([null,null,null,'unknown']);
  });
  it('does not infer missing parents or recurse forever through conflicting/cyclic task evidence',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{taskId:'orphan',parentTaskId:'missing'}),event(2,{taskId:'a',parentTaskId:'b'}),event(3,{taskId:'b',parentTaskId:'a'}),
    ]));
    const tasks=observedTasks(state);expect(tasks).toHaveLength(3);expect(tasks.find(task=>task.id==='orphan')!.orphan).toBe(true);expect(tasks.some(task=>task.cycle)).toBe(true);
  });
  it('retains true parent closure inside a multi-run task view',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{spanId:'root',taskId:'t'}),event(2,{node:'llm',parentSpanId:'root',taskId:'t'}),event(3,{spanId:'root',taskId:'t',kind:'span.completed'}),
    ]));
    const view=taskRunView(state,'t'); expect(spanState([...view.spans.values()].find(value=>value.id==='s2'),view)).toBe('unknown');
  });
  it('counts a child of a closed parent as unknown and stops its receipt clock in selected and retained scopes',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([
      event(1,{spanId:'root',taskId:'t'}),
      event(2,{spanId:'child',node:'llm',parentSpanId:'root',taskId:'t'}),
      event(3,{spanId:'root',taskId:'t',kind:'span.completed',elapsedMs:20}),
      event(4,{spanId:'root',runId:'other',taskId:'other'}),
    ]));
    const selected=effectiveObservedSpans(state,taskRunView(state,'t').spans.values());
    const retained=effectiveObservedSpans(state,[...state.runs.values()].flatMap(run=>[...run.spans.values()]));
    expect(timingSummary(selected)).toMatchObject({running:0,unknown:1,n:1,median:20});
    expect(timingSummary(retained)).toMatchObject({running:1,unknown:1,n:1});
    const clock=createElapsedClock(); clock.observe(retained,10);
    expect(clock.elapsed(selected.find(item=>item.id==='child'),20)).toBeNull();
    expect(clock.elapsed(retained.find(item=>item.runId==='other'),20)).toBe(10);
    const disconnected=effectiveObservedSpans({...state,transport:'lost'},retained);clock.observe(disconnected,30);
    expect(timingSummary(disconnected)).toMatchObject({running:0,unknown:2,n:1,median:20});
    expect(clock.elapsed(retained.find(item=>item.runId==='other'),40)).toBeNull();
  });
  it('samples only finite completed measurements, deduplicates span identity and separates models/origins',()=>{
    const a=span('a',{elapsedMs:10,model:'model-a'}),b=span('b',{elapsedMs:30,model:'model-a'});
    const spans=[a,a,b,span('failed',{elapsedMs:500,state:'failed'}),span('missing'),span('active',{endedAt:null,state:'running'}),span('c',{elapsedMs:50,model:'model-b',origin:'client'})];
    expect(timingSummary(spans)).toMatchObject({total:6,n:3,median:30,p95:50,failed:1,unmeasured:1,running:1});
    expect(timingSummary([a,b])).toMatchObject({median:20,p95:30});
    expect(timingGroups(spans).filter(group=>group.n).map(group=>[group.model,group.origin,group.n])).toEqual([['model-a','server',2],['model-b','client',1]]);
    expect(timingSummary(spans)).not.toHaveProperty('wallTime');
  });
  it('counts canonical provider cache fields once without treating selector caching or TTL breakdown as extra writes',()=>{
    const provider=span('provider',{output:{usage:{cacheReadTokens:100,cacheCreationTokens:20,cacheCreation1hTokens:20,cacheCreation5mTokens:0}}});
    const missing=span('missing',{output:{usage:{cacheReadTokens:null}}});
    expect(timingSummary([provider,provider,missing,span('selector',{node:'jevt',output:{cached:true,usage:{cacheReadTokens:999}}})]).cache).toEqual({readTokens:100,writeTokens:20,readN:1,writeN:1,providerN:2});
  });
  it('reports separate streamed milestones without imputing zero for tool-only, nonstream, failed or unmeasured rounds',()=>{
    const first=span('visible',{output:{firstVisibleOutputAfterMs:40,finalUsageAfterMs:100}});
    const second=span('visible2',{output:{firstVisibleOutputAfterMs:80,finalUsageAfterMs:200}});
    const tool=span('tool-only',{output:{finalUsageAfterMs:60}});
    const nonstream=span('nonstream',{output:{usage:{cacheReadTokens:0}}});
    const failed=span('failed',{state:'failed',output:{firstVisibleOutputAfterMs:999}});
    const other=span('not-llm',{node:'tools',output:{firstVisibleOutputAfterMs:999}});
    const result=streamTimingSummary([first,first,second,tool,nonstream,failed,other]);
    expect(result).toEqual({completedRequests:4,firstVisible:{n:2,median:60,p95:80},finalUsage:{n:3,median:100,p95:200}});
    expect(streamTimingSummary([nonstream]).firstVisible).toEqual({n:0,median:null,p95:null});
    expect(streamTimingSummary([span('zero',{output:{firstVisibleOutputAfterMs:0,finalUsageAfterMs:-1}})]))
      .toMatchObject({firstVisible:{n:1,median:0,p95:0},finalUsage:{n:0,median:null,p95:null}});
  });
  it('keeps server/client clock domains separate and missing durations unmeasured',()=>{
    const rows=timelineRows([span('a',{elapsedMs:100}),span('b',{startedAt:'2026-10-09T00:00:00.020Z',elapsedMs:90}),span('client',{origin:'client',startedAt:'2026-10-09T03:00:00.000Z'}),span('orphan',{startedAt:null,elapsedMs:5})]);
    expect(rows.map(row=>row.offsetMs)).toEqual([0,20,0,null]);expect(rows[2]).toMatchObject({durationMs:null,provenance:'unmeasured'});
  });
  it('clears derived tasks, statistics and local elapsed clock after an audience hold or explicit reset',()=>{
    const state=reduceObserverEnvelope(createObserverState(),batch([event(1,{taskId:'private-task'}),event(2,{spanId:'s1',taskId:'private-task',kind:'span.completed',elapsedMs:23})]));
    const held=reduceObserverEnvelope(state,batch([],{availability:'held',cursor:2}));
    expect(observedTasks(held)).toEqual([]);expect(timingSummary([...held.runs.values()].flatMap(run=>[...run.spans.values()])).n).toBe(0);
    const clock=createElapsedClock(),active=span('local',{endedAt:null,state:'running'});clock.observe([active],100);expect(clock.elapsed(active,350)).toBe(250);clock.clear();expect(clock.elapsed(active,350)).toBeNull();
    clock.observe([active],500);clock.observe([],600);expect(clock.elapsed(active,700)).toBeNull();
  });
});
describe('detailed shared processing map',()=>{
  it('keeps every canonical processor distinct, with complete links and stable role colours',()=>{
    const ids=NODE_SPECS.map(spec=>spec[0]);expect(new Set(ids).size).toBe(ids.length);expect([...ids].sort()).toEqual([...OBSERVER_NODES].sort());
    for(const [from,to] of LINKS){expect(ids).toContain(from);expect(ids).toContain(to);}
    expect(circuitFor('jevt')).toBe('judgment');expect(circuitFor('tools')).toBe('action');expect(circuitFor('play')).toBe('output');
  });
  it('keeps a readable horizontal lane on narrow screens and no boxes overlap',()=>{
    for(const width of [390,1080,1600]){
      const layout=mapLayout(width),boxes=[...layout.boxes.values()];expect(layout.width).toBeGreaterThanOrEqual(1080);
      for(const [index,a] of boxes.entries())for(const b of boxes.slice(index+1))expect(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y).toBe(true);
    }
  });
  it('dims unrelated links without manufacturing task execution or hiding tool inspection',()=>{
    expect(routeIncludes('voice','tts','play')).toBe(true);expect(routeIncludes('voice','sleep','memory')).toBe(false);expect(routeIncludes('all','sleep','memory')).toBe(true);expect(routeIncludes('tool','tools')).toBe(true);
  });
});
