import type { CutBy, Handover, ItemOutcome, Progress } from '../../contracts/continueContract.js';
import type { ActHandLine, ActResult } from '../../contracts/minecraftActContract.js';

/**
 * The words of a result that the contract's two axes make possible (continue contract 1 and 2; chapter 8's 再開): what a hand aimed at and how its run ended, how far it
 * got, where it stopped, what a reflex handed over, and what a unit whose result is not known (or corrected) is told as. **Facts only**: every sentence says what is
 * (or what the body could not see) and none says what to do; what to do next is the model's. Each line starts with `  事実:` so the history keeps it with the hand's line.
 */
const FACT = '  事実: ';
const CUT_WORDS: Readonly<Record<CutBy, string>> = { reflex: '反射', stopIf: 'stopIf', inventoryFull: '持ち物が満杯', cancelled: '取り消し', deadline: '期限', noProgress: '進みなし',
  damage: 'ダメージ', fall: '落下', death: '死んだ', stale_life: '前の命の命令', dimension_changed: '次元が変わった', lease_expired: 'lease が切れた', connection_changed: '体のつなぎ直し',
  operator_stop: '操作者の止め', handover: '引き継ぎ' };
const UNIT_WORDS: Readonly<Record<Progress['unit'], string>> = { step: '段', block: 'マス', item: '個', meter: ' m', blow: '打', second: '秒' };
/** A number to one decimal without a trailing `.0` (35.9, 27.5, 10). */
const num = (value: number): string => String(Math.round(value * 10) / 10);
const at = (cell: { x: number; y: number; z: number }) => cell && typeof cell === 'object' ? `(${cell.x},${cell.y},${cell.z})` : String(cell);

/** The last path search of a go, as the model reads it: found, partial, timed out (with the cells round the goal that nothing can pass), none. */
function searchWords(search: NonNullable<Progress['lastSearch']>): string {
  const base = search.status === 'success' ? `道は見つかっていた（${search.len} 歩）`
    : search.status === 'partial' ? `道は途中まで見つかった（${search.len} 歩）`
      : search.status === 'timeout' ? `道探しは時間切れ（道 ${search.len} マス・${search.nodes} ノード・${search.ms} ms）`
        : `道は無かった（道 ${search.len} マス・${search.nodes} ノード）`;
  const around = search.blockedAround?.length
    ? `。行き先の周り: ${search.blockedAround.map(cell => `${at(cell.at)} ${cell.block}（${cell.diggable ? '掘れる' : '掘れない'}）`).join('・')}` : '';
  return `最後の道探し: ${base}${search.endM !== undefined ? `（先端から行き先まで ${num(search.endM)} m）` : ''}${around}`;
}
/** How far a hand got: the amount done and left, where it stopped, the work it did, the last search. */
export function progressWords(progress: Progress): string {
  const unit = UNIT_WORDS[progress.unit];
  const parts: string[] = [];
  if (progress.unit === 'meter' && progress.fromStopM !== undefined) {
    parts.push(`進んだ ${num(progress.done)} m`, `${progress.at ? `止まった位置 ${at(progress.at)} から` : '止まった位置から'}行き先まで ${num(progress.fromStopM)} m`
      + `${progress.searchEndM !== undefined ? `（道探しの先端からは ${num(progress.searchEndM)} m）` : ''}`);
  } else {
    parts.push(`進んだ ${num(progress.done)}${unit}`, progress.left === null ? '残りは分からない' : `残り ${num(progress.left)}${unit}`);
    if (progress.at) parts.push(`止まった位置 ${at(progress.at)}`);
  }
  const work = progress.work;
  if (work) {
    const made = [`掘 ${work.dug}`, ...(work.placed !== undefined ? [`置 ${work.placed}`] : []),
      ...(work.placeAttempts !== undefined ? [`置きの送り ${work.placeAttempts}`] : []), ...(work.placedConfirmed !== undefined ? [`確かめた置き ${work.placedConfirmed}`] : []),
      ...(work.stockUsed !== undefined ? [`使った在庫 ${work.stockUsed}`] : [])];
    parts.push(made.join(' '));
  }
  if (progress.lastSearch) parts.push(searchWords(progress.lastSearch));
  return parts.join('・');
}
/** What a code the body names for a hand that did not start or lost its target says when it is a closed one the model may not know. */
function codeWords(line: ActHandLine): string {
  const code = line.code ?? '';
  if (code === 'cleanup_stop') return '片付けの stop で止めた・捨てた（結果として確定。さっきの不明が後で分かっても戻らない）';
  const depends = /^depends_(failed|unknown):(\d+)$/u.exec(code);
  if (depends) return depends[1] === 'failed' ? `頼る手 ${depends[2]} が済まなかったので動かさなかった` : `頼る手 ${depends[2]} の結果が分からないので動かさなかった`;
  return code;
}

