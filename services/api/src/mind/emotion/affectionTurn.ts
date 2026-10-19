/**
 * Her affection in the text turn (owner 2026-10-20; `SHANNON_AFFECTION`): her stage with the owner alone, what it does to the feeling
 * turn's decision, to her identity's core and to the stronger model's share of the day. The feeling turn's hooks (`feelingPorts.ts`)
 * call these; without a stage (the switch off, anyone else there, a voice turn) each returns what it was handed. Core: emotion.
 */
import {
  CHARACTER_CORE, characterCoreBlock, characterCoreForStage, continuedAfterRefusal, devotedTurn, otherAiIn, utteranceKind, type AffectionStage,
  type FeelingTurnDecision, type ReplyCheckContext, type StrongReplyReason,
} from '@shannon/cognition';
import { holdsAgainstOwner } from './feelingAmends.js';
import type { FeelingTurnHandle } from './feelingPorts.js';

/** Her stage in a turn of the owner alone (absent otherwise, and while it is off). */
export function stageOf(handle: Pick<FeelingTurnHandle, 'key' | 'lines'>): AffectionStage | undefined {
  return handle.key.audience === 'owner_alone' ? handle.lines?.affection?.stage : undefined;
}

/**
 * At 本気 a plain turn is not left plain (`devotedTurn`); at any other stage, the decision as it came. Never while she is pulling back
 * (review 4): her composure off its ordinary register, a touch after her no going on, or something still held against him.
 */
export function stagedDecision(handle: FeelingTurnHandle, decision: FeelingTurnDecision | null): FeelingTurnDecision | null {
  if (!decision || stageOf(handle) !== 'devoted') return decision;
  const withdrawn = handle.register !== 'normal' || continuedAfterRefusal(handle.lines?.ledger, handle.at) || holdsAgainstOwner(handle.snapshot, handle.at);
  if (withdrawn) return decision;
  const words = handle.words ?? '';
  return devotedTurn(decision, { words, kindWords: utteranceKind(words) === 'praised', otherAi: otherAiIn(words) });
}

/** The v2 core as it stands in her identity (`withCharacterCore`): what a stage's core takes the place of. */
const V2_CORE_BLOCK = characterCoreBlock(CHARACTER_CORE);

/**
 * Her identity with the core of her stage in place of v2 (only where the v2 core block stands, the owner alone with her inner note on;
 * ツンデレ is v2 itself). Everything else, and every turn without a stage, is returned as it was (the very object).
 */
export function stagedIdentity<T extends { systemPrompt: string; prompt: string }>(handle: FeelingTurnHandle | null, layered: T): T {
  const stage = handle ? stageOf(handle) : undefined;
  if (!stage || stage === 'tsundere') return layered;
  try {
    const core = characterCoreBlock(characterCoreForStage(stage));
    const swap = (text: string) => text.replace(V2_CORE_BLOCK, () => core);
    return { ...layered, systemPrompt: swap(layered.systemPrompt), prompt: swap(layered.prompt) };
  } catch {
    return layered;
  }
}

/**
 * At 本気 every reply to him alone is a strong one; those may take at most this share of the day's cap, so that a refusal or a touch
 * after her no later that day still finds the stronger model (review 8).
 */
export const DEVOTED_CAP_SHARE = 0.7;
export const capFor = (reason: StrongReplyReason | null, cap: number) => (reason === 'devoted' ? Math.floor(cap * DEVOTED_CAP_SHARE) : cap);

/** Past the cap the reply stays on Haiku; at 本気 that is the ordinary end of a long day, not worth a line each turn. */
export function warnCapped(reason: StrongReplyReason | null): void {
  if (reason !== 'devoted') console.warn('Shannon feeling reply model: the day\'s cap of strong replies is reached; this reply stays on Haiku');
}

type Routed = { feelingStrong?: true; feelingCheck?: ReplyCheckContext };

/** The routing of a turn; at 本気 a failure of it still leaves the check before sending (review 9: it fails closed). */
export function routedOrChecked(handle: FeelingTurnHandle, route: (handle: FeelingTurnHandle) => Routed,
  check: (handle: FeelingTurnHandle) => ReplyCheckContext | null): Routed {
  try {
    return route(handle);
  } catch {
    if (stageOf(handle) !== 'devoted') return {};
    try {
      const context = check(handle);
      return context ? { feelingCheck: context } : {};
    } catch {
      return {};
    }
  }
}
