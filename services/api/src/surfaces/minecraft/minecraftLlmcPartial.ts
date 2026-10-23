import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { toolFailure } from '../../mind/tools/toolRegistryPorts.js';
import { preflightOfFrame, preflightText, standAfterHands, type PreflightStop } from './minecraftLlmcPreflight.js';
import { seenReopenStop, urgentLimitStop, type HandStop } from './minecraftLlmcHandGuards.js';
import { furnaceWaitNote } from './minecraftLlmcFurnaceWait.js';
import { useReachStop } from './minecraftLlmcLiquid.js';
import { ruleGuardOfFrame, type RuleStop } from './minecraftLlmcRuleGuard.js';

/**
 * mb-llmc-cand 部分送り（改修案 §2.4、SHANNON_MINECRAFT_LLMC_V2）。送る前の守り（地図で確かにできない手・規則に反する手）が手 k を止める時、
 * 今は act 全体が止まり、止める手の前にあった手（平均 1.3 手）も動かない。部分送りは、手 1 … k−1 だけを体へ送り（stopIf・accept・why はそのまま。
 * 手は直さず足さない）、体の結果の後ろに「手 k から先は体へ送っていない」と事実を添える。k = 1 は今まで通り、体に何も送らず事実を返す。
 */
const HEAD = '送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: ';

/** 止めた手: 守りの種類にかかわらず、手の番号と、体の結果の行と同じ言い方の 1 文（「手 k walk 一歩ではない: …」）。 */
export interface Held {
  /** 1 始まり。 */
  hand: number;
  code: string;
  kind: string;
  /** 「手 2 walk 一歩ではない: …（地図で確かめた）。…。」 */
  line: string;
}

/** 4f98156 の守りが止める手の文から、頭（体には何も送っていない）を除いた物。 */
function preflightLine(stop: PreflightStop): string {
  const text = preflightText(stop);
  return text.startsWith(HEAD) ? text.slice(HEAD.length) : text;
}
const ruleLine = (stop: RuleStop): string => `手 ${stop.hand} ${stop.kind} ${stop.word}: ${stop.why}。`;

const handLine = (stop: HandStop): string => `手 ${stop.hand} ${stop.kind}: ${stop.line}。`;
/**
 * The guards' stops, the one with the smallest hand number (the same hand: the act-preflight's, then the rule guard's, the seen-again dig, the
 * urgent limit). `urgent`: the decision was an urgent one (its live state's answer line says 「手は 3 つまで」). Null when none holds.
 */
export function heldOfFrame(input: unknown, frame: BodyObservation | null, taskId: string, urgent = false, notes?: string[]): Held | null {
  const wait = furnaceWaitNote(input, frame);
  if (wait) notes?.push(wait);
  const options = { bodyRules: true, continuePlace: true, ...(notes ? { notes } : {}) };
  const stand = preflightOfFrame(input, frame, taskId, options), rule = ruleGuardOfFrame(input, frame, taskId);
  const found: Held[] = [...stand ? [{ hand: stand.hand, code: stand.code, kind: stand.kind, line: preflightLine(stand) }] : [],
    ...rule ? [{ hand: rule.hand, code: rule.code, kind: rule.kind, line: ruleLine(rule) }] : []];
  for (const stop of [seenReopenStop(input, frame), useReachStop(input, frame), urgentLimitStop(input, urgent)]) {
    if (stop) found.push({ hand: stop.hand, code: stop.code, kind: stop.kind, line: handLine(stop) });
  }
  return found.reduce<Held | null>((first, next) => !first || next.hand < first.hand ? next : first, null);
}

/** 手 1 … k−1 だけの act（他の欄はそのまま）。手が 1 つも残らなければ null（全部止める）。 */
export function sentPart(input: unknown, held: Held): unknown {
  const act = input as { hands?: unknown } | null;
  if (!act || !Array.isArray(act.hands) || held.hand < 2 || held.hand > act.hands.length) return null;
  return { ...act, hands: act.hands.slice(0, held.hand - 1) };
}

/** act 全体を止めた時の結果の文（4f98156 と同じ言い方）。 */
export const heldWhole = (held: Held): string => `${HEAD}${held.line}`;

