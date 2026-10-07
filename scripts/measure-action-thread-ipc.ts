import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredMind } from '../services/api/src/wiring/mindWiring.js';
import { configuredMindWorker } from '../services/api/src/wiring/mindWorkerWiring.js';
import { configuredRemoteMind } from '../services/api/src/wiring/remoteMindWiring.js';
import { textPerception } from '../services/api/src/mind/perception/perceptionPorts.js';
import { actionThreadsClient } from '../services/api/src/wiring/actionThreadsWiring.js';
import { MindSocketClient } from '../services/api/src/infra/ipc/mindSocket.js';
import { leaseOf } from '../services/api/src/contracts/actionThreadContract.js';
import { OWNER_AUDIENCE } from '../packages/cognition/src/index.js';

// Isolated synthetic run: no production data, pairing, credentials, model, or outside request.
const directory=await mkdtemp('/tmp/shannon-stage4-latency-'),path=join(directory,'db.sqlite');
const on={SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE4:'on'},now=()=>new Date().toISOString();
const owned=()=>{const mind=configuredMind(on,{role:'worker',databasePath:path,now,schedule:work=>work()})!;return {host:mind.host!,close:mind.close};};
const worker=await configuredMindWorker(on,path,owned,now),remote=configuredRemoteMind(on,path),client=new MindSocketClient(join(directory,'mind-runtime','mind.sock'));
const actions=actionThreadsClient(client.call),samples:number[]=[],admission:number[]=[];
try{
  for(let index=0;index<220;index++){
    const started=performance.now();
    remote.host.perceive('owner',textPerception({threadId:`synthetic-${index}`,message:'こんにちは',present:OWNER_AUDIENCE,alone:true,at:now()}));
    await remote.host.sync();
    const perception=performance.now()-started;
    const before=performance.now(),draft=await actions.enqueue({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:`benchmark-${index}`});
    const view=await actions.claim(draft.id);if(!view)throw new Error('ADMISSION_FAILED');
    const accepted=performance.now()-before;
    await actions.finish(leaseOf(view),'completed','benchmark');
    if(index>=20){samples.push(perception);admission.push(accepted);}
  }
  const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {samples:values.length,p50Ms:values[Math.floor(values.length*.50)],p95Ms:values[Math.floor(values.length*.95)],maxMs:values.at(-1)};};
  console.log(JSON.stringify({environment:`${process.platform}; isolated synthetic warm IPC`,workspace:summary(samples),foregroundAdmission:summary(admission)},null,2));
}finally{remote.close();client.close();await worker.close();await rm(directory,{recursive:true,force:true});}
