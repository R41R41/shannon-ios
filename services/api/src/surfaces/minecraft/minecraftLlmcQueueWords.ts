import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { conditionText } from '../../contracts/minecraftActCondition.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import { unitFromOutcome, type DependState, type ItemOutcome } from '../../contracts/continueContract.js';
import type { ActInput, ActPos } from '../../contracts/minecraftActContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import type { MinecraftControlReceipt, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import { toolFailure, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { conditionWords } from './minecraftConditions.js';
import { llmcResult } from './minecraftLlmc.js';
import { withDrops } from './minecraftLlmcDropsLine.js';
import { altitudeLine,hopSize,LONG_GO_M,type AltitudeInput,type GoHop } from './minecraftLlmcAltitude.js';
import { posIn,queueGoal } from './minecraftLlmcHazardFacts.js';
import { finite,rec,world } from './minecraftLlmcHealth.js';
import { droppedWords, keptWords, releasedWords, replayWords, unknownWords } from './minecraftLlmcResultWords.js';

/** The words of the head's mirror of the body's queue (`minecraftLlmcQueue.ts`): what an item's end is told as,
 * and the lines of the live state. */
export const QUEUE_MAX = 3;
/** The queue's answer "the same work is already in the queue": it says "already asked" (A-16: not a mistake of the model). */
export const SAME_IN_QUEUE_WORDS = 'と同じ手が列にある';
/** R3-1 (6): a wait-only act behind an item that runs is not put in the queue (run59: 172 s of them, each run in full after the item before it ended). */
export const waitBehindWords = (running: string) =>
  `送らなかった: 走っている ${running} の後ろに wait だけの項目は積めない（積んだ wait は ${running} が終わってから全長走る）。${running} の結果は終わった時に知らせる。`
  + '有用な手（拾う・作る・食べる・隣の採掘・安全な前提作業）を同じ項目に入れる。寝たい時は wait で夜を待たず sleep の手を 1 つ積む（夜になり次第、体が寝る）。夜を使う項目（夜に湧く敵を倒す・夜に急ぐ）と人が寝ないと言った時は、sleep on=false を入れて寝ない（理由: 寝ると夜が飛ぶ）';
/**
 * run 4 (11/10): a wait-only act behind a running item is not put in the queue (a queued wait runs in full after the item before it), and it
 * is no refusal either: a refusal cost a whole new decision round (5 times in run 4) and the model only wanted "tell me when it ends". It is
 * answered as taken: nothing is added to the queue (the body gets no wait), and the step is woken by the queue's own wakes (the running item
 * nearly done, or the queue empty, once on this queue).
 */
export const waitWakeWords = (running: string) =>
  `wait は積まなかった（体には何も足していない。体は列を動かし続ける）。列の最後の ${running} が終わって列が空になったら起こす: その結果は終わった時に知らせる。`
  + '待つ間に体を使う項目があれば、wait ではなくその項目を足す';
/**
 * Flow 1113 (F4): what the model is told, as one line, when its decision added nothing and the items it has go on (`fcaToolRound.ts` puts it in the
 * history in place of the longer words of the answer, and the step waits for the queue's next wake before it decides again).
 */
export const QUEUE_RUNS_ON_LINE = '積み済みの手が走っている。次の起こしまで待つ';
/** Whether an answer says nothing was added and the queue still runs: the wait of a running tail, the same hand sent again, a result still running. */
export const queueRunsOn = (text: string): boolean => text.includes('体は列を動かし続ける') || text.includes('に積み済み（同じ手が列にある')
  || (text.startsWith('wait は積まなかった') && text.includes('はまだ走っている'));
