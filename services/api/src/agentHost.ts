import { AgentHostBrokerClient } from './agentHostBroker.js';
import { loadAgentHostConfig } from './agentHostConfig.js';
import { AgentHostStateStore } from './agentHostState.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { codexModelCatalog } from './codexModelCatalog.js';
import { CodexTaskBridge } from './codexTaskBridge.js';
import { AgentWorkspaceSnapshotReader } from './agentWorkspaceSnapshot.js';
import { AgentProjectProvisioner } from './agentProjectProvisioner.js';
import { readWorkspaceResource } from './agentWorkspaceResources.js';

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
  diagnostic: message => console.error(`[agent-host] ${message}`),
});
const workspaceSnapshots = new AgentWorkspaceSnapshotReader();

console.log(`Shannon Agent Host: ${config.displayName} (${config.hostId})`);
console.log(`Projects: ${[...config.projects.keys()].join(', ')}`);

let stopping = false;
let lastHeartbeat = 0;
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
  await bridge.stop();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
