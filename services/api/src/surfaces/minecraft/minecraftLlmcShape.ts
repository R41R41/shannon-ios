import { ACT_THOUGHT_MAX, handFieldNames, slotWordOf, type HandKind } from '../../contracts/minecraftActContract.js';
import { HAND_FIELDS } from '../../contracts/minecraftActHandRules.js';

/**
 * The act as the model writes it, made ready for the body (r2, 2026-10-22; contract `minecraftActContract.ts`):
 * put into the contract's
 * shape where what it meant is plain (`normalizeActInput`), and where it is not, the one line that says where and how it is wrong
 * (`schemaProblem`).
 */
type Fields = Record<string, unknown>;
const plainRecord = (value: unknown): Fields | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
const isPos = (value: unknown) => {
  const pos = plainRecord(value);
  return !!pos && ['x', 'y', 'z'].every(key => typeof pos[key] === 'number');
};
const isItem = (value: unknown) => typeof plainRecord(value)?.item === 'string';

/** One plain fix of a field: whether it applies to the value, the value made right, and what to say (`{name}` is
 * the hand or act). */
interface Fix { key: string; when(value: unknown): boolean; make(value: unknown): unknown; say: string }
const listOf = (key: string, when: (value: unknown) => boolean): Fix => ({ key, when, make: value => [value], say: `${key} を配列にした` });
const ACT_FIXES: readonly Fix[] = [
  listOf('hands', value => !!plainRecord(value)),
  listOf('accept', value => typeof value === 'string'),
  { key: 'why', when: value => typeof value === 'string' && value.length > 120, make: value => String(value).slice(0, 120), say: 'why を 120 字に切った' },
  // A thought is for the screen only: one that runs long is cut rather than the whole act refused.
  { key: 'thought', when: value => typeof value === 'string' && value.length > ACT_THOUGHT_MAX, make: value => String(value).slice(0, ACT_THOUGHT_MAX),
    say: `thought を ${ACT_THOUGHT_MAX} 字に切った` },
];
const HAND_FIXES: readonly Fix[] = [
  { key: 'note', when: value => typeof value === 'string' && value.length > 40, make: value => String(value).slice(0, 40), say: 'note を 40 字に切った' },
  listOf('at', isPos),
  listOf('path', isPos),
  { key: 'to', when: value => Array.isArray(value) && value.length === 1 && isPos(value[0]), make: value => (value as unknown[])[0],
    say: 'to を 1 つの座標にした' },
  { key: 'items', when: value => typeof value === 'string', make: value => [{ item: value }], say: 'items を配列にした' },
  listOf('items', isItem),
  { key: 'target', when: value => Number.isSafeInteger(value), make: value => `#${String(value)}`, say: 'target を #id にした' },
];
function applyFixes(fields: Fields, fixes: readonly Fix[], said: string[], name: string): Fields {
  const out = { ...fields };
  for (const fix of fixes) {
    if (!(fix.key in out) || !fix.when(out[fix.key])) continue;
    out[fix.key] = fix.make(out[fix.key]);
    said.push(name ? `${name} の ${fix.say}` : fix.say);
  }
  return out;
}
/** A hand's `why` taken out: the act's own `why` when it has none (said either way). */
function moveWhy(act: Fields, hand: Fields, name: string, said: string[]): void {
  if (!('why' in hand)) return;
  const why = hand.why;
  delete hand.why;
  if (typeof act.why !== 'string' && typeof why === 'string' && why.trim()) {
    act.why = why.slice(0, 120);
    said.push(`${name} の why を act の why にした（why は act に 1 つ）`);
    return;
  }
  said.push(`${name} の why は捨てた（why は act に 1 つ。手には note）`);
}

/**
 * The act as the model wrote it, put into the contract's shape where what it meant is plain (scene replay
 * 2026-10-21: Haiku wrote `why`
 * in a hand 4 times in 12 and the act was refused whole; Sonnet wrote one `at` as an object). Each fix is said
 * in one line, for the
 * result the model reads. What is not plain is left as written (`llmcInputProblem` then says where it is wrong).
 * - a hand's `why`: taken out (the act's `why` when it has none); `note` past 40 characters: cut;
 * - `at`, `path`, `stopIf.blockChanged`: one {x,y,z} → a list of it; `to`: a list of one {x,y,z} → it;
 * - `items`: one {item} or a name → a list of it; `target`: a number → `#id`; `accept`: one name → a list;
 * `hands`: one hand → a list.
 */
