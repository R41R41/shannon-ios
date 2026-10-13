import { createActionThreadRoute } from '../infra/http/actionThreadRoutes.js';
import { externalActionWiring } from './externalActionWiring.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { AgentTaskStore } from '../mind/action/agentTasks/agentTasksPorts.js';
export function configuredActionRoutes(actions:ActionThreads|null,tasks:AgentTaskStore,ownerScope:string,now:()=>string,othersPresent:()=>boolean=()=>false,beforeStop?:(target:string|null)=>Promise<void>) {
  const external=externalActionWiring(actions,tasks,ownerScope,now);
  return {...external,route:createActionThreadRoute(actions,ownerScope,external.stopOutside,now,othersPresent,beforeStop)};
}
