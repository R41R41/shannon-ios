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
export type MinecraftRetryHint = 'retry_same' | 'change_situation' | 'need_material' | 'invalid_input';
const RETRY_SAME = new Set(['interrupted', 'timeout', 'movement_incomplete', 'position_verification_failed', 'placement_unconfirmed', 'not_ready',
  'BODY_DEADLINE']);
const NEED_MATERIAL = new Set(['material_missing', 'missing_item', 'missing_tool', 'wrong_tool', 'tool_durability_low', 'tool_broke']);
const INVALID_INPUT = new Set(['unsupported_target', 'protected_target']);
/** Fixed words, the same for every failure of a kind (they sit in replayed history, and the cache reads them as they were). */
const HINT_WORDS: Readonly<Record<MinecraftRetryHint, string>> = Object.freeze({
  retry_same: 'そのままもう一度試せる',
  change_situation: '位置・対象・周りを変えてから試す',
  need_material: '材料や道具がそろうまで同じ操作は通らない',
  invalid_input: '引数か対象を直さない限り通らない',
});

/** The hint of a failure type; any other code changes the situation first. Null when the body sent none. */
export function minecraftRetryHint(failureType: unknown): MinecraftRetryHint | null {
  if (typeof failureType !== 'string' || !failureType) return null;
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
  return toolFailure('failed', `${text}\n［再試行の目安: ${hint}｜${HINT_WORDS[hint]}］`, { retryable: hint === 'retry_same' || hint === 'change_situation' });
}
