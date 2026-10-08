import { createActionThreadRoute } from '../infra/http/actionThreadRoutes.js';
import { externalActionWiring } from './externalActionWiring.js';
import { minecraftActionPort } from './minecraftActionWiring.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { AgentTaskStore } from '../mind/action/agentTasks/agentTasksPorts.js';
import type { MinecraftBodyRequests } from '../surfaces/minecraft/minecraftBodyRequests.js';
export function configuredActionRoutes(actions:ActionThreads|null,tasks:AgentTaskStore,minecraft:MinecraftBodyRequests|null,ownerScope:string,now:()=>string,othersPresent:()=>boolean=()=>false,beforeStop?:(target:string|null)=>Promise<void>) {
  if(actions && minecraft)minecraft.execution=minecraftActionPort(actions);
  const external=externalActionWiring(actions,tasks,minecraft,ownerScope,now);
  return {...external,route:createActionThreadRoute(actions,ownerScope,external.stopOutside,now,othersPresent,beforeStop)};
}
