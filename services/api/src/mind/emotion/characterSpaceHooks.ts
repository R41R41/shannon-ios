/**
 * Her character space in the text turn's hooks (owner 2026-10-20; `SHANNON_CHARACTER_SPACE`): the region she replies from, what it does
 * to the feeling turn's decision, her identity's core (the space's, a fixed text), the stronger model's share of the day, the routing
 * that fails closed where a region asks for a check, and her face. The feeling turn's hooks (`feelingPorts.ts`) call these; without a
 * space (the switch off, a voice turn) each returns what it was handed. Core: emotion.
 */
import {
  CHARACTER_CORE, CHARACTER_REGIONS, characterCoreBlock, characterCoreForSpace, continuedAfterRefusal, feelingTurnFor, otherAiIn, regionTurn,
  type FeelingTurnDecision, type RegionId, type ReplyCheckContext, type ShannonFace, type StrongReplyReason,
} from '@shannon/cognition';
import { holdsAgainstOwner } from './feelingAmends.js';
import type { FeelingTurnHandle } from './feelingPorts.js';

/** The region she replies from this turn (absent without her space). */
export function regionOf(handle: Pick<FeelingTurnHandle, 'lines'>): RegionId | undefined {
  return handle.lines?.space?.selection.primary;
}

/**
 * The feeling turn in her region (`regionTurn`): a 「ふつう」 turn takes the region's stance, a vivid region shows it はっきり. Never while she
 * is pulling back (review 4): her composure off its ordinary register, a touch after her no going on, or something still held against
 * him (the owner alone).
 */
export function spaceDecision(handle: FeelingTurnHandle, decision: FeelingTurnDecision | null): FeelingTurnDecision | null {
  const region = regionOf(handle);
  if (!decision || !region) return decision;
  const held = handle.key.audience === 'owner_alone' && holdsAgainstOwner(handle.snapshot, handle.at);
  if (handle.register !== 'normal' || continuedAfterRefusal(handle.lines?.ledger, handle.at) || held) return decision;
  const words = handle.words ?? '';
  // With anyone else there, the owner-only stances a region takes become 「ふつう」 (review 5).
  return feelingTurnFor(regionTurn(decision, region, { words, otherAi: otherAiIn(words) }), handle.key.audience);
}

/** The v2 core as it stands in her identity (`withCharacterCore`): what the space's core takes the place of. */
const V2_CORE_BLOCK = characterCoreBlock(CHARACTER_CORE);

/**
 * Her identity with the space's core in place of v2 (only where the v2 core block stands: the owner alone with her inner note on). One
 * fixed text whatever the region, so the cached prefix holds while the region moves; who she is now is the last block's.
 */
export function spaceIdentity<T extends { systemPrompt: string; prompt: string }>(handle: FeelingTurnHandle | null, layered: T): T {
  if (!handle || !regionOf(handle)) return layered;
  try {
    const core = characterCoreBlock(characterCoreForSpace());
    const swap = (text: string) => text.replace(V2_CORE_BLOCK, () => core);
    return { ...layered, systemPrompt: swap(layered.systemPrompt), prompt: swap(layered.prompt) };
  } catch {
    return layered;
  }
}

/**
 * With her space on every text reply is the stronger model's (owner 2026-10-20: 「返事は Sonnet 5.5 で」); those may take at most this
 * share of the day's cap, so that a refusal or a touch after her no later that day still finds the stronger model (review 8).
 */
export const SPACE_CAP_SHARE = 0.8;
export const capFor = (reason: StrongReplyReason | null, cap: number) => (reason === 'space' ? Math.floor(cap * SPACE_CAP_SHARE) : cap);

/** Past the cap the reply stays on Haiku; for a space reply that is the ordinary end of a long day, not worth a line each turn. */
export function warnCapped(reason: StrongReplyReason | null): void {
  if (reason !== 'space') console.warn('Shannon feeling reply model: the day\'s cap of strong replies is reached; this reply stays on Haiku');
}

type Routed = { feelingStrong?: true; feelingCheck?: ReplyCheckContext };

/** The routing of a turn; in a region that asks for a check before sending, a failure of it still checks (review 9: it fails closed). */
export function routedOrChecked(handle: FeelingTurnHandle, route: (handle: FeelingTurnHandle) => Routed,
  check: (handle: FeelingTurnHandle) => ReplyCheckContext | null): Routed {
  try {
    return route(handle);
  } catch {
    // A strong reply reserved before the failure is not one (its reply is the ordinary model's): the day's count gets it back.
    if (handle.strong) {
      handle.port.events.releaseStrong(handle.scopeKey, handle.at);
      handle.strong = false;
    }
    const region = regionOf(handle);
    if (!region || !CHARACTER_REGIONS[region].checkBefore) return {};
    try {
      const context = check(handle);
      return context ? { feelingCheck: context } : {};
    } catch {
      return {};
    }
  }
}

/** Her face in her region, as the mood face (a stance or a visible feeling still takes the face first); absent without her space. */
export function regionFace(handle: Pick<FeelingTurnHandle, 'lines'> | null): ShannonFace | undefined {
  const region = handle ? regionOf(handle) : undefined;
  return region ? CHARACTER_REGIONS[region].face : undefined;
}