/** Which way an act was not put in the queue, for the decision metrics: `wait` (a wait only), `same` (the same hand), `shape` (a form the tool refused), `other`; null when it was queued. */
export function notQueuedReason(result: { ok: boolean; text: string; failure?: string }): 'wait' | 'same' | 'shape' | 'other' | null {
  if (result.text.includes('に積み済み（同じ手が列にある') || result.text.includes(SAME_IN_QUEUE_WORDS)) return 'same';
  if (result.text.startsWith('wait は積まなかった') || result.text.includes('wait だけの項目は積めない')) return 'wait';
  if (!result.ok && result.failure === 'invalid_input') return 'shape';
  return !result.ok && result.text.includes('送らなかった') ? 'other' : null;
}
/** Flow 1113 (F4): the same hand was sent while it runs or waits: answered as taken (`already`), with the mark it has. */
export const alreadyQueuedWords = (item: string) =>
  `${item} に積み済み（同じ手が列にある。足し直していない）。結果は終わった時に知らせる。待つ間に体を使う別の項目があれば足す`;
/**
 * A wait-only act that waits for the result of an item (it names it in `dependsOn` or its why), or that is written while a result is already in
 * hand: no wait goes to the body (run 6 / Haiku 1: 13 such waits, 64 s of the body standing still, each for a result the decision was about to read).
 * `state`: the item ended (`ok`: how), or is still running (`left` ms, `room` free places in the queue).
 */
export function resultWaitWords(ref: string | null,
  state: { ended: true; ok: boolean | null; unread: boolean } | { ended: false; left: number; room: number }): string {
  const lead = 'wait は積まなかった（体には何も足していない）。';
  if (!state.ended) {
    const seconds = Math.max(1, Math.round(state.left / 1000));
    return `${lead}${ref ?? '走っている項目'} はまだ走っている（列全体で あと約 ${seconds} 秒・列の空き ${Math.max(0, state.room)} 件）。`
      + '待つ間に体を使う項目を足す（今の節の次の手）。終わった時に結果を知らせる';
  }
  const how = state.ok === true ? '成功で' : state.ok === false ? '失敗で' : '';
  const where = state.unread ? '結果はこの下の行' : '結果は知らせた通り';
  const name = ref ? `${ref} はもう${how}終わった` : '結果が手元に届いている';
  return `${lead}${name}: ${where}。体は空いている。読んで次の手を積む（待たない）`;
}
/** The body's own words of an item it did not run (`failureType`): the item never started and no hand moved. */
export const NEVER_RAN: ReadonlySet<string> = new Set(['queue_dropped', 'queue_expired', 'queue_after_gone', 'queue_busy', 'queue_full']);

/** What the words need of an item. */
export interface QueueWordsItem {
  item: string; node: string | null; why: string; input: ActInput; pre: ActCondition | undefined; done: ActCondition | undefined;
  startedAt: number | null; because: string | null; reason(): string | null;
  /** Continue contract 2: the marks the item relies on (`undefined`: it is dropped when the one before it stops). */
  dependsOn?: readonly string[] | undefined;
  /** What each of them is now (`dependStateOf`), in the same order. */
  dependStates?: ReadonlyArray<readonly [string, DependState]> | undefined;
  /** Run 45's resume: the item this one sends again (a held act). */
  resume?: { item: string; command: string } | undefined;
}
export const shortWhy = (why: string): string => why.replace(/^\s*\[[^\]]*\]\s*/u, '').slice(0, 40);
/** `q15 [p7] 鉄へトンネル`: the item, its node and its why without the tag. */
export const itemLabel = (item: Pick<QueueWordsItem, 'item' | 'node' | 'why'>): string =>
  `${item.item}${item.node ? ` [${item.node}]` : ''} ${shortWhy(item.why)}`.trim();

/** The unit of a receipt: the body's own, else the old words read as one (a body or a test that sends none). */
export const unitOfReceipt = (receipt: Pick<MinecraftControlReceipt, 'unit' | 'outcome' | 'inputsReleased'>): ItemOutcome =>
  receipt.unit ?? unitFromOutcome(receipt.outcome, receipt.inputsReleased);

/** Whether the receipt says the item never ran (the body dropped or refused it, or it was cancelled before it
 * started, or its unit says it did not run). */
