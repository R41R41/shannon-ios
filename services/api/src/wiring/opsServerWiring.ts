import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { MindHost } from '../mind/workspace/workspacePorts.js';
import { startExecutionBackfill } from './executionBackfillWiring.js';
import { startExecutionMonitor, withExecution } from './executionOpsWiring.js';
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
  /** The mind as the server holds it: its host (stage 3) and, with stage 4, the scheduler's client. */
  mind(): { host: Pick<MindHost, 'faulted' | 'faultCount' | 'busyCount'> | null; actions?: Pick<ActionThreads, 'metrics'> } | null;
  outbox: Parameters<typeof withMindOps>[1]['outbox'];
  now(): string;
  log?(line: string): void;
}

/**
 * The owner's `server` object of `GET /v1/ops`, composed in one place: the self-description, the mind, liveness, the switch
 * findings, the execution metrics and the model cache receipts (ADR-0009 stage 1). The switches are checked once, here, at boot,
 * and the S3 backfill of the execution columns starts here, once per start of the API (its metrics are part of the same view).
 */
export function configuredOpsServer(parts: OpsServerParts) {
  const log = parts.log ?? (line => console.warn(line));
  const switchWarnings = reportSwitches(parts.environment, log);
  const liveness = startLivenessMonitor({
    databasePath: parts.databasePath, ownerScope: parts.ownerScope, ownTimeEnabled: parts.ownTime.enabled,
    timeZone: parts.ownTime.timeZone, environment: parts.environment, now: parts.now,
  });
  const backfill = startExecutionBackfill({ databasePath: parts.databasePath, log: parts.log });
  const execution = startExecutionMonitor({
    database: liveness.database,
    scheduler: () => parts.mind()?.actions ?? null,
    liveness: () => liveness.view(parts.ownerScope),
    now: parts.now,
  });
  const view = (scopeKey: string): object | null => {
    const described = parts.describe(scopeKey);
    const withMind = withMindOps(described, { host: parts.mind()?.host ?? null, outbox: parts.outbox, now: parts.now });
    const withChecks = withSwitches(withLiveness(withMind, liveness.view(scopeKey)), switchWarnings);
    if (!withChecks) return null;
    return withExecution(withChecks, execution.view(), execution.modelCache());
  };
  const close = (): void => {
    void backfill.close();
    execution.close();
    liveness.close();
  };
  return { view, close };
}
