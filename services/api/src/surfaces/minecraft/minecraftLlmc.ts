import { createFcaLookahead, type FcaLookahead } from '../../mind/action/fca/fcaLookahead.js';
import type { FcaToolCall, FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import { toolFailure, toolOk, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlReceipt, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, actExpectedMilliseconds, actMilliseconds, actProblem, LLMC_READ_SKILLS, MC_ACT_SKILL, MC_ACT_TOOL,
  MC_VIEW_SKILL, MC_VIEW_TOOL, readActResult, readViewResult, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, type ActInput, type ActPos, type ActResult,
} from '../../contracts/minecraftActContract.js';
import { MC_PROBE_SKILL, MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../../contracts/minecraftProbeContract.js';
import { normalizeActInput, schemaProblem } from './minecraftLlmcShape.js';
import { LLMC_PROBE, PROBE_WIRE_SCHEMA, prepareProbeInput, probeAnswerText, type ProbeContext } from './minecraftLlmcProbeInput.js';
import { validSkillInput } from './minecraftControlValidation.js';
import { isShooter } from './minecraftLlmcThreat.js';
import { stopFacts } from './minecraftLlmcStopFacts.js';

/**
 * The head's side of the LLM-centric body (design mb-llm-centric 2.3; contract `minecraftActContract.ts`): the tools it offers, how it
 * runs `mc.act` and `mc.view` on the body, how a result reads to the model, when the next decision is asked while an act runs, and when
 * an act is cut for a hostile come near (an urgent step).
 */
/**
 * An act is long enough to ask the next decision while it runs (design 2.3: four seconds; r8: eight). Run 32: 16 asked ahead, 5 taken,
 * 11 thrown away (7 after a failed act, 4 too old), about a tenth of the cost; a decision takes 7–10 s (p50 7.4), so one asked ahead of an
 * act under about 8 s is not ready when the act ends, and its call is paid for all the same.
 */
export const LLMC_LOOKAHEAD_MS = 8_000;
/** A hostile this near, not near when the act began and not watched by its own `stopIf`, cuts the act (an urgent step). */
export const LLMC_URGENT_METERS = 6;
/** The ms added to an act's ceiling for the command's deadline (delivery and the body's own stop). */
const COMMAND_MARGIN_MS = 5_000;
const VIEW_MS = 15_000;

/**
 * The tools of the mode, from the body's catalog: `mc.act` and `mc.view` in the head's own words, r4's `mc.probe` (in the head's words too,
 * when `probe` is on and the body offers it), and the reads it keeps.
 */
export function llmcBodyDefinitions(skills: readonly MinecraftSkillDefinition[],
  definition: (name: string, description: string, readOnly: boolean) => FcaToolDefinition, options: { probe?: boolean } = {}): FcaToolDefinition[] {
  const has = (name: string) => skills.some(skill => skill.name === name);
  return [
    ...(has(MC_ACT_SKILL) ? [{ ...definition(MC_ACT_TOOL, ACT_DESCRIPTION, false), nativeInputSchema: ACT_INPUT_SCHEMA }] : []),
    ...(has(MC_VIEW_SKILL) ? [{ ...definition(MC_VIEW_TOOL, VIEW_DESCRIPTION, true), nativeInputSchema: VIEW_INPUT_SCHEMA }] : []),
    ...(options.probe && has(MC_PROBE_SKILL) ? [{ ...definition(MC_PROBE_TOOL, PROBE_DESCRIPTION, true), nativeInputSchema: PROBE_INPUT_SCHEMA }] : []),
    ...skills.filter(skill => LLMC_READ_SKILLS.has(skill.name))
      .map(skill => ({ ...definition(`mc.${skill.name}`, skill.description, skill.readOnly), nativeInputSchema: skill.inputSchema })),
  ];
}
/**
 * The head's schema of a mode tool (`mc.act`, `mc.view`; r4 `mc.probe` in the body's form, `PROBE_WIRE_SCHEMA`), or undefined for a body
 * skill whose schema is the body's.
 */
export function llmcSchema(name: string): Readonly<Record<string, unknown>> | undefined {
  return name === MC_ACT_TOOL ? ACT_INPUT_SCHEMA : name === MC_VIEW_TOOL ? VIEW_INPUT_SCHEMA : name === MC_PROBE_TOOL ? PROBE_WIRE_SCHEMA : undefined;
}

/**
 * Why an input is refused before the body sees it, or null: where it leaves the schema (`schemaProblem`: the field, what it must be,
 * what it is), then each hand's fields (`actProblem`). One line, so the next decision can mend exactly that.
 */
export function llmcInputProblem(name: string, input: unknown): string | null {
  const schema = llmcSchema(name);
  if (!schema) return null;
  if (!validSkillInput(input, schema)) return `引数が ${name} の形に合わない: ${schemaProblem(input, schema) ?? '形が違う'}`;
  return name === MC_ACT_TOOL ? actProblem(input as ActInput) : null;
}

/**
 * An input made ready for the body: put into the contract's shape where what the model meant is plain (`normalizeActInput`; a view's
 * `only` as a list), then checked. `fixes` are said in the result the model reads.
 */
export function llmcPrepare(name: string, input: unknown, context: ProbeContext = { feet: null, creatures: [] })
  : { input: unknown; fixes: string[]; problem: string | null } {
  let prepared = input, fixes: string[] = [];
  if (name === MC_PROBE_TOOL) {
    // r4: a probe into the body's form (its kind's fields, a creature's id, a column's bounds from her feet).
    const probe = prepareProbeInput(input, context);
    if (probe.problem || !probe.input) return { input, fixes: probe.fixes, problem: probe.problem ?? 'mc.probe の形が違う' };
    return { input: probe.input, fixes: probe.fixes, problem: llmcInputProblem(name, probe.input) };
  }
  if (name === MC_ACT_TOOL) ({ input: prepared, fixes } = normalizeActInput(input));
  else if (name === MC_VIEW_TOOL && typeof (input as { only?: unknown } | null)?.only === 'string') {
    prepared = { ...(input as object), only: [(input as { only: string }).only] };
    fixes = ['only を配列にした'];
  }
  return { input: prepared, fixes, problem: llmcInputProblem(name, prepared) };
}

/** How long the body runs it and how long the head waits for its receipt (`from`: her feet now, for the walks' lengths). */
export function llmcMilliseconds(name: string, input: unknown, from: ActPos | null = null): number {
  return name === MC_ACT_TOOL ? actMilliseconds(input as ActInput, from) + COMMAND_MARGIN_MS : name === MC_PROBE_TOOL ? LLMC_PROBE.toolMs : VIEW_MS;
}
/** Her feet in a frame, or null. */
export function feetOf(observation: BodyObservation | null): ActPos | null {
  const at = (observation?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined)?.position;
  return at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: at.x as number, y: at.y as number, z: at.z as number } : null;
}

/** How a stopped hand's 3×3×3 starts in a result (r3: it is shown once, in the next decision's live state, not kept in the history). */
export const AROUND_PREFIX = '  周り（上の層から、北が上・西が左）';
/** An act's result in the lines the model reads (no map: the live state carries the newest one). */
export function actResultText(result: ActResult): string {
  // r3: an act whose hands all ran, one or more of them `failed` (onFail continue), did not stop.
  const failed = result.lines.filter(line => line.status === 'failed').length;
  const head = result.ok ? `act 全部済み（${result.done}/${result.of}、${(result.ms / 1000).toFixed(1)}秒）`
    : !result.stoppedBy && failed ? `act 最後まで動いた（済み ${result.done}/${result.of}、失敗して続けた手 ${failed}、${(result.ms / 1000).toFixed(1)}秒）`
      : `act ${result.done}/${result.of} 済みで止まった（${result.stoppedBy ?? 'failure'}${result.stoppedWhy ? `: ${result.stoppedWhy}` : ''}）`;
  const mark = { done: '済', stopped: '止', failed: '失', skipped: '未' } as const;
  const lines = result.lines.flatMap(line => [`${line.i} ${line.do} ${mark[line.status] ?? '未'} ${line.line}`,
    ...((line.status === 'stopped' || line.status === 'failed') && line.around ? [`${AROUND_PREFIX}${line.around.slice(0, 160)}`] : [])]);
  const extras = [
    `今 (${result.at.x},${result.at.y},${result.at.z}) 体力${result.hp} 満腹${result.food}`,
    ...(result.eye ? [`アイ: (${result.eye.from.x},${result.eye.from.z}) から方位 ${result.eye.bearingDeg}° に ${result.eye.flew} 飛んだ`
      + `${result.eye.broke ? '（割れた）' : '（落ちた: 拾える）'}`] : []),
    ...(result.container ? [`${result.container.kind} (${result.container.at.x},${result.container.at.y},${result.container.at.z}): `
      + `${result.container.items.join('、') || '空'}`] : []),
    ...(result.arrowsLeft !== undefined ? [`矢の残り ${result.arrowsLeft}`] : []),
  ];
  // r10 (body): the act began after a reflex that held the body let go.
  const after = typeof result.afterReflex === 'string' && result.afterReflex ? [`（${result.afterReflex.slice(0, 200)}）`] : [];
  return [head, ...after, ...lines, ...extras].join('\n');
}

/** A result longer than this is kept in the history by its first line; the whole text is shown once, in the next live state (r3). */
export const LLMC_KEPT_RESULT_CHARS = 400;
const SHOWN_RESULT_CHARS = 6_000;
/**
 * What the history keeps of one result in the mode, and what the next decision's live state shows once (`lastResults`): r3, run 27
 * (2026-10-22): every round's results stayed in the replay to the end of its epoch (an observation 5,066 characters, a plan 2,842, a
 * view's map about 2,500), read again by every later decision. An act's result is kept whole but for its stopped hands' 3×3×3
 * (`around`, for the next decision only); any other result past `LLMC_KEPT_RESULT_CHARS` is kept as its first line and says where the
 * whole was. The stored text never changes afterwards (the replay stays byte for byte the same: the cache holds).
 */
export function llmcStoredResult(name: string, text: string): { stored: string; shown: string | null } {
  if (name === MC_ACT_TOOL) {
    const lines = text.split('\n'), kept = lines.filter(line => !line.startsWith(AROUND_PREFIX));
    return kept.length === lines.length ? { stored: text, shown: null }
      : { stored: [...kept, '（止まった手の周りは、この次の判断の live.lastResults に一度だけ出した）'].join('\n'), shown: text.slice(0, SHOWN_RESULT_CHARS) };
  }
  if (text.length <= LLMC_KEPT_RESULT_CHARS) return { stored: text, shown: null };
  const first = (text.split('\n')[0] ?? '').slice(0, 200);
  return { stored: `${first}…（全文 ${text.length}字は、この次の判断の live.lastResults に一度だけ出した）`, shown: text.slice(0, SHOWN_RESULT_CHARS) };
}

/** The tool result of an act or a view from the body's receipt; `fixes`: what the head put into shape before sending (said first). */
export function llmcResult(name: string, receipt: MinecraftControlReceipt, urgent: string | null, fixes: readonly string[] = [], input?: unknown,
  observation: BodyObservation | null = null): ToolResult {
  const result = name === MC_VIEW_TOOL ? viewResult(receipt) : name === MC_PROBE_TOOL ? probeResult(receipt) : actResult(receipt, urgent, input, observation);
  return fixes.length ? { ...result, text: `（頭が形を直して送った: ${fixes.join('、')}）\n${result.text}` } : result;
}
function viewResult(receipt: MinecraftControlReceipt): ToolResult {
  const view = readViewResult(receipt.result);
  if (receipt.outcome !== 'completed' || !view) return toolFailure('failed', `見られなかった: ${receipt.result?.slice(0, 300) ?? receipt.outcome}`);
  return toolOk([view.map, ...(view.landmarks ?? [])].join('\n'));
}
/** r4: a probe's answer, its text first and then its fields (`probeAnswerText`). */
function probeResult(receipt: MinecraftControlReceipt): ToolResult {
  if (receipt.outcome !== 'completed' || !receipt.result) return toolFailure('failed', `調べられなかった: ${receipt.result?.slice(0, 300) ?? receipt.outcome}`);
  return toolOk(probeAnswerText(receipt.result, false));
}
function actResult(receipt: MinecraftControlReceipt, urgent: string | null, input?: unknown, observation: BodyObservation | null = null): ToolResult {
  const act = readActResult(receipt.result);
  const cut = urgent ? `急ぎ: ${urgent} が近づいたので act を止めた。\n` : '';
  if (!act) {
    const words = receipt.result?.slice(0, 600) ?? '';
    return receipt.outcome === 'completed' ? toolOk(`${cut}${words || 'act 済み'}`) : toolFailure('failed', `${cut}act ${receipt.outcome}: ${words}`);
  }
  // r10 (H3): what a stopped hand's cut line leaves out (the cell out of reach and how far, the cells a step must dig…), from the result's own fields.
  let facts: string[] = [];
  try { facts = input === undefined ? [] : stopFacts(act, normalizeActInput(input).input, observation); } catch { facts = []; }
  const text = `${cut}${actResultText(act)}${facts.length ? `\n${facts.join('\n')}` : ''}`;
  if (act.ok && receipt.outcome === 'completed') return toolOk(text);
  // A reflex or an urgent cut is no fault of the decision (`bodyReflex`); an act that did some of its hands moved (`progressed`).
  const failed = toolFailure('failed', text, { retryable: true });
  return { ...failed, ...(act.stoppedBy === 'reflex' || urgent ? { bodyReflex: true as const } : {}),
    ...(act.done > 0 ? { progressed: true as const } : {}) };
}

/** The hostiles of a frame, nearest first (with the body's own `canSee`, when the frame says it). */
function hostiles(observation: BodyObservation | null): Array<{ name: string; distance: number; canSee?: boolean }> {
  const world = observation?.state.world as { nearbyThreats?: unknown } | undefined;
  return (Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats as Array<Record<string, unknown>> : [])
    .flatMap(item => typeof item?.name === 'string' && typeof item.distance === 'number' && Number.isFinite(item.distance)
      ? [{ name: item.name, distance: item.distance, ...(typeof item.canSee === 'boolean' ? { canSee: item.canSee } : {}) }] : [])
    .sort((left, right) => left.distance - right.distance);
}

/**
 * Watches the frames while an act runs: a hostile within `LLMC_URGENT_METERS` that was not that near when the act began, where the act's
 * own `stopIf.hostileWithin` does not already watch that distance, aborts it (the decision runs again at once). Returns the signal for the
 * command and what cut it (or null), and a stop for the watch. r7 (`walled`, with the probe; run 30: a blaze 5.6 m above the tunnel in the
 * rock cut its digging): a shooter the frame says cannot see her (the body's own check at every frame) does not cut it.
 */
export function urgentWatch(input: unknown, observe: () => BodyObservation | null, parent: AbortSignal, everyMs = 250,
  options: { walled?: boolean } = {}): { signal: AbortSignal; reason(): string | null; stop(): void } {
  const watched = (input as ActInput | null)?.stopIf?.hostileWithin ?? 0;
  // The kinds she took on in this act (`accept`) are hers to fight: they never cut it.
  const near = new Set([...(input as ActInput | null)?.accept ?? [],
    ...hostiles(observe()).filter(item => item.distance <= LLMC_URGENT_METERS).map(item => item.name)]);
  const controller = new AbortController();
  let reason: string | null = null;
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener('abort', cancel, { once: true });
  if (parent.aborted) cancel();
  const timer = watched >= LLMC_URGENT_METERS ? null : setInterval(() => {
    const come = hostiles(observe()).find(item => item.distance <= LLMC_URGENT_METERS && !near.has(item.name)
      && !(options.walled && isShooter(item.name) && item.canSee === false));
    if (!come || controller.signal.aborted) return;
    reason = `${come.name} ${come.distance.toFixed(1)}m`;
    controller.abort('urgent');
  }, everyMs);
  timer?.unref?.();
  const stop = () => {
    if (timer) clearInterval(timer);
    parent.removeEventListener('abort', cancel);
  };
  return { signal: controller.signal, reason: () => reason, stop };
}

/** An act whose hands take long enough that the next decision is asked while it runs (`from`: her feet now, for the walks). */
export function llmcLongCall(call: Pick<FcaToolCall, 'name' | 'input'>, from: ActPos | null = null): boolean {
  if (call.name !== MC_ACT_TOOL || !call.input || typeof call.input !== 'object') return false;
  try { return actExpectedMilliseconds(normalizeActInput(call.input).input as ActInput, from) >= LLMC_LOOKAHEAD_MS; } catch { return false; }
}
/** Each task's way to read her feet now (set by the task's step parts), for a walk's length in the lookahead. */
const feetOfTask = new Map<string, () => ActPos | null>();
export function noteLlmcFeet(taskId: string, read: () => ActPos | null): void {
  feetOfTask.delete(taskId);
  feetOfTask.set(taskId, read);
  if (feetOfTask.size > 32) feetOfTask.delete(feetOfTask.keys().next().value as string);
}
/** The mode's lookahead: no agenda acts between the steps, so a decision asked ahead is fresh while the step's history is. */
export function createLlmcLookahead(log: (line: string) => void): FcaLookahead {
  return createFcaLookahead({ wanted: (call, taskId) => { let from: ActPos | null = null;
    try { from = feetOfTask.get(taskId)?.() ?? null; } catch { /* unknown: a walk counts its default length */ }
    return llmcLongCall(call, from); }, log });
}
