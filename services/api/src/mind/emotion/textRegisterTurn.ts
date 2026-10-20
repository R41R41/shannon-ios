import {
  bypassedTextRegister, textPacingBypassIn, textRegisterFor, textRegisterLines, type FeelingRegister, type FeelingTurnDecision, type TextPacingBypass,
  type TextRegisterDirective,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { ChatTextRegister } from '../../contracts/contracts.js';
import { splitChatSentences } from '../../surfaces/text/chatSentenceSplitter.js';

/**
 * Her text register and pacing on a text turn (Syzygy ADR-0013 item 10; owner's choice 「B. 形＋間と分け方」; `SHANNON_TEXT_REGISTER`).
 * Core: emotion. Before the model writes: the directive from the feeling turn and her composure's register, and its lines for the model.
 * After: the same directive for the device, with what bypasses the pacing (urgent, safety, a promise kept by her tools, a system notice)
 * and the two messages when it splits. The Observer is told the closed values, never the words.
 */
export function textRegisterOf(decision: FeelingTurnDecision, register: FeelingRegister, audience: TextRegisterDirectiveAudience): TextRegisterDirective {
  return observeSync('emotion', { phase: 'feeling.text_register', audience, stance: decision.stance }, () =>
    textRegisterFor({ stance: decision.stance, intensity: decision.intensity, register, audience }),
  value => ({ length: value.length, maxCharacters: value.maxCharacters, emoji: value.emoji, endings: value.endings, pauseMs: value.pauseMs,
    typingMs: value.typingMs, split: value.split }));
}

type TextRegisterDirectiveAudience = Parameters<typeof textRegisterFor>[0]['audience'];

export { textRegisterLines };

/** What bypasses the pacing: a system notice (her reply ran out of time), a promise her tools kept (a write), urgency or safety. */
function bypassOf(input: { message: string; reply: string; outOfTime: boolean; wrote: boolean }): TextPacingBypass | null {
  if (input.outOfTime) return 'system';
  return textPacingBypassIn(input.message, input.reply) ?? (input.wrote ? 'promise' : null);
}

/** The directive before the model writes: bypassed already when his words are urgent or about safety (review M3). */
export function textRegisterBefore(directive: TextRegisterDirective, message: string): ChatTextRegister {
  const bypass = textPacingBypassIn(message, '');
  return bypass ? { ...bypassedTextRegister(directive, bypass), bypass } : { ...directive };
}

/** The directive as the device receives it with the reply. */
export function textRegisterReply(directive: TextRegisterDirective, input: { message: string; reply: string; outOfTime: boolean; wrote: boolean })
  : ChatTextRegister {
  const bypass = bypassOf(input);
  if (bypass) return { ...bypassedTextRegister(directive, bypass), bypass };
  const sentences = directive.split ? splitChatSentences(input.reply) : [];
  const first = sentences[0]?.trim() ?? '', rest = sentences.slice(1).join('').trim();
  return first && rest ? { ...directive, parts: [first, rest] } : { ...directive };
}

/** A voice channel's words are heard, not read: its feeling turn runs without the text register (a typed reply's form and pacing). */
export function feelingPortFor<T extends { textRegister?: boolean } | null>(surface: { voice?: boolean } | undefined, port: T): T {
  return surface?.voice && port ? { ...port, textRegister: false } : port;
}
