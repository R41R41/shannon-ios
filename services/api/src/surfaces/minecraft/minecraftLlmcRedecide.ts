import { MC_ACT_TOOL, type ActInput } from '../../contracts/minecraftActContract.js';
import { actToShort, SHORT_HAND_ERROR_KEY } from '../../contracts/minecraftActShortContract.js';
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

/** Amendment A-11 2: the note for the one mend of an act the checks refused (facts: the act as written, what refused it, and the one line that asks again). */
export function repairNote(opusAct: unknown, refusal: string): string {
  let written: string;
  try {
    const unread = (opusAct as Record<string, unknown> | null)?.[SHORT_HAND_ERROR_KEY];
    written = JSON.stringify({ ...shortOf(opusAct as ActInput), ...(typeof unread === 'string' ? { [SHORT_HAND_ERROR_KEY]: unread } : {}) });
  } catch { written = JSON.stringify(opusAct); }
  return `Opus の次の act: ${cut(written, 800)}。送る前の確認が断った: ${cut(refusal.replace(/\s+/gu, ' '), 400)}。書き方を直してください`;
}

/**
 * Asks once and settles what to do with the answer. `input` is the first model's act as it would be sent (after the head's own checks); `breaking` the lines `breakingOf` made,
 * `uncounted` what it could not count and `satisfied` the promises it found the act keeps by their `instead` (A-11 1: not asked about). Returns the checked act of Opus (`replaced`) to go
 * on with, or null to go on with the first one, and the lines to say after the queue's line.
 *
 * Amendment A-11 2: an act of Opus that the checks before sending refuse is mended once: the same request with the act and the refusal added (a mend of the writing; counted apart from the
 * ask, `repairs: 1` in the record). If the mended act is refused too, the first model's act stands.
 */
