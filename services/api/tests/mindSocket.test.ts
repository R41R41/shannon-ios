import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindSocketClient, serveMindSocket } from '../src/infra/ipc/mindSocket.js';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
it('uses a private socket, refuses a second owner, and drops late replies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shannon-mind-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'mind.sock');
  const server=await serveMindSocket(path,async(method,args)=>{
    if(method==='slow'){await new Promise(resolve=>setTimeout(resolve,30));return 'late';}return args;
  });cleanups.push(()=>server.close());
  const client=new MindSocketClient(path);cleanups.push(async()=>client.close());
  expect((await stat(path)).mode&0o777).toBe(0o600);
  expect(await client.call('echo',{closed:'ok'})).toEqual({closed:'ok'});
  await expect(serveMindSocket(path,()=>null)).rejects.toThrow('MIND_IPC_ALREADY_RUNNING');
  await expect(client.call('slow',{},5)).rejects.toThrow('MIND_IPC_DEADLINE');
  expect(await client.call('echo',{next:true})).toEqual({next:true});
});
it('rejects interrupted mutations and reconnects without sending them twice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shannon-mind-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'mind.sock');let calls=0;
  let server=await serveMindSocket(path,async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,100));return true;});
  cleanups.push(()=>server.close());const client=new MindSocketClient(path);cleanups.push(async()=>client.close());
  const result=client.call('mutate',{}).catch(error=>error);
  await new Promise(resolve=>setTimeout(resolve,20));await server.close();
  expect((await result as Error).message).toBe('MIND_IPC_DISCONNECTED');
  server=await serveMindSocket(path,()=>true);expect(await client.call('echo',{})).toBe(true);expect(calls).toBe(1);
});
