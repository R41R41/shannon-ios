import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ObserverDraft, ObserverJson, ObserverNodeId, ObserverTaskLink } from '../../contracts/observerContract.js';
import { beginTurnSteps, flushTurnSteps, markModelStart, timedStep, turnStepsSnapshot, type TurnStep } from './turnSteps.js';
import { namedWork } from './eventLoopWatch.js';

export type ObserverSink = (event: ObserverDraft) => void;
type Run = ObserverTaskLink & { scopeKey: string; runId: string; parent: string | null; root: string; activeNode?:ObserverNodeId; activeSpan?:string; latest: Map<ObserverNodeId,string>; audience: 'owner' | 'others' };
const context = new AsyncLocalStorage<Run>();
let sink: ObserverSink | null = null;
/** A process installs one bounded, non-awaiting publisher. Useful in deterministic fixtures too. */
export function installObserverSink(next: ObserverSink): () => void {
  const previous = sink; sink = next;
  return () => { if (sink === next) sink = previous; };
}
const secretKey = /(?:authorization|password|secret|api.?key|credential|system.?prompt|profile.?prompt|instructions|thinking|signature|base64|^audio$|^image$|memory.?text|knowledge.?text|^(?:access|refresh|bearer)?token$)/i;
/** Projections are explicit at the call site; this is a final size/credential guard, not permission to serialize a prompt. */
export function observerValue(value: unknown, depth = 0): ObserverJson {
  if (depth > 5) return '[depth limit]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0,2000).replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[^\s]+)\b/gi,'[redacted]');
  if (Array.isArray(value)) return value.slice(0,64).map(item => observerValue(item,depth+1));
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    const result: { [key:string]:ObserverJson } = {};
    for (const [key,item] of Object.entries(value).slice(0,32)) {
      result[key.slice(0,80)] = secretKey.test(key) ? '[redacted]' : observerValue(item,depth+1);
    }
    return result;
  }
  return '[not projected]';
}
function emit(run: Run, event: Omit<ObserverDraft,'scopeKey'|'runId'|'parentSpanId'|'at'>): void {
  if (!sink || run.audience !== 'owner') return;
  try { sink({ ...taskLink(run), ...event,origin:'server',scopeKey:run.scopeKey,runId:run.runId,parentSpanId:run.parent,at:new Date().toISOString() }); } catch { /* observation never changes the turn */ }
}
function projected(project: (()=>unknown) | undefined): ObserverJson | undefined {
  if (!project) return undefined;
  try { const result=observerValue(project());return JSON.stringify(result).length<=12_000?result:'[size limit]'; } catch { return '[projection unavailable]'; }
}
/** Only opaque identifiers cross the task linkage boundary, never titles, goals or inbox text. */
function taskLink(value: ObserverTaskLink): ObserverTaskLink {
  const result: ObserverTaskLink = {};
  for (const key of ['taskId', 'parentTaskId', 'stepId', 'actionId'] as const) {
    const id = value[key];
    if (key === 'parentTaskId' && id === null) result.parentTaskId = null;
    else if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(id) && observerValue(id) === id) result[key] = id;
  }
  return result;
}
/** A branch changes its linkage without mutating siblings or inventing a cross-run parent span. */
export function withObserverTask<T>(link: ObserverTaskLink, work: () => T): T {
  const parent = context.getStore();
  if (!sink || !parent) return work();
  const { taskId: _task, parentTaskId: _parent, stepId: _step, actionId: _action, ...run } = parent;
  const sameTask = link.taskId && link.taskId === parent.taskId;
  const inherited = sameTask ? taskLink(parent) : {};
  if (link.stepId && link.stepId !== parent.stepId) delete inherited.actionId;
  // Every task branch owns its source map. A different known task/step has no
  // causal right to the caller's latest outcome (for example an older outbox row).
  // Initial binding may retain the real untagged foreground caller's ancestry.
  const sameContext = !parent.taskId || sameTask && (!link.stepId || link.stepId === parent.stepId);
  const provenance = sameContext ? { latest: new Map(parent.latest) }
    : { latest: new Map<ObserverNodeId, string>(), parent: parent.root, activeNode: undefined, activeSpan: undefined };
  return context.run({ ...run, ...inherited, ...taskLink(link), ...provenance }, work);
}
/** Outbox flushes can process other scopes/tasks. Suppress foreign observation without suppressing the writer. */
export function withScopedObserverTask<T>(scopeKey: string, link: ObserverTaskLink, work: () => T): T {
  const parent = context.getStore();
  return parent && parent.scopeKey !== scopeKey ? context.run({ ...parent, audience: 'others' }, work) : withObserverTask(link, work);
}
type RunOptions = ObserverTaskLink & { scopeKey: string; surface: string; audience?: 'owner' | 'others'; runId?: string; parentRunId?: string };
/** Synchronous durable task operations retain their original synchronous return/throw contract. */
export function withObserverRunSync<T>(options: RunOptions, work: () => T): T {
  if (!sink) return work();
  const inherited = context.getStore();
  if (inherited && inherited.scopeKey === options.scopeKey && (!options.runId || options.runId === inherited.runId)) {
    return options.audience === 'others' ? context.run({ ...inherited, audience: 'others' }, work) : work();
  }
  const run: Run = { scopeKey: options.scopeKey, runId: options.runId ?? randomUUID(), parent: null, root: randomUUID(), latest: new Map(),
    audience: inherited?.audience === 'others' ? 'others' : options.audience ?? 'owner', ...taskLink(options) };
  return context.run(run, () => {
    const started = performance.now();
    emit(run, { spanId: run.root, node: 'turn', kind: 'run.started', input: projected(() => ({ surface: options.surface })) });
    try { const value = context.run({ ...run, parent: run.root }, work); emit(run, { spanId: run.root, node: 'turn', kind: 'run.completed', elapsedMs: performance.now() - started, output: { status: 'completed' } }); return value; }
    catch (error) { emit(run, { spanId: run.root, node: 'turn', kind: 'span.failed', elapsedMs: performance.now() - started, output: { status: 'failed' } }); throw error; }
  });
}
export function currentObserverRunId(): string | null { return context.getStore()?.runId ?? null; }
/** A synchronous step of the current turn, timed for its steps line (`turnSteps.ts`); outside an observed turn it only runs. */
export function observedStep<T>(step: TurnStep, work: () => T): T { return timedStep(sink ? currentObserverRunId() : null, step, work); }
/** The turn's measured steps (closed names, numbers only) ride on its terminal event as well as the log line. */
function terminalSteps(runId: string): { [key: string]: ObserverJson } {
  const value = turnStepsSnapshot(runId);
  return value ? { steps: value.steps, modelStartMs: value.modelStartMs } : {};
}
export async function withObserverRun<T>(options:RunOptions,work:()=>Promise<T>):Promise<T> {
  if (!sink) return work();
  const inherited=context.getStore();
  if(inherited&&inherited.scopeKey===options.scopeKey&&(!options.runId||options.runId===inherited.runId))return options.audience==='others'?context.run({...inherited,audience:'others'},work):work();
  const run:Run={...taskLink(options),scopeKey:options.scopeKey,runId:options.runId??randomUUID(),parent:null,root:randomUUID(),latest:new Map(),audience:inherited?.audience==='others'?'others':options.audience??'owner'};
  return context.run(run,async()=>{
    const started=performance.now();
    beginTurnSteps(run.runId);
    emit(run,{spanId:run.root,node:'turn',kind:'run.started',input:projected(()=>({surface:options.surface,parentRunId:options.parentRunId??null}))});
    const end=(kind:'run.completed'|'span.failed',status:string)=>
      emit(run,{spanId:run.root,node:'turn',kind,elapsedMs:performance.now()-started,output:{status,...terminalSteps(run.runId)}});
    try {const value=await context.run({...run,parent:run.root},work);end('run.completed','completed');return value;}
    catch(error){end('span.failed','failed');throw error;}
    finally{flushTurnSteps(run.runId,options.surface,performance.now()-started);}
  });
}
/** Detached work keeps the original promise and microtask boundary; terminal callbacks run in its existing chain. */
export function observerSpan(node: ObserverNodeId, input: unknown) {
  const parent = context.getStore();
  if (!sink || !parent || parent.audience !== 'owner') return { run: <T>(work: () => T): T => work(), complete: (_value?: unknown) => {}, failed: (_error: unknown) => {} };
  const id = randomUUID(), started = performance.now();
  let ended = false;
  parent.latest.set(node, id);
  emit(parent, { spanId: id, node, kind: 'span.started', input: projected(() => input) });
  const child = { ...parent, parent: id, activeNode: node, activeSpan: id, latest: new Map(parent.latest) };
  const fail = (error: unknown) => { if (ended) return; ended = true; emit(parent, { spanId: id, node, kind: 'span.failed', elapsedMs: performance.now() - started, output: { status: 'failed', errorKind: error instanceof Error ? error.name : 'UnknownError' } }); };
  return {
    run: <T>(work: () => T): T => { try { return context.run(child, work); } catch (error) { fail(error); throw error; } },
    complete(value?: unknown) { if (ended) return; ended = true; emit(parent, { spanId: id, node, kind: 'span.completed', elapsedMs: performance.now() - started, output: projected(() => value) }); },
    failed: fail,
  };
}
export async function observeAsync<T>(node:ObserverNodeId,input:unknown,work:()=>Promise<T>,project?:(value:T)=>unknown,meta?:{model?:string}):Promise<T> {
  const parent=context.getStore(); if(!sink||!parent||parent.audience!=='owner')return work();
  const id=randomUUID(),started=performance.now();parent.latest.set(node,id);
  emit(parent,{spanId:id,node,kind:'span.started',input:projected(()=>input),...(meta?.model?{model:meta.model}:{})});
  return context.run({...parent,parent:id,activeNode:node,activeSpan:id,latest:new Map(parent.latest)},async()=>{
    try{const value=await work();emit(parent,{spanId:id,node,kind:'span.completed',elapsedMs:performance.now()-started,output:projected(project?()=>project(value):undefined),...(meta?.model?{model:meta.model}:{})});return value;}
    catch(error){emit(parent,{spanId:id,node,kind:'span.failed',elapsedMs:performance.now()-started,output:{status:'failed',errorKind:error instanceof Error?error.name:'UnknownError'}});throw error;}
  });
}
/** The synchronous work of a node, kept by name when it lasts (`namedWork`: a block of the loop is told what it overlapped). */
export function observeSync<T>(node:ObserverNodeId,input:unknown,work:()=>T,project?:(value:T)=>unknown,meta?:{model?:string}):T {
  return namedWork(`observe_${node}`,()=>observeSyncInner(node,input,work,project,meta));
}
function observeSyncInner<T>(node:ObserverNodeId,input:unknown,work:()=>T,project?:(value:T)=>unknown,meta?:{model?:string}):T {
  const parent=context.getStore();if(!sink||!parent||parent.audience!=='owner')return work();
  const id=randomUUID(),started=performance.now();parent.latest.set(node,id);
  emit(parent,{spanId:id,node,kind:'span.started',input:projected(()=>input),...(meta?.model?{model:meta.model}:{})});
  return context.run({...parent,parent:id,activeNode:node,activeSpan:id,latest:new Map(parent.latest)},()=>{
    try{const value=work();emit(parent,{spanId:id,node,kind:'span.completed',elapsedMs:performance.now()-started,output:projected(project?()=>project(value):undefined),...(meta?.model?{model:meta.model}:{})});return value;}
    catch(error){emit(parent,{spanId:id,node,kind:'span.failed',elapsedMs:performance.now()-started,output:{status:'failed',errorKind:error instanceof Error?error.name:'UnknownError'}});throw error;}
  });
}
export function observerHandoff(fromNode:ObserverNodeId,toNode:ObserverNodeId,payload?:unknown):void {
  const run=context.getStore();
  if (run && toNode === 'native') markModelStart(run.runId); // The steps line's model start, also on a turn others share (numbers only).
  if(!sink||!run||run.audience!=='owner')return;
  emit(run,{spanId:randomUUID(),node:toNode,kind:'handoff',fromNode,toNode,sourceSpanId:run.activeNode===fromNode?run.activeSpan??null:run.latest.get(fromNode)??null,output:projected(payload===undefined?undefined:()=>payload)});
}
/** The bounded stages of a turn (`turnTiming.ts`), here beside the spans for the routes that already import this module. */
export { textStage } from './turnTiming.js';