export const neverRan = (receipt: MinecraftControlReceipt, item: Pick<QueueWordsItem, 'startedAt'>): boolean =>
  NEVER_RAN.has(receipt.failureType ?? '') || (receipt.outcome === 'cancelled' && item.startedAt === null &&
     receipt.unit?.startedAt === undefined && receipt.unit?.end !== 'unknown')
  || (receipt.unit?.end === 'not_run' && receipt.unit.goal === 'not_started');

/** Why an item behind a bad end is told dropped: the item before it (`q14`), or the words of whoever took it off. */
function behind(because: string | null): string {
  if (!because) return '前の項目が止まった';
  return /^q\d+$/u.test(because) ? `前の項目 ${because} が止まった` : because;
}

/**
 * The result of an item that ended, as the model reads it: the body's act result, or the words of why it did not
 * run or start. A unit the body dropped says why from
 * its own `droppedBecause` (a stopped item it relied on, a death, another dimension…); one it kept going says it
 * did not rely on the one that stopped; a second try
 * of a held act says whose it is. (A result that is not known is `unknownResult`.)
 */
export function itemResult(item: QueueWordsItem, receipt: MinecraftControlReceipt, fixes: readonly string[], frame: BodyObservation | null = null): ToolResult {
  const unit = unitOfReceipt(receipt);
  if (neverRan(receipt, item)) {
    const cause = unit.droppedBecause ? droppedWords(unit.droppedBecause) : (receipt.failureType === 'cleanup_stop' ||
       unit.code === 'cleanup_stop') ? '片付けの stop で捨てた（結果として確定。さっきの不明が後で分かっても戻らない）' : behind(item.because);
    const why = receipt.result ?? `捨てた: ${cause}。手は動いていない`;
    const told = why.startsWith('捨てた') || why.startsWith('断られた') ? why : `断られた: ${why}（手は動いていない）`;
    return toolFailure('failed', told, { retryable: true });
  }
  if ((receipt.failureType === 'precondition' || receipt.failureType === 'precondition_unknown') && receipt.result) return toolFailure(
    'failed', receipt.result, { retryable: true });
  const result = withDrops(llmcResult(MC_ACT_TOOL, receipt, item.reason(), fixes), frame);
  const lead = [...(item.resume ? [replayWords(item.resume.item)] : []), ...(item.because ? [`${item.because}で止めた（頭が取り除いた）。`] : []),
    ...(unit.keptDespite ? [keptWords(unit.keptDespite).trim()] : [])];
  return lead.length ? { ...result, text: `${lead.join('\n')}\n${result.text}` } : result;
}
/** The result of an item whose result is not known (the model must not take it for done or for failed): see `unknownWords`. */
export function unknownResult(item: Pick<QueueWordsItem, 'item' | 'node' | 'why'>, released = false): ToolResult {
  return toolFailure('failed', released ? releasedWords(itemLabel(item)) : unknownWords(itemLabel(item)), { retryable: false });
}

const DEPEND_WORDS: Readonly<Record<DependState, string>> = { succeeded: '済んだ', failed: '止まった', pending: 'まだ', unknown: '結果不明' };
/**
 * The time the queue says an item has left counts a fight at half its `seconds` (`minecraftActTime.ts`: a fight that kills ends early). A fight that waits for its
 * target (nothing in sight, or none that sees her) does not: run of 11/26, `fight target=enderman seconds=90` was shown 「残り 約 7 秒」 and ended at 90 s with its result
 * only then. The running item's line says the ceiling next to the estimate, as a fact; the estimate itself stays what it is.
 */
