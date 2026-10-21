import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { minecraftObservationSummary, MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS } from './minecraftObservationSummary.js';

/**
 * What a transient body task stores of a body tool's result (observation redesign P3, `SHANNON_FCA_OBS_MODE=transient`; the old Minebot
 * cut each result at 2,000 characters, ShannonExecutor.ts:1316): every history round is replayed (and priced, and signed over) for
 * the rest of the task, and `minecraft.observe` alone returns a frame of some 43,000 characters. A body result is stored cut at
 * 2,000 characters; the observation, in the summary form of 6,000 at most (`minecraftObservationSummary`). The cut is marked with the
 * number of characters left out. The tool's own result, its evidence and its measurements keep the whole text; only the round does not.
 */
export const STORED_BODY_RESULT_CHARACTERS = 2_000;
/** `mc.view`: its whole map (the body's bound is 6,000 cells, about 13,000 characters). */
export const STORED_VIEW_CHARACTERS = 16_000;
const marked = (original: string, kept: string) => kept.length < original.length ? `${kept}…(${original.length - kept.length}文字省略)` : kept;

/** The first `limit` characters, never ending between the halves of a surrogate pair (a lone half is refused by the provider). */
function head(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return /[\uD800-\uDBFF]/u.test(value[limit - 1] ?? '') ? value.slice(0, limit - 1) : value.slice(0, limit);
}

function observation(text: string): BodyObservation | null {
  try {
    const value = JSON.parse(text) as Partial<BodyObservation> | null;
    return value && typeof value === 'object' && value.state && typeof value.state === 'object' && value.facts && typeof value.facts === 'object'
      ? value as BodyObservation : null;
  } catch { return null; }
}

/**
 * The retry hint a failed body skill ends its text with (`minecraftOutcome.ts`: `［再試行の目安: retry_same｜…］` after a line break). It is the
 * outcome of the call, so a cut never takes it (review 6, L-1): the body of the text is cut and the hint stays at the end.
 */
const RETRY_HINT_TAIL = /\n［再試行の目安: [A-Za-z_]{1,40}｜[^］\n]{0,120}］\s*$/u;

/** A body result cut at `STORED_BODY_RESULT_CHARACTERS`; a trailing retry hint is kept whole and counts inside the limit. */
function cutBodyResult(text: string): string {
  if (text.length <= STORED_BODY_RESULT_CHARACTERS) return text;
  const match = RETRY_HINT_TAIL.exec(text);
  if (!match) return marked(text, head(text, STORED_BODY_RESULT_CHARACTERS));
  const tail = match[0].trimEnd(), body = text.slice(0, match.index);
  const cut = `${marked(body, head(body, STORED_BODY_RESULT_CHARACTERS - tail.length))}${tail}`;
  return cut.length < text.length ? cut : text; // Never longer than what was cut.
}

/** A body tool is one of `mc.*` and `minecraft.*`; any other tool's result is stored as it is. */
export function storedBodyResult(name: string, text: string): string {
  if (!name.startsWith('mc.') && !name.startsWith('minecraft.')) return text;
  // A view (design mb-llm-centric 2.2) is read once, whole: the map it asked for is the reason it was called.
  if (name === 'mc.view') return marked(text, head(text, STORED_VIEW_CHARACTERS));
  if (name === 'mc.act') return marked(text, head(text, 2 * STORED_BODY_RESULT_CHARACTERS));
  if (name === 'minecraft.observe') {
    const frame = observation(text);
    const summary = frame ? JSON.stringify(minecraftObservationSummary(frame)) : text;
    return marked(text, head(summary, MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS));
  }
  return cutBodyResult(text);
}