export async function redecideAct<C>(parts: { port: RedecidePort; operationId: string; input: ActInput; breaking: readonly string[]; uncounted: readonly string[];
  satisfied?: readonly string[]; urgent: boolean; signal: AbortSignal; recheck(input: ActInput): Promise<Rechecked<C>> }): Promise<{ replaced: C | null; lead: string[] }> {
  const { port, input, breaking, uncounted } = parts;
  const satisfied = [...(parts.satisfied ?? [])];
  const none = { replaced: null, lead: [] as string[] };
  const first = cut(JSON.stringify(shortOf(input)), 800);
  if (!breaking.length) {
    if (uncounted.length || satisfied.length) noteRedecide({ asked: false, count: 0, breaking: [], uncounted: [...uncounted], ...(satisfied.length ? { satisfied } : {}), act: first });
    return none;
  }
  if (parts.urgent) {
    // An urgent decision wants its act at once: nothing waits for a second opinion.
    noteRedecide({ asked: false, count: 0, skipped: 'urgent', breaking: [...breaking], uncounted: [...uncounted], ...(satisfied.length ? { satisfied } : {}), act: first });
    return none;
  }
  const note = redecideNote(port.label, input, breaking);
  const failedWords = (error: unknown) => cut(String((error as Error | undefined)?.message ?? error).replace(/\s+/gu, ' '), 200);
  let answer: FcaRedecided | null;
  try {
    answer = await port.ask(note, parts.signal);
  } catch (error) {
    if (parts.signal.aborted) throw error;
    port.log(`Shannon FCA redecide failed why=${failedWords(error)}`);
    noteRedecide({ asked: true, count: 1, outcome: 'kept_first', why: 'failed', failed: failedWords(error), breaking: [...breaking], uncounted: [...uncounted], act: first });
    return none;
  }
  if (!answer) {
    noteRedecide({ asked: false, count: 0, skipped: 'no_stronger_model', breaking: [...breaking], uncounted: [...uncounted], act: first });
    return none;
  }
  const model = answer.model;
  let costUsd = answer.usage.costUsd, ms = answer.ms, usageComplete = answer.usage.complete;
  const tokens = { input: answer.usage.inputTokens, cacheRead: answer.usage.cachedInputTokens, cacheWrite: answer.usage.cacheCreationInputTokens, output: answer.usage.outputTokens };
  const spent = () => ({ model, ms, costUsd, usageComplete, tokens: { ...tokens } });
  const row = { asked: true, count: 1, breaking: [...breaking], uncounted: [...uncounted], act: first };
  const acts = answer.calls.filter(call => call.name === MC_ACT_TOOL), plans = answer.calls.filter(call => call.name === PLAN_UPDATE_TOOL);
  const chosen = acts[0];
  const ignored = answer.calls.filter(call => call !== chosen && !plans.includes(call)).map(call => call.name);
  const refusals: string[] = [];
  let repairs = 0;
  const repairFields = () => repairs ? { repairs, refusedBy: cut(refusals[0] ?? '', 300), ...(refusals[1] ? { repairRefusedBy: cut(refusals[1], 300) } : {}) } : {};
  const kept = (why: string, extra: Record<string, unknown> = {}): { replaced: null; lead: string[] } => {
    noteRedecide({ ...row, ...spent(), outcome: 'kept_first', why, ...(ignored.length ? { ignored } : {}), ...repairFields(), ...extra });
    port.log(`Shannon FCA redecide kept the first act why=${why} model=${model} ms=${ms} costUsd=${costUsd}${repairs ? ' repairs=1' : ''}`);
    return none;
  };
  if (!chosen) return kept(answer.control ? `no_act:${answer.control}` : 'no_act');
  let opus = chosen.input as ActInput;
  // Hands that do not read (their lines are dropped, the act keeps the reason: `SHORT_HAND_ERROR_KEY`) go to the checks, which say why; only an answer with no list of hands at all is refused here.
  const unfit = (act: ActInput | null | undefined): boolean => !act || typeof act !== 'object' || !Array.isArray(act.hands);
  // Its plan.update goes through the plan's tool first (the act's `why` may name a node it made); a failure is told and changes nothing else. It is made once, not again for a mend.
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
  const shapeOf = (act: ActInput) => {
    const difference = actDifference(input, act);
    return { difference, shape: { change: difference.change, changedFields: difference.fields, keep: difference.keep, planUpdate: plans.length > 0, planUpdates,
      opusAct: cut(JSON.stringify(shortOf(act)), 800) } };
  };
  for (;;) {
    let refusal: string | null = unfit(opus) ? '手の欄が無い' : null;
    if (!refusal) {
      const { difference, shape } = shapeOf(opus);
      if (difference.change === 'same') {
        // The same act, whole: it goes in as it is (why it is right is in its why); its checks were passed once and nothing is done twice.
        noteRedecide({ ...row, ...spent(), outcome: 'used', ...shape, ...(ignored.length ? { ignored } : {}), ...repairFields() });
        port.log(`Shannon FCA redecide same act model=${model} ms=${ms} costUsd=${costUsd}`);
        return { replaced: null, lead: [`決め直し（Opus）: 同じ act を出した`, ...lead] };
      }
      const checked = await parts.recheck(opus);
      if (checked.ok) {
        noteRedecide({ ...row, ...spent(), outcome: 'used', ...shape, ...(ignored.length ? { ignored } : {}), ...repairFields() });
        port.log(`Shannon FCA redecide used model=${model} change=${difference.change} ms=${ms} costUsd=${costUsd}${repairs ? ' repairs=1' : ''}`);
        const said = difference.change === 'hands' ? '手を替えた' : `手は同じで ${difference.fields.join('・')} を替えた`;
        return { replaced: checked.value, lead: [`決め直し（Opus）: ${said}。列に入れたのは Opus の act: ${cut(JSON.stringify(shortOf(opus)), 600)}`, ...lead] };
      }
      refusal = checked.why;
    }
    refusals.push(refusal);
    const written = unfit(opus) ? {} : shapeOf(opus).shape;
    // A refusal of the second try is final; the first is mended once, in the writing (A-11 2).
    if (repairs >= 1) return kept('refused', written);
    repairs = 1;
    let again: FcaRedecided | null;
    try {
      again = await port.ask(`${note}\n\n${repairNote(opus, refusal)}`, parts.signal);
    } catch (error) {
      if (parts.signal.aborted) throw error;
      port.log(`Shannon FCA redecide failed why=${failedWords(error)} repair=1`);
      return kept('refused', { repairFailed: failedWords(error), ...written });
    }
    if (!again) return kept('refused', written);
    costUsd += again.usage.costUsd; ms += again.ms; usageComplete = usageComplete && again.usage.complete;
    tokens.input += again.usage.inputTokens; tokens.cacheRead += again.usage.cachedInputTokens;
    tokens.cacheWrite += again.usage.cacheCreationInputTokens; tokens.output += again.usage.outputTokens;
    const mended = again.calls.find(call => call.name === MC_ACT_TOOL);
    if (!mended) return kept('refused', { repairFailed: again.control ? `no_act:${again.control}` : 'no_act', ...written });
    opus = mended.input as ActInput;
  }
}
