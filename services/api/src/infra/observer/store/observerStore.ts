import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObserverBatch, ObserverDraft, ObserverEvent } from '../../../contracts/observerContract.js';
import { installObserverSink } from '../observerContext.js';

/** The client's spans (pcm, STT handoff) are capped apart from the server's. */
const laneOf=(event:{origin?:string})=>event.origin==='client'?'client':'server';
/** Separate, expendable, bounded sidecar. A failure must never block a conversation or change an action. */
export class SQLiteObserverStore {
  readonly instanceId = randomUUID();
  private readonly db: DatabaseSync;
  private queue: ObserverDraft[]=[];
  private scheduled: NodeJS.Immediate | null=null;
  private disposed=false;
  /** Only uncommitted loss belongs to this process; the committed counter is shared by every connection. */
  private pendingLost=0;
  private knownLost=0;
  private maintenance:NodeJS.Timeout;
  /**
   * `maxRows` bounds the server's spans and `clientRows`, separately, the client's (`origin: 'client'`: its pcm and STT handoff
   * spans arrive about twice a second through a whole call and used to evict a turn's server spans within minutes, 2026-10-12).
   * The table holds at most `maxRows + clientRows` rows.
   */
  constructor(path:string,private readonly now:()=>number=Date.now,private readonly maxRows=2000,private readonly retentionMs=15*60_000,private readonly clientRows=800) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS observer_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, recorded_ms INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS observer_scope_seq ON observer_events(scope_key,sequence); CREATE TABLE IF NOT EXISTS observer_loss(id INTEGER PRIMARY KEY CHECK(id=1),dropped INTEGER NOT NULL CHECK(dropped>=0 AND dropped<=9007199254740991)); INSERT OR IGNORE INTO observer_loss(id,dropped) VALUES(1,0);');
    // Additive and idempotent: rows written before the column existed count as the server's. Another process may add it first.
    if(!(this.db.prepare('PRAGMA table_info(observer_events)').all() as {name:string}[]).some(column=>column.name==='lane')){
      try{this.db.exec("ALTER TABLE observer_events ADD COLUMN lane TEXT NOT NULL DEFAULT 'server'");}catch{/* added concurrently */}
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS observer_lane_seq ON observer_events(lane,sequence)');
    this.prune();
    this.maintenance=setInterval(()=>this.prune(),60_000).unref();
    if(path!==':memory:')for(const file of [path,`${path}-wal`,`${path}-shm`])try{chmodSync(file,0o600);}catch{/* absent WAL */}
  }
  noteDropped(count:number):void {
    if(this.disposed||!Number.isSafeInteger(count)||count<=0)return;
    this.pendingLost=Math.min(Number.MAX_SAFE_INTEGER,this.pendingLost+count);
    this.schedule();
  }
  private schedule():void {if(!this.scheduled)this.scheduled=setImmediate(()=>{this.scheduled=null;this.flush();}).unref();}
  private dropped():number {
    try{this.knownLost=(this.db.prepare('SELECT dropped FROM observer_loss WHERE id=1').get() as {dropped:number}).dropped;}catch{/* retain the last known shared count */}
    return Math.min(Number.MAX_SAFE_INTEGER,this.knownLost+this.pendingLost);
  }
  prune():void {if(this.disposed)return;if(this.pendingLost)this.flush();try{this.trim();this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');}catch{/* sidecar contention never affects a task */}}
  /** Expired rows, then each lane beyond its own cap (oldest first). Runs inside the caller's transaction or alone. */
  private trim():void {
    this.db.prepare('DELETE FROM observer_events WHERE recorded_ms < ?').run(this.now()-this.retentionMs);
    for(const [lane,cap] of [['server',this.maxRows],['client',this.clientRows]] as const)
      this.db.prepare(`DELETE FROM observer_events WHERE lane=? AND sequence <= (SELECT COALESCE(MAX(sequence),0)
        FROM (SELECT sequence FROM observer_events WHERE lane=? ORDER BY sequence DESC LIMIT -1 OFFSET ?))`).run(lane,lane,cap);
  }
  publish=(event:ObserverDraft):void=>{
    if(this.disposed)return;
    if(this.queue.length>=512){this.noteDropped(1);return;}
    this.queue.push(event);
    this.schedule();
  };
  /** Called by scheduled publisher, never awaited by the response path. Failed writes retry only their loss counter. */
  flush():void {
    if(this.disposed||(!this.queue.length&&!this.pendingLost))return;
    const batch=this.queue.splice(0,64),pending=this.pendingLost;
    let rejected=0;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      if(batch.length){
        const insert=this.db.prepare('INSERT INTO observer_events(scope_key,recorded_ms,payload,lane) VALUES(?,?,?,?)');
        for(const draft of batch){const {scopeKey,...event}=draft;const payload=JSON.stringify(event);if(payload.length<=16_000)insert.run(scopeKey,this.now(),payload,laneOf(event));else rejected++;}
        this.trim();
      }
      const delta=Math.min(Number.MAX_SAFE_INTEGER,pending+rejected);
      if(delta)this.db.prepare('UPDATE observer_loss SET dropped=MIN(9007199254740991,dropped+?) WHERE id=1').run(delta);
      this.db.exec('COMMIT');
      this.pendingLost=Math.max(0,this.pendingLost-pending);
      this.knownLost=Math.min(Number.MAX_SAFE_INTEGER,this.knownLost+delta);
    }catch{
      try{this.db.exec('ROLLBACK');}catch{/* no transaction */}
      // Nothing in a rolled-back batch persisted; count each event once, including rejected oversized payloads.
      this.pendingLost=Math.min(Number.MAX_SAFE_INTEGER,this.pendingLost+batch.length);
    }
    // Do not spin on a locked/broken sidecar. Loss-only failures wait for the next publication or maintenance tick.
    if(this.queue.length)this.schedule();
  }
  read(scopeKey:string,after:number,limit:number):ObserverBatch {
    const bounds=this.db.prepare('SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM observer_events WHERE scope_key=? AND recorded_ms>=?').get(scopeKey,this.now()-this.retentionMs) as {first:number|null;last:number|null};
    const rows=this.db.prepare('SELECT sequence,payload FROM observer_events WHERE scope_key=? AND sequence>? AND recorded_ms>=? ORDER BY sequence LIMIT ?').all(scopeKey,after,this.now()-this.retentionMs,Math.min(200,Math.max(1,limit))) as {sequence:number;payload:string}[];
    const events:ObserverEvent[]=rows.map(row=>({...JSON.parse(row.payload),sequence:row.sequence}));
    return {schemaVersion:1,instanceId:this.instanceId,events,cursor:events.at(-1)?.sequence??Math.max(after,bounds.last??0),oldestCursor:bounds.first??0,gap:after>0&&(bounds.first===null||after<bounds.first-1),availability:'ready',generatedAt:new Date(this.now()).toISOString(),dropped:this.dropped()};
  }
  held():ObserverBatch{return{schemaVersion:1,instanceId:this.instanceId,events:[],cursor:0,oldestCursor:0,gap:false,availability:'held',generatedAt:new Date(this.now()).toISOString(),dropped:this.dropped()};}
  close():void {if(this.disposed)return;clearInterval(this.maintenance);if(this.scheduled)clearImmediate(this.scheduled);while(this.queue.length)this.flush();if(this.pendingLost)this.flush();if(this.scheduled)clearImmediate(this.scheduled);this.disposed=true;this.db.close();}
}
export function startObserverPublisher(path:string):{store:SQLiteObserverStore;close:()=>void}|null {
  try{const store=new SQLiteObserverStore(path===':memory:'?path:`${path}.observer`);const uninstall=installObserverSink(store.publish);return{store,close:()=>{uninstall();store.close();}};}catch{return null;}
}
