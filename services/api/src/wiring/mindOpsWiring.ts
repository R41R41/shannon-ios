import type { MindHost } from '../mind/workspace/workspacePorts.js';

/** What `/v1/ops` shows of the mind (Syzygy ADR-0008 stage 3, pre-deploy review): numbers and booleans only, for the owner's scope. */
export interface MindOpsView {
  workspace: { faulted: boolean; faults: number; busyWrites: number } | null;
  memoryOutbox: { pending: number; oldestPendingSeconds: number | null; failed: number } | null;
}

/**
 * The server's description of itself with the mind's state added under `mind` (owner only: `server` is null for any other scope, and
 * then nothing is added). Null parts are switched off; with both off nothing is added. Never throws: an unreadable backlog is shown as null.
 */
export function withMindOps(
  server: object | null,
  parts: { host: Pick<MindHost, 'faulted' | 'faultCount' | 'busyCount'> | null; outbox: { backlog(now: string): NonNullable<MindOpsView['memoryOutbox']> } | null; now: () => string },
): object | null {
  if (!server) return null;
  if (!parts.host && !parts.outbox) return server; // Stage 3 switched off: the response of afb38c28.
  let memoryOutbox: MindOpsView['memoryOutbox'] = null;
  try { memoryOutbox = parts.outbox?.backlog(parts.now()) ?? null; } catch { memoryOutbox = null; }
  const mind: MindOpsView = {
    workspace: parts.host ? { faulted: parts.host.faulted, faults: parts.host.faultCount, busyWrites: parts.host.busyCount } : null,
    memoryOutbox,
  };
  return { ...server, mind };
}
