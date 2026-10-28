import { MC_ACT_TOOL, type ActInput } from '../../contracts/minecraftActContract.js';
import { actToShort } from '../../contracts/minecraftActShortContract.js';
import { noteRedecide } from '../../infra/decisionRecords/decisionRecordNotes.js';
import type { FcaRedecided } from '../../mind/action/fca/fcaPorts.js';
import { PLAN_UPDATE_TOOL } from '../../mind/action/fca/fcaPlanTools.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';

/**
 * Amendment A-10 (owner's decision 2026-10-29: 「約束を割る時だけ Opus」): an act of the first model that the head counts as one that would break an open promise is, before it goes
 * into the queue, decided again once by Opus, on the same request (the same system, tools, history and live state) with the act and the promise line added as facts. What Opus
 * answers (its act, its `keep`, its `plan.update`) is used in place of the first model's answer; what it cannot or does not answer leaves the first model's act as it was. There is no
 * switch: a task whose model is Opus already has nothing to ask (`FcaModel.redecide` is null).
 *
 * The head decides nothing here. It counts (`breakingOf`), asks, checks what comes back with the same checks the first act went through (the caller's `recheck`), and says what happened.
 * One ask for an act: whatever Opus answers is not asked again, however it stands to the promise.
 */
/**
 * How long the act waits for Opus (ms). The first plan's request gives up after 120 s (`FIRST_PLAN.giveUpMs`) because nothing waits for it; here the step waits (an act held in the
 * middle of a decision), and a decision is given 90 s (`AnthropicFcaModel`'s default). A decision asked again is one of the same size, so it is given less than the decision: past this the
 * first model's act goes in as it was.
 */
export const REDECIDE_GIVE_UP_MS = 60_000;

export interface RedecidePort {
  /** Who decided first, as the note names it (「Sonnet」). */
  label: string;
  /** The ask (`FcaModel.redecide`): null when there is nothing to ask. Throws when it did not come to an answer. */
  ask(note: string, signal: AbortSignal): Promise<FcaRedecided | null>;
  /** Opus's `plan.update`, through the plan's own tool. */
  planUpdate(input: unknown, signal: AbortSignal, operationId: string): Promise<ToolResult>;
  log(line: string): void;
}
/** What the caller's checks say of the act Opus chose: the thing the caller goes on with (its checked act), or the line that refused it. */
export type Rechecked<C> = { ok: true; value: C } | { ok: false; why: string };

const cut = (text: string, size: number): string => text.length > size ? `${text.slice(0, size)}…` : text;
const shortOf = (act: ActInput): Record<string, unknown> => actToShort(act) as unknown as Record<string, unknown>;

/** The note after the live state: facts, in the form the amendment gives (「Sonnet が次の act を出した: …。この act は約束 #1（…）を割る見込み（…）。この判断をもう一度決めてください」). */
export function redecideNote(label: string, act: ActInput, breaking: readonly string[]): string {
  return `${label} が次の act を出した: ${JSON.stringify(shortOf(act))}。${breaking.join('。')}。この判断をもう一度決めてください`;
}

/** How two acts differ, by their short forms: `same` when no field does, `hands` when the hands do, else `fields` (the names of the other fields that differ). */
export function actDifference(before: ActInput, after: ActInput): { change: 'same' | 'hands' | 'fields'; fields: string[]; keep: { before: number; after: number } } {
  const left = shortOf(before), right = shortOf(after);
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const fields = names.filter(name => JSON.stringify(left[name]) !== JSON.stringify(right[name]));
  const keepCount = (short: Record<string, unknown>) => Array.isArray(short.keep) ? short.keep.length : 0;
  return { change: !fields.length ? 'same' : fields.includes('hands') ? 'hands' : 'fields', fields, keep: { before: keepCount(left), after: keepCount(right) } };
}

/**
 * Asks once and settles what to do with the answer. `input` is the first model's act as it would be sent (after the head's own checks); `breaking` the lines `breakingOf` made and
 * `uncounted` what it could not count. Returns the checked act of Opus (`replaced`) to go on with, or null to go on with the first one, and the lines to say after the queue's line.
 */
