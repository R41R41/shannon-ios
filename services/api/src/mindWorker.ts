import { configuredDatabasePath } from './infra/sqlite/sqliteStore.js';
import { configuredAutonomy } from './mind/inhibition/inhibitionPorts.js';
import { stage4Enabled } from './infra/config/stage4.js';
import { configuredMind } from './wiring/mindWiring.js';
import { configuredMindWorker } from './wiring/mindWorkerWiring.js';
import { startObserverPublisher } from './infra/observer/store/observerStore.js';
const now=()=>new Date().toISOString();
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
