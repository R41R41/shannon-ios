import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * mb-llmc-cand 送る前の守りの足し 2 つ（SHANNON_MINECRAFT_LLMC_V2、再現台 candidate-fix-20261023 の A: live に事実があるのに反した答え）。部分送りと同じ形:
 * 止める手の前までは体へ送り、止めた手から先は送らず事実を返す。手は直さず足さない。
 *
 * 1. `urgentLimitStop`: 急ぎの判断（live の答え方の行 `URGENT_ANSWER` が「手は 3 つまで」と言った判断）の act が 4 手以上なら、手 4 から先は送らない（s12・s34）。
 * 2. `seenReopenStop`: 直前に「見られる」で止まったマス（体の `recentStops`、90 秒以内）を exposeOk なしで dig する手は送らない（s30・s02）。
 *    exposeOk 付きの dig は止めない（見られると分かって開ける手）。
 */
export const URGENT_HANDS = 3;
/** A stop for 「見られる」 this young is a fact about the cell now (the hostile moves; after this the body's own check decides). */
export const SEEN_REOPEN_SECONDS = 90;

/** A hand a guard holds: 1-based number, the kind of the hand, a closed code and the line the model reads. */
export interface HandStop { hand: number; kind: string; code: string; line: string }
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const handsOf = (input: unknown): Rec[] => {
  const hands = rec(input)?.hands;
  return Array.isArray(hands) ? hands.map(rec).filter((hand): hand is Rec => hand !== null) : [];
};

/** Whether a live state belongs to an urgent decision: its `body.answer` is the urgent answer line (「手は 3 つまで」). */
export function isUrgentLive(live: Rec): boolean {
  const answer = rec(live.body)?.answer;
  return typeof answer === 'string' && answer.includes(`手は ${URGENT_HANDS} つまで`);
}

/** The fourth hand of an urgent decision's act, when it has more than three. */
export function urgentLimitStop(input: unknown, urgent: boolean): HandStop | null {
  const hands = handsOf(input);
  if (!urgent || hands.length <= URGENT_HANDS) return null;
  const kind = String(hands[URGENT_HANDS]!.do ?? '?');
  return { hand: URGENT_HANDS + 1, kind, code: 'urgent_limit',
    line: `急ぎの判断は ${URGENT_HANDS} 手まで（live の答え方の行）。${URGENT_HANDS + 1} 手目（${kind}）から先は送っていない。続きは次の判断で出せる` };
}

/** The cells the body's recent stops say stopped for 「見られる」 within `SEEN_REOPEN_SECONDS`: `x,y,z` → seconds ago. */
export function seenStops(recentStops: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of Array.isArray(recentStops) ? recentStops : []) {
    const m = /^(?:\([-\d,]+\)→)?\((-?\d+),(-?\d+),(-?\d+)\) 見られる(?: ×\d+)? (\d+)秒前$/u.exec(String(line));
    if (m && Number(m[4]) <= SEEN_REOPEN_SECONDS) out.set(`${m[1]},${m[2]},${m[3]}`, Number(m[4]));
  }
  return out;
}
/** The nearest hostile the body says sees her, as `blaze #7 6.0m`, or null. */
function seeingHostile(world: Rec): string | null {
  const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).map(rec)
    .filter((item): item is Rec => item !== null && item.canSee === true && typeof item.name === 'string' && typeof item.distance === 'number');
  const near = threats.sort((a, b) => (a.distance as number) - (b.distance as number))[0];
  return near ? `${String(near.name)}${typeof near.id === 'number' ? ` #${near.id}` : ''} ${(near.distance as number).toFixed(1)}m` : null;
}

/** The first dig without exposeOk of a cell that stopped for 「見られる」 a moment ago. */
export function seenReopenStop(input: unknown, frame: BodyObservation | null): HandStop | null {
  const world = rec(frame?.state.world) ?? {};
  const stops = seenStops(world.recentStops);
  if (!stops.size) return null;
  for (const [index, hand] of handsOf(input).entries()) {
    if (hand.do !== 'dig' || hand.rel === true || (hand.exposeOk !== undefined && hand.exposeOk !== false)) continue;
    for (const cell of Array.isArray(hand.at) ? hand.at : []) {
      const at = rec(cell), key = at ? `${at.x},${at.y},${at.z}` : '';
      const age = stops.get(key);
      if (age === undefined) continue;
      const hostile = seeingHostile(world);
      return { hand: index + 1, kind: 'dig', code: 'reopen_seen',
        line: `(${key}) は直前に「見られる」で止まった（${age}秒前${hostile ? `。今も見える敵: ${hostile}` : ''}）。開けるなら exposeOk を付ける。`
          + 'ほかのマスを掘るなら、見られない別のマス（敵と反対側・下の岩）を' };
    }
  }
  return null;
}
