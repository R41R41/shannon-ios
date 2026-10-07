import { AgentHostBrokerClient } from './integrations/agentHost/agentHostBroker.js';
import { loadAgentHostConfig } from './integrations/agentHost/agentHostConfig.js';
import { AgentHostStateStore } from './integrations/agentHost/agentHostState.js';
import { CodexAppServerClient } from './integrations/agentHost/codexAppServerClient.js';
import { codexModelCatalog } from './integrations/agentHost/codexModelCatalog.js';
import { CodexTaskBridge } from './integrations/agentHost/codexTaskBridge.js';
import { AgentWorkspaceSnapshotReader } from './integrations/agentHost/agentWorkspaceSnapshot.js';
import { AgentProjectProvisioner } from './integrations/agentHost/agentProjectProvisioner.js';
import { readWorkspaceResource } from './mind/action/agentTasks/store/agentWorkspaceResources.js';

const config = loadAgentHostConfig();
const state = new AgentHostStateStore(config.stateFile);
const projectProvisioner = new AgentProjectProvisioner(config, state);
projectProvisioner.restore();
const broker = new AgentHostBrokerClient(config.apiBaseURL, config.token, config.hostId, state);
const client = new CodexAppServerClient({ executable: config.codexExecutable });
const bridge = new CodexTaskBridge({
  config,
  client,
  state,
  publish: events => broker.publish(events),
  permit: taskId => broker.permit(taskId),
  diagnostic: message => console.error(`[agent-host] ${message}`),
});
const workspaceSnapshots = new AgentWorkspaceSnapshotReader();

console.log(`Shannon Agent Host: ${config.displayName} (${config.hostId})`);
console.log(`Projects: ${[...config.projects.keys()].join(', ')}`);

let stopping = false;
let lastHeartbeat = 0;
let checkingRights=false;
const executionTimer=setInterval(()=>{
  if(checkingRights)return;checkingRights=true;
  void bridge.checkExecutionRights().catch(error=>console.error('[agent-host] execution check failed')).finally(()=>{checkingRights=false;});
},5_000);executionTimer.unref();
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

try {
  await bridge.start();
  const models = await codexModelCatalog(client, config.codexModel, config.codexEffort);
  while (!stopping) {
    const now = Date.now();
    try {
      if (now - lastHeartbeat >= config.heartbeatIntervalMs) {
        await broker.heartbeat({
          displayName: config.displayName,
          kind: config.deliveryMode === 'cloud-testflight' ? 'cloud' : 'local',
          projects: [...config.projects.keys()],
          models,
          workspaces: workspaceSnapshots.read(config.projects, now),
          capabilities: [
            'codex-app-server', 'thread-resume', 'steer', 'interrupt',
            'command-approval', 'file-approval', 'network-approval', 'permission-approval',
            'workspace-files', 'workspace-diff', 'workspace-git', 'workspace-build',
            'project-provision',
          ],
        });
        lastHeartbeat = now;
      }
      await broker.flush();
      const project = await broker.claimProject();
      if (project) {
        await broker.publishProject(await projectProvisioner.provision(project));
        lastHeartbeat = 0;
        continue;
      }
      const command = await broker.claim();
      if (command) {
        await bridge.handle(command);
        await delay(150);
        continue;
      }
      const resource = await broker.claimWorkspaceResource();
      if (resource) {
        await broker.publishWorkspaceResource(readWorkspaceResource(config.projects, resource));
        continue;
      }
      await delay(config.pollIntervalMs);
    } catch (error) {
      console.error(`[agent-host] ${error instanceof Error ? error.message : String(error)}`);
      await delay(Math.max(config.pollIntervalMs, 2_000));
    }
  }
} finally {
  clearInterval(executionTimer);
  await bridge.stop();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
