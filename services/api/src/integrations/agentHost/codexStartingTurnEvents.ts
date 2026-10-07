import type { CodexNotification, CodexServerRequest } from './codexAppServerClient.js';
import type { RuntimeTask } from './codexTaskRuntime.js';

type StartingEvent = { kind:'notification'; value:CodexNotification } | { kind:'request'; value:CodexServerRequest };
interface PendingStart {
  owner:string; settled:boolean; lease:string; turnId?:string; events:StartingEvent[]; bytes:number; overflow:boolean;
}
/** Only an in-flight start RPC may correlate early events. A failed response grants no identity. */
export class CodexStartingTurnEvents {
  private readonly pending=new Map<RuntimeTask,PendingStart>();
  constructor(private readonly reject:(request:CodexServerRequest)=>void){}
  ready(runtime:RuntimeTask,owner:string):boolean {const start=this.pending.get(runtime);return !!start&&start.owner===owner&&start.settled;}
  begin(runtime:RuntimeTask,owner:string|undefined):void {
    if(!runtime.actionLease)return;
    if(!owner)throw new Error('ACTION_START_UNOWNED');
    if(this.pending.has(runtime))throw new Error('ACTION_START_IN_FLIGHT');
    this.pending.set(runtime,{owner,settled:false,lease:leaseIdentity(runtime),events:[],bytes:0,overflow:false});
  }
  correlate(runtime:RuntimeTask,turnId:string):void {
    const start=this.pending.get(runtime);if(start){start.turnId=turnId;start.settled=true;}
  }
  failed(runtime:RuntimeTask):void {const start=this.pending.get(runtime);if(start)start.settled=true;}
  capture(runtime:RuntimeTask,event:StartingEvent):boolean {
    const start=this.pending.get(runtime);if(!start)return false;
    const bytes=Buffer.byteLength(JSON.stringify(event),'utf8');
    if(start.events.length>=512 || start.bytes+bytes>2*1024*1024){
      start.overflow=true;if(event.kind==='request')this.reject(event.value);return true;
    }
    start.events.push(structuredClone(event));start.bytes+=bytes;return true;
  }
  take(runtime:RuntimeTask,owner:string):{events:StartingEvent[]; rejected:CodexServerRequest[]; uncertain:boolean}|null {
    const start=this.pending.get(runtime);if(!start)return null;
    if(start.owner!==owner||!start.settled)return null;
    this.pending.delete(runtime);
    const correlated=!!start.turnId&&start.turnId===runtime.turnId&&start.lease===leaseIdentity(runtime);
    const usable=correlated&&!start.overflow;
    const matches=(event:StartingEvent)=>usable&&eventTurnId(event)===start.turnId;
    return {events:start.events.filter(matches),rejected:start.events.filter(event=>event.kind==='request'&&!matches(event))
      .map(event=>(event as {kind:'request';value:CodexServerRequest}).value),uncertain:correlated&&start.overflow};
  }
}
function eventTurnId(event:StartingEvent):string|undefined {
  const params=event.value.params??{},nested=event.kind==='notification'&&['turn/started','turn/completed'].includes(event.value.method)
    ? params.turn as {id?:unknown}|undefined : undefined;
  const id=nested?.id??params.turnId;
  return typeof id==='string'&&(!nested?.id||params.turnId===undefined||params.turnId===id)?id:undefined;
}
function leaseIdentity(runtime:RuntimeTask):string {
  const lease=runtime.actionLease;return JSON.stringify(lease?[lease.id,lease.holder,lease.generation]:null);
}
