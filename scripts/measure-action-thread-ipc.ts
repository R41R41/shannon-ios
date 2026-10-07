import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredRemoteMind } from '../services/api/src/wiring/remoteMindWiring.js';
import { textPerception } from '../services/api/src/mind/perception/perceptionPorts.js';
import { actionThreadsClient } from '../services/api/src/wiring/actionThreadsWiring.js';
import { MindSocketClient } from '../services/api/src/infra/ipc/mindSocket.js';
import { leaseOf } from '../services/api/src/contracts/actionThreadContract.js';
import { OWNER_AUDIENCE } from '../packages/cognition/src/index.js';

// Isolated synthetic run: no production data, pairing, credentials, model, or outside request.
const directory=await mkdtemp('/tmp/shannon-stage4-latency-'),path=join(directory,'db.sqlite');
const on={SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE4:'on'},now=()=>new Date().toISOString();
const worker=spawn(process.execPath,['--import','tsx','services/api/src/mindWorker.ts'],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),
  // Deliberately omit inherited credentials, environment files and production paths.
  env:{PATH:dirname(process.execPath),SHANNON_DATABASE_PATH:path,...on},stdio:['ignore','pipe','pipe'],
});
let output='',startupError:Error|undefined;
worker.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-4_096);});
worker.stderr.on('data',chunk=>{output=(output+String(chunk)).slice(-4_096);});
const exited=new Promise<void>(resolve=>{
  worker.once('exit',()=>resolve());worker.once('error',error=>{startupError=error;resolve();});
});
const alive=()=>worker.exitCode===null&&worker.signalCode===null&&!startupError;
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function ready():Promise<void> {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){
    if(startupError)throw startupError;
    if(!alive())throw new Error('Benchmark worker exited: '+output);
    if(output.includes('Shannon mind worker ready'))return;
    await delay(20);
  }
  throw new Error('Benchmark worker ready deadline: '+output);
}
let stopPromise:Promise<void>|undefined;
function stopWorker():Promise<void> {return stopPromise??=stopWorkerOnce();}
async function stopWorkerOnce():Promise<void> {
  if(!alive()){await exited;return;}
  worker.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(resolve,5_000);})]);}
  finally{clearTimeout(timer);}
  if(alive())worker.kill('SIGKILL');
  await exited;
}
const remote=configuredRemoteMind(on,path),client=new MindSocketClient(join(directory,'mind-runtime','mind.sock'));
const actions=actionThreadsClient(client.call),samples:number[]=[],admission:number[]=[];
let interrupted:NodeJS.Signals|undefined;
const interrupt=(signal:NodeJS.Signals)=>{
  interrupted??=signal;process.exitCode=interrupted==='SIGINT'?130:143;
  remote.close();client.close();void stopWorker();
};
const onInterrupt=()=>interrupt('SIGINT'),onTerminate=()=>interrupt('SIGTERM');
process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
try{
  await ready();
  for(let index=0;index<220;index++){
    if(interrupted)break;
    const started=performance.now();
    remote.host.perceive('owner',textPerception({threadId:`synthetic-${index}`,message:'こんにちは',present:OWNER_AUDIENCE,alone:true,at:now()}));
    await remote.host.sync();
    const perception=performance.now()-started;
    const before=performance.now(),view=await actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:`benchmark-${index}`});
    if(!view)throw new Error('ADMISSION_FAILED');
    const accepted=performance.now()-before;
    await actions.finish(leaseOf(view),'completed','benchmark');
    if(index>=20){samples.push(perception);admission.push(accepted);}
  }
  const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {samples:values.length,p50Ms:values[Math.floor(values.length*.50)],p95Ms:values[Math.floor(values.length*.95)],maxMs:values.at(-1)};};
  if(!interrupted)console.log(JSON.stringify({environment:`${process.platform}; isolated synthetic warm IPC; production worker child`,workspace:summary(samples),foregroundAdmission:summary(admission)},null,2));
}catch(error){if(!interrupted)throw error;}
finally{
  remote.close();client.close();await stopWorker();await rm(directory,{recursive:true,force:true});
  process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);
}
