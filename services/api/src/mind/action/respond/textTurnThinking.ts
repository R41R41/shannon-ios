import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../../infra/config/serverEnvironment.js';
import type { ShannonModelToolSession } from '../../../infra/models/chatModelTools.js';
import { sessionAsksForTools } from '../../tools/toolsPorts.js';
import type { RoutedTier } from './turnRouting.js';

/**
 * Whether a text turn answers without thinking first (owner decision 2026-10-14, form 「軽い会話だけ考えるのを切る」;
 * `docs/skill-and-routing-contract.md`, "Thinking of a text turn"). Core: response path.
 *
 * Measured in production (2026-10-14, a Windows text turn read aloud): 6.6 s of 8.5 s before the first spoken word were the
 * model's time to its first output, about 400 hidden thinking tokens for an 82-character reply. Voice already answers without
 * thinking since 2026-10-13 (`SHANNON_HAIKU_VOICE_THINKING`); this follows it for the text turns that do not need it.
 *
 * Decided from signals the turn already has, nothing new is asked:
 * - **hard** keeps thinking: the tier policy served `luna_plus` or `sonnet`, or chose by Jev's confident `needs_strong_model`,
 *   luna's learned weakness (its exploration included) or `multi_step` (`decideTier`);
 * - **research** keeps thinking: a web search or the required web read, a place search, admitted research work, an attachment;
 * - **light** skips it: the tier policy's small talk (`jev_only`: the kind is chat and strong, verification and several steps
 *   are all a confident no) and no tool asked for (`sessionAsksForTools`: nothing beyond the always-loaded ones);
 * - **read aloud** skips it: the client says it will read the reply aloud (`readAloud`, the Windows body while 「話しかける」
 *   is on), and the turn is neither hard nor research, whatever Jev's kind (as voice; a turn Jev could not route included).
 * Everything else thinks exactly as before. `SHANNON_TEXT_LIGHT_NO_THINKING=off` makes every text turn think.
 */
export type TextThinkingCase = 'light' | 'read_aloud';

export interface TextThinkingTurn {
  /** The tier the policy decided (`routeTurn`); null when the difficulty was not asked or Jev could not answer. */
  tier: RoutedTier | null;
  /** The turn's tools as offered to the model now (after Jev's menu and the FCA selector). */
  tools: ShannonModelToolSession | undefined;
  /** The request's `readAloud`: only `true` counts. */
  readAloud: unknown;
  /** The turn's research signals (web search asked or chosen, a place search, admitted work, an attachment): any truthy one is research. */
  research: readonly unknown[];
}

type SwitchEnvironment = Readonly<Record<string, string | undefined>>;
const HARD_REASONS: readonly string[] = Object.freeze(['strong', 'luna_weak', 'explore', 'multi_step']);

/** Why the turn answers without thinking, or null when it thinks as configured. Pure; the switch is read by `textTurnThinking`. */
export function textThinkingCase(turn: TextThinkingTurn): TextThinkingCase | null {
  if (turn.research.some(Boolean)) return null;
  const tier = turn.tier;
  if (tier && (tier.served !== 'luna' || HARD_REASONS.includes(tier.reason))) return null;
  if (tier?.tier === 'jev_only' && !sessionAsksForTools(turn.tools)) return 'light';
  return turn.readAloud === true ? 'read_aloud' : null;
}

/** The request field of the turn: `skipThinking` when it answers without thinking; nothing otherwise (the request as it was). */
export function textTurnThinking(turn: TextThinkingTurn, environment: SwitchEnvironment = serverEnvironment()): { skipThinking?: true } {
  if (!switchOn(environment, 'SHANNON_TEXT_LIGHT_NO_THINKING')) return {};
  return textThinkingCase(turn) ? { skipThinking: true } : {};
}