export function fightLongWords(input: ActInput, running: number | null): string {
  const hand = running !== null ? (input.hands[running - 1]?.do === 'fight' ? input.hands[running - 1] : undefined) : input.hands.find(item => item.do === 'fight');
  if (!hand) return '';
  const seconds = hand.seconds ?? 20;
  return `（この fight の見積もりは ${seconds} 秒の半分。倒せない間・個体が来ない間は ${seconds} 秒まで続くことがあり、結果はその時まで来ない）`;
}
/** One line of the live state for an item: the running one with its hand and time left, a waiting one with its pre. */
function itemLine(item: QueueWordsItem, index: number, frame: BodyObservation | null,
  running: { progress: MinecraftQueueProgress | null; leftMs: number }): string {
  const mine = index === 0 ? running.progress : null;
  const words = item.done ? conditionWords(item.done, frame) : null;
  const itemDetails = () => ([
    mine ? `手 ${mine.hand}/${mine.of}${mine.repeat > 1 ? `・繰り返し ${mine.iteration}/${mine.repeat} 回目` : ''}` : '',
    item.done ? `済む: ${conditionText(item.done)}${words ? `（今 ${words}）` : ''}` : '',
    index > 0 && item.pre ? `前提 ${conditionText(item.pre)}（前の項目の後で体が確かめる）` : '',
    item.dependsOn !== undefined ? `頼る: ${item.dependsOn.length ? (item.dependStates ?? item.dependsOn.map(ref => [ref,
       null] as const)).map(([ref, state]) => `${ref}${state ? `（${DEPEND_WORDS[state]}）` : ''}`).join('・') : 'なし'}` : '',
    index === 0 ? `残り約 ${Math.max(1, Math.round(running.leftMs / 1000))} 秒${fightLongWords(item.input, mine?.hand ?? null)}` : '',
  ].filter(Boolean));
  const parts = itemDetails();
  return `${index === 0 ? '▶' : '・'} ${itemLabel(item)} ${index === 0 ? '実行中' : '待ち'}${parts.length ? `: ${parts.join('・')}` : ''}`;
}

/**
 * Flow 1113 (F2: run 9's body stood idle between decisions because the head could not see when the next one came): the whole queue's time left (the
 * hands' estimates added up, `leftMs`) and the time until the head is asked again. The head is asked when the running item has `T` (`queueWakeMs`: the
 * 90th percentile of its recent decisions and a margin) left, so the next decision is `first - T` from now (at once when the running item is already
 * that near): a hand that takes longer than that, added now, is in time.
 */
export function timingLine(timing: { wakeMs: number; leftMs: number }, firstLeftMs: number): string {
  const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));
  const until = Math.max(0, firstLeftMs - timing.wakeMs);
  return `列の残り 約 ${seconds(timing.leftMs)} 秒／次の決断まで約 ${until > 0 ? seconds(until) : 0} 秒（走っている項目の残りが T=${seconds(timing.wakeMs)} 秒になったら決める。考える時間はこの T）`;
}

/**
 * try1124b stall (the owner's test of 11/24, 07:15 to 07:22): 40 finished gos had a median of 6 steps and 1.6 s while a decision takes 2 to 3 s, so the body stood between
 * acts for most of the run; the model copied its own last short moves (「短く進む」). The line puts her recent gos and the decision time side by side, the facts the model
 * did not have. Said only when her last go was a short one (its goal under 15 m away) and the median of the last 5 was under 14 m, over 3 or more.
 *
 * Run of 11/27: the line counted only the gos that arrived, so the long gos that were stopped (by their seconds, their digging limit, a hostile) never entered it and it said
 * 「3・31・2・11・9 m」 for 40 minutes while the model was sending long gos; the line read 「this length leaves the body standing」 and was wrong. A go that stopped now
 * counts with the distance its goal was and how it ended, and the line is not said when the last go's goal was 15 m or more away. It gives the facts only: a go's size beside
 * the goal's, the seconds, and what the decision time does to the body's standing.
 */
