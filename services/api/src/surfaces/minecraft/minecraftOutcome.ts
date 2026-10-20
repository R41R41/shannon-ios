import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { FAST_JUDGMENT_LIMITS, RANGED_ENEMIES, WALK_UP_SHOOTERS, armedAndArmoured } from '../../mind/action/reflex/fastJudgment.js';
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
 * cooked food and no bed, she died to a zombie at y=-7): from 300 s before dark (run 17) and at night it refuses to take her below
 * y=16 while armour, cooked food
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
  `日暮れ前と夜に深い所へは備えがそろうまで行けない。次の手: ${nightGateNeeds(text).map(need => NIGHT_GATE_NEEDS[need]).join('／')}。拠点か浅い穴で精錬と料理を進める`;
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
 * A fight she asks for against a creeper is refused before it is sent (owner 2026-10-19, Minecraft run 17: her flee from a creeper
 * moved 2 m and failed, she then called `combat` on it, and it blew up at her side from full health). The refusal says the moves that
 * do work: away from it, or three blocks up a pillar where it cannot reach. Only a target she names; `hostile` is the body's choice.
 */
const FIGHTS: Readonly<Record<string, string>> = Object.freeze({
  'mc.combat': 'target', 'mc.attack-continuously': 'entityName', 'mc.attack-nearest': 'entityName',
});
export const CREEPER_FIGHT_REFUSAL = 'クリーパーとは戦わない（近くで爆発すると体力の大半を失う）。離れる: flee-from（target=creeper、minDistance=16）。'
  + '逃げ道が無い時は tower-up（height=3）で柱に上る。爆発の後は落とし物を拾う。';
export function creeperFightRefusal(name: string, input: unknown): ToolResult | null {
  const key = FIGHTS[name], value = key && input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  const creeper = typeof value === 'string' && /creeper/iu.test(value) && !holdingPosition(input);
  return creeper ? toolFailure('refused', CREEPER_FIGHT_REFUSAL, { retryable: false }) : null;
}
/** A fight from inside her cage (`holdPosition=true`: hitting through the gap, never stepping out), which the body lane lets through too. */
const holdingPosition = (input: unknown) => !!input && typeof input === 'object' && (input as Record<string, unknown>).holdPosition === true;
export const ONE_HIT_WAIT_REFUSAL = 'あと1撃で倒れる時に、敵の近くで待たない。離れる（flee-from、minDistance=16）・3段上る（tower-up、height=3）・'
  + '囲う（build-around-self、structureName=slit_shelter）のどれかを先にする。';
/**
 * A wait while one more hit of a threat within 16 m takes her down (`world.margin.hitsLeft` at most 1) is refused (owner 2026-10-19,
 * Minecraft run 17: she waited 50 s with "one hit left" shown and a creeper came).
 */
function oneHitWaitRefusal(observation: BodyObservation | null): ToolResult | null {
  const world = observation?.state.world as { margin?: { hitsLeft?: { hits?: unknown } }; nearbyThreats?: unknown } | undefined;
  const hits = world?.margin?.hitsLeft?.hits;
  // A threat that can reach her: one outside her sealed hole cannot, and a wait inside it is the night shelter's own step.
  const near = reaching(world?.nearbyThreats).some(threat => threat.name !== 'enderman' && threat.name !== 'ender_dragon');
  return typeof hits === 'number' && hits <= 1 && near ? toolFailure('refused', ONE_HIT_WAIT_REFUSAL, { retryable: false }) : null;
}
/** The threats within 16 m that can reach her (`canReachMe` not false), as the fast judgment reads them. */
function reaching(threats: unknown): Array<{ name: string; distance: number }> {
  return (Array.isArray(threats) ? threats : []).flatMap(threat => {
    const item = threat as { name?: unknown; distance?: unknown; canReachMe?: unknown };
    return typeof item?.name === 'string' && typeof item.distance === 'number' && item.distance <= 16 && item.canReachMe !== false
      ? [{ name: item.name, distance: item.distance }] : [];
  });
}
export const FLOOR_FIGHT_REFUSAL = '体の反射が退避中（体を使用中）。終わるまで戦いの道具を出さない: 退避を取り消すことになる。少し待ってから、新しい観測で決める。';
export const RANGED_FIGHT_REFUSAL = '体力が半分以下で、遠くから撃つ敵がいる時は戦わない。離れて壁や木の陰へ（flee-from、target=その敵、minDistance=16）、'
  + 'または縦穴（dig-shelter）。夜は外へ出ない。';
/**
 * The fights she asks for that are refused before they are sent: against a creeper (`creeperFightRefusal`); any fight while the body's
 * floor holds the body (its retreat would be cancelled: Minecraft run 17, D14, she called `combat` at 11 health against a skeleton at
 * night, cancelled the floor's retreat and died); and, at half health or less with a ranged enemy within 16 m that can reach her, a
 * fight against it or against any hostile (a zombie named at her side is still hers to fight).
 */