/** 結果の後ろに足す文: 手 k から先 n 手は体へ送っていない。 */
/** Where the sent hands leave her: the cell she stands in for certain, or the cell she is near. */
interface Stand { at: { x: number; y: number; z: number } | null; via: { x: number; y: number; z: number } | null }
export function heldTail(held: Held, total: number, stand: Stand | null = null): string {
  const rest = total - held.hand + 1, sent = held.hand === 2 ? '手 1' : `手 1〜${held.hand - 1}`;
  const cell = stand?.at ?? stand?.via, near = stand?.at ? '' : ' の近く';
  const where = cell ? `送った手のあと、足は (${cell.x},${cell.y},${cell.z})${near}（地図での見積もり。体の「今」の行が正）。` : '';
  const done = `${sent} は体へ送った（結果は上の行。動いた手は書き直さない）。${where}`;
  return `${done}手 ${held.hand} から先 ${rest} 手（全 ${total} 手のうち）は体へ送っていない（送る前に止めた。手は 1 つも動いていない）: ${held.line}`;
}

/**
 * 体の結果に「送らなかった手」の文を添える。体の止まりは先（隠さない）。手 1 … k−1 が全部済んだ結果は成功のままにせず「止まった」扱い
 * （全体は終わっていない）にして、前の手が動いたこと（progressed）は残す。
 */
export function withHeldTail(result: ToolResult, tail: string): ToolResult {
  const text = `${result.text}\n${tail}`;
  if (!result.ok) return { ...result, text };
  return { ...toolFailure('refused', text, { retryable: true }), progressed: true } as ToolResult;
}

/** What the tools do with a held act in v2: nothing held, the whole act turned back, or a part sent with a tail. */
export type HoldV2 = { whole: string; held: Held } | { part: unknown; tail: string; held: Held } | { note: string } | null;
export function holdV2(input: unknown, frame: BodyObservation | null, taskId: string, urgent = false): HoldV2 {
  const notes: string[] = [];
  const held = heldOfFrame(input, frame, taskId, urgent, notes);
  if (!held) return notes.length ? { note: notes.join('\n') } : null;
  const part = sentPart(input, held);
  if (part === null) return { whole: heldWhole(held), held };
  const total = (input as { hands: unknown[] }).hands.length;
  return { part, tail: heldTail(held, total, standAfterHands(input, frame, taskId, held.hand - 1)), held };
}

/** What the tools do with an act before it is sent: its result now (nothing is sent), or the act to send and the tail to add to the result. */
export interface BeforeSend { result?: ToolResult; input?: unknown; tail?: string; note?: string }
/** A fact added to a result that stays what the body made of it (a hand the guards let go with a word: `continuePlace`). */
export function withNote(result: ToolResult, note: string): ToolResult { return { ...result, text: `${result.text}\n${note}` }; }
const say = (line: string): void => { console.info(line); };
/**
 * The guards before an `mc.act` goes to the body. Without v2, the 4f98156 act-preflight alone (`preflight`): the whole act is held at the first
 * hand the map faults, and the log line and the words are the same as they were. With v2 (SHANNON_MINECRAFT_LLMC_V2), the preflight and the rule
 * guard: the hands before the held one are sent and the rest comes back as a fact (`holdV2`).
 */
export function heldBeforeSend(mode: { preflight?: boolean; v2?: boolean; urgent?: boolean } | undefined, input: unknown, frame: BodyObservation | null,
  taskId: string): BeforeSend | null {
  if (mode?.v2) {
    const hold = holdV2(input, frame, taskId, mode.urgent === true);
    if (!hold) return null;
    if ('note' in hold) return { note: hold.note };
    if ('whole' in hold) {
      say(`Shannon Minecraft act held before send task=${taskId} hand=${hold.held.hand} do=${hold.held.kind} code=${hold.held.code}`);
      return { result: toolFailure('refused', hold.whole, { retryable: true }) };
    }
    say(`Shannon Minecraft act held partway task=${taskId} hand=${hold.held.hand} sent=${hold.held.hand - 1} code=${hold.held.code}`);
    return { input: hold.part, tail: hold.tail };
  }
  const held = mode?.preflight ? preflightOfFrame(input, frame, taskId) : null;
  if (!held) return null;
  say(`Shannon Minecraft act held before send task=${taskId} hand=${held.hand} do=${held.kind} code=${held.code}`);
  return { result: toolFailure('refused', preflightText(held), { retryable: true }) };
}
