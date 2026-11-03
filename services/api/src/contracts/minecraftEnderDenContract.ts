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
    || !DEN_DIRECTIONS.includes(den.direction as typeof DEN_DIRECTIONS[number])) {
    return 'den は {entrance:{x,y,z}, direction: north|east|south|west}（mc_probe kind=den の候補のまま）';
  }
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

/** What the codes a den fight stops with say (S4's list of 11/3; the body writes `fight 止まった <code>`, no other field). A fact each; no next hand. */
export const DEN_STOP_WORDS: Readonly<Record<string, string>> = {
  den_angry_before_ready: '穴が出来る前に相手が敵対した',
  den_path_unsafe: '入口までの道が安全でない',
  den_turn_timeout: '向き直しが時間内に終わらなかった',
  den_move_timeout: '移動が時間内に終わらなかった',
  den_too_far: '入口が遠すぎる',
  den_approach_failed: '入口に着けなかった',
  den_dig_failed: '横穴を掘れなかった',
  den_dig_unconfirmed: '掘れたかを確かめられなかった',
  den_gaze_conflict: '掘る間に目が合った',
  den_displaced: '穴の外に出された',
  den_pickup_threat: '落とし物を拾う間に他の個体が近づいた',
  den_hurt: '体力を受けた',
  enderman_not_visible: '相手が見えない',
  enderman_not_angry: '相手が敵対しなかった',
  enderman_did_not_arrive: '敵対させて穴の奥で待ったが、20 秒来なかった',
  den_hazard: '穴の中か周りに溶岩など危ないブロックがある',
  den_not_diggable: '横穴で掘ってよい固いブロックでない',
  den_not_open: '入口が開いていない',
  den_open_shell: '穴の周りに空洞がある',
  den_outside_unsafe: '入口の外に平らで乾いた床と高さ 3 が無い',
};
/** The fact for one stop code of a fight line, or '' for any other code. */
export const denStopWords = (code: string | undefined): string => {
  const words = code ? DEN_STOP_WORDS[code] : undefined;
  return words ? `穴の手が止まった理由 ${code}: ${words}` : '';
};
