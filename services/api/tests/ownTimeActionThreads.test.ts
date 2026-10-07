import { afterEach, expect, it } from 'vitest';
import { OwnTimeActionRunner, foregroundRunner } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { FULL_PLAN, loopHarness } from './autonomyLoopHarness.js';
import { GeminiAutonomyTextModel, OpenAIAutonomyTextModel } from '../src/mind/action/ownTime/autonomyTextModel.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { ShannonAutonomyLoop } from '../src/mind/action/ownTime/autonomyLoop.js';
import { AutonomyToolResults } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import { DatabaseSync } from 'node:sqlite';
const cleanups:Array<()=>void>=[];
afterEach(()=>cleanups.splice(0).reverse().forEach(close=>close()));
function fixture(path?:string,ownTools=false){
  const clock={at:'2026-10-07T01:00:00.000Z'},h=actionHarness(()=>clock.at),runner=new OwnTimeActionRunner(h.actions);
  const loop=loopHarness({clock,actionSteps:runner,concurrentActions:true,path,toolResults:ownTools?new AutonomyToolResults():undefined});
  cleanups.push(h.close,()=>runner.close(),()=>loop.store.close());
  return {...h,...loop,runner,actionStore:h.store};
}
it('keeps the OFF schema until a real ACK commits and rolls its first schema back with the canonical spend',()=>{
  const directory=mkdtempSync(join(tmpdir(),'shannon-action-ack-schema-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'canonical.sqlite');let store=new SQLiteAutonomyStore(path);cleanups.push(()=>store.close());
  const inspect=new DatabaseSync(path);cleanups.push(()=>inspect.close());
  const exists=()=>!!inspect.prepare("SELECT 1 FROM sqlite_schema WHERE name='autonomy_action_acknowledgements'").get();
  const report={id:'ack-one',scopeKey:'owner',lease:{id:'action-one',generation:1,holder:'holder-one'},reservationId:'ack-one',actual:1,state:'checkpoint' as const,code:'think'};
  expect(exists()).toBe(false);expect(store.pendingActionAcknowledgements('owner')).toEqual([]);
  store.deliveredActionAcknowledgement('missing');expect(exists()).toBe(false);
  const save=()=>{store.recordSpend('owner','2026-10-07','2026-10-07T01:00:00.000Z',{model:'synthetic',inputTokens:1,outputTokens:1,costUsd:0.01,costYen:1});store.recordActionAcknowledgement(report);};
  expect(()=>store.transaction(()=>{save();throw new Error('rollback');})).toThrow('rollback');
  expect(exists()).toBe(false);expect(store.spentYen('owner','2026-10-07')).toBe(0);
  expect(store.pendingActionAcknowledgements('owner')).toEqual([]);
  store.transaction(save);expect(exists()).toBe(true);expect(store.spentYen('owner','2026-10-07')).toBe(1);
  store.close();store=new SQLiteAutonomyStore(path);
  expect(store.pendingActionAcknowledgements('owner')).toEqual([report]);
  store.deliveredActionAcknowledgement(report.id);expect(store.pendingActionAcknowledgements('owner')).toEqual([]);
});
it('continues her own work while the owner talks through an independent foreground slot',async()=>{
  const h=fixture();h.showing.ownerActive=true;h.model.plans=[FULL_PLAN];
  expect(await h.loop.tick()).toBe('stepped');
  expect(h.model.kinds()).toEqual(['think']);
  await foregroundRunner(h.actions)('owner',async()=>{
    const active=await h.actions.list('owner');
    expect(active.filter(a=>a.state==='running' && a.kind==='respond')).toHaveLength(1);
    expect(active.filter(a=>a.kind==='ownTime')).toHaveLength(1);
    return 'reply';
  });
  expect(h.showing.told).toHaveLength(0);
});
it('withholds a product after stop and does not call the model again without an explicit resume',async()=>{
  const h=fixture();h.model.plans=[FULL_PLAN];
  const seeds=h.store.pursuits.list('owner',h.clock.at).map(p=>p.id);
  h.model.during=async()=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'owner-stop');
  };
  expect(await h.loop.tick()).toBe('stepped');
  expect(h.store.pursuits.list('owner',h.clock.at).map(p=>p.id)).toEqual(seeds);
  expect(h.store.study.list('owner')).toHaveLength(0);
  expect(await h.loop.tick()).toBe('thread-wait');
  expect(h.model.calls).toHaveLength(1);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');
  expect(await h.actions.resume('owner',stopped.id)).toBeTruthy();
  h.model.during=undefined;
  // The withheld plan is never replayed: explicit resume may close this empty cycle with rest.
  expect(await h.loop.tick()).toBe('cycle-ended');
  expect(h.model.calls).toHaveLength(1);
  expect((await h.actions.list('owner')).find(a=>a.id===stopped.id)?.state).toBe('completed');
});
it('retains unknown execution when a stopped model request loses its acknowledgement',async()=>{
  const h=fixture();
  h.model.during=async()=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'owner-stop');
    throw new Error('connection lost');
  };
  expect(await h.loop.tick()).toBe('stepped');
  const unknown=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(unknown.state).toBe('unknown');
  expect(await h.actions.resume('owner',unknown.id)).toBeFalsy();
  expect(await h.loop.tick()).toBe('thread-wait');
  expect(h.model.calls).toHaveLength(1);
});
it('recovers an acknowledged stopped thought after lease expiry without replaying its withheld plan',async()=>{
  const h=fixture();h.model.plans=[FULL_PLAN];
  const seeds=h.store.pursuits.list('owner',h.clock.at).map(p=>p.id);
  h.model.during=async()=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'late-stop');
    // The provider returns after expiry, before the mind worker's next periodic sweep.
    h.advance(31_000);
  };
  expect(await h.loop.tick()).toBe('stepped');
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped).toMatchObject({state:'cancelled',generation:2,result:'stop_acknowledged'});
  expect(h.store.pursuits.list('owner',h.clock.at).map(p=>p.id)).toEqual(seeds);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);
  h.model.during=undefined;
  expect(await h.loop.tick()).toBe('cycle-ended');
  expect(h.model.calls).toHaveLength(1);
});
it('retains an uncertain provider call and its estimate even without an owner stop',async()=>{
  const h=fixture();h.model.during=()=>{throw new Error('connection lost');};
  expect(await h.loop.tick()).toBe('stepped');
  const unknown=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(unknown).toMatchObject({state:'unknown',result:'model_result_unknown'});
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'held'}]);
  expect(await h.actions.resume('owner',unknown.id)).toBe(false);
  expect(await h.loop.tick()).toBe('thread-wait');
  expect(h.model.calls).toHaveLength(1);
});
it.each(['paused','not-leader'] as const)('durably settles a known unused reservation after %s and lost ACK delivery',async(reason)=>{
  const h=fixture(),reserve=h.actions.reserve,acknowledge=h.actions.acknowledge;
  h.actions.reserve=async(...args)=>{
    const accepted=await reserve(...args);
    if(reason==='paused')h.store.setPaused('owner',true,h.clock.at);else h.loop.release();
    h.actions.acknowledge=async()=>{throw new Error('IPC lost before ACK');};return accepted;
  };
  expect(await h.loop.tick()).toBe(reason);expect(h.model.calls).toHaveLength(0);
  expect(h.store.pendingActionAcknowledgements('owner')).toMatchObject([{actual:0,code:reason==='paused'?'refused':'not_leader'}]);
  h.advance(31_000);h.actionStore.transaction(()=>h.actionStore.sweep(h.clock.at));
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'held'}]);
  h.actions.acknowledge=acknowledge;h.runner.close();
  expect(await h.loop.tick()).toBe(reason==='paused'?'paused':'thread-wait');
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(0);expect(h.model.calls).toHaveLength(0);
  expect(h.actionStore.list('owner').find(a=>a.kind==='ownTime')?.state).toBe('cancelled');
  expect(h.service.overview('owner').budget.spentYen).toBe(0);
});
it.each([false,true])('recovers only the durable acknowledgement after an IPC loss and worker replacement (answer lost: %s)',async(answerLost)=>{
  const directory=mkdtempSync(join(tmpdir(),'shannon-action-ack-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'canonical.sqlite'),h=fixture(path);h.model.plans=[FULL_PLAN];
  const acknowledge=h.actions.acknowledge,finish=h.actions.finish;
  h.model.during=async()=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'ipc-stop');
    h.actions.acknowledge=async report=>{if(answerLost)await acknowledge(report);throw new Error('IPC lost');};
    h.actions.finish=async()=>{throw new Error('IPC lost');};
  };
  expect(await h.loop.tick()).toBe('stepped');
  const spent=h.service.overview('owner').budget.spentYen;
  expect(spent).toBeGreaterThan(0);expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(1);
  h.runner.close();h.advance(Math.max(31_000,h.loopConfig.leaseMilliseconds+1));h.actionStore.transaction(()=>h.actionStore.sweep(h.clock.at));
  h.actions.acknowledge=acknowledge;h.actions.finish=finish;
  // Reopen the canonical database: recovery cannot depend on the old runner's memory.
  const store=new SQLiteAutonomyStore(path),runner=new OwnTimeActionRunner(h.actions);
  const service=new ShannonAutonomyService({store,config:h.config,now:()=>h.clock.at});
  const replacement=new ShannonAutonomyLoop({store,service,config:h.config,loop:h.loopConfig,model:h.model,reader:h.reader,
    showing:h.showing,now:()=>h.clock.at,workerId:'replacement',actionSteps:runner,concurrentActions:true});
  cleanups.push(()=>store.close(),()=>runner.close());
  expect(await replacement.tick()).toBe('thread-wait');
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(store.pendingActionAcknowledgements('owner')).toHaveLength(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(service.overview('owner').budget.spentYen).toBe(spent);
  expect(h.model.calls).toHaveLength(1);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);
});
it.each([null,'AUTONOMY_READ_NOT_PUBLIC'])('acknowledges a stopped read only after its known result or not-sent refusal (%s)',async(failure)=>{
  const h=fixture();h.model.plans=[FULL_PLAN];await h.loop.tick();
  const read=h.reader.read.bind(h.reader);h.reader.failure=failure;
  h.reader.read=async url=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'read-stop');return read(url);
  };
  expect(await h.loop.tick()).toBe('stepped');
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(h.store.loop.wasRead('owner','https://example.org/station')).toBe(false);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);expect(h.reader.reads).toHaveLength(1);
});
it('retains an uncertain read without clearing its execution rights or replaying it',async()=>{
  const h=fixture();h.model.plans=[FULL_PLAN];await h.loop.tick();h.reader.failure='connection lost';
  expect(await h.loop.tick()).toBe('stepped');
  const unknown=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(unknown).toMatchObject({state:'unknown',result:'step_result_unknown'});
  expect(await h.actions.resume('owner',unknown.id)).toBe(false);
  expect(await h.loop.tick()).toBe('thread-wait');expect(h.reader.reads).toHaveLength(1);
});
it('acknowledges a normally returned tool after stop without running the tool again',async()=>{
  const h=fixture(undefined,true);h.model.plans=[{thought:'書斎を見ます。',pursuits:[],steps:[{action:'tool',name:'study.list',input:{}}]}];
  expect(await h.loop.tick()).toBe('stepped');
  const prepare=h.service.tools.prepare.bind(h.service.tools);let runs=0;
  h.service.tools.prepare=(...args)=>{
    const ready=prepare(...args);if('result' in ready)return ready;
    const prepared=ready.prepared;
    return {...ready,prepared:{...prepared,run:async signal=>{
      const result=await prepared.run(signal);runs++;
      const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
      await h.actions.stop('owner',own.id,'tool-stop');return result;
    }}};
  };
  expect(await h.loop.tick()).toBe('stepped');
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(await h.actions.resume('owner',stopped.id)).toBe(true);
  expect(runs).toBe(1);expect(h.model.calls).toHaveLength(1);
});
it('settles a known draft model call after stop while withholding its product',async()=>{
  const h=fixture();h.model.plans=[{thought:'物語を書きます。',pursuits:[],steps:[{action:'draft',idea:'合成の話'}]}];
  await h.loop.tick();const before=h.service.overview('owner').budget.spentYen;
  h.model.during=async()=>{const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;await h.actions.stop('owner',own.id,'draft-stop');};
  expect(await h.loop.tick()).toBe('stepped');
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(h.store.study.list('owner')).toHaveLength(0);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(before);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'},{state:'settled'}]);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);expect(h.model.calls).toHaveLength(2);
});
it.each([['google',GeminiAutonomyTextModel],['openai',OpenAIAutonomyTextModel]] as const)('keeps an HTTP 200 response with a lost body unknown and charges its estimate (%s)',async(_provider,Provider)=>{
  const h=fixture(),provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>new Response(new ReadableStream({
    start(controller){controller.error(new Error('connection lost after headers'));},
  }),{status:200})});
  h.model.generate=async request=>{h.model.calls.push(request);return provider.generate(request);};
  expect(await h.loop.tick()).toBe('stepped');
  const unknown=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(unknown.state).toBe('unknown');expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'held'}]);
  expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(0);
  expect(await h.loop.tick()).toBe('thread-wait');expect(h.model.calls).toHaveLength(1);
});
it.each([['google',GeminiAutonomyTextModel],['openai',OpenAIAutonomyTextModel]] as const)('preserves the pre-Stage-4 lost-body empty reply and zero usage (%s)',async(_provider,Provider)=>{
  const provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>new Response(new ReadableStream({
    start(controller){controller.error(new Error('connection lost after headers'));},
  }),{status:200})});
  await expect(provider.generate({model:'synthetic',system:'s',prompt:'p',maximumOutputTokens:10}))
    .rejects.toMatchObject({code:'AUTONOMY_MODEL_EMPTY',usage:{inputTokens:0,outputTokens:0}});
});
it.each([{name:'google',Provider:GeminiAutonomyTextModel,status:400},{name:'google',Provider:GeminiAutonomyTextModel,status:422},
  {name:'openai',Provider:OpenAIAutonomyTextModel,status:400},{name:'openai',Provider:OpenAIAutonomyTextModel,status:422}])('checks execution rights before a reasoning fallback after a known $name HTTP $status refusal',async({Provider,status})=>{
  const h=fixture();let requests=0;
  const provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>{
    requests++;const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'reasoning-stop');return new Response('{}',{status});
  }});
  h.model.generate=async request=>{h.model.calls.push(request);return provider.generate({...request,reasoning:'low'});};
  expect(await h.loop.tick()).toBe('stepped');expect(requests).toBe(1);
  const stopped=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(h.service.overview('owner').budget.spentYen).toBe(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(0);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);expect(requests).toBe(1);
});
const tokenProviders=[{name:'google',Provider:GeminiAutonomyTextModel,input:'promptTokenCount',output:'candidatesTokenCount'},
  {name:'openai',Provider:OpenAIAutonomyTextModel,input:'input_tokens',output:'output_tokens'}];
