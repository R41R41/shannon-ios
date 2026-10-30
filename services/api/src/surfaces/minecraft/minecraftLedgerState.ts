import { emptyLedgerSeen, AHEAD_LIMIT, CONNECTIONS_LIMIT } from './minecraftLedgerTypes.js';
import type { UsesSnapshot, LedgerAhead, LedgerSeen } from './minecraftLedgerTypes.js';
import type { PlanPromise } from '@shannon/mind';

/** The definitions of `ids` as they stand, to send with a command (an unknown or closed one is left out). */
export function snapshotUses(promises: readonly PlanPromise[], usesIds: readonly number[] | undefined): UsesSnapshot[] {
  const out: UsesSnapshot[] = [];
  for (const id of usesIds ?? []) {
    const promise = promises.find((item) => item.id === id);
    if (promise && promise.state !== 'closed' && !out.some((item) => item.id === id))
      out.push({ id, rev: promise.rev, item: promise.item, count: promise.count, use: promise.use });
  }
  return out;
}

/** A `LedgerSeen` read back from a checkpoint (anything that does not read is empty). */
export function readLedgerSeen(value: unknown): LedgerSeen {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || !Array.isArray(raw.eventIds)) return emptyLedgerSeen();
  const last = raw.lastObs as Record<string, unknown> | null | undefined;
  const lastObs =
    last && typeof last.bodyBoot === 'string' && typeof last.connectionId === 'string' && Number.isFinite(last.obsSeq)
      ? { bodyBoot: last.bodyBoot, connectionId: last.connectionId, obsSeq: last.obsSeq as number }
      : null;
  const death = raw.death as Record<string, unknown> | null | undefined;
  const ahead = Array.isArray(raw.ahead)
    ? raw.ahead.filter(
        (item): item is LedgerAhead =>
          !!item &&
          typeof item === 'object' &&
          Number.isSafeInteger((item as LedgerAhead).promise) &&
          Number.isFinite((item as LedgerAhead).delta) &&
          typeof (item as LedgerAhead).connection === 'string',
      )
    : [];
  const deathObservation = () =>
    death && typeof death.deathEpoch === 'string' && Number.isSafeInteger(death.deathSeq)
      ? {
          death: {
            deathEpoch: death.deathEpoch,
            deathSeq: death.deathSeq as number,
          },
        }
      : {};
  return {
    eventIds: raw.eventIds.filter((id): id is string => typeof id === 'string'),
    lastObs,
    ...deathObservation(),
    ...(Array.isArray(raw.connections)
      ? { connections: raw.connections.filter((item): item is string => typeof item === 'string').slice(-CONNECTIONS_LIMIT) }
      : {}),
    ...(Array.isArray(raw.products)
      ? {
          products: raw.products
            .filter(
              (item): item is { id: string; item: string } =>
                !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.item === 'string',
            )
            .slice(-AHEAD_LIMIT),
        }
      : {}),
    ...(ahead.length ? { ahead: ahead.slice(-AHEAD_LIMIT) } : {}),
  };
}
