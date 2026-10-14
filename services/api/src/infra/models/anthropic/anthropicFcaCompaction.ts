import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';

/**
 * The current decision message, shortened before it is sent when the whole request is estimated above `compactAboveTokens`
 * (`AnthropicFcaOptions`), so that a request stays under Haiku's long-prompt price step (100,000 input tokens priced at five times
 * the rate, `claudeUsage.ts`). The replay is bounded below the step by its own policy (`maximumReplayTokens`); what can still pass it
 * is the decision message itself (the recall packet, the outcomes, the body's and the observations' reports, the catalog) with the
 * fixed instructions and new definitions. The replay is never touched: its signed blocks keep their prefix.
 *
 * The longest texts of the shortened parts are cut to one common length, the highest at which the request fits (found by halving),
 * never below `FLOOR_CHARACTERS`, each cut marked with how much was left out. Ids, names and numbers stay whole (no id reaches the
 * floor). What the owner wrote (`messages`), the task itself, its children's titles and summaries, the clock and the fixed rules
 * are never cut.
 *
 * The whole request is measured once. The estimate (`estimatedAnthropicTokens`) counts characters, so the request with another
 * decision message is that measure less the first message's and plus the other's: each halving measures only the message. The message is stored as it
 * was sent, so a later decision restates a part in full rather than naming the shortened one as unchanged (`elidedDecision`).
 */
export const FCA_COMPACT_ABOVE_TOKENS = 95_000;
const FLOOR_CHARACTERS = 400;
const KEPT_WHOLE = new Set(['task', 'messages', 'children', 'ownerClock', 'waiting', 'contextInstructions', 'progressInstructions']);
/** The most halvings of the common length (each measures only the decision message): enough for texts of up to about 4 MB. */
const MAX_HALVINGS = 22;
const CUT = (omitted: number) => `…（長いため後略: ${omitted}字）`;

/**
 * The decision fields to send: as given when the request (`requestTokens`, measured with `fields`) fits, else the highest common
 * cut that fits, else the floor (the best it can do).
 */
export function compactedDecision(fields: Record<string, unknown>, requestTokens: number,
  maximum: number): { fields: Record<string, unknown>; level: number | null } {
  if (requestTokens <= maximum) return { fields, level: null };
  // The message travels as a JSON string inside the request: measured as that string, with its escapes.
  const message = (sent: Record<string, unknown>) => estimatedAnthropicTokens(JSON.stringify(sent));
  // Each measure rounds up once, so the sum may fall one token short of the whole; one token of room covers it.
  const rest = requestTokens - message(fields), fits = (sent: Record<string, unknown>) => rest + message(sent) + 1 <= maximum;
  const at = (level: number) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, KEPT_WHOLE.has(key) ? value : cutTexts(value, level)]));
  const floor = at(FLOOR_CHARACTERS);
  if (!fits(floor)) return { fields: floor, level: FLOOR_CHARACTERS };
  let low = FLOOR_CHARACTERS, high = Math.max(low, longestText(fields)), best = floor;
  for (let halvings = 0; low < high && halvings < MAX_HALVINGS; halvings++) {
    const level = Math.ceil((low + high) / 2), candidate = at(level);
    if (fits(candidate)) {
      low = level;
      best = candidate;
    } else high = level - 1;
  }
  return { fields: best, level: low };
}

/** Every string longer than `level` cut to it and marked, never inside a surrogate pair; structure, keys and other values as they were. */
function cutTexts(value: unknown, level: number): unknown {
  if (typeof value === 'string') {
    if (value.length <= level) return value;
    const keep = /[\uD800-\uDBFF]/u.test(value[level - 1] ?? '') ? level - 1 : level;
    const cut = `${value.slice(0, keep)}${CUT(value.length - keep)}`;
    return cut.length < value.length ? cut : value;
  }
  if (Array.isArray(value)) return value.map(item => cutTexts(item, level));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutTexts(item, level)]));
  return value;
}

function longestText(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce<number>((longest, item) => Math.max(longest, longestText(item)), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((longest, item) => Math.max(longest, longestText(item)), 0);
  return 0;
}

/** The threshold from the environment (`SHANNON_FCA_COMPACT_ABOVE_TOKENS`): a positive whole number, else the default. */
export function fcaCompactAboveTokens(value: string | undefined): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FCA_COMPACT_ABOVE_TOKENS;
}
