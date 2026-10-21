import { PLAN_LIMITS } from '@shannon/mind';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import { readProbeResult, type ProbeInput } from '../../contracts/minecraftProbeContract.js';
import { finite, plain, posText, readPos } from './minecraftLlmcProbeInput.js';

/**
 * mb-llmc r5 (run 28: the same answer, 「(175,53,197) stone：見えない。間に固いブロック 1：(174,54,197) stone」, came 15 times or more, and the
 * next act dug two ahead again; neither a forbid nor a caution was ever written): at the second time the same surprise comes, the head's
 * code writes what was found as a fact on the current plan node's caution (`FcaPlanPort.amend`, at most 4, the oldest goes). A fact, not a
 * decision: what is not seen, where a walk did not arrive, where a path breaks. Never a word of what to dig (arch-check 6, S1).
 */
export interface CautionSource {
  /** The surprise's closed code (`repeat`, `dig`, `miss`, `found`; the dangers are said by the live state). */
  code: string;
  /** How many times this same surprise has come (this one included). */
  nth: number;
  /** The stopped hand as the act's result said it: its kind, where it went or aimed, and its line. */
  hand?: { do: string; aim: ActPos | null; line: string } | null;
}
/** Surprises whose fact is noted at their second coming. */
export const CAUTION_CODES: ReadonlySet<string> = new Set(['repeat', 'dig', 'miss', 'found']);

const cut = (text: string) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= PLAN_LIMITS.rule ? flat : `${flat.slice(0, PLAN_LIMITS.rule - 1)}…`;
};
/** A sight's fact: the target not seen (and the first block between), or seen but out of reach. */
function sightFact(fields: Record<string, unknown>): string | null {
  const target = plain(fields.target), at = readPos(target?.at ?? target);
  const name = typeof target?.name === 'string' ? ` の ${target.name}` : '';
  const between = (Array.isArray(fields.between) ? fields.between : []).map(item => plain(item)).find(item => item && readPos(item.at));
  if (fields.visible === false && between && at) {
    return `${posText(at)}${name} は見えない: 間に ${typeof between.name === 'string' ? between.name : 'ブロック'} ${posText(readPos(between.at)!)}`;
  }
  const distance = finite(fields.distance), limit = finite(fields.reachLimit);
  if (fields.visible === true && fields.reach === false && at && distance !== null) {
    return `${posText(at)}${name} は目から ${Math.round(distance * 10) / 10}m: 手が届かない${limit !== null ? `（${limit}m まで）` : ''}`;
  }
  return null;
}
/**
 * A path's fact: the place not reached on foot and its first break; or (the body's r5, `onTarget: false`) a target she cannot stand on,
 * in the body's own first sentence (「的そのものには立てない（下 2 マスが空気（立つ床が無い））」).
 */
function pathFact(fields: Record<string, unknown>, probe: ProbeInput): string | null {
  if (!probe.to) return null;
  if (fields.onTarget === false && typeof fields.text === 'string' && fields.text.startsWith('的そのものには立てない')) {
    return `${posText(probe.to)}: ${fields.text.split('。')[0]}`;
  }
  if (fields.reachable !== false) return null;
  const first = plain((Array.isArray(fields.breaks) ? fields.breaks : [])[0]);
  const why = typeof first?.text === 'string' ? first.text : typeof first?.reason === 'string' ? first.reason : '';
  return `${posText(probe.to)} へは掘らず置かずに歩いて行けない${why ? `: ${why}` : ''}`;
}

/**
 * The fact to note for a surprise met again (`nth` 2 or more), from its probes' answers first (a sight, a path), else from the stopped
 * hand's own line; null for a first time, a danger, or nothing to say. At most `PLAN_LIMITS.rule` characters.
 */
export function cautionFact(source: CautionSource, probes: readonly ProbeInput[], answers: ReadonlyArray<string | null | undefined>): string | null {
  if (source.nth < 2 || !CAUTION_CODES.has(source.code)) return null;
  for (const [index, probe] of probes.entries()) {
    const read = readProbeResult(answers[index] ?? undefined);
    if (!read || read.kind === undefined) continue;
    const fields = read as unknown as Record<string, unknown>;
    const fact = probe.kind === 'sight' ? sightFact(fields) : probe.kind === 'path' ? pathFact(fields, probe) : null;
    if (fact) return cut(fact);
  }
  const hand = source.hand;
  if (!hand?.line) return null;
  // The place first, unless the body's line already names it (its r5 words do).
  const place = hand.aim && !hand.line.includes(posText(hand.aim)) ? `${posText(hand.aim)} の ` : '';
  return cut(`${place}${hand.do}: ${hand.line}`);
}
