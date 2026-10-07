import type { TurnRouting } from '../../contracts/turnRoutingContract.js';
import type { TurnDeadline } from '../../mind/action/respond/turnDeadline.js';
import { finishTurn, routeTurn, type RoutedTier } from '../../mind/action/respond/turnRouting.js';
import { offerWithMenu, ownerAloneReads, startTurnToolMenu, type ConversationToolServer, type ToolMenuChooser, type TurnChoiceAnswer } from '../../mind/tools/shannonToolSession.js';
import type { ShannonToolRunner } from '../../mind/tools/shannonToolRunner.js';
import type { ShannonModelToolSession } from '../../infra/models/chatModelTools.js';

/**
 * Syzygy ADR-0008 stage 2 on a voice turn (`docs/skill-and-routing-contract.md`), kept out of `apiLiveVoice.ts`. Without the
 * stage-2 wiring each of these returns at once what the turn had (no Jev call, no extra await).
 */

/** Her tools' audience, and the second Jev call (the menu; the difficulty from step 4) started beside the router's. */
export function startVoiceStage2(chooser: ToolMenuChooser | undefined | null, parts: {
  autonomy: { tools?: ShannonToolRunner } | undefined; server: Partial<ConversationToolServer>; scopeKey: string; threadId: string; transcript: string;
  guest: boolean; legacyGuest: boolean; alone: boolean;
}) {
  const toolAudience = parts.guest ? !parts.legacyGuest && 'guests' as const : parts.alone || 'others' as const;
  const choices = startTurnToolMenu(chooser, parts.autonomy, parts.scopeKey, 'voice', toolAudience, parts.server, `${parts.threadId}\n${parts.transcript}`, ownerAloneReads(toolAudience));
  return { toolAudience, choices };
}

/** The offer narrowed by the menu and the turn's tier (voice: with the time it has left), once the second call has answered. */
export async function voiceOfferAndTier<T extends { tools?: ShannonModelToolSession }>(routing: TurnRouting | undefined, offered: T, choices: Promise<TurnChoiceAnswer>,
  turn: { scopeKey: string; threadId: string; deadline: TurnDeadline; at: string }): Promise<{ offer: T; tier: RoutedTier | null }> {
  const answer = await choices;
  const offer = await offerWithMenu(offered, Promise.resolve(answer));
  return { offer, tier: routeTurn(routing, { scopeKey: turn.scopeKey, surface: 'voice', threadId: turn.threadId, answer, remainingMs: turn.deadline.left(), at: turn.at }) };
}

/** After the reply: the verdict and her choices learned (her spoken words are not amended). */
export async function voiceFinished(routing: TurnRouting, turn: {
  scopeKey: string; threadId: string; alone: boolean; reply: string; completion: { outOfTime?: true; escalated?: true; mode?: string }; tier: RoutedTier | null;
  tools: ShannonModelToolSession | undefined; deadline: TurnDeadline; at: string;
}): Promise<string> {
  return (await finishTurn(routing, { scopeKey: turn.scopeKey, surface: 'voice', threadId: turn.threadId, presence: turn.alone ? 'alone' : 'others', reply: turn.reply,
    outOfTime: turn.completion.outOfTime === true, escalated: turn.completion.escalated === true, decision: turn.tier, tools: turn.tools,
    remainingMs: turn.deadline.left(), at: turn.at, answeredBy: turn.completion.mode })).reply;
}
