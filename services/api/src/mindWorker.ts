import { configuredDatabasePath } from './infra/sqlite/sqliteStore.js';
import { configuredAutonomy } from './mind/inhibition/inhibitionPorts.js';
import { stage4Enabled } from './infra/config/stage4.js';
import { configuredMind } from './wiring/mindWiring.js';
import { configuredMindWorker } from './wiring/mindWorkerWiring.js';
import { startObserverPublisher } from './infra/observer/store/observerStore.js';
import { isSqliteBusy, throttledLog } from './infra/sqlite/sqliteBusy.js';
const now=()=>new Date().toISOString();
// A busy/locked database is transient (another process held the write lock): log it and keep serving. Anything else
// is fatal for this process: log a closed name and exit non-zero so systemd restarts a clean worker.
const busyLog=throttledLog(line=>console.error(line));
const unexpected=(kind:string)=>(error:unknown)=>{
  if(isSqliteBusy(error)){busyLog(`Shannon mind worker ${kind}: database busy, continuing`);return;}
  const code=error instanceof Error ? /^[A-Z0-9_:-]{1,120}$/u.test(error.message) ? error.message : error.name : 'unknown';
  console.error(`Shannon mind worker fatal ${kind}: ${code}`);
  process.exit(1);
};
process.on('uncaughtException',unexpected('exception'));
process.on('unhandledRejection',unexpected('rejection'));
if(!stage4Enabled(process.env))throw new Error('MIND_STAGE4_DISABLED');
const databasePath=configuredDatabasePath();
const observation=startObserverPublisher(databasePath);
const worker=await configuredMindWorker(process.env,databasePath,()=>{
  const mind=configuredMind(process.env,{databasePath,now,ticking:true,role:'worker',timeZone:configuredAutonomy(process.env,{databasePath}).timeZone,log:line=>console.log(line)});
  if(!mind?.host)throw new Error('MIND_WORKSPACE_DISABLED');
  return {host:mind.host,close:mind.close};
},now);
console.log('Shannon mind worker ready');
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;try{await worker.close();}finally{observation?.close();}};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
