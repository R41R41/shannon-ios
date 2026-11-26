/**
 * mb-llmc v2 `body.repeat` (ADR-0014 D7 「同じ失敗の繰り返しは、全文ではなく『試した手・引数・原因・見えた変化・同じやり直しの禁止』にまとめて渡す」;
 * 再現台の A: 直前に「見られる」で止まったマスを exposeOk でまた掘る、置けなかった橋を onFail continue のまま出し直す、「届かない」の attack を続ける):
 * the stops that came again, said in one line each, from the live state alone (the body's `stops` with its counts, the last act's stopped lines
 * in `lastResults`, and the head's investigation line 「同じ止まりの N 回目」). Facts only: the line says what stopped and how many times; the
 * hand is the decision's. At most three lines, the most often first; a stop that happened once is not said.
 */
import { readActResult } from '../../contracts/minecraftActContract.js';
type Rec = Record<string, unknown>;
export const REPEAT_LINES = 3;
interface Tried { do: string | null; reason: string; cell: string | null; target: string | null; count: number }

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const CELL = /\((-?\d+,-?\d+,-?\d+)\)/u;

/**
 * The code of a stopped hand beside the body's word for it (run of 11/26: the body's stop line said only 「(126,62,-320) 無い 4秒前」 for a fight that stopped
 * `enderman_not_visible` and for a digging that stopped `support_not_removed`, so 「目が見えない」 and 「道が無い」 read the same). The body's words are its closed ones and
 * stay; the hand's own code, which the result of the act says, is put after them: `(126,62,-320) 無い 4秒前（enderman_not_visible）`.
 */
export interface StopCode { cell: string; word: string; code: string }
export const STOP_CODES_KEPT = 12;
const CODE_AT_END = /（([A-Za-z][\w:.-]*)）$/u;
/** The word a hand's line starts with (`無い: fight 止まった …` → 「無い」), as the body's stop line says it. */
const wordOf = (line: string): string | null => /^([^:：\s（(]+)[:：]/u.exec(line)?.[1] ?? null;
/** The code, the word and the cell of each stopped or failed hand of an act's result (the cell the hand says, else where she stands after the act). */
export function stopCodesOf(resultJson: string | undefined): StopCode[] {
  const result = readActResult(resultJson);
  if (!result) return [];
  return result.lines.flatMap(line => {
    const word = wordOf(line.line), spot = line.where ?? result.at;
    if ((line.status !== 'stopped' && line.status !== 'failed') || !line.code || !word || !spot) return [];
    return [{ cell: `${Math.floor(spot.x)},${Math.floor(spot.y)},${Math.floor(spot.z)}`, word, code: line.code }];
  });
}
/** The body's stop lines with the code of the hand that stopped there (the newest code of the same cell and word) after each; a line with none, or one the code is already in, is as it was. */
export function withStopCodes(lines: readonly string[], codes: readonly StopCode[]): string[] {
  if (!codes.length) return [...lines];
  return lines.map(line => {
    const m = /^(?:\([-\d,]+\)→)?\((-?\d+,-?\d+,-?\d+)\) (\S+?)(?: ×\d+)? \d+秒前$/u.exec(line);
    const found = m ? [...codes].reverse().find(entry => entry.cell === m[1] && entry.word === m[2]) : undefined;
    return found && found.code !== m![2] ? `${line}（${found.code}）` : line;
  });
}

/** The body's recent stops:`(a)→(b) 理由 ×N 15秒前`, the stop's cell, its word and how many times. */
export function stopsOf(list: readonly string[]): Array<{ cell: string; reason: string; count: number }> {
  return list.flatMap(raw => {
    const line = raw.replace(CODE_AT_END, '');
    const m =/^(?:\([-\d,]+\)→)?\((-?\d+,-?\d+,-?\d+)\) (\S+?)(?: ×(\d+))? \d+秒前$/u.exec(line);
    return m ? [{ cell: m[1]!, reason: m[2]!, count: m[3] ? Number(m[3]) : 1 }] : [];
  });
}
/**
 * The stopped or failed hands of a result text: `3 dig 止 見られる: (308,66,73)（…`, the hand's kind, the word, a cell or a creature. mb-llmc-cand 3: a walk's
 * stop may carry its cause right after the word (`一歩ではない（元: 水の中・…）: 本文`, up to 260 characters); the cause is left out of the cell it reads.
 */
function stoppedHands(text: string): Array<{ do: string; reason: string; cell: string | null; target: string | null }> {
  return text.split('\n').flatMap(line => {
    const m = /^(\d+) (\w+) (?:止|失) ([^:：\s（(]+)(?:（元:.*?）(?=[:：]))?[:：]?\s*(.*)$/u.exec(line);
    if (!m) return [];
    const rest = m[4] ?? '';
    const creature = /([a-z_]+)（id (\d+)）/u.exec(rest);
    return [{ do: m[2]!, reason: m[3]!, cell: CELL.exec(rest)?.[1] ?? null, target: creature ? `${creature[1]} #${creature[2]}` : null }];
  });
}
/** The investigation line 「同じ止まりの 4 回目: attack「届かない」」. */
function surprises(list: readonly string[]): Array<{ do: string; reason: string; count: number }> {
  return list.flatMap(line => {
    const m = /同じ止まりの (\d+) 回目: (\w+)「([^」]+)」/u.exec(line);
    return m ? [{ do: m[2]!, reason: m[3]!, count: Number(m[1]) }] : [];
  });
}

/** What came again, from the body's live state: items with a count of two or more. */
export function triedAgain(body: Rec): Tried[] {
  const stops = stopsOf(strings(body.stops));
  const items: Tried[] = [];
  const add = (item: Tried) => {
    const sameHand = (other: Tried) => other.cell === item.cell || (item.do && other.do === item.do && !item.cell && !other.cell);
    const same = items.find(other => other.reason === item.reason && sameHand(other));
    if (same) {
      same.count = Math.max(same.count, item.count);
      same.do ??= item.do;
      same.target ??= item.target;
    } else items.push(item);
  };
  for (const text of strings(body.lastResults)) {
    for (const hand of stoppedHands(text)) {
      const known = stops.find(stop => stop.reason === hand.reason && hand.cell === stop.cell);
      add({ do: hand.do, reason: hand.reason, cell: hand.cell, target: hand.target, count: known?.count ?? 1 });
    }
  }
  for (const found of surprises(strings(body.investigation))) {
    const hand = items.find(item => item.do === found.do && item.reason === found.reason);
    add({ do: found.do, reason: found.reason, cell: hand?.cell ?? null, target: hand?.target ?? null, count: found.count });
  }
  for (const stop of stops) add({ do: null, reason: stop.reason, cell: stop.cell, target: null, count: stop.count });
  return items.filter(item => item.count >= 2).sort((a, b) => b.count - a.count);
}

/** `同じやり直しはしない: (308,66,73) の dig は「見られる」で 2 回止まった`, at most three. Empty when nothing came again. */
export function repeatedFailures(body: Rec): string[] {
  return triedAgain(body).slice(0, REPEAT_LINES).map(item => {
    const kind = item.do ? ` ${item.do} は` : '手は';
    const what = item.cell ? `(${item.cell}) の${kind}` : `${item.do ?? '手'}${item.target ? `（${item.target}）` : ''}は`;
    return `同じやり直しはしない: ${what}「${item.reason}」で ${item.count} 回止まった`;
  });
}