export function normalizeActInput(input: unknown): { input: unknown; fixes: string[] } {
  const act = plainRecord(input);
  if (!act) return { input, fixes: [] };
  const fixes: string[] = [];
  let spelled = false;
  const hands = Array.isArray(act.hands) ? act.hands : [act.hands];
  const rush = hands.some(value => plainRecord(value)?.style === 'shield_rush');
  const out = applyFixes(act, rush ? ACT_FIXES.filter(fix => fix.key !== 'accept') : ACT_FIXES, fixes, '');
  const stopIf = plainRecord(out.stopIf);
  if (stopIf) out.stopIf = applyFixes(stopIf, [listOf('blockChanged', isPos)], fixes, 'stopIf');
  if (Array.isArray(out.hands)) {
    out.hands = out.hands.map((value, index) => {
      const hand = plainRecord(value);
      if (!hand) return value;
      // Rush and fill permissions are checked exactly as written, including any extra fields.
      if (hand.style === 'shield_rush' || hand.do === 'fill') return hand;
      const fixed = { ...hand };
      // A-11 3: a plain variation of a hand word in `slot` (off-hand, main_hand…) is the body's word; not said (it is
// a spelling, not a change of meaning).
      if (typeof fixed.slot === 'string' && slotWordOf(fixed.slot) !== fixed.slot) { fixed.slot = slotWordOf(fixed.slot);
        spelled = true; }
      moveWhy(out, fixed, `手${index + 1}`, fixes);
      return applyFixes(fixed, HAND_FIXES, fixes, `手${index + 1}`);
    });
  }
  return { input: fixes.length || spelled ? out : input, fixes };
}

type Schema = Readonly<Record<string, unknown>>;
type Path = ReadonlyArray<string | number>;
const TYPE_WORDS: Record<string, string> = { object: 'object', array: '配列', string: '文字', number: '数', integer: '整数', boolean: 'true か false' };
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return '配列';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? '整数' : '数';
  return TYPE_WORDS[typeof value] ?? typeof value;
}
function fits(type: string, value: unknown): boolean {
  if (type === 'object') return !!plainRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}
const isPosSchema = (node: unknown) => !!plainRecord(plainRecord(node)?.properties)?.x;
const outside = (value: number, low: unknown, high: unknown) => typeof low === 'number' && value < low || typeof high === 'number' && value > high;

/** Where a field is, in the model's words: `手3（chest）の at[1].x`, `stopIf.hostileWithin`, or `引数`. */
const pathWords = (path: Path) => path.map(part => typeof part === 'number' ? `[${part + 1}]` : `.${part}`).join('').replace(/^\./u, '');
function placeOf(path: Path, hands: readonly unknown[]): string {
  if (path[0] !== 'hands' || typeof path[1] !== 'number') return pathWords(path) || '引数';
  const kind = plainRecord(hands[path[1]])?.do;
  const hand = `手${path[1] + 1}${typeof kind === 'string' ? `（${kind}）` : ''}`;
  const tail = pathWords(path.slice(2));
  return tail ? `${hand}の ${tail}` : hand;
}
/** What is wrong with one value against its own node (type, enum, bounds), not its children. */
function ownProblem(value: unknown, node: Schema, here: string): string | null {
  const type = typeof node.type === 'string' ? node.type : null;
  if (type && !fits(type, value)) {
    const wanted = type === 'array' && isPosSchema(node.items) ? '{x,y,z} の配列（1 つでも [ ]）'
      : type === 'object' && isPosSchema(node) ? '{x,y,z}' : TYPE_WORDS[type] ?? type;
    return `${here} は ${wanted}（今は ${kindOf(value)}）`;
  }
  return boundsProblem(value, node, here);
}
/** What is wrong with one value's enum and bounds. */
function boundsProblem(value: unknown, node: Schema, here: string): string | null {
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    return `${here} は ${node.enum.join('・')} のどれか（今は ${JSON.stringify(value)?.slice(0, 30)}）`;
  }
  if (typeof value === 'number' && outside(value, node.minimum, node.maximum)) {
    return `${here} は ${String(node.minimum ?? '')}〜${String(node.maximum ?? '')}（今は ${value}）`;
  }
  if (typeof value === 'string' && typeof node.maxLength === 'number' && value.length > node.maxLength) {
    return `${here} は ${node.maxLength} 字まで（今は ${value.length} 字）`;
  }
  if (Array.isArray(value) && outside(value.length, node.minItems, node.maxItems)) {
    return `${here} は ${String(node.minItems ?? 0)}〜${String(node.maxItems ?? '')} 個（今は ${value.length} 個）${value.length === 0 && typeof node.minItems === 'number' && node.minItems >= 1 ? '。使わないなら欄ごと書かない（空の [] は断られる）' : ''}`;
  }
  return null;
}
/** The words a model writes for the kind of a hand when it leaves `do` out (run 6: `{"type":"vertical",…}` sent twice, three seconds apart). */
const KIND_ALIASES = ['type', 'kind', 'op', 'action', 'hand'] as const;
/** A hand with no `do`: the kind it wrote under another name (named, with that kind's fields), or the shape of a hand and the kinds. */
function noDoProblem(object: Fields, extra: string[], here: string): string {
  const key = KIND_ALIASES.find(name => typeof object[name] === 'string' && Object.hasOwn(HAND_FIELDS, object[name] as string));
  if (key) {
    const kind = object[key] as HandKind;
    return `${here} に do が要る（${key} は無い欄。do に "${kind}" と書く）。${kind} の欄: ${handFieldNames(kind).join('・')}`;
  }
  return `${here}${here.endsWith('）') ? '' : ' '}の ${extra.join('・')} は無い欄。do が要る: json は {"do":"walk","to":{"x":1,"y":64,"z":2}} のように do（手の種類）から書く。`
    + `種類: ${Object.keys(HAND_FIELDS).join('・')}`;
}
/** A field an object does not take, said with the fields a hand of that kind takes. */
function extraProblem(object: Fields, properties: Fields, path: Path, here: string): string | null {
  const extra = Object.keys(object).filter(key => !(key in properties));
  if (!extra.length) return null;
  if (path.length === 2 && path[0] === 'hands' && typeof object.do !== 'string') return noDoProblem(object, extra, here);
  const names = path.length === 2 && path[0] === 'hands' && typeof object.do === 'string' ? handFieldNames(object.do as HandKind) : [];
  const may = names.length ? `。${String(object.do)} の欄: ${names.join('・')}` : '';
  // Run of 11/26 (6th): stopIf written inside a go (twice) and joined with & once; the go's fields are listed here, and stopIf is not one of them.
  const stop = extra.includes('stopIf') ? '（stopIf は act の欄で、手の中には書かない。条件は & でつながない: stopIf=hostileWithin=8 hpBelow=10 か json の "stopIf":{"hostileWithin":8,"hpBelow":10}）' : '';
  return `${here}${here.endsWith('）') ? '' : ' '}の ${extra.join('・')} は無い欄${extra.includes('why') ? '（why は act に 1 つ）' : ''}${stop}${may}`;
}

