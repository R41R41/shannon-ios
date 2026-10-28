import type { FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import { toolFailure, toolOk, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlReceipt, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
import {
  ACT_INPUT_SCHEMA, actMilliseconds, actProblem, MC_ACT_SKILL, MC_ACT_TOOL,
  MC_VIEW_SKILL, MC_VIEW_TOOL, actOutcomeOf, readActResult, readViewResult, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, type ActInput, type ActPos, type ActResult,
} from '../../contracts/minecraftActContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, shortHandProblem } from '../../contracts/minecraftActShortContract.js';
import { MC_PROBE_SKILL, MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../../contracts/minecraftProbeContract.js';
import { normalizeActInput, schemaProblem } from './minecraftLlmcShape.js';
import { LLMC_PROBE, PROBE_WIRE_SCHEMA, prepareProbeInput, probeAnswerText, type ProbeContext } from './minecraftLlmcProbeInput.js';
import { validSkillInput } from './minecraftControlValidation.js';
import { isShooter } from './minecraftLlmcThreat.js';
import { urgentRange } from './minecraftLlmcUrgent.js';
import { actFacts, handFacts } from './minecraftLlmcResultWords.js';

/**
 * The head's side of the LLM-centric body (design mb-llm-centric 2.3; contract `minecraftActContract.ts`): the tools it offers, how it
 * runs `mc.view` and `mc.probe` on the body, how a result reads to the model, and when an act is cut for a hostile come near (an urgent step).
 * (`mc.act` is an item of the task queue: `minecraftLlmcQueue.ts`.)
 */
/** A hostile this near, not near when the act began and not watched by its own `stopIf`, cuts the act (an urgent step). */
export const LLMC_URGENT_METERS = 6;
/** The ms added to an act's ceiling for the command's deadline (delivery and the body's own stop). */
const COMMAND_MARGIN_MS = 5_000;
const VIEW_MS = 15_000;

/**
 * The tools of the mode, from the body's catalog: `mc.act` (the hands written one to a line, `minecraftActShortContract.ts`), `mc.view` and
 * `mc.probe`, each in the head's own words, when the body offers it.
 */
export function llmcBodyDefinitions(skills: readonly MinecraftSkillDefinition[],
  definition: (name: string, description: string, readOnly: boolean) => FcaToolDefinition): FcaToolDefinition[] {
  const has = (name: string) => skills.some(skill => skill.name === name);
  return [
    ...(has(MC_ACT_SKILL) ? [{ ...definition(MC_ACT_TOOL, SHORT_ACT_DESCRIPTION, false), nativeInputSchema: SHORT_ACT_INPUT_SCHEMA }] : []),
    ...(has(MC_VIEW_SKILL) ? [{ ...definition(MC_VIEW_TOOL, VIEW_DESCRIPTION, true), nativeInputSchema: VIEW_INPUT_SCHEMA }] : []),
    ...(has(MC_PROBE_SKILL) ? [{ ...definition(MC_PROBE_TOOL, PROBE_DESCRIPTION, true), nativeInputSchema: PROBE_INPUT_SCHEMA }] : []),
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
  const unread = name === MC_ACT_TOOL ? shortHandProblem(input) : null;
  if (unread) return unread;
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
  // Continue contract 1: every hand already satisfied is not a thing the act did.
  const outcome = actOutcomeOf(result);
  const head = result.ok && outcome.goal === 'already' ? `act 既に済み（${result.done}/${result.of}。始める前に全部満たしていた。何も変えていない）`
    : result.ok ? `act 全部済み（${result.done}/${result.of}、${(result.ms / 1000).toFixed(1)}秒）`
    : !result.stoppedBy && failed ? `act 最後まで動いた（済み ${result.done}/${result.of}、失敗して続けた手 ${failed}、${(result.ms / 1000).toFixed(1)}秒）`
      : `act ${result.done}/${result.of} 済みで止まった（${result.stoppedBy ?? 'failure'}${result.stoppedWhy ? `: ${result.stoppedWhy}` : ''}）`;
  const mark = { done: '済', stopped: '止', failed: '失', skipped: '未' } as const;
  const lines = result.lines.flatMap(line => [`${line.i} ${line.do} ${mark[line.status] ?? '未'} ${line.line}`, ...handFacts(line),
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
  return [head, ...after, ...lines, ...actFacts(result), ...extras].join('\n');
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
    // mb-llmc-cand 10 (D1): the mode shows only what the history does not have, the stopped hands' surroundings, not the act's lines again.
    const shown = lines.filter(line => line.startsWith(AROUND_PREFIX)).join('\n');
    return kept.length === lines.length ? { stored: text, shown: null }
      : { stored: [...kept, '（止まった手の周りは、この次の判断の live.lastResults に一度だけ出した）'].join('\n'), shown: shown.slice(0, SHOWN_RESULT_CHARS) };
  }
  if (text.length <= LLMC_KEPT_RESULT_CHARS) return { stored: text, shown: null };
  const first = (text.split('\n')[0] ?? '').slice(0, 200);
  return keptAndRest(text, first);
}
/** The mode's long result (a view's map, a probe's answer, a plan): the history keeps the first line, the next decision shows the lines after it once. */
function keptAndRest(text: string, first: string): { stored: string; shown: string | null } {
  const whole = (text.split('\n')[0] ?? '').length <= first.length;
  const rest = whole ? text.slice(first.length).replace(/^\n/u, '') : text;
  return { stored: `${first}…（続き ${rest.length}字は、この次の判断の live.lastResults に一度だけ出した）`, shown: rest.slice(0, SHOWN_RESULT_CHARS) };
}

/** The tool result of an act or a view from the body's receipt; `fixes`: what the head put into shape before sending (said first). */
export function llmcResult(name: string, receipt: MinecraftControlReceipt, urgent: string | null, fixes: readonly string[] = []): ToolResult {
  const result = name === MC_VIEW_TOOL ? viewResult(receipt) : name === MC_PROBE_TOOL ? probeResult(receipt) : actResult(receipt, urgent);
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
function actResult(receipt: MinecraftControlReceipt, urgent: string | null): ToolResult {
  const act = readActResult(receipt.result);
  const cut = urgent ? `急ぎ: ${urgent} が近づいたので act を止めた。\n` : '';
  if (!act) {
    const words = receipt.result?.slice(0, 600) ?? '';
    return receipt.outcome === 'completed' ? toolOk(`${cut}${words || 'act 済み'}`) : toolFailure('failed', `${cut}act ${receipt.outcome}: ${words}`);
  }
  const text = `${cut}${actResultText(act)}`;
  if (act.ok && receipt.outcome === 'completed') return toolOk(text);
  // A reflex or an urgent cut is no fault of the decision (`bodyReflex`); an act that did some of its hands moved (`progressed`).
  const failed = toolFailure('failed', text, { retryable: true });
  return { ...failed, ...(act.stoppedBy === 'reflex' || urgent ? { bodyReflex: true as const } : {}),
    ...(act.done > 0 || actOutcomeOf(act).goal === 'partial' ? { progressed: true as const } : {}) };
}

/** The hostiles of a frame, nearest first (with the body's own `canSee`, when the frame says it). */
function hostiles(observation: BodyObservation | null): Array<{ name: string; distance: number; canSee?: boolean; canReachMe?: boolean; reach?: string }> {
  const world = observation?.state.world as { nearbyThreats?: unknown } | undefined;
  return (Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats as Array<Record<string, unknown>> : [])
    .flatMap(item => typeof item?.name === 'string' && typeof item.distance === 'number' && Number.isFinite(item.distance)
      ? [{ name: item.name, distance: item.distance, ...(typeof item.canSee === 'boolean' ? { canSee: item.canSee } : {}),
        ...(typeof item.canReachMe === 'boolean' ? { canReachMe: item.canReachMe } : {}),
        ...(typeof item.reach === 'string' ? { reach: item.reach } : {}) }] : [])
    .sort((left, right) => left.distance - right.distance);
}

/**
 * Watches the frames while an act runs: a hostile within `LLMC_URGENT_METERS` that was not that near when the act began, where the act's
 * own `stopIf.hostileWithin` does not already watch that distance, aborts it (the decision runs again at once). Returns the signal for the
 * command and what cut it (or null), and a stop for the watch. r7 (`walled`, with the probe; run 30: a blaze 5.6 m above the tunnel in the
 * rock cut its digging): a shooter the frame says cannot see her (the body's own check at every frame) does not cut it.
 */
export function urgentWatch(input: unknown, observe: () => BodyObservation | null, parent: AbortSignal, everyMs = 250,
): { signal: AbortSignal; reason(): string | null; stop(): void } {
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
    const come = hostiles(observe()).find(item => item.distance <= urgentRange(item, LLMC_URGENT_METERS) && !near.has(item.name)
      && !(isShooter(item.name) && item.canSee === false));
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
