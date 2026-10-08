import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ObserverDraft, ObserverJson, ObserverNodeId } from '../../contracts/observerContract.js';

export type ObserverSink = (event: ObserverDraft) => void;
type Run = { scopeKey: string; runId: string; parent: string | null; root: string; activeNode?:ObserverNodeId; activeSpan?:string; latest: Map<ObserverNodeId,string>; audience: 'owner' | 'others' };
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
  try { sink({ ...event,origin:'server',scopeKey:run.scopeKey,runId:run.runId,parentSpanId:run.parent,at:new Date().toISOString() }); } catch { /* observation never changes the turn */ }
}
function projected(project: (()=>unknown) | undefined): ObserverJson | undefined {
  if (!project) return undefined;
  try { const result=observerValue(project());return JSON.stringify(result).length<=12_000?result:'[size limit]'; } catch { return '[projection unavailable]'; }
}
export function currentObserverRunId(): string | null { return context.getStore()?.runId ?? null; }
export async function withObserverRun<T>(options:{scopeKey:string;surface:string;audience?:'owner'|'others';runId?:string;parentRunId?:string},work:()=>Promise<T>):Promise<T> {
  if (!sink) return work();
  const inherited=context.getStore();
  if(inherited&&inherited.scopeKey===options.scopeKey&&(!options.runId||options.runId===inherited.runId))return options.audience==='others'?context.run({...inherited,audience:'others'},work):work();
  const run:Run={scopeKey:options.scopeKey,runId:options.runId??randomUUID(),parent:null,root:randomUUID(),latest:new Map(),audience:inherited?.audience==='others'?'others':options.audience??'owner'};
  return context.run(run,async()=>{
    const started=performance.now();
    emit(run,{spanId:run.root,node:'turn',kind:'run.started',input:projected(()=>({surface:options.surface,parentRunId:options.parentRunId??null}))});
    try {const value=await context.run({...run,parent:run.root},work);emit(run,{spanId:run.root,node:'turn',kind:'run.completed',elapsedMs:performance.now()-started,output:{status:'completed'}});return value;}
    catch(error){emit(run,{spanId:run.root,node:'turn',kind:'span.failed',elapsedMs:performance.now()-started,output:{status:'failed'}});throw error;}
  });
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
export function observeSync<T>(node:ObserverNodeId,input:unknown,work:()=>T,project?:(value:T)=>unknown,meta?:{model?:string}):T {
  const parent=context.getStore();if(!sink||!parent||parent.audience!=='owner')return work();
  const id=randomUUID(),started=performance.now();parent.latest.set(node,id);
  emit(parent,{spanId:id,node,kind:'span.started',input:projected(()=>input),...(meta?.model?{model:meta.model}:{})});
  return context.run({...parent,parent:id,activeNode:node,activeSpan:id,latest:new Map(parent.latest)},()=>{
    try{const value=work();emit(parent,{spanId:id,node,kind:'span.completed',elapsedMs:performance.now()-started,output:projected(project?()=>project(value):undefined),...(meta?.model?{model:meta.model}:{})});return value;}
    catch(error){emit(parent,{spanId:id,node,kind:'span.failed',elapsedMs:performance.now()-started,output:{status:'failed',errorKind:error instanceof Error?error.name:'UnknownError'}});throw error;}
  });
}
export function observerHandoff(fromNode:ObserverNodeId,toNode:ObserverNodeId,payload?:unknown):void {
  const run=context.getStore();if(!sink||!run||run.audience!=='owner')return;
  emit(run,{spanId:randomUUID(),node:toNode,kind:'handoff',fromNode,toNode,sourceSpanId:run.activeNode===fromNode?run.activeSpan??null:run.latest.get(fromNode)??null,output:projected(payload===undefined?undefined:()=>payload)});
}
