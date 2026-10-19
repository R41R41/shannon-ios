import { createHash } from 'node:crypto';
import type { ItemCounts } from './minecraftItems.js';

/**
 * What a transient decision reads of the task's pace beyond `minecraftPace` (observation redesign P3; the old Minebot `describePace`):
 * the minutes since her last achievement (an item kind she had never held), the minutes of the last 15 she spent in each kind of body
 * call (from the calls' own durations), and a notice when the same call failed the same way again. Every decision is a new step with
 * a new adapter, so the ledger is a closed, bounded object kept in the task's checkpoint (`minecraftPaceLedger`). Times are seconds
 * since the task began. Measured facts only; nothing here is her content.
 */
const WINDOW_SECONDS = 15 * 60, MAXIMUM_CALLS = 60, MAXIMUM_KINDS = 400;
export const PACE_KINDS = ['waiting', 'mining', 'moving', 'smelting', 'crafting', 'combat', 'sheltering', 'water', 'other'] as const;
export type PaceKind = typeof PACE_KINDS[number];

/** The kind of a body call, from its tool name; order matters (a shelter is dug, so `shelter` is asked before `mine`). */
const KINDS: ReadonlyArray<readonly [PaceKind, RegExp]> = [
  ['waiting', /wait/u], ['smelting', /smelt|furnace/u], ['crafting', /craft/u], ['combat', /attack|fight|kill|shoot|hunt/u],
  ['sheltering', /shelter|flee|retreat|hide|escape/u], ['water', /water|swim|boat/u], ['mining', /mine|dig|chop|harvest|collect/u],
  ['moving', /move|walk|goto|go-to|explore|travel|follow|navigate|portal/u],
];
export function paceKind(name: string): PaceKind | null {
  if (!name.startsWith('mc.') && !name.startsWith('minecraft.')) return null;
  const bare = name.replace(/^(?:mc|minecraft)\./u, '');
  return KINDS.find(([, pattern]) => pattern.test(bare))?.[0] ?? 'other';
}

interface Failure { sig: string; n: number; name: string }
interface Ledger { held: string[] | null; achievedAt: number | null; calls: Array<[number, PaceKind, number]>; failure: Failure | null }

const whole = (value: unknown, maximum: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), maximum) : null;
const ITEM = /^[a-z][a-z0-9_]{0,63}$/u;
function readLedger(kept: unknown): Ledger {
  const value = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept as Record<string, unknown> : {};
  const names = Array.isArray(value.held) ? value.held : null;
  const held = names ? names.filter((name): name is string => typeof name === 'string' && ITEM.test(name)).slice(0, MAXIMUM_KINDS) : null;
  const calls = (Array.isArray(value.calls) ? value.calls : []).flatMap((entry): Array<[number, PaceKind, number]> => {
    const [at, kind, milliseconds] = Array.isArray(entry) ? entry : [];
    const when = whole(at, 31_536_000), spent = whole(milliseconds, 3_600_000);
    return when !== null && spent !== null && PACE_KINDS.includes(kind as PaceKind) ? [[when, kind as PaceKind, spent]] : [];
  }).slice(-MAXIMUM_CALLS);
  const failure = value.failure && typeof value.failure === 'object' ? value.failure as Record<string, unknown> : null;
  return { held, achievedAt: whole(value.achievedAt, 31_536_000), calls,
    failure: failure && typeof failure.sig === 'string' && typeof failure.name === 'string' && whole(failure.n, 999) !== null
      ? { sig: failure.sig.slice(0, 64), name: failure.name.slice(0, 80), n: whole(failure.n, 999)! } : null };
}

export function createPaceLedger(parts: { kept: unknown; began: number; now(): number }) {
  const state = readLedger(parts.kept);
  let touched = false;
  const seconds = () => Number.isFinite(parts.began) ? Math.max(0, Math.round((parts.now() - parts.began) / 1000)) : 0;
  return {
    /** A decision reads the ledger (with or without an observation): from here its state is kept in the checkpoint. */
    use(): void { touched = true; },
    /** What she carries now: an item kind she had never held is an achievement (the first look only sets what she began with). */
    observe(counts: ItemCounts): void {
      const kinds = [...counts.keys()].filter(name => ITEM.test(name));
      touched = true;
      if (state.held === null) {
        state.held = kinds.slice(0, MAXIMUM_KINDS);
        return;
      }
      const known = new Set(state.held), fresh = kinds.filter(name => !known.has(name));
      if (!fresh.length) return;
      state.held = [...state.held, ...fresh].slice(0, MAXIMUM_KINDS);
      state.achievedAt = seconds();
    },
    /**
     * A finished call: its duration under its kind, and the run of the same failure. A call the body's own reflex cut off
     * (`bodyReflex`, failureType `interrupted_by_reflex`) is no failure of the call: it is retry_same (P8), so it neither adds to
     * the run nor ends it (review 6, L-2); its time still counts under its kind.
     */
    note(call: { name: string; input: unknown }, result: { ok: boolean; failure?: string | null; bodyReflex?: boolean }, milliseconds: number): void {
      const kind = paceKind(call.name);
      if (kind === null) return;
      if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        const spent = Math.min(Math.round(milliseconds), 3_600_000);
        state.calls = [...state.calls, [seconds(), kind, spent] as [number, PaceKind, number]].slice(-MAXIMUM_CALLS);
      }
      if (result.bodyReflex === true) return;
      if (result.ok) {
        state.failure = null;
        return;
      }
      const sig = createHash('sha256').update(`${call.name}|${JSON.stringify(call.input) ?? ''}|${result.failure ?? ''}`).digest('hex').slice(0, 16);
      state.failure = state.failure?.sig === sig ? { ...state.failure, n: Math.min(state.failure.n + 1, 999) } : { sig, n: 1, name: call.name };
    },
    /** The pace facts of this decision. */
    snapshot(): { sinceAchievementMinutes: number; last15min: Partial<Record<PaceKind, number>>; sameFailure?: { tool: string; times: number } } {
      const now = seconds(), since = state.achievedAt ?? 0;
      const last15min: Partial<Record<PaceKind, number>> = {};
      for (const [at, kind, milliseconds] of state.calls) {
        if (now - at <= WINDOW_SECONDS) last15min[kind] = round1((last15min[kind] ?? 0) + milliseconds / 60_000);
      }
      return { sinceAchievementMinutes: Math.floor(Math.max(0, now - since) / 60), last15min,
        ...(state.failure && state.failure.n >= 2 ? { sameFailure: { tool: state.failure.name, times: state.failure.n } } : {}) };
    },
    /** What to keep in the checkpoint; nothing while no decision read it (`observe` marks it used): a task that is not transient writes nothing. */
    checkpoint(): Record<string, unknown> {
      if (!touched) return {};
      const floor = seconds() - WINDOW_SECONDS;
      const calls = state.calls.filter(([at]) => at >= floor);
      return { minecraftPaceLedger: { held: state.held, achievedAt: state.achievedAt, calls, failure: state.failure } };
    },
  };
}
const round1 = (value: number) => Math.round(value * 10) / 10;