/** A hand's two counts that the schema caps (a go's or vertical's `maxDig` and `maxPlace`). */
const COUNT_KEYS = ['maxDig', 'maxPlace'] as const;
/**
 * Run 7 of 11/26 (a go with maxDig 250 and maxPlace 120 was refused for maxDig alone, and the retry with maxDig 200 was refused for maxPlace: the refusal names the
 * first field only, and says what the cap is, not what it is for): a count over its cap says what the cap is (the most one hand digs or places; a longer way is
 * a go cut in parts and stacked) and the other cap beside it, so a retry looks at both before it is sent. Only the first field is named; no second one is
 * judged here.
 */
function limitNote(problem: string, value: unknown, node: Schema, path: Path, parent: Schema | undefined): string {
  const key = path[2];
  if (path[0] !== 'hands' || path.length !== 3 || typeof key !== 'string' || !(COUNT_KEYS as readonly string[]).includes(key)
    || typeof value !== 'number' || !outside(value, node.minimum, node.maximum)) return problem;
  const other = COUNT_KEYS.filter(name => name !== key).flatMap(name => {
    const cap = plainRecord(parent?.[name])?.maximum;
    return typeof cap === 'number' ? [`${name} は ${cap} まで`] : [];
  });
  return `${problem}。上限は 1 手で掘る・置く数の最大で、足りない道は go を区切って続けて積む。同じ手の ${other.join('・') || 'ほかの数'} も上限を確かめてから出し直す`;
}

/**
 * Where an input leaves the schema, in one line (closed words, Japanese): the first field that does not fit, by its place
 * (`手3（chest）の at`), what it must be and what it is now. Null when it fits. For the subset the tools' schemas use (object, array,
 * string, number, integer, boolean, enum, bounds, required, no other fields).
 */
export function schemaProblem(input: unknown, schema: Schema): string | null {
  const record = plainRecord(input);
  const hands = Array.isArray(record?.hands) ? record!.hands as unknown[] : [];
  const walk = (value: unknown, node: Schema, path: Path, parent?: Schema): string | null => {
    const here = placeOf(path, hands);
    const own = ownProblem(value, node, here);
    if (own) return limitNote(own, value, node, path, parent);
    const items = plainRecord(node.items);
    if (Array.isArray(value)) {
      return items ? value.reduce<string | null>((found, item, index) => found ?? walk(item, items, [...path, index]), null) : null;
    }
    const object = plainRecord(value), properties = plainRecord(node.properties);
    if (!object || !properties) return null;
    const extra = node.additionalProperties === false ? extraProblem(object, properties, path, here) : null;
    if (extra) return extra;
    const missing = (Array.isArray(node.required) ? node.required as string[] : []).find(key => object[key] === undefined);
    // A hand with no `do` and no stray field (e.g. only `op`): the same shape and kinds, so the retry is not the same refusal again.
    if (missing === 'do' && path.length === 2 && path[0] === 'hands') {
      return `${here} に do が要る。json は {"do":"walk","to":{"x":1,"y":64,"z":2}} のように do（手の種類）から書く。種類: ${Object.keys(HAND_FIELDS).join('・')}`;
    }
    if (missing) return `${here} に ${missing} が要る`;
    return Object.entries(properties).reduce<string | null>((found, [key, child]) => found
      ?? (object[key] === undefined || !plainRecord(child) ? null : walk(object[key], child as Schema, [...path, key], properties)), null);
  };
  return walk(input, schema, []);
}
