import { AgentHostBrokerClient } from './agentHostBroker.js';
import { loadAgentHostConfig } from './agentHostConfig.js';
import { AgentHostStateStore } from './agentHostState.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { CodexTaskBridge } from './codexTaskBridge.js';

const config = loadAgentHostConfig();
const state = new AgentHostStateStore(config.stateFile);
const broker = new AgentHostBrokerClient(config.apiBaseURL, config.token, config.hostId, state);
const client = new CodexAppServerClient({ executable: config.codexExecutable });
const bridge = new CodexTaskBridge({
  config,
  client,
  state,
  publish: events => broker.publish(events),
  diagnostic: message => console.error(`[agent-host] ${message}`),
});

console.log(`Shannon Agent Host: ${config.displayName} (${config.hostId})`);
console.log(`Projects: ${[...config.projects.keys()].join(', ')}`);

let stopping = false;
let lastHeartbeat = 0;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

try {
  await bridge.start();
  while (!stopping) {
    const now = Date.now();
    try {
      if (now - lastHeartbeat >= config.heartbeatIntervalMs) {
        await broker.heartbeat(config.displayName, [
          'codex-app-server', 'thread-resume', 'steer', 'interrupt',
          'command-approval', 'file-approval', 'network-approval', 'permission-approval',
        ]);
        lastHeartbeat = now;
      }
      await broker.flush();
      const command = await broker.claim();
      if (command) await bridge.handle(command);
      await delay(command ? 150 : config.pollIntervalMs);
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