export const SHORT_HOP_M = 14;
/** The line's first words: the plan made again is not shown the line unless short moves are what stopped her (`minecraftLlmcReplanBrief.ts`). */
export const HOPS_LINE_HEAD = '直近の go は ';
const reachWords = (hop: GoHop): string => {
  const metres = (value: number) => Math.round(value * 10) / 10;
  return hop.stop === null ? `行き先 ${metres(hopSize(hop))} m に対し進んだ ${metres(hop.done)} m（着いた）`
    : `行き先 ${metres(hopSize(hop))} m に対し進んだ ${metres(hop.done)} m（${hop.stop}）`;
};
export const HOPS_STALE_MS = 2 * 60_000;
export function hopsLine(hops: readonly (GoHop | number)[], decisionsMs: readonly number[], nowMs?: number): string | null {
  // A bare number is a go that arrived, that many metres from where it began.
  const recent = hops.slice(-5).map((hop): GoHop => typeof hop === 'number'
    ? { done: hop, target: hop, stop: null, seconds: null, fromY: null, toY: null } : hop);
  if (recent.length < 3) return null;
  if (hopSize(recent[recent.length - 1]!) >= LONG_GO_M) return null;
  // 11/27: the line stood for 5 minutes in a stretch of waiting (nine `wait`s, no go) and read as advice about the next move; it is about the last gos, so it goes when the last one is 2 minutes old.
  const lastAt = recent[recent.length - 1]!.at;
  if (nowMs !== undefined && lastAt !== undefined && nowMs - lastAt >= HOPS_STALE_MS) return null;
  const median = (values: readonly number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;
  const metres = median(recent.map(hopSize));
  if (metres >= SHORT_HOP_M) return null;
  const decision = decisionsMs.length ? Math.max(2, Math.round(median(decisionsMs.slice(-10)) / 1000)) : 3;
  return `${HOPS_LINE_HEAD}${recent.map(reachWords).join('・')}（直近の go の距離は中央値で ${Math.round(metres)} m。go 1 本は約 ${Math.max(1, Math.round(metres / 3.7 * 10) / 10)} 秒）。判断 1 回に約 ${decision} 秒かかるので、この長さだと次の手が届くまで体は止まっている`;
}

/**
 * Hostiles on her (one within 8 m) or health at 12 or less, read from the frame: the body's `nearbyThreats` carry the distance, `health` the points. False when the frame says neither.
 */
export function underAttack(frame: BodyObservation | null): boolean {
  const world = frame?.state.world;
  if (!world || typeof world !== 'object' || Array.isArray(world)) return false;
  const record = world as Record<string, unknown>;
  const health = record.health;
  const near = Array.isArray(record.nearbyThreats) && record.nearbyThreats.some(entity =>
    !!entity && typeof entity === 'object' && typeof (entity as { distance?: unknown }).distance === 'number' && (entity as { distance: number }).distance <= 8);
  return near || (typeof health === 'number' && health <= 12);
}

/** Items taken off the queue in the last `DROPPED_LATELY_MS` (a stop of the one before them): said again in the live state, since a decision asked just before the stop was made without it (nine decisions in 27 s waited for an item that had already failed). */
export const DROPPED_LATELY_MS = 30_000;
export function droppedLine(why: readonly string[]): string | null {
  return why.length ? `直近 ${DROPPED_LATELY_MS / 1000} 秒に列から外れた項目（体は動いていない）: ${why.slice(-3).join('／')}。待たずに、止まった理由を読んで次の手を出す` : null;
}

/** Moves stopped by a new decision in the last minute (`reissuedAgoMs`: the ages of the stops, newest last); said from the third. */
export const REISSUE_WINDOW_MS = 60_000;
export function reissueLine(agoMs: readonly number[]): string | null {
  const recent = agoMs.filter(age => age <= REISSUE_WINDOW_MS);
  if (recent.length < 3) return null;
  const every = Math.max(1, Math.round(REISSUE_WINDOW_MS / 1000 / recent.length));
  return `この 1 分で、走っている手を ${recent.length} 回止めて出し直した（約 ${every} 秒ごと）。止めるたびに体は歩き出しからやり直し、go は着く前に切れる。今の手と同じ向きなら出し直さず走らせ、向き・目標が変わる事実（敵が別の側に回った・体力が急に落ちた・足場が無い）がある時だけ止める`;
}

/** What the queue keeps for the line of height and speed (`minecraftLlmcAltitude.ts`): the last go's goal, the y it lost, the speeds its gos measured. */
export type AltitudeSource = Pick<AltitudeInput, 'lastDropM' | 'samples' | 'tune'> & { lastGoal: ActPos | null; surfaceGoal?: ActPos | null };
/** The line's input from the frame (feet, dimension), the queue's open items (where its last go goes, else where the last go that came back went) and what the queue kept. */
function altitudeInput(frame: BodyObservation | null, items: readonly Pick<QueueWordsItem, 'input'>[], kept: AltitudeSource): AltitudeInput {
  const w = world(frame), at = rec(w.position), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  const feet = x !== null && y !== null && z !== null ? { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } : posIn(typeof w.at === 'string' ? w.at : null);
  const dimension = typeof w.dimension === 'string' ? w.dimension.replace(/^minecraft:/u, '') : null;
  // The goal that makes a climb is the one read: the open go's, else the last go that came back, else the last the model named at the surface (a go to a workbench under the ground
  // is not the way she means to go).
  const open = queueGoal(items.map(item => item.input));
  const climbs = (goal: ActPos | null | undefined): goal is ActPos => !!goal && !!feet && goal.y - feet.y >= 20;
  const remembered = !climbs(open) && !climbs(kept.lastGoal) && climbs(kept.surfaceGoal);
  const goal = [open, kept.lastGoal, kept.surfaceGoal].find(climbs) ?? open ?? kept.lastGoal;
  return { dimension, feet, goal, ...(remembered ? { remembered: true } : {}), lastDropM: kept.lastDropM, samples: kept.samples, tune: kept.tune, underAttack: underAttack(frame) };
}

/** The lines of the live state: each open item, then how many more may be added; an empty queue says only that it
 * has no item (the
 * reflexes and the hands that no item runs are not said to stop). */
export function queueLines(items: readonly QueueWordsItem[], frame: BodyObservation | null,
  running: { progress: MinecraftQueueProgress | null; leftMs: number },
  timing?: { wakeMs: number; leftMs: number; hops?: readonly (GoHop | number)[]; nowMs?: number; decisionsMs?: readonly number[]; reissuedAgoMs?: readonly number[];
    droppedLately?: readonly string[]; altitude?: AltitudeSource }): string[] {
  // A line that says 「移動の go は 15 m 以上にせよ」 is for a calm stretch of work; with enemies on her or her health low it sent a flight to a target 31 m away (the lake was 12 m off).
  const hopsWords = timing?.hops && !underAttack(frame) ? hopsLine(timing.hops, timing.decisionsMs ?? [], timing.nowMs) : null;
  const altitudeWords = timing?.altitude ? altitudeLine(altitudeInput(frame, items, timing.altitude)) : null;
  const reissueWords = timing?.reissuedAgoMs ? reissueLine(timing.reissuedAgoMs) : null;
  const droppedWords = droppedLine(timing?.droppedLately ?? []);
  if (!items.length) return ['列に項目なし', ...(droppedWords ? [droppedWords] : []), ...(hopsWords ? [hopsWords] : []), ...(altitudeWords ? [altitudeWords] : []), ...(reissueWords ? [reissueWords] : [])];
  const room = QUEUE_MAX - items.length;
  const last = items[items.length - 1]!.item;
  return [...items.map((item, index) => itemLine(item, index, frame, running)),
    ...(timing ? [timingLine(timing, running.leftMs)] : []),
    ...(hopsWords ? [hopsWords] : []),
    ...(altitudeWords ? [altitudeWords] : []),
    ...(reissueWords ? [reissueWords] : []),
    ...(droppedWords ? [droppedWords] : []),
    // Loop 11/10: the room is said with what it is for: the next work behind the running item, not a look at its result.
    room > 0 ? `あと ${room} つ足せる（足した項目は ${last} の後ろに付く。${last} の結果を待たずに次の作業を足せば、体は止まらない）` : `列はいっぱい（${QUEUE_MAX}/${QUEUE_MAX}）`];
}
