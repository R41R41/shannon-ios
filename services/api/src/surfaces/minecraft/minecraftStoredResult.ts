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

/** A body tool is one of `mc.*` and `minecraft.*`; any other tool's result is stored as it is. */
export function storedBodyResult(name: string, text: string): string {
  if (!name.startsWith('mc.') && !name.startsWith('minecraft.')) return text;
  if (name === 'minecraft.observe') {
    const frame = observation(text);
    const summary = frame ? JSON.stringify(minecraftObservationSummary(frame)) : text;
    return marked(text, head(summary, MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS));
  }
  return marked(text, head(text, STORED_BODY_RESULT_CHARACTERS));
}