/** The fact lines of a hand: only what its two axes add to the line the body wrote (a plain done or a plain failure adds none). */
export function handFacts(line: ActHandLine): string[] {
  const out: string[] = [];
  const cutBy = line.cutBy ? CUT_WORDS[line.cutBy] : '';
  switch (line.goal) {
    case 'already': out.push(`既に済${line.code ? `（${line.code}）` : ''}: この手を始めた時にはもうねらいを満たしていた。何も変えていない`); break;
    case 'partial': out.push(`途中まで${line.progress ? `: ${progressWords(line.progress)}` : ''}${line.end === 'cut' && cutBy ? `（${cutBy}で止められた）` : ''}`); break;
    case 'not_started':
      out.push(line.end === 'not_run' ? `始めていない${codeWords(line) ? `（${codeWords(line)}）` : ''}`
        : `始めていない（手は呼んだが体を動かす操作は 0）${line.code ? `。理由: ${line.code}` : ''}${line.progress ? `。${progressWords(line.progress)}` : ''}`);
      break;
    case 'unknown': out.push(`結果は不明${line.code === 'target_lost' ? '（相手を見失った。倒したかは見ていない）' : line.code ? `（${line.code}）` : ''}`); break;
    case 'failed': if (line.progress) out.push(`進んでいない: ${progressWords(line.progress)}`); break;
    default: break;
  }
  if (line.goal !== 'partial' && line.end === 'cut' && cutBy) out.push(`外から止められた（${cutBy}）`);
  if (line.code === 'cleanup_stop' && line.goal !== 'not_started') out.push(codeWords(line));
  return out.map(text => `${FACT}${text}`);
}

const SHIELD_WORDS: Readonly<Record<Handover['shield'], string>> = { kept: '盾は下げなかった', lowered: '盾が下がった', none: '盾は構えていなかった' };
/** The fact lines of the act as a whole: what a reflex handed over. */
export function actFacts(result: ActResult): string[] {
  const out: string[] = [];
  const handover = result.handover;
  if (handover) {
    out.push(`${FACT}反射 ${handover.from} から引き継いだ: 相手 #${handover.target} を ${num(handover.waitedMs / 1000)} 秒待った後、`
      + `${handover.confirmed ? '同じ相手と確かめて続けた' : '同じ相手とは確かめられなかった'}・${SHIELD_WORDS[handover.shield]}`);
  }
  if (result.earlierPasses) {
    out.push(`${FACT}古い周回 ${result.earlierPasses.passes} 回分（手の行 ${result.earlierPasses.lines}、済 ${result.earlierPasses.done}、失 ${result.earlierPasses.failed}）は数だけにまとめた`);
  }
  return out;
}

/** Why a queue item the body dropped did not run: the item that stopped, or the cause (death, another dimension…). */
export function droppedWords(because: NonNullable<ItemOutcome['droppedBecause']>): string {
  const by = because.item ? because.item.item : '前の項目';
  switch (because.code) {
    case 'depends_failed': return `頼る項目 ${by} が止まった`;
    case 'depends_unknown': return `頼る項目 ${by} の結果が分からない`;
    case 'death': return '死んだ（命が変わった）';
    case 'stale_life': return '前の命で作った命令だった';
    case 'dimension_changed': return '次元が変わった';
    case 'connection_changed': return '体か頭がつなぎ直した';
    case 'lease_expired': return 'lease が切れた';
    case 'operator_stop': case 'cancelled': return '止められた';
    default: return CUT_WORDS[because.code as CutBy] ?? because.code;
  }
}
/** The fact line of an item the body kept going although one before it stopped (it did not rely on it). */
export const keptWords = (kept: NonNullable<ItemOutcome['keptDespite']>): string =>
  `${FACT}${kept.item.item} が止まった（${kept.code}）が、この項目は頼っていなかったので動かした`;

/** What a unit whose result is not known is told as, while the body is being stopped (the model must not take it for done or for failed). */
export const unknownWords = (label?: string): string =>
  `${label ? `${label}: ` : ''}結果は不明（解放を確かめていない）。自動では出し直さない。体を止める片付けを送った。世界は見て確かめる`;
/** The unit's release was proved by the cleanup (or the new connection) and its result is still not known. */
export const releasedWords = (label?: string): string => `${label ? `${label}: ` : ''}解放を確かめた（結果は不明のまま）。出し直していない`;
/** The unit's cleanup did not prove the release in time: the task is held for the operator. */
export const heldWords = (label?: string): string => `${label ? `${label}: ` : ''}解放を確かめられなかった（片付けが期限内に済まなかった）。保留にして操作者を待つ`;
/** The real result came after an unknown one. `summary` is the first line of the result as it reads. */
export const correctionWords = (label: string, summary: string): string => `訂正: ${label} の結果は ${summary} だった（さっきの「不明」はこれで置き換わる）`;

/** The first line of a resent act's result: whose second try it is. */
export const replayWords = (held: string): string => `保留した ${held} の出し直し`;
/** The first line after a resume that did not send the held act again. */
export const skipWords = (held: { item: string; hand?: string; code?: string }): string =>
  `保留した ${held.item}${held.hand ? `（${held.hand}）` : ''}は出し直さなかった${held.code ? `（保留の理由: ${held.code}）` : ''}`;
/** A resent act that was held again for another reason, and what was dropped from the queue meanwhile. */
export function heldAgainWords(record: { replayCode: string; dropped: readonly { item: string; why: string }[] }): string {
  const dropped = record.dropped.map(entry => `${entry.item}（${entry.why}）`).join('・');
  return `保留した act の出し直しは ${record.replayCode} で再び保留になった${dropped ? `。その間の ${dropped} は捨てた` : ''}`;
}
