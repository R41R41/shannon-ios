import type { WorkingEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { InventoryEvent, ReflexCappedData } from '../../contracts/continueContract.js';
import type { LedgerInput } from './minecraftLlmcPromises.js';
import type { MinecraftControl } from './minecraftControl.js';

/**
 * What the body tells beside its receipts and the head acts on (continue contract 3 and 4): the body's events
 * `reflex.capped` and `inventory.changed`
 * (`packages/mind/src/workingEvents.ts` takes them in; `MinecraftControl.eventListeners` hands each batch).
 * Nothing here decides: a
 * cap is told to the queue (its next
 * `ready` says `reflex_capped`) and to the live state as a fact; a reflex's use of the pack outside any act goes to the promises'
 * ledger once, by its own id.
 */
export interface ReflexCapped extends ReflexCappedData { reflex: string; at: string }

const LIMITS: readonly ReflexCappedData['limit'][] = ['melee_hands', 'melee_hits', 'budget_arrow', 'budget_eat', 'budget_armor'];
const BRIDGES: readonly ReflexCappedData['bridge'][] = ['shield', 'step_back', 'none'];
const REASONS: readonly InventoryEvent['reason'][] = ['ingredient', 'fuel', 'food', 'placed', 'thrown', 'tool_broke', 'crafted', 'picked', 'mined', 'smelted',
  'reflex_eat', 'reflex_armor', 'death', 'unexplained', 'stored', 'retrieved'];

/** The `reflex.capped` event as the contract gives it (subject: the reflex; data: the limit, the count, the
 * bridge and its end), or
 * null when it does not read. */
export function readReflexCapped(event: Pick<WorkingEvent, 'kind' | 'subject' | 'data' | 'at'>): ReflexCapped | null {
  if (event.kind !== 'reflex.capped') return null;
  const { limit, count, bridge, until } = event.data;
  if (!LIMITS.includes(limit as never) || !BRIDGES.includes(bridge as never) || typeof count !== 'number' || !Number.isFinite(count)) return null;
  if (until !== null && until !== undefined && (typeof until !== 'string' || !Number.isFinite(Date.parse(until)))) return null;
  return { reflex: event.subject, limit: limit as ReflexCappedData['limit'], count, bridge: bridge as ReflexCappedData['bridge'], until:
     typeof until === 'string' ? until : null, at: event.at };
}
/** The `inventory.changed` event (a reflex's use of the pack outside any act; id `reflex:<connection>:<seq>`) as
 * the ledger's event,
 * or null when it does not read. */
export function readInventoryChanged(event: Pick<WorkingEvent, 'kind' | 'subject' | 'data'>): InventoryEvent | null {
  if (event.kind !== 'inventory.changed') return null;
  const { id, item, count, reason, obsSeq } = event.data;
  if (typeof id !== 'string' || !id || typeof item !== 'string' || !item || typeof count !== 'number' || !Number.isFinite(count)) return null;
  if (!REASONS.includes(reason as never) || typeof obsSeq !== 'number' || !Number.isSafeInteger(obsSeq)) return null;
  return { id, obsSeq, item, count, reason: reason as InventoryEvent['reason'] };
}

const LIMIT_WORDS: Readonly<Record<ReflexCappedData['limit'], (count: number) => string>> = {
  melee_hands: count => `手数 ${count}`, melee_hits: count => `打ち ${count}`, budget_arrow: () => '矢の予算', budget_eat: () => '食事の予算', budget_armor: () => '防具の予算' };
/** The fact the live state shows once when a reflex hit its cap: which reflex, which limit, and what it keeps up
 * for how long. Facts only. */
export function reflexCappedWords(info: ReflexCapped): string {
  const seconds = info.until ? Math.max(0, Math.round((Date.parse(info.until) - Date.parse(info.at)) / 1000)) : null;
  const bridge = info.bridge === 'shield' ? `盾を構えたままつなぐ${seconds !== null ? `（約 ${seconds} 秒まで）` : ''}`
    : info.bridge === 'step_back' ? `一歩下がったままつなぐ${seconds !== null ? `（約 ${seconds} 秒まで）` : ''}` : 'つなぎは無い';
  return `反射 ${info.reflex} が上限に着いた（${LIMIT_WORDS[info.limit](info.count)}）。${bridge}`;
}

/**
 * Listens to the body's events for one task's queue: a cap is told on, an inventory event goes to the ledger
 * (`applyLedger`) with the newest observation, once
 * (the ledger keeps an event's id and refuses it the second time). Never throws into a poll. Returns what takes the listener off.
 */
export function watchBodyEvents(parts: { control: Pick<MinecraftControl, 'eventListeners'>; bodyId(): string; observe(): BodyObservation | null;
  applyLedger?(input: Omit<LedgerInput, 'nodes' | 'at'> & { at?: string }): unknown; onReflexCapped?(info: ReflexCapped): void; log?(line:
     string): void }): () => void {
  const listener = (bodyId: string, events: readonly WorkingEvent[]) => {
    if (!bodyId || bodyId !== parts.bodyId()) return;
    for (const event of events) {
      try {
        if (event.kind === 'reflex.capped') {
          const info = readReflexCapped(event);
          if (info) parts.onReflexCapped?.(info);
          else parts.log?.(`Shannon Minecraft reflex.capped not read seq=${event.seq}`);
        } else if (event.kind === 'inventory.changed') {
          const fact = readInventoryChanged(event);
          if (!fact) parts.log?.(`Shannon Minecraft inventory.changed not read seq=${event.seq}`);
          else parts.applyLedger?.({ events: [fact], observation: parts.observe() });
        }
      } catch (cause) { parts.log?.(`Shannon Minecraft body event failed kind=${event.kind} ${String(cause).slice(0, 120)}`); }
    }
  };
  parts.control.eventListeners.add(listener);
  return () => { parts.control.eventListeners.delete(listener); };
}
