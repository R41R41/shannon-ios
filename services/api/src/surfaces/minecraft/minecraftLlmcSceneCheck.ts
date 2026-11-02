/**
 * The checks of a replayed scene (`scripts/minecraft-llmc-endgame-scene.ts`): what the hands of a decision must and must not hold, so that two
 * models (or two versions of the knowledge) are counted on the same scenes, "◯ of N", beside the answers read by eye. Pure; the scene says what
 * it expects, in `check`, and the replay says whether the hands meet it.
 */
export interface SceneCheck {
  /** At least one hand is of one of these kinds (`go`, `attack`, `use`, …). */
  anyHand?: string[];
  /** Each group has at least one hand of one of its kinds (`[["go","walk"],["attack"]]`: she moves, and she strikes). */
  eachOf?: string[][];
  /** No hand is of any of these kinds. */
  noHand?: string[];
  /** Each of these (regular expressions) matches the JSON of the hands. */
  match?: string[];
  /** None of these matches. */
  noMatch?: string[];
  /** These kinds come in this order (others may stand between). */
  order?: string[];
}

export interface SceneVerdict {
  pass: boolean;
  /** What was not met, one line each. */
  why: string[];
}

type Hand = Record<string, unknown>;
const kindOf = (hand: Hand): string => String(hand.do ?? '');

function orderProblem(kinds: readonly string[], wanted: readonly string[]): string | null {
  let at = 0;
  for (const kind of kinds) if (kind === wanted[at]) at += 1;
  return at === wanted.length ? null : `手の順が ${wanted.join('→')} でない（${kinds.join('→') || '手なし'}）`;
}

function kindProblems(check: SceneCheck | undefined, kinds: readonly string[]): string[] {
  const why: string[] = [];
  if (check?.anyHand?.length && !kinds.some(kind => check.anyHand!.includes(kind))) why.push(`${check.anyHand.join('・')} のどれかの手が無い`);
  for (const group of check?.eachOf ?? []) if (!kinds.some(kind => group.includes(kind))) why.push(`${group.join('・')} のどれかの手が無い`);
  for (const kind of check?.noHand ?? []) if (kinds.includes(kind)) why.push(`${kind} の手がある`);
  return why;
}

function textProblems(check: SceneCheck | undefined, text: string): string[] {
  const why: string[] = [];
  for (const pattern of check?.match ?? []) if (!new RegExp(pattern, 'u').test(text)) why.push(`${pattern} に合う所が無い`);
  for (const pattern of check?.noMatch ?? []) if (new RegExp(pattern, 'u').test(text)) why.push(`${pattern} に合う所がある`);
  return why;
}

/** Whether the hands of a decision meet a scene's check; with no check, a scene passes when it has any hand. */
export function sceneVerdict(check: SceneCheck | undefined, hands: readonly Hand[]): SceneVerdict {
  const kinds = hands.map(kindOf);
  const order = check?.order?.length ? orderProblem(kinds, check.order) : null;
  const why = [...(hands.length ? [] : ['手が無い']), ...kindProblems(check, kinds), ...textProblems(check, JSON.stringify(hands)), ...(order ? [order] : [])];
  return { pass: why.length === 0, why };
}
