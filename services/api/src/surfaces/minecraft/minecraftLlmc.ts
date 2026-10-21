import { createFcaLookahead, type FcaLookahead } from '../../mind/action/fca/fcaLookahead.js';
import type { FcaToolCall, FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import { toolFailure, toolOk, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlReceipt, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, actExpectedMilliseconds, actMilliseconds, actProblem, LLMC_READ_SKILLS, MC_ACT_SKILL, MC_ACT_TOOL,
  MC_VIEW_SKILL, MC_VIEW_TOOL, readActResult, readViewResult, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, type ActInput, type ActPos, type ActResult,
} from '../../contracts/minecraftActContract.js';
import { normalizeActInput, schemaProblem } from './minecraftLlmcShape.js';
import { validSkillInput } from './minecraftControlValidation.js';

/**
 * The head's side of the LLM-centric body (design mb-llm-centric 2.3; contract `minecraftActContract.ts`): the tools it offers, how it
 * runs `mc.act` and `mc.view` on the body, how a result reads to the model, when the next decision is asked while an act runs, and when
 * an act is cut for a hostile come near (an urgent step).
 */
/** An act is long enough to ask the next decision while it runs (design 2.3: four seconds). */
export const LLMC_LOOKAHEAD_MS = 4_000;
/** A hostile this near, not near when the act began and not watched by its own `stopIf`, cuts the act (an urgent step). */
export const LLMC_URGENT_METERS = 6;
/** The ms added to an act's ceiling for the command's deadline (delivery and the body's own stop). */
const COMMAND_MARGIN_MS = 5_000;
const VIEW_MS = 15_000;

/** The tools of the mode, from the body's catalog: `mc.act` and `mc.view` in the head's own words, and the reads it keeps. */
export function llmcBodyDefinitions(skills: readonly MinecraftSkillDefinition[],
  definition: (name: string, description: string, readOnly: boolean) => FcaToolDefinition): FcaToolDefinition[] {
  const has = (name: string) => skills.some(skill => skill.name === name);
  return [
    ...(has(MC_ACT_SKILL) ? [{ ...definition(MC_ACT_TOOL, ACT_DESCRIPTION, false), nativeInputSchema: ACT_INPUT_SCHEMA }] : []),
    ...(has(MC_VIEW_SKILL) ? [{ ...definition(MC_VIEW_TOOL, VIEW_DESCRIPTION, true), nativeInputSchema: VIEW_INPUT_SCHEMA }] : []),
    ...skills.filter(skill => LLMC_READ_SKILLS.has(skill.name))
      .map(skill => ({ ...definition(`mc.${skill.name}`, skill.description, skill.readOnly), nativeInputSchema: skill.inputSchema })),
  ];
}
/** The head's schema of a mode tool (`mc.act`, `mc.view`), or undefined for a body skill whose schema is the body's. */
export function llmcSchema(name: string): Readonly<Record<string, unknown>> | undefined {
  return name === MC_ACT_TOOL ? ACT_INPUT_SCHEMA : name === MC_VIEW_TOOL ? VIEW_INPUT_SCHEMA : undefined;
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
export function llmcPrepare(name: string, input: unknown): { input: unknown; fixes: string[]; problem: string | null } {
  let prepared = input, fixes: string[] = [];
  if (name === MC_ACT_TOOL) ({ input: prepared, fixes } = normalizeActInput(input));
  else if (name === MC_VIEW_TOOL && typeof (input as { only?: unknown } | null)?.only === 'string') {
    prepared = { ...(input as object), only: [(input as { only: string }).only] };
    fixes = ['only を配列にした'];
  }
  return { input: prepared, fixes, problem: llmcInputProblem(name, prepared) };
}

/** How long the body runs it and how long the head waits for its receipt (`from`: her feet now, for the walks' lengths). */
export function llmcMilliseconds(name: string, input: unknown, from: ActPos | null = null): number {
  return name === MC_ACT_TOOL ? actMilliseconds(input as ActInput, from) + COMMAND_MARGIN_MS : VIEW_MS;
}
/** Her feet in a frame, or null. */
export function feetOf(observation: BodyObservation | null): ActPos | null {
  const at = (observation?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined)?.position;
  return at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: at.x as number, y: at.y as number, z: at.z as number } : null;
}

/** An act's result in the lines the model reads (no map: the live state carries the newest one). */
export function actResultText(result: ActResult): string {
  const head = result.ok ? `act 全部済み（${result.done}/${result.of}、${(result.ms / 1000).toFixed(1)}秒）`
    : `act ${result.done}/${result.of} 済みで止まった（${result.stoppedBy ?? 'failure'}${result.stoppedWhy ? `: ${result.stoppedWhy}` : ''}）`;
  const lines = result.lines.flatMap(line => [`${line.i} ${line.do} ${line.status === 'done' ? '済' : line.status === 'stopped' ? '止' : '未'} ${line.line}`,
    ...(line.status === 'stopped' && line.around ? [`  周り（上の層から、北が上・西が左）${line.around.slice(0, 160)}`] : [])]);
  const extras = [
    `今 (${result.at.x},${result.at.y},${result.at.z}) 体力${result.hp} 満腹${result.food}`,
    ...(result.eye ? [`アイ: (${result.eye.from.x},${result.eye.from.z}) から方位 ${result.eye.bearingDeg}° に ${result.eye.flew} 飛んだ`
      + `${result.eye.broke ? '（割れた）' : '（落ちた: 拾える）'}`] : []),
    ...(result.container ? [`${result.container.kind} (${result.container.at.x},${result.container.at.y},${result.container.at.z}): `
      + `${result.container.items.join('、') || '空'}`] : []),
    ...(result.arrowsLeft !== undefined ? [`矢の残り ${result.arrowsLeft}`] : []),
  ];
  return [head, ...lines, ...extras].join('\n');
}

/** The tool result of an act or a view from the body's receipt; `fixes`: what the head put into shape before sending (said first). */
export function llmcResult(name: string, receipt: MinecraftControlReceipt, urgent: string | null, fixes: readonly string[] = []): ToolResult {
  const result = name === MC_VIEW_TOOL ? viewResult(receipt) : actResult(receipt, urgent);
  return fixes.length ? { ...result, text: `（頭が形を直して送った: ${fixes.join('、')}）\n${result.text}` } : result;
}
function viewResult(receipt: MinecraftControlReceipt): ToolResult {
  const view = readViewResult(receipt.result);
  if (receipt.outcome !== 'completed' || !view) return toolFailure('failed', `見られなかった: ${receipt.result?.slice(0, 300) ?? receipt.outcome}`);
  return toolOk([view.map, ...(view.landmarks ?? [])].join('\n'));
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
    ...(act.done > 0 ? { progressed: true as const } : {}) };
}

/** The hostiles of a frame, nearest first. */
function hostiles(observation: BodyObservation | null): Array<{ name: string; distance: number }> {
  const world = observation?.state.world as { nearbyThreats?: unknown } | undefined;
  return (Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats as Array<Record<string, unknown>> : [])
    .flatMap(item => typeof item?.name === 'string' && typeof item.distance === 'number' && Number.isFinite(item.distance)
      ? [{ name: item.name, distance: item.distance }] : []).sort((left, right) => left.distance - right.distance);
}

/**
 * Watches the frames while an act runs: a hostile within `LLMC_URGENT_METERS` that was not that near when the act began, where the act's
 * own `stopIf.hostileWithin` does not already watch that distance, aborts it (the decision runs again at once). Returns the signal for the
 * command and what cut it (or null), and a stop for the watch.
 */
export function urgentWatch(input: unknown, observe: () => BodyObservation | null, parent: AbortSignal, everyMs = 250)
  : { signal: AbortSignal; reason(): string | null; stop(): void } {
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
    const come = hostiles(observe()).find(item => item.distance <= LLMC_URGENT_METERS && !near.has(item.name));
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