export async function redecideAct<C>(parts: { port: RedecidePort; operationId: string; input: ActInput; breaking: readonly string[]; uncounted: readonly string[];
  urgent: boolean; signal: AbortSignal; recheck(input: ActInput): Promise<Rechecked<C>> }): Promise<{ replaced: C | null; lead: string[] }> {
  const { port, input, breaking, uncounted } = parts;
  const none = { replaced: null, lead: [] as string[] };
  const first = cut(JSON.stringify(shortOf(input)), 800);
  if (!breaking.length) {
    if (uncounted.length) noteRedecide({ asked: false, count: 0, breaking: [], uncounted: [...uncounted], act: first });
    return none;
  }
  if (parts.urgent) {
    // An urgent decision wants its act at once: nothing waits for a second opinion.
    noteRedecide({ asked: false, count: 0, skipped: 'urgent', breaking: [...breaking], uncounted: [...uncounted], act: first });
    return none;
  }
  let answer: FcaRedecided | null;
  try {
    answer = await port.ask(redecideNote(port.label, input, breaking), parts.signal);
  } catch (error) {
    if (parts.signal.aborted) throw error;
    const why = cut(String((error as Error | undefined)?.message ?? error).replace(/\s+/gu, ' '), 200);
    port.log(`Shannon FCA redecide failed why=${why}`);
    noteRedecide({ asked: true, count: 1, outcome: 'kept_first', why: 'failed', failed: why, breaking: [...breaking], uncounted: [...uncounted], act: first });
    return none;
  }
  if (!answer) {
    noteRedecide({ asked: false, count: 0, skipped: 'no_stronger_model', breaking: [...breaking], uncounted: [...uncounted], act: first });
    return none;
  }
  const spent = { model: answer.model, ms: answer.ms, costUsd: answer.usage.costUsd, usageComplete: answer.usage.complete,
    tokens: { input: answer.usage.inputTokens, cacheRead: answer.usage.cachedInputTokens, cacheWrite: answer.usage.cacheCreationInputTokens, output: answer.usage.outputTokens } };
  const row = { asked: true, count: 1, breaking: [...breaking], uncounted: [...uncounted], act: first, ...spent };
  const acts = answer.calls.filter(call => call.name === MC_ACT_TOOL), plans = answer.calls.filter(call => call.name === PLAN_UPDATE_TOOL);
  const chosen = acts[0];
  const ignored = answer.calls.filter(call => call !== chosen && !plans.includes(call)).map(call => call.name);
  const kept = (why: string, extra: Record<string, unknown> = {}): { replaced: null; lead: string[] } => {
    noteRedecide({ ...row, outcome: 'kept_first', why, ...(ignored.length ? { ignored } : {}), ...extra });
    port.log(`Shannon FCA redecide kept the first act why=${why} model=${answer!.model} ms=${answer!.ms} costUsd=${answer!.usage.costUsd}`);
    return none;
  };
  if (!chosen) return kept(answer.control ? `no_act:${answer.control}` : 'no_act');
  const opus = chosen.input as ActInput;
  if (!opus || typeof opus !== 'object' || !Array.isArray(opus.hands) || !opus.hands.length) return kept('refused', { refusedBy: '手が無い' });
  // Its plan.update goes through the plan's tool first (the act's `why` may name a node it made); a failure is told and changes nothing else.
  const lead: string[] = [];
  let planUpdates = 0;
  for (const [index, call] of plans.entries()) {
    try {
      const done = await port.planUpdate(call.input, parts.signal, `${parts.operationId}:redecide-plan${index + 1}`);
      planUpdates += 1;
      lead.push(done.ok ? `Opus の plan.update: 通した` : `Opus の plan.update: 通らなかった（${cut(done.text.split(/\r?\n/u)[0] ?? '', 120)}）`);
    } catch (error) {
      if (parts.signal.aborted) throw error;
      lead.push(`Opus の plan.update: 通らなかった（${cut(String((error as Error | undefined)?.message ?? error), 120)}）`);
    }
  }
  const difference = actDifference(input, opus);
  const shape = { change: difference.change, changedFields: difference.fields, keep: difference.keep, planUpdate: plans.length > 0, planUpdates, opusAct: cut(JSON.stringify(shortOf(opus)), 800) };
  if (difference.change === 'same') {
    // The same act, whole: it goes in as it is (why it is right is in its why); its checks were passed once and nothing is done twice.
    noteRedecide({ ...row, outcome: 'used', ...shape, ...(ignored.length ? { ignored } : {}) });
    port.log(`Shannon FCA redecide same act model=${answer.model} ms=${answer.ms} costUsd=${answer.usage.costUsd}`);
    return { replaced: null, lead: [`決め直し（Opus）: 同じ act を出した`, ...lead] };
  }
  const checked = await parts.recheck(opus);
  if (!checked.ok) return kept('refused', { refusedBy: cut(checked.why, 300), ...shape });
  noteRedecide({ ...row, outcome: 'used', ...shape, ...(ignored.length ? { ignored } : {}) });
  port.log(`Shannon FCA redecide used model=${answer.model} change=${difference.change} ms=${answer.ms} costUsd=${answer.usage.costUsd}`);
  const said = difference.change === 'hands' ? '手を替えた' : `手は同じで ${difference.fields.join('・')} を替えた`;
  return { replaced: checked.value, lead: [`決め直し（Opus）: ${said}。列に入れたのは Opus の act: ${cut(JSON.stringify(shortOf(opus)), 600)}`, ...lead] };
}
