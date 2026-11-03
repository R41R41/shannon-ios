import type { ActInput, ActPos, ActStopIf } from '../../contracts/minecraftActContract.js';
import type { ActClause, ActCondition } from '../../contracts/minecraftActCondition.js';

/**
 * R3-1 (4): the reserve item. While the head thinks, the body goes on with a small item the model wrote for that
 * (`reserve: true` on an act: a head-only mark, not sent to the body): what can be done on the spot first (pick up,
 * a vein next to the body, a craft at hand, a gathering between bakes), a `go` only to within 16 m of where the next
 * hand will be. The head puts it last in the queue and takes it off itself when the decided item comes (`replace`),
 * the safety defaults are the head's and the body's (`dependsOn: []`, a `pre`, a `stopIf`, and the body's safety cut:
 * no reserve starts after an item that ended in a danger). Used only for a task nobody watches (a held or watched
 * task does not take one), and in the Nether and the End no reserve moves the body.
 */
export const RESERVE_DEFAULTS = Object.freeze({ safeR: 16, hp: 12, atR: 32, hostileWithin: 8, hpBelow: 10 });
/** The hands that move the body from where it is: no reserve has them in the Nether or the End. */
export const RESERVE_TRAVEL_HANDS: ReadonlySet<string> = new Set(['go', 'walk', 'vertical', 'portal', 'obsidian', 'pillarUp', 'fight', 'attack', 'fill']);
const QUIET_DIMENSIONS: ReadonlySet<string> = new Set(['the_nether', 'nether', 'the_end', 'end']);

/** Why a reserve is not taken, or null. `hasReserve`: one is open already; `hasDecided`: a decided item is open (the reserve goes behind it). */
export function reserveRefusal(
  input: Pick<ActInput, 'hands' | 'dependsOn' | 'replace'>,
  state: { allowed: boolean; dimension: string | null; hasReserve: boolean; hasDecided: boolean },
): string | null {
  if (!state.allowed) return '送らなかった: この依頼は控えを受け付けない（人が見守る・保留つきの依頼）。決めた項目だけを送る';
  if (state.hasReserve) return '送らなかった: 控えは列に 1 つまで。今の控えを使うか、決めた項目を送れば控えは自分で消える';
  if (!state.hasDecided) return '送らなかった: 控えは決めた項目の後ろに置くもの（列が空なら、決めた項目として reserve を付けずに送る）';
  if (input.replace?.length) return '送らなかった: 控えに replace は付けられない（控えは頭が自分で消す）';
  if (state.dimension && QUIET_DIMENSIONS.has(state.dimension) && input.hands.some(hand => RESERVE_TRAVEL_HANDS.has(hand.do))) {
    const travel = [...new Set(input.hands.filter(hand => RESERVE_TRAVEL_HANDS.has(hand.do)).map(hand => hand.do))].join('・');
    return `送らなかった: ネザー・エンドでは控えに体を動かす手（${travel}）は入れられない。拾う・食べる・持ち替え・盾だけ`;
  }
  return null;
}

const SAFETY_CLAUSES: ReadonlySet<string> = new Set(['safe', 'hp', 'at']);
const hasKind = (alternative: readonly ActClause[], kind: ActClause['k']) => alternative.some(clause => clause.k === kind);
/**
 * The reserve's `pre`: the one the model wrote (or none) with the defaults added to every alternative that lacks them:
 * safe (no hostile in sight within 16), health 12 or more, and within 32 m of where the decision was made.
 * A condition that would pass six clauses keeps the ones it has (the body's limit).
 */
export function reserveCondition(pre: ActCondition | undefined, feet: ActPos | null, dimension: string | null): ActCondition {
  const base: ActCondition = pre?.length ? pre : [[]];
  return base.map(alternative => {
    const added: ActClause[] = [];
    if (!hasKind(alternative, 'safe')) added.push({ k: 'safe', r: RESERVE_DEFAULTS.safeR });
    if (!hasKind(alternative, 'hp')) added.push({ k: 'hp', n: RESERVE_DEFAULTS.hp });
    if (!hasKind(alternative, 'at') && feet) {
      const dim = dimension === 'overworld' || dimension === 'the_nether' || dimension === 'the_end' ? dimension : undefined;
      added.push({ k: 'at', x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z), r: RESERVE_DEFAULTS.atR, ...(dim ? { dim } : {}) });
    }
    // The body's limit is six clauses: the safety ones (the model's own and the added) stay, the model's others give way
    // (review of 11/3: cut by position, the added fell off).
    const safety = alternative.filter((clause, index) => SAFETY_CLAUSES.has(clause.k) && alternative.findIndex(other => other.k === clause.k) === index);
    const rest = alternative.filter(clause => !SAFETY_CLAUSES.has(clause.k));
    return [...safety, ...added, ...rest].slice(0, 6);
  });
}
/** The reserve's `stopIf`: the model's, with hostileWithin and hpBelow at least the defaults (a stricter word of the model stands). */
export function reserveStopIf(stopIf: ActStopIf | undefined): ActStopIf {
  return { ...(stopIf ?? {}), hostileWithin: Math.max(stopIf?.hostileWithin ?? 0, RESERVE_DEFAULTS.hostileWithin),
    hpBelow: Math.max(stopIf?.hpBelow ?? 0, RESERVE_DEFAULTS.hpBelow) };
}
