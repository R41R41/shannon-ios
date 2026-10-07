import { afterEach, expect, it } from 'vitest';
import { OwnTimeActionRunner, foregroundRunner } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { FULL_PLAN, loopHarness } from './autonomyLoopHarness.js';
const cleanups:Array<()=>void>=[];
afterEach(()=>cleanups.splice(0).reverse().forEach(close=>close()));
function fixture(){
  const clock={at:'2026-10-07T01:00:00.000Z'},h=actionHarness(()=>clock.at),runner=new OwnTimeActionRunner(h.actions);
  const loop=loopHarness({clock,actionSteps:runner,concurrentActions:true});
  cleanups.push(h.close,()=>runner.close(),()=>loop.store.close());
  return {...h,...loop,runner};
}
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
it('serializes recovery conversations locally and grants no outside write during disconnection',async()=>{
  const h=fixture(),run=foregroundRunner({...h.actions,enqueue:async()=>{throw new Error('disconnected');}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,maximum=0;
  const first=run('owner',async()=>{maximum=Math.max(maximum,++active);await gate;active--;});
  const second=run('owner',async()=>{maximum=Math.max(maximum,++active);active--;});
  await new Promise(resolve=>setTimeout(resolve,5));release();await Promise.all([first,second]);expect(maximum).toBe(1);
});
