import type { MinecraftControlReceipt, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
import { toolFailure, toolOk, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';

/**
 * How long one body skill may run (Minebot lane agreement, 2026-10-14): the catalog's `maxDurationMs` for that skill, at most
 * `MINECRAFT_SKILL_MAX_MS`, and the former fixed 120 s when the body does not send it (or sends something else). The body runs
 * for min(maxDurationMs, the command's deadline); the API waits for its receipt as long.
 */
export const MINECRAFT_SKILL_DEFAULT_MS = 120_000;
export const MINECRAFT_SKILL_MAX_MS = 600_000;
export function minecraftSkillMilliseconds(skill: Pick<MinecraftSkillDefinition, 'maxDurationMs'> | undefined): number {
  const value = skill?.maxDurationMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1_000) return MINECRAFT_SKILL_DEFAULT_MS;
  return Math.min(Math.round(value), MINECRAFT_SKILL_MAX_MS);
}

/** What to do after a failed body skill, from the body's `failureType` (Minebot lane agreement, 2026-10-14). */
export type MinecraftRetryHint = 'retry_same' | 'change_situation' | 'need_material' | 'invalid_input' | 'prepare_first';
/**
 * The body's night gate (agreed with the body lane on 2026-10-19, Minecraft run 16: down for diamonds at night with no armour, no
 * cooked food and no bed, she died to a zombie at y=-7): at dusk or night it refuses to take her below y=16 while armour, cooked food
 * or a bed is missing, and its text ends with `足りない: armor, cooked_food, bed` (those missing only). The same call does not go
 * through until they are made, so it is not retryable; the hint names the next moves for what is missing.
 */
export const NIGHT_GATE_FAILURE = 'night_unprepared';
const NIGHT_GATE_NEEDS = Object.freeze({ armor: '胸当て（鉄8）を作って着る', cooked_food: 'かまどで肉を焼く', bed: '同じ色の羊毛3個でベッド' });
type NightNeed = keyof typeof NIGHT_GATE_NEEDS;
/** The missing things the gate named, in a fixed order; all three when its text names none (the words stay fixed either way). */
export function nightGateNeeds(text: string): NightNeed[] {
  const named = /足りない[:：]\s*([a-z_,\s]{1,60})/u.exec(text)?.[1]?.split(/[\s,]+/u) ?? [];
  const needs = (Object.keys(NIGHT_GATE_NEEDS) as NightNeed[]).filter(need => named.includes(need));
  return needs.length ? needs : Object.keys(NIGHT_GATE_NEEDS) as NightNeed[];
}
const nightGateWords = (text: string) =>
  `夜に深い所へは備えがそろうまで行けない。次の手: ${nightGateNeeds(text).map(need => NIGHT_GATE_NEEDS[need]).join('／')}。拠点か浅い穴で精錬と料理を進める`;
/**
 * A bed the body could not craft for want of wool of one colour (agreed with the body lane on 2026-10-19; owner: "make the bed as
 * soon as three wool are in, so that a mixed colour shows itself"; run 16 carried white 2 and light grey 1 and never noticed). The
 * body's text says the colours it holds and its own next move, and ends with what is short, `足りない: white_wool×1` (the colour of
 * which most is carried), or `足りない: wool×3` with none. The hint repeats the next move in fixed words: the sheep of that colour.
 */
export const BED_WOOL_FAILURE = 'bed_wool_mismatch';
/** What the bed is short of: the wool's colour (null: any, none carried) and how many. Null when the text names nothing. */
export function bedWoolShort(text: string): { color: string | null; count: number } | null {
  const match = /足りない[:：]\s*(?:([a-z][a-z_]{0,30})_)?wool×(\d)\s*$/u.exec(text.trim());
  return match ? { color: match[1] ?? null, count: Math.min(3, Math.max(1, Number(match[2]))) } : null;
}
function bedWoolWords(text: string): string {
  const short = bedWoolShort(text);
  if (!short?.color) return 'ベッドには同じ色の羊毛が3個要る → 羊を探して同じ色を3匹倒し、3個たまったらすぐベッドを作る';
  return `ベッドには同じ色の羊毛が3個要る → ${short.color} の羊をあと${short.count}匹（attack-continuously の color=${short.color}）`;
}
/**
 * The body's own reflex (a meal, a step back from a creeper) took the body from the command (P8, 2026-10-17). Nothing was wrong
 * with the command or the model's choice: it can be run again once the reflex is over and a new observation has been read. It is
 * `retry_same`, and it does not count as a failed step (`ToolResult.bodyReflex`, read by the FCA runner).
 */
export const BODY_REFLEX_FAILURE = 'interrupted_by_reflex';
const RETRY_SAME = new Set(['interrupted', BODY_REFLEX_FAILURE, 'timeout', 'movement_incomplete', 'position_verification_failed',
  'placement_unconfirmed', 'not_ready', 'BODY_DEADLINE']);
const NEED_MATERIAL = new Set(['material_missing', 'missing_item', 'missing_tool', 'wrong_tool', 'tool_durability_low', 'tool_broke',
  BED_WOOL_FAILURE]);
const INVALID_INPUT = new Set(['unsupported_target', 'protected_target']);
/** Fixed words, the same for every failure of a kind (they sit in replayed history, and the cache reads them as they were). */
const HINT_WORDS: Readonly<Record<MinecraftRetryHint, string>> = Object.freeze({
  retry_same: 'そのままもう一度試せる',
  change_situation: '位置・対象・周りを変えてから試す',
  need_material: '材料や道具がそろうまで同じ操作は通らない',
  invalid_input: '引数か対象を直さない限り通らない',
  prepare_first: '備えがそろうまで同じ操作は通らない',
});

/** The hint of a failure type; any other code changes the situation first. Null when the body sent none. */
export function minecraftRetryHint(failureType: unknown): MinecraftRetryHint | null {
  if (typeof failureType !== 'string' || !failureType) return null;
  if (failureType === NIGHT_GATE_FAILURE) return 'prepare_first';
  if (RETRY_SAME.has(failureType)) return 'retry_same';
  if (NEED_MATERIAL.has(failureType)) return 'need_material';
  if (INVALID_INPUT.has(failureType) || failureType.startsWith('invalid_')) return 'invalid_input';
  return 'change_situation';
}

/**
 * A body skill's receipt as the tool result the model reads. A failure with a `failureType` carries its hint at the end of its text
 * (`［再試行の目安: retry_same｜…］`) and is retryable for `retry_same` and `change_situation` only. A failure without one, a
 * `BODY_*` code in its text among them, is as it was: not retryable, its text as the body wrote it.
 */
export function minecraftSkillResult(receipt: MinecraftControlReceipt): ToolResult {
  if (receipt.outcome === 'completed') return toolOk(receipt.result ?? '操作の実行結果を受け取った。目的の達成は新しい観測で確認する。');
  const text = receipt.result ?? `操作は${receipt.outcome}になった。現在の観測からやり直し方を判断する。`;
  const hint = minecraftRetryHint(receipt.failureType);
  if (!hint) return toolFailure('failed', text, { retryable: false });
  const words = hint === 'prepare_first' ? nightGateWords(text) : receipt.failureType === BED_WOOL_FAILURE ? bedWoolWords(text) : HINT_WORDS[hint];
  const failure = toolFailure('failed', `${text}\n［再試行の目安: ${hint}｜${words}］`,
    { retryable: hint === 'retry_same' || hint === 'change_situation' });
  return receipt.failureType === BODY_REFLEX_FAILURE ? Object.freeze({ ...failure, bodyReflex: true as const }) : failure;
}
