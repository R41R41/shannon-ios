import { MINECRAFT_RETIRED_CONNECTION_MS } from './minecraftControlState.js';
export function createRetiredConnections(now: () => number) {
  /** Per body, the connections a newer one replaced (the last 16). */
  const retiredConnections = new Map<string, string[]>();

  /**
   * A poll from a connection a newer one replaced, while the newer one is alive: refused. A body process kept from run to run may
   * keep an earlier loop polling (practice ground, 2026-10-20); taking each connection's frame in turn swapped the
   * catalog under a
   * step (FCA_BODY_CATALOG_CHANGED). A new connection retires the one before it. A retired one is taken again only
   * while the newer one
   * has been silent for `MINECRAFT_RETIRED_CONNECTION_MS`, and then as a stand-in: it stays retired and retires
   * nobody, so the newer
   * one's next poll is taken again (an API stall of a few seconds must not hand the body to a leftover loop for good).
   */
  function retiredConnection(
    bodyId: string,
    old: { poll: { connectionId: string }; received: number } | undefined,
    connectionId: string,
  ): boolean {
    if (!old || old.poll.connectionId === connectionId) return false;
    const retired = retiredConnections.get(bodyId) ?? [];
    if (retired.includes(connectionId)) {
      const refused = now() - old.received < MINECRAFT_RETIRED_CONNECTION_MS;
      if (refused) tellRetired(bodyId, connectionId);
      return refused;
    }
    retiredConnections.set(bodyId, [...retired.filter((id) => id !== old.poll.connectionId), old.poll.connectionId].slice(-16));
    return false;
  }

  const retiredTold = new Map<string, number>();

  /** One line a connection at most every 30 s: the route answers a refused poll with a bare 400. */
  function tellRetired(bodyId: string, connectionId: string): void {
    const at = now();
    if (at - (retiredTold.get(connectionId) ?? -Infinity) < 30_000) return;
    retiredTold.set(connectionId, at);
    if (retiredTold.size > 64) retiredTold.delete(retiredTold.keys().next().value as string);
    console.info(`Shannon Minecraft body poll refused body=${bodyId} connection=${connectionId.slice(0, 12)} reason=retired`);
  }
  return retiredConnection;
}
