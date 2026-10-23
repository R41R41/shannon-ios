/**
 * mb-llmc v2 `body.repeat` (ADR-0014 D7 「同じ失敗の繰り返しは、全文ではなく『試した手・引数・原因・見えた変化・同じやり直しの禁止』にまとめて渡す」;
 * 再現台の A: 直前に「見られる」で止まったマスを exposeOk でまた掘る、置けなかった橋を onFail continue のまま出し直す、「届かない」の attack を続ける):
 * the stops that came again, said in one line each, from the live state alone (the body's `stops` with its counts, the last act's stopped lines
 * in `lastResults`, and the head's investigation line 「同じ止まりの N 回目」). Facts only: the line says what stopped and how many times; the
 * hand is the decision's. At most three lines, the most often first; a stop that happened once is not said.
 */
type Rec = Record<string, unknown>;
export const REPEAT_LINES = 3;
interface Tried { do: string | null; reason: string; cell: string | null; target: string | null; count: number }

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const CELL = /\((-?\d+,-?\d+,-?\d+)\)/u;

/** The body's recent stops: `(a)→(b) 理由 ×N 15秒前`, the stop's cell, its word and how many times. */
function stopsOf(list: readonly string[]): Array<{ cell: string; reason: string; count: number }> {
  return list.flatMap(line => {
    const m = /^(?:\([-\d,]+\)→)?\((-?\d+,-?\d+,-?\d+)\) (\S+?)(?: ×(\d+))? \d+秒前$/u.exec(line);
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