export function fightRefusal(name: string, input: unknown, observe: () => BodyObservation | null): ToolResult | null {
  if (name === 'mc.wait-time') return oneHitWaitRefusal(observe());
  if (!FIGHTS[name]) return null;
  const creeper = creeperFightRefusal(name, input), observation = creeper ? null : observe();
  if (creeper || !observation) return creeper;
  if (observation.facts.floorActive === true) return toolFailure('refused', FLOOR_FIGHT_REFUSAL, { retryable: true });
  return rangedFightRefusal(name, input, observation);
}
/** At half health or less with a ranged enemy that can reach her, a fight against it or against any hostile (not from her cage). */
function rangedFightRefusal(name: string, input: unknown, observation: BodyObservation): ToolResult | null {
  const world = observation.state.world as { health?: unknown; nearbyThreats?: unknown } | undefined;
  const health = typeof world?.health === 'number' ? world.health : null;
  if (health === null || health > 10 || holdingPosition(input)) return null;
  const shooters = reaching(world?.nearbyThreats).filter(threat => RANGED_ENEMIES.has(threat.name));
  // mb-r21 (run 21): with a sword in hand and armour on, one or two archers she can walk up to are fought down to the floor of the rules.
  if (health > FAST_JUDGMENT_LIMITS.lowHealth && shooters.length <= FAST_JUDGMENT_LIMITS.shooterFightMax
    && shooters.every(threat => WALK_UP_SHOOTERS.has(threat.name)) && armedAndArmoured(world)) return null;
  const ranged = shooters.length > 0;
  const target = String((input as Record<string, unknown> | null)?.[FIGHTS[name]!] ?? 'hostile').toLowerCase();
  const atRanged = RANGED_ENEMIES.has(target) || target === 'hostile' || target === '';
  return ranged && atRanged ? toolFailure('refused', RANGED_FIGHT_REFUSAL, { retryable: false }) : null;
}

/**
 * A body skill's receipt as the tool result the model reads. A failure with a `failureType` carries its hint at the end of its text
 * (`［再試行の目安: retry_same｜…］`) and is retryable for `retry_same` and `change_situation` only. A failure without one, a
 * `BODY_*` code in its text among them, is as it was: not retryable, its text as the body wrote it.
 */
const ARMOUR_PIECE = /^(?:leather|chainmail|iron|golden|diamond|netherite)_(?:helmet|chestplate|leggings|boots)$/u;
/**
 * A piece of armour she asked to be crafted that the frame shows in her pack or worn (mb-r21, run 21: the body's armour reflex put on
 * the chestplate and the helmet the moment each was made, cut the craft off as `interrupted_by_reflex`, and the craft read as a failure
 * with the calls after it in the response thrown away). The item name when it is one, else null.
 */
export function armourCrafted(input: unknown, observation: BodyObservation | null): string | null {
  const name = input && typeof input === 'object' ? (input as Record<string, unknown>).itemName : undefined;
  if (typeof name !== 'string' || !ARMOUR_PIECE.test(name)) return null;
  const world = observation?.state.world as { inventory?: unknown; worn?: unknown } | undefined;
  const inPack = (Array.isArray(world?.inventory) ? world!.inventory : []).some(item => (item as { name?: unknown } | null)?.name === name);
  const worn = typeof world?.worn === 'string' && new RegExp(`(?:頭|胴|脚|足):\\s*${name}(?![a-z_])`, 'u').test(world.worn);
  return inPack || worn ? name : null;
}

/** The body's own failure kind kept on a result (minecraftSkillResult), for the executor's procedures (mb-arch); the model never reads it. */
export function bodyFailureOf(result: ToolResult): string | null {
  const kind = (result as { bodyFailure?: unknown }).bodyFailure;
  return typeof kind === 'string' ? kind : null;
}

export function minecraftSkillResult(receipt: MinecraftControlReceipt): ToolResult {
  if (receipt.outcome === 'completed') return toolOk(receipt.result ?? '操作の実行結果を受け取った。目的の達成は新しい観測で確認する。');
  const text = receipt.result ?? `操作は${receipt.outcome}になった。現在の観測からやり直し方を判断する。`;
  const hint = minecraftRetryHint(receipt.failureType);
  // The body's kind as it named it (a closed id), for the executor's procedures (session mb-arch).
  const kind = typeof receipt.failureType === 'string' && /^[a-z_]{1,40}$/u.test(receipt.failureType) ? { bodyFailure: receipt.failureType } : {};
  if (!hint) return { ...toolFailure('failed', text, { retryable: false }), ...kind };
  const words = hint === 'prepare_first' ? nightGateWords(text) : receipt.failureType === BED_WOOL_FAILURE ? bedWoolWords(text) : HINT_WORDS[hint];
  const failure = { ...toolFailure('failed', `${text}\n［再試行の目安: ${hint}｜${words}］`,
    { retryable: hint === 'retry_same' || hint === 'change_situation' }), ...kind };
  return receipt.failureType === BODY_REFLEX_FAILURE ? Object.freeze({ ...failure, bodyReflex: true as const }) : failure;
}
