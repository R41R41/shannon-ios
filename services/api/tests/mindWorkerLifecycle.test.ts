import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MindSocketClient } from '../src/infra/ipc/mindSocket.js';
import { actionThreadsClient } from '../src/wiring/actionThreadsWiring.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const delay=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

function worker(databasePath:string) {
  const process=spawn(globalThis.process.execPath,['--import','tsx','services/api/src/mindWorker.ts'],{
    cwd:globalThis.process.cwd(),
    // Deliberately omit inherited credentials, private environment files and production paths.
    env:{PATH:dirname(globalThis.process.execPath),SHANNON_DATABASE_PATH:databasePath,SHANNON_ADR8_STAGE3:'on',SHANNON_ADR8_STAGE4:'on'},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  process.stdout!.on('data',chunk=>{output=(output+String(chunk)).slice(-4096);});
  process.stderr!.on('data',chunk=>{output=(output+String(chunk)).slice(-4096);});
  const exited=new Promise<void>((resolve,reject)=>{process.once('error',reject);process.once('exit',()=>resolve());});
  cleanups.push(async()=>{if(process.exitCode===null && process.signalCode===null)process.kill('SIGKILL');await exited;});
  return {process,exited,output:()=>output};
}
async function ready(child:ReturnType<typeof worker>) {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){
    if(child.output().includes('Shannon mind worker ready'))return;
    if(child.process.exitCode!==null || child.process.signalCode!==null)throw new Error(child.output());
    await delay(20);
  }
  throw new Error('Worker did not become ready: '+child.output());
}
async function terminate(child:ReturnType<typeof worker>,signal:NodeJS.Signals) {
  child.process.kill(signal);await child.exited;
}

it('fences duplicate processes and recovers after SIGKILL without replaying uncertain work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shannon-worker-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const databasePath=join(directory,'db.sqlite'),socketPath=join(directory,'mind-runtime','mind.sock');
  const first=worker(databasePath);await ready(first);
  const duplicate=worker(databasePath);await duplicate.exited;
  expect(duplicate.process.exitCode).not.toBe(0);
  expect(duplicate.output()).toContain('MIND_IPC_ALREADY_RUNNING');
  expect((await stat(socketPath)).mode&0o777).toBe(0o600);

  let resets=0;
  const client=new MindSocketClient(socketPath,()=>{resets++;});cleanups.push(()=>client.close());
  const actions=actionThreadsClient(client.call,'original-runner');
  const resource=actionResource('synthetic-body','body');
  const draft=await actions.enqueue({scopeKey:'owner',kind:'minecraft',origin:'owner_request',sourceId:'single-attempt',resources:[resource]});
  const running=await actions.claim(draft.id);expect(running).not.toBeNull();
  const lease=leaseOf(running!);expect(await actions.dispatch(lease)).toBe(true);
  await terminate(first,'SIGKILL');

  // Advance only the isolated journal deadline rather than sleeping for 30 seconds.
  const db=new DatabaseSync(databasePath);
  db.prepare('UPDATE mind_actions SET lease_until=? WHERE id=?').run(new Date(Date.now()-1_000).toISOString(),draft.id);
  db.close();
  const recovered=worker(databasePath);await ready(recovered);
  const deadline=Date.now()+5_000;
  let result;
  do {await delay(30);result=(await actions.list('owner')).find(item=>item.id===draft.id);}while(result?.state!=='unknown' && Date.now()<deadline);
  expect(resets).toBeGreaterThan(0);
  expect(result?.state).toBe('unknown');
  expect(result?.generation).toBe(lease.generation+1);
  expect(await actions.renew(lease)).toBeNull();
  expect(await actions.resume('owner',draft.id)).toBe(false);
  const next=await actions.enqueue({scopeKey:'owner',kind:'minecraft',origin:'owner_request',sourceId:'next-attempt',resources:[resource]});
  expect(await actions.claim(next.id)).toBeNull();
  // Only the original canonical acknowledgement releases the retained physical resource.
  expect(await actions.reconcile({...lease,holder:'other-runner'},'cancelled','body_result')).toBe(false);
  expect(await actions.reconcile(lease,'cancelled','body_result')).toBe(true);
  expect(await actions.claim(next.id)).not.toBeNull();
  await terminate(recovered,'SIGTERM');
  expect(recovered.process.exitCode).toBe(0);
},30_000);
