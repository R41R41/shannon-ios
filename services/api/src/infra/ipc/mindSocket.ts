import { createConnection, createServer, type Socket, type Server } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { holdMindOwnership } from '../sqlite/mindOwnership.js';

export const MIND_IPC_LIMITS = Object.freeze({ bytes: 262_144, pending: 128, timeoutMs: 1_000 });
export interface MindReply { v: 1; id: string; epoch: string; value?: unknown; error?: string }
export type MindRequest = { v: 1; id: string; method: string; args: unknown };
export type MindCall = <T>(method: string, args: unknown, timeoutMs?: number) => Promise<T>;
const ID = /^[A-Za-z0-9_-]{1,80}$/u;
const METHOD = /^[a-z][A-Za-z.]{0,49}$/u;
function frames(socket: Socket, receive: (value: unknown) => void): void {
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => {
    bytes=Buffer.concat([bytes,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
    let split: number;
    while((split=bytes.indexOf(10))>=0) {
      if(split>MIND_IPC_LIMITS.bytes){socket.destroy();return;}
      const frame=bytes.subarray(0,split);bytes=bytes.subarray(split+1);
      try {receive(JSON.parse(frame.toString('utf8')));} catch {socket.destroy();return;}
    }
    if(bytes.length>MIND_IPC_LIMITS.bytes)socket.destroy();
  });
}
function write(socket: Socket, value: unknown): void {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>MIND_IPC_LIMITS.bytes || socket.writableLength>MIND_IPC_LIMITS.bytes*2)throw new Error('MIND_IPC_SIZE');
  socket.write(bytes);
}
/** Persistent local connection. An interrupted mutation is never resent. Deadlines discard late responses. */
export class MindSocketClient {
  private socket: Socket | null=null;
  private connecting: Promise<Socket>|null=null;
  private closed=false;
  private epoch: string|null=null;
  private readonly pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private faults=0;
  constructor(private readonly path: string,private readonly onReset: ()=>void=()=>{}) {}
  get connected(): boolean{return this.socket!==null && !this.socket.destroyed;}
  get faultCount(): number{return this.faults;}
  readonly call: MindCall=async <T>(method: string,args: unknown,timeoutMs:number=MIND_IPC_LIMITS.timeoutMs):Promise<T>=>{
    if(!METHOD.test(method)||this.closed||this.pending.size>=MIND_IPC_LIMITS.pending)throw new Error('MIND_IPC_UNAVAILABLE');
    const budget=Math.max(1,Math.min(timeoutMs,10_000)), started=Date.now();
    let connectingTimer:ReturnType<typeof setTimeout>|undefined;
    const socket=await Promise.race([this.connect(),new Promise<never>((_,reject)=>{
      connectingTimer=setTimeout(()=>reject(new Error('MIND_IPC_DEADLINE')),budget);
    })]).finally(()=>{clearTimeout(connectingTimer);});
    const remaining=budget-(Date.now()-started);
    if(remaining<=0)throw new Error('MIND_IPC_DEADLINE');
    const id=randomUUID();
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('MIND_IPC_DEADLINE'));},remaining);
      this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
      try {write(socket,{v:1,id,method,args});}catch {clearTimeout(timer);this.pending.delete(id);reject(new Error('MIND_IPC_SIZE'));}
    });
  };
  close():void{this.closed=true;this.socket?.destroy();this.reset();}
  private reset():void{
    this.socket=null;this.epoch=null;this.onReset();
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('MIND_IPC_DISCONNECTED'));}
    this.pending.clear();
  }
  private connect():Promise<Socket>{
    if(this.closed)return Promise.reject(new Error('MIND_IPC_CLOSED'));
    if(this.connected)return Promise.resolve(this.socket!);
    if(this.connecting)return this.connecting;
    this.connecting=new Promise<Socket>((resolve,reject)=>{
      const socket=createConnection(this.path);
      const deadline=setTimeout(()=>socket.destroy(new Error('MIND_IPC_CONNECT')),MIND_IPC_LIMITS.timeoutMs);
      socket.once('connect',()=>{clearTimeout(deadline);this.socket=socket;resolve(socket);});
      socket.on('error',()=>{this.faults+=1;reject(new Error('MIND_IPC_CONNECT'));});
      socket.once('close',()=>{clearTimeout(deadline);if(this.socket===socket || !this.socket)this.reset();});
      frames(socket,value=>{
        const r=value as MindReply;
        if(!r || r.v!==1 || typeof r.id!=='string'||!ID.test(r.id)||typeof r.epoch!=='string'||!ID.test(r.epoch)) {socket.destroy();return;}
        if(this.epoch && this.epoch!==r.epoch){socket.destroy();return;}
        this.epoch=r.epoch;
        const pending=this.pending.get(r.id);if(!pending)return;
        clearTimeout(pending.timer);this.pending.delete(r.id);
        if(r.error)pending.reject(new Error('MIND_IPC_REMOTE'));else pending.resolve(r.value);
      });
    }).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
}
/** One serialized request queue per connection; all scheduling transactions are synchronous. Socket is owner-only. */
export async function serveMindSocket(path: string,handle: (method: string,args: unknown)=>unknown|Promise<unknown>):Promise<{epoch:string;close():Promise<void>}> {
  const parent=dirname(path);
  await mkdir(parent,{recursive:true,mode:0o700});
  const directory=await lstat(parent);
  if(!directory.isDirectory()||directory.isSymbolicLink()||(process.getuid && directory.uid!==process.getuid()))throw new Error('MIND_IPC_DIRECTORY');
  await chmod(parent,0o700);
  // A separate SQLite file holds an OS-backed writer lock for the server lifetime.
  // It survives neither process exit nor a crash; two stale-socket recoveries cannot create two minds.
  const releaseOwnership=await holdMindOwnership(path+'.owner.sqlite');
  try{
  try {
    const old=await lstat(path);
    if(!old.isSocket()||(process.getuid && old.uid!==process.getuid()))throw new Error('MIND_IPC_PATH');
    const active=await new Promise<boolean>(resolve=>{
      const probe=createConnection(path);const timer=setTimeout(()=>{probe.destroy();resolve(true);},200);
      probe.once('connect',()=>{clearTimeout(timer);probe.destroy();resolve(true);});
      probe.once('error',()=>{clearTimeout(timer);resolve(false);});
    });
    if(active)throw new Error('MIND_IPC_ALREADY_RUNNING');
    await unlink(path);
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const epoch=randomUUID(), sockets=new Set<Socket>();
  const server: Server=createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    let queue=Promise.resolve(), outstanding=0;
    frames(socket,value=>{
      const r=value as MindRequest;
      if(!r||r.v!==1||typeof r.id!=='string'||typeof r.method!=='string'||!ID.test(r.id)||!METHOD.test(r.method)||++outstanding>MIND_IPC_LIMITS.pending){socket.destroy();return;}
      queue=queue.then(async()=>{
        if(socket.destroyed)return;
        let reply:MindReply;
        try{reply={v:1,id:r.id,epoch,value:await handle(r.method,r.args)};}catch{reply={v:1,id:r.id,epoch,error:'MIND_REQUEST_REJECTED'};}
        if(!socket.destroyed)try{write(socket,reply);}catch{socket.destroy();}
      }).finally(()=>{outstanding-=1;});
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>resolve());});
  await chmod(path,0o600);
  let closed=false;
  return {epoch,close:async()=>{
    if(closed)return;closed=true;
    try{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    finally{releaseOwnership();}
  }};
  }catch(error){releaseOwnership();throw error;}
}
