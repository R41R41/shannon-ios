import type { MindHost } from '../mind/workspace/workspacePorts.js';
import { startLivenessMonitor, withLiveness } from './livenessWiring.js';
import { withMindOps } from './mindOpsWiring.js';
import { reportSwitches, withSwitches } from './switchesWiring.js';

type Environment = Readonly<Record<string, string | undefined>>;

export interface OpsServerParts {
  environment: Environment;
  databasePath: string;
  ownerScope: string;
  ownTime: { enabled: boolean; timeZone: string };
  /** The server's description of itself for a scope (null for anyone but the owner). */
  describe(scopeKey: string): object | null;
  mindHost(): Pick<MindHost, 'faulted' | 'faultCount' | 'busyCount'> | null;
  outbox: Parameters<typeof withMindOps>[1]['outbox'];
  now(): string;
  log?(line: string): void;
}

/**
 * The owner's `server` object of `GET /v1/ops`, composed in one place: the self-description, the mind, liveness and the switch
 * findings. The switches are checked once, here, at boot.
 */
export function configuredOpsServer(parts: OpsServerParts) {
  const log = parts.log ?? (line => console.warn(line));
  const switchWarnings = reportSwitches(parts.environment, log);
  const liveness = startLivenessMonitor({
    databasePath: parts.databasePath, ownerScope: parts.ownerScope, ownTimeEnabled: parts.ownTime.enabled,
    timeZone: parts.ownTime.timeZone, environment: parts.environment, now: parts.now,
  });
  const view = (scopeKey: string): object | null => {
    const described = parts.describe(scopeKey);
    const withMind = withMindOps(described, { host: parts.mindHost(), outbox: parts.outbox, now: parts.now });
    return withSwitches(withLiveness(withMind, liveness.view(scopeKey)), switchWarnings);
  };
  return { view, close: () => liveness.close() };
}