const invalidCounts=[{label:'absent',input:undefined,output:undefined},{label:'partial',input:10,output:undefined},
  {label:'wrong type',input:'10',output:2},{label:'negative',input:10,output:-1},{label:'fractional',input:10,output:0.5},
  {label:'unsafe integer',input:10,output:Number.MAX_SAFE_INTEGER+2},{label:'nonfinite',input:10,output:NaN}];
it.each(tokenProviders.flatMap(provider=>invalidCounts.map(counts=>({...provider,...counts,inputKey:provider.input,outputKey:provider.output}))))('retains uncertain $name usage when counts are $label',async({name,Provider,inputKey,outputKey,input,output})=>{
  const h=fixture(),usage={[inputKey]:input,[outputKey]:output},text=JSON.stringify(FULL_PLAN);
  const provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>Response.json(name==='google'
    ?{candidates:[{content:{parts:[{text}]}}],usageMetadata:usage}:{output_text:text,usage})});
  h.model.generate=async request=>{h.model.calls.push(request);return provider.generate(request);};
  expect(await h.loop.tick()).toBe('stepped');
  expect(h.actionStore.list('owner').find(a=>a.kind==='ownTime')?.state).toBe('unknown');
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'held'}]);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
  expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(0);
  expect(await h.loop.tick()).toBe('thread-wait');expect(h.model.calls).toHaveLength(1);
});
it.each(tokenProviders)('accepts explicitly known zero $name counts and absent optional counts',async({name,Provider,input,output})=>{
  const h=fixture(),usage={[input]:0,[output]:0},text=JSON.stringify(FULL_PLAN);
  const provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>Response.json(name==='google'
    ?{candidates:[{content:{parts:[{text}]}}],usageMetadata:usage}:{output_text:text,usage})});
  h.model.generate=async request=>provider.generate(request);
  expect(await h.loop.tick()).toBe('stepped');expect(h.service.overview('owner').budget.spentYen).toBe(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(h.actionStore.list('owner').find(a=>a.kind==='ownTime')?.state).toBe('waiting');
});
it.each([false,true])('settles a known Gemini empty/reasoning-only usage with omitted zero candidates (reasoning: %s)',async(reasoning)=>{
  const h=fixture(),provider=new GeminiAutonomyTextModel({apiKey:'synthetic-only',fetcher:async()=>Response.json({
    candidates:reasoning?[{content:{parts:[{text:'synthetic thinking',thought:true}]},finishReason:'MAX_TOKENS'}]:[],
    usageMetadata:{promptTokenCount:10,...(reasoning?{thoughtsTokenCount:7}:{})},
  })});
  h.model.generate=async request=>provider.generate(request);
  expect(await h.loop.tick()).toBe('stepped');expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(h.actionStore.list('owner').find(a=>a.kind==='ownTime')?.state).toBe('waiting');
});
it.each([false,true])('collects the original ACK after an explicit resume without undoing queued intent (expired: %s)',async(expired)=>{
  const h=fixture(),acknowledge=h.actions.acknowledge;
  h.model.plans=[FULL_PLAN];h.model.during=async()=>{
    const own=(await h.actions.list('owner')).find(a=>a.kind==='ownTime')!;
    await h.actions.stop('owner',own.id,'stop-before-resume');
    h.actions.acknowledge=async()=>{throw new Error('ACK not delivered');};
    if(expired)h.advance(31_000);
  };
  expect(await h.loop.tick()).toBe('stepped');
  const stopped=h.actionStore.list('owner').find(a=>a.kind==='ownTime')!;
  expect(stopped.state).toBe('cancelled');expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(1);
  expect(await h.actions.resume('owner',stopped.id)).toBe(true);
  const queued=h.actionStore.get(stopped.id)!;expect(queued.state).toBe('queued');
  h.actions.acknowledge=acknowledge;
  const pending=h.store.pendingActionAcknowledgements('owner');expect(await h.runner.recover(pending)).toEqual([pending[0]!.id]);
  expect(h.actionStore.get(stopped.id)).toEqual(queued);
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  h.model.during=undefined;expect(await h.loop.tick()).toBe('cycle-ended');
  expect(h.store.pendingActionAcknowledgements('owner').some(report=>report.id===pending[0]!.id)).toBe(false);
  expect(await h.loop.tick()).toBe('idle'); // Deliver the fresh cycle-close ACK without running another model.
  expect(h.store.pendingActionAcknowledgements('owner')).toHaveLength(0);expect(h.model.calls).toHaveLength(1);
});
it.each(tokenProviders.flatMap(provider=>['wrong total','nonfinite total','inconsistent total','invalid cache','excess cache'].map(label=>({...provider,label}))))('retains uncertain $name usage with $label',async({name,Provider,input,output,label})=>{
  const h=fixture(),totalKey=name==='google'?'totalTokenCount':'total_tokens',usage:Record<string,unknown>={[input]:10,[output]:2};
  if(label.endsWith('total'))usage[totalKey]=label==='wrong total'?'12':label==='nonfinite total'?Infinity:0;
  else if(name==='google')usage.cachedContentTokenCount=label==='invalid cache'?-1:11;
  else usage.input_tokens_details={cached_tokens:label==='invalid cache'?-1:11};
  const text=JSON.stringify(FULL_PLAN),provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>Response.json(name==='google'
    ?{candidates:[{content:{parts:[{text}]}}],usageMetadata:usage}:{output_text:text,usage})});
  h.model.generate=async request=>provider.generate(request);
  expect(await h.loop.tick()).toBe('stepped');expect(h.actionStore.list('owner').find(a=>a.kind==='ownTime')?.state).toBe('unknown');
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'held'}]);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
});
it.each(tokenProviders)('preserves known $name reasoning/cache counts and their coherent total',async({name,Provider})=>{
  const h=fixture(),text=JSON.stringify(FULL_PLAN);let knownUsage:unknown;
  const provider=new Provider({apiKey:'synthetic-only',fetcher:async()=>Response.json(name==='google'
    ?{candidates:[{content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,thoughtsTokenCount:7,cachedContentTokenCount:5,totalTokenCount:19}}
    :{output_text:text,usage:{input_tokens:10,output_tokens:9,input_tokens_details:{cached_tokens:5},total_tokens:19}})});
  h.model.generate=async request=>{const answer=await provider.generate(request);knownUsage=answer.usage;return answer;};
  expect(await h.loop.tick()).toBe('stepped');expect(knownUsage).toEqual({inputTokens:10,outputTokens:9,cachedInputTokens:5});
  expect(h.db.prepare('SELECT state FROM mind_action_budget').all()).toEqual([{state:'settled'}]);
  expect(h.service.overview('owner').budget.spentYen).toBeGreaterThan(0);
});
it('serializes recovery conversations locally and grants no outside write during disconnection',async()=>{
  const h=fixture(),run=foregroundRunner({...h.actions,enqueue:async()=>{throw new Error('disconnected');}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,maximum=0;
  const first=run('owner',async()=>{maximum=Math.max(maximum,++active);await gate;active--;});
  const second=run('owner',async()=>{maximum=Math.max(maximum,++active);active--;});
  await new Promise(resolve=>setTimeout(resolve,5));release();await Promise.all([first,second]);expect(maximum).toBe(1);
});
