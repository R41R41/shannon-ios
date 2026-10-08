import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../auth/deviceAuth.js';
import { readJson, sendJson } from '../http/serverHttp.js';
import type { ObserverDraft, ObserverKind, ObserverNodeId } from '../../contracts/observerContract.js';
import type { SQLiteObserverStore } from './store/observerStore.js';
import { observerValue } from './observerContext.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nodes=new Set(['pcm','stt','join','play']);
const endpoints=new Set([...nodes,'perception','tts','sentences']);
const kinds=new Set(['span.started','span.completed','span.failed','span.cancelled','handoff']);
/** Authenticated native telemetry is labelled client-reported; it cannot impersonate a server model/tool span. */
export async function ingestObserverClientEvents(request:IncomingMessage,response:ServerResponse,principal:ShannonDevicePrincipal,store:SQLiteObserverStore,alone:()=>boolean):Promise<void>{
  let body:unknown;
  try{body=await readJson(request,32*1024);}catch(error){sendJson(response,error instanceof Error&&error.message==='request body too large'?413:400,{error:'INVALID_OBSERVER_EVENTS'});return;}
  if(!body||typeof body!=='object'||!Array.isArray((body as {events?:unknown}).events)){sendJson(response,400,{error:'INVALID_OBSERVER_EVENTS'});return;}
  const events=(body as {events:unknown[]}).events;
  const supplied=(body as {droppedEvents?:unknown}).droppedEvents;
  const dropped=supplied===undefined?0:supplied;
  if(typeof dropped!=='number'||!Number.isSafeInteger(dropped)||dropped<0||dropped>4096){sendJson(response,400,{error:'INVALID_OBSERVER_LOSS'});return;}
  if((events.length===0&&dropped===0)||events.length>16){sendJson(response,400,{error:'INVALID_OBSERVER_EVENTS'});return;}
  const drafts:ObserverDraft[]=[];
  for(const raw of events){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){sendJson(response,400,{error:'INVALID_OBSERVER_EVENT'});return;}
    const event=raw as Record<string,unknown>;
    const at=typeof event.at==='string'?Date.parse(event.at):NaN;
    if(typeof event.runId!=='string'||!uuid.test(event.runId)||typeof event.spanId!=='string'||!uuid.test(event.spanId)||typeof event.node!=='string'||!nodes.has(event.node)||typeof event.kind!=='string'||!kinds.has(event.kind)||!Number.isFinite(at)||Math.abs(Date.now()-at)>120_000||(event.parentSpanId!=null&&(typeof event.parentSpanId!=='string'||!uuid.test(event.parentSpanId)))){sendJson(response,400,{error:'INVALID_OBSERVER_EVENT'});return;}
    const handoff=event.kind==='handoff';
    if(handoff&&(typeof event.fromNode!=='string'||!endpoints.has(event.fromNode)||typeof event.toNode!=='string'||!endpoints.has(event.toNode)||(event.sourceSpanId!=null&&(typeof event.sourceSpanId!=='string'||!uuid.test(event.sourceSpanId))))){sendJson(response,400,{error:'INVALID_OBSERVER_HANDOFF'});return;}
    drafts.push({scopeKey:principal.scopeKey,origin:'client',runId:event.runId,spanId:event.spanId,parentSpanId:typeof event.parentSpanId==='string'?event.parentSpanId:null,node:event.node as ObserverNodeId,kind:event.kind as ObserverKind,at:new Date(at).toISOString(),...(event.input!==undefined?{input:observerValue(event.input)}:{}),...(event.output!==undefined?{output:observerValue(event.output)}:{}),...(typeof event.elapsedMs==='number'&&Number.isFinite(event.elapsedMs)&&event.elapsedMs>=0?{elapsedMs:Math.min(event.elapsedMs,120_000)}:{}),...(handoff?{fromNode:event.fromNode as ObserverNodeId,toNode:event.toNode as ObserverNodeId,sourceSpanId:typeof event.sourceSpanId==='string'?event.sourceSpanId:null}:{})});
  }
  if(!alone()){sendJson(response,200,store.held());return;}
  store.noteDropped(dropped);
  for(const draft of drafts)store.publish(draft);
  sendJson(response,202,{schemaVersion:1,accepted:drafts.length});
}
