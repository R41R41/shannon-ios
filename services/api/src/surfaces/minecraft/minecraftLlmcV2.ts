import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import { expandShortAct, SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA } from '../../contracts/minecraftActShortContract.js';
import type { FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import { llmcPrepare } from './minecraftLlmc.js';
import { heldBeforeSend } from './minecraftLlmcPartial.js';
import { checkedStopIf } from './minecraftLlmcStopIf.js';
import { rewriteLlmcLive, type RewriteNotes } from './minecraftLlmcLiveRewrite.js';
import { stageKnowledge, V2_ALWAYS } from './minecraftLlmcV2Knowledge.js';

/**
 * mb-llmc v2 (改修案 2.1〜2.3, ADR-0014): the mode's entry points. Every function here is a pure function of the recorded
 * material, so the decision replay calls the same code the model's request does:
 *
 * - `candidateLive(live)`: the live state as the decision reads it. In: the object the model's request builds from the task's state (`liveObject`:
 *   `ownerClock`, `waiting`, `observations`, `recall`, `plan`, `body`…), or a recorded one (a `system` entry with `clear_at`, parsed). Out: the
 *   rewritten live state (`minecraftLlmcLiveRewrite.ts`: fields left out, one line to a hostile, the pack added up, `body.around`,
 *   `body.route`, `body.repeat`, the map on one range) and `stage`, the knowledge of the stages the code picked (`stageKnowledge`): not in the
 *   live state but a part of the stored state, `stageKnowledge`, stated again only when it changes. Same in, same out.
 * - `candidateMenuTools(core)`: the tool definitions of the mode from any list of the body's and the plan's (the recorded core or the body's
 *   catalog): `mc.act` with the hands written one to a line, `mc.probe`, `mc.view`, `plan.update`, in this order (`MINECRAFT_V2_TOOLS`);
 *   everything else is left out. The controls (`fca_wait`, `fca_complete`) are the model's own and come after.
 * - `candidateInput(name, input)`: a call of the model as the body's tools read it (`mc.act` hands from lines to hands; the others as given).
 * - `candidateAct(raw, frame)`: what the head does to a model's `mc.act` before the body sees it (below).
 * - `candidateInstructions()`: the cached instructions' knowledge (`V2_ALWAYS`); `minecraftV2System` (`anthropicFcaMinecraftSystem.ts`) puts the
 *   header, the decision protocol and the reading before it.
 */
export function candidateLive(live: Record<string, unknown>): { live: Record<string, unknown>; notes: RewriteNotes; stage: string | null } {
  const { live: rewritten, notes } = rewriteLlmcLive(live);
  return { live: rewritten, notes, stage: stageKnowledge(live) };
}
/** The knowledge of the stages the live state calls for (a part of the stored state, stated again only when it changes), or undefined. */
export const candidateStage = (live: Record<string, unknown>): string | undefined => stageKnowledge(live) ?? undefined;

/** The mode's `mc.act` definition: the hands one to a line. */
export function shortActDefinition(base: FcaToolDefinition): FcaToolDefinition {
  return { ...base, description: SHORT_ACT_DESCRIPTION, nativeInputSchema: SHORT_ACT_INPUT_SCHEMA };
}
const MENU_ORDER = ['mc.act', 'mc.probe', 'mc.view', 'plan.update'];
/** Whether a tool is one of the mode's four (the controls are not definitions of the catalog). */
export const v2MenuTool = (tool: Pick<FcaToolDefinition, 'name'>): boolean => MENU_ORDER.includes(tool.name);

export function candidateMenuTools(core: readonly FcaToolDefinition[]): FcaToolDefinition[] {
  const ordered = MENU_ORDER.flatMap(name => core.filter(tool => tool.name === name));
  return ordered.map(tool => tool.name === MC_ACT_TOOL ? shortActDefinition(tool) : planWords(reachWords(tool)));
}
/**
 * mb-llmc-cand 10 (C2): the plan tool's description says 「済み」 of the done-condition (read as done): in the mode it says 済む条件, as the live state does.
 * Notion 09-1c 2-2 P0 (2026-10-24): it also said 「親が済みでも子は済みにならない」 while the mode's code closes an open child under a done node as no longer
 * needed (`closedUnder`), and 「体の手と同じ応答で出してよい」 with no order: the order of the response is the order the calls run.
 */
const PLAN_WORDS: ReadonlyArray<readonly [string, string]> = [
  // GPT's review 2026-10-28: where a note and the forbid and caution lines show up, said from the code (`planPath`): the note is on the node's line, the rules are the lines.
  ['live の plan.rules に、今の節と親の道の禁止・注意が出る（その節を離れると出ない）。',
    'forbid・caution は live の plan.rules に（今の節と親の道の分。その節を離れると出ない）。note は節の補足の文で、live の plan の now・next の行に付く（rules には出ない）。'],
  ['済み（r9）: doneWhen が観測の形の節は、頭のコードがその節自身の条件で済みにする。',
    '済む条件: doneWhen が観測の形（have:・dim:・at:・food>=）の節は、live では「（済む条件: …）」と出る。頭のコードがその条件が満たされた時に済みにする。'],
  ['親が済みでも子は済みにならない（子は自分の条件か set state=done で）。',
    '親が済むと、その下の開いた子（blocked を除く）は「不要になった」として閉じる（成果を得て済んだのではない）。'],
  ['済み扱いの子（消費して無くなった板・棒など）は set state=done で自分で閉じる。',
    '消費して無くなる物（板・棒など）の子は、作った時に set state=done で自分で閉じる。'],
  ['体の手と同じ応答で出してよい。', '同じ応答で mc_act を続けてよい（plan_update を先に書く。書いた順に実行される）。'],
];
function planWords(tool: FcaToolDefinition): FcaToolDefinition {
  if (tool.name !== 'plan.update') return tool;
  let description = tool.description;
  // The plain definition (without the probe's rules) has no r9 lines: each is changed where it stands.
  for (const [from, to] of PLAN_WORDS) description = description.replace(from, () => to);
  return { ...tool, description };
}
const DRAGON_PLAIN = '完了の証明は、体がエンドラの死を見届けたことだけ（条件 witnessed-dragon: 体の記録 mc.goal-evidence の boss.verified が true。'
  + 'あなたが呼ぶ道具ではない）。計画の節が済んだ・完了を要求した・自分で報告した、だけでは完了にならない。';
/** The progress as the model reads it: with the dragon's binding (`minecraftGoalBinding`, unchanged), one plain sentence of what proves completion. */
export function progressWithPlain(progress: unknown): unknown {
  const row = progress && typeof progress === 'object' && !Array.isArray(progress) ? progress as Record<string, unknown> : null;
  const binding = row?.binding && typeof row.binding === 'object' ? row.binding as Record<string, unknown> : null;
  const conditions = Array.isArray(binding?.conditions) ? binding!.conditions as Array<{ id?: unknown }> : [];
  return row && binding && conditions.some(item => item?.id === 'witnessed-dragon') ? { ...row, binding: { ...binding, plain: DRAGON_PLAIN } } : progress;
}
/**
 * The body reaches 5 m for dig, place, use, chest, furnace and craft (mb-llmc-cand 2, \`BLOCK_REACH\`); the probe's description
 * still says 4.5 m: in the mode's menu it says 5 m.
 */
function reachWords(tool: FcaToolDefinition): FcaToolDefinition {
  return tool.description.includes('4.5m') ? { ...tool, description: tool.description.replace(/4\.5m/gu, '5m') } : tool;
}
export const candidateInput = (name: string, input: unknown): unknown => name === MC_ACT_TOOL ? expandShortAct(input).input : input;
export { isUrgentLive } from './minecraftLlmcHandGuards.js';
export const candidateInstructions = (): string => V2_ALWAYS;

/** The hooks the model's options take (`createAnthropicFcaModel`, `minecraftV2`). */
export function minecraftV2Hooks(): { knowledge: string; rewriteLive(live: Record<string, unknown>): Record<string, unknown>;
  stageKnowledge(live: Record<string, unknown>): string | undefined; callInput(name: string, input: unknown): unknown;
  progress(progress: unknown): unknown } {
  return { knowledge: V2_ALWAYS, rewriteLive: live => candidateLive(live).live, stageKnowledge: candidateStage, callInput: candidateInput,
    progress: progressWithPlain };
}

/** What the head does to a model's `mc.act` before the body sees it, for the replay: the same order as `fcaMinecraftTools.ts`. */
export interface CandidateAct {
  /** The act to send (hands before the one a guard held, when it held one partway); the model's own input when the shape was refused. */
  input: unknown;
  /** The lines the result starts with ("頭が形を直して送った: …"). */
  fixes: string[];
  /** A refusal of the shape (one line), or null. The body is sent nothing then. */
  problem: string | null;
  /** The guards (act preflight, rule guard): `stopped` when nothing goes to the body, `sentHands` when a part does; `text` is the fact the model reads. */
  guard?: { stopped: boolean; hand: number; sentHands?: number; code?: string; text: string };
  /** A fact added to the result of an act that went whole (a place with onFail continue the map faults: the body skips the cell, the act goes on). */
  note?: string;
}

/**
 * The model's `mc.act` as the body's tool takes it, from the model's raw input (hands in lines or hands) and the newest frame: the hands made
 * ready (`candidateInput`), the shape put right and checked (`llmcPrepare`), the stopIf looked at (`checkedStopIf`), then the guards
 * (`heldBeforeSend`). The frame may be a made one (`state.world`: `localMap`, `position`, `health`, `nearbyThreats`, and
 * `recentStops`: the body's stop lines, from which a dig of a cell that stopped for 「見られる」 a moment ago is held). `options.urgent`: the decision
 * was an urgent one (`isUrgentLive(live)`), so the act goes to the body three hands at most.
 */
export function candidateAct(raw: unknown, frame: BodyObservation | null, taskId = 'replay', options: { urgent?: boolean } = {}): CandidateAct {
  const prepared = llmcPrepare(MC_ACT_TOOL, candidateInput(MC_ACT_TOOL, raw));
  if (prepared.problem) return { input: raw, fixes: prepared.fixes, problem: prepared.problem };
  const checked = checkedStopIf(prepared.input, frame);
  const fixes = [...prepared.fixes, ...checked.fixes];
  const held = heldBeforeSend(options.urgent === true, checked.input, frame, taskId);
  if (held?.result) return { input: checked.input, fixes, problem: null, guard: { stopped: true, hand: 1, text: held.result.text } };
  if (held?.input) {
    const sent = (held.input as { hands: unknown[] }).hands.length;
    return { input: held.input, fixes, problem: null, guard: { stopped: false, hand: sent + 1, sentHands: sent, text: held.tail ?? '' } };
  }
  return { input: checked.input, fixes, problem: null, ...held?.note ? { note: held.note } : {} };
}

/**
 * The stored-state text that states the stages' knowledge (what the model's request puts into the history when the stages change, and in the
 * epoch's first state): for the replay, which has no stored state of its own to carry it. `{"stateUpdate":"changed","stageKnowledge":…}`; in an
 * epoch's first state the request writes `"full"` and the task beside it.
 */
export const candidateStageState = (stage: string, full = false): string => JSON.stringify({ stateUpdate: full ? 'full' : 'changed', stageKnowledge: stage });
