/**
 * The enderman den, the head's side of the body's fight hand (11/3, S4: `den` on `fight`, the candidates from `mc_probe kind=den`): the entrance
 * and the direction come from an observed candidate as they are, whole-block absolute cells; the target is an observed `#id`; the hand stands alone
 * in its act, takes no `rel` and no `flee`. The body refuses the same at run time; here it is said before the call, with the form to write.
 */
export const DEN_DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
export interface EnderDen { entrance: { x: number; y: number; z: number }; direction: typeof DEN_DIRECTIONS[number] }

export const DEN_DESCRIPTION = 'fight enderman 専用: mc_probe kind=den が返した候補の entrance と direction をそのまま（絶対整数マス）。'
  + 'target は観測した #id。この手だけの act にし、rel・stance=flee は付けない。';

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** What is wrong with the `den` of a fight hand, or null. */
export function denProblem(hand: Record<string, unknown>): string | null {
  if (hand.den === undefined) return null;
  const den = objectOf(hand.den), entrance = objectOf(den?.entrance);
  const cells = ['x', 'y', 'z'].map(key => entrance?.[key]);
  if (!den || Object.keys(den).some(key => key !== 'entrance' && key !== 'direction')
    || !DEN_DIRECTIONS.includes(den.direction as typeof DEN_DIRECTIONS[number])) return 'den は {entrance:{x,y,z}, direction: north|east|south|west}（mc_probe kind=den の候補のまま）';
  if (!entrance || Object.keys(entrance).length !== 3 || !cells.every(cell => Number.isSafeInteger(cell))) return 'den.entrance は整数の絶対マス {x,y,z}';
  const target = hand.target;
  if (!(typeof target === 'number' && Number.isSafeInteger(target) && target >= 0) && !(typeof target === 'string' && /^#\d+$/u.test(target.trim()))) {
    return 'den の fight には観測した target:"#id" が要る（種類名では選ばない）';
  }
  if (hand.stance === 'flee') return 'den は stance=fight だけ';
  return hand.rel === true ? 'den.entrance は絶対マス（rel:true は使えない）' : null;
}

/** The act-level check: a hand with `den` is the only hand of its act. */
export function denActProblem(input: unknown): string | null {
  const hands = objectOf(input)?.hands;
  if (!Array.isArray(hands) || hands.length < 2) return null;
  const index = hands.findIndex(raw => objectOf(raw)?.den !== undefined);
  return index < 0 ? null : `手${index + 1}（fight）: den の手は act に 1 つだけ（他の手と混ぜない）`;
}
