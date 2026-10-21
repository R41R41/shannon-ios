import { handFieldNames, type HandKind } from '../../contracts/minecraftActContract.js';

/**
 * The act as the model writes it, made ready for the body (r2, 2026-10-22; contract `minecraftActContract.ts`): put into the contract's
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

/** One plain fix of a field: whether it applies to the value, the value made right, and what to say (`{name}` is the hand or act). */
interface Fix { key: string; when(value: unknown): boolean; make(value: unknown): unknown; say: string }
const listOf = (key: string, when: (value: unknown) => boolean): Fix => ({ key, when, make: value => [value], say: `${key} を配列にした` });
const ACT_FIXES: readonly Fix[] = [
  listOf('hands', value => !!plainRecord(value)),
  listOf('accept', value => typeof value === 'string'),
  { key: 'why', when: value => typeof value === 'string' && value.length > 120, make: value => String(value).slice(0, 120), say: 'why を 120 字に切った' },
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
 * The act as the model wrote it, put into the contract's shape where what it meant is plain (scene replay 2026-10-21: Haiku wrote `why`
 * in a hand 4 times in 12 and the act was refused whole; Sonnet wrote one `at` as an object). Each fix is said in one line, for the
 * result the model reads. What is not plain is left as written (`llmcInputProblem` then says where it is wrong).
 * - a hand's `why`: taken out (the act's `why` when it has none); `note` past 40 characters: cut;
 * - `at`, `path`, `stopIf.blockChanged`: one {x,y,z} → a list of it; `to`: a list of one {x,y,z} → it;
 * - `items`: one {item} or a name → a list of it; `target`: a number → `#id`; `accept`: one name → a list; `hands`: one hand → a list.
 */
export function normalizeActInput(input: unknown): { input: unknown; fixes: string[] } {
  const act = plainRecord(input);
  if (!act) return { input, fixes: [] };
  const fixes: string[] = [];
  const out = applyFixes(act, ACT_FIXES, fixes, '');
  const stopIf = plainRecord(out.stopIf);
  if (stopIf) out.stopIf = applyFixes(stopIf, [listOf('blockChanged', isPos)], fixes, 'stopIf');
  if (Array.isArray(out.hands)) {
    out.hands = out.hands.map((value, index) => {
      const hand = plainRecord(value);
      if (!hand) return value;
      const fixed = { ...hand };
      moveWhy(out, fixed, `手${index + 1}`, fixes);
      return applyFixes(fixed, HAND_FIXES, fixes, `手${index + 1}`);
    });
  }
  return { input: fixes.length ? out : input, fixes };
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
    return `${here} は ${String(node.minItems ?? 0)}〜${String(node.maxItems ?? '')} 個（今は ${value.length} 個）`;
  }
  return null;
}
/** A field an object does not take, said with the fields a hand of that kind takes. */
function extraProblem(object: Fields, properties: Fields, path: Path, here: string): string | null {
  const extra = Object.keys(object).filter(key => !(key in properties));
  if (!extra.length) return null;
  const names = path.length === 2 && path[0] === 'hands' && typeof object.do === 'string' ? handFieldNames(object.do as HandKind) : [];
  const may = names.length ? `。${String(object.do)} の欄: ${names.join('・')}` : '';
  return `${here}${here.endsWith('）') ? '' : ' '}の ${extra.join('・')} は無い欄${extra.includes('why') ? '（why は act に 1 つ）' : ''}${may}`;
}

/**
 * Where an input leaves the schema, in one line (closed words, Japanese): the first field that does not fit, by its place
 * (`手3（chest）の at`), what it must be and what it is now. Null when it fits. For the subset the tools' schemas use (object, array,
 * string, number, integer, boolean, enum, bounds, required, no other fields).
 */
export function schemaProblem(input: unknown, schema: Schema): string | null {
  const record = plainRecord(input);
  const hands = Array.isArray(record?.hands) ? record!.hands as unknown[] : [];
  const walk = (value: unknown, node: Schema, path: Path): string | null => {
    const here = placeOf(path, hands);
    const own = ownProblem(value, node, here);
    if (own) return own;
    const items = plainRecord(node.items);
    if (Array.isArray(value)) {
      return items ? value.reduce<string | null>((found, item, index) => found ?? walk(item, items, [...path, index]), null) : null;
    }
    const object = plainRecord(value), properties = plainRecord(node.properties);
    if (!object || !properties) return null;
    const extra = node.additionalProperties === false ? extraProblem(object, properties, path, here) : null;
    if (extra) return extra;
    const missing = (Array.isArray(node.required) ? node.required as string[] : []).find(key => object[key] === undefined);
    if (missing) return `${here} に ${missing} が要る`;
    return Object.entries(properties).reduce<string | null>((found, [key, child]) => found
      ?? (object[key] === undefined || !plainRecord(child) ? null : walk(object[key], child as Schema, [...path, key])), null);
  };
  return walk(input, schema, []);
}
