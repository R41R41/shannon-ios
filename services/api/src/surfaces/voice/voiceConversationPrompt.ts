import { guardedShannonSeenPrompt } from '@shannon/cognition';
import { agentTaskPromptProjection } from '../../mind/action/respond/apiPromptProjection.js';
import { buildConversationOrchestrationPrompt } from '../../mind/action/respond/conversationOrchestration.js';
import { composedTurnContext, turnReplay, type TurnParts } from '../../mind/action/respond/conversationTurn.js';
import { conversationFcaProvenance } from '../../mind/action/fca/fcaConversationPorts.js';
import { innerNoteVoice, stillFeltLine } from '../../mind/emotion/companionPresence.js';
import { feelingVoice } from '../../mind/emotion/feelingPorts.js';
import { DisclosureGate, sharedDailyFocus } from '../../mind/inhibition/memoryDisclosure.js';
import { guestPeoplePrompt } from '../../mind/memory/peopleMemoryPrompts.js';
import { toolTraceReader } from '../../mind/tools/shannonToolSession.js';
import { notHisWordsToHer } from '../../mind/attention/voiceSilence.js';
import { temporaryGuestVoiceInstructions, voiceConversationInstructions } from './voiceConversationInstructions.js';
import { guestSpeakerReminder, guestTurnPositionInstruction } from './voiceIntroductionInstructions.js';
import { voiceTranscriptInterpretationPrompt } from './voiceTranscriptContext.js';
import { voiceTurnStages, type VoiceConversation } from './voiceConversation.js';

/**
 * A spoken turn's prompt, from the one flow's shared parts (what she remembers, who she is, what she read): her identity with the voice's
 * delivery notes, then the turn's context in the voice's own order, the replay of her conversation, and an FCA turn begun last (moved out
 * of `apiLiveVoice.ts` with every block and its order as they were).
 */
export interface VoiceComposed {
  parts: TurnParts;
  basePrompt: string;
  turnContext: string;
  replay: ReturnType<typeof turnReplay> | null;
  fcaTurn: ReturnType<NonNullable<VoiceConversation['fca']>['begin']> | null;
  fcaStartedAt: number;
}

/** Her identity, fixed first: a friend's call has its own delivery notes; one head: her space's core in her region (as a text turn's). */
function basePromptOf(turn: VoiceConversation, parts: TurnParts): string {
  const notes = turn.temporaryGuest ? [voiceConversationInstructions(true, false, false), temporaryGuestVoiceInstructions]
    : [voiceConversationInstructions(true)];
  return feelingVoice.identity(turn.feelingTurn, [parts.identity.identity, ...notes].join('\n\n'));
}

/** What she remembers: her memory (or, on the slim path, her knowledge and impressions), and who is here and what she remembers of them. */
function memoryBlocks(turn: VoiceConversation, parts: TurnParts): string[] {
  const { cognitive, recalled, peopleRecall } = parts.memory;
  // A client that predates people memory tells the friend that no owner memory is used; keep that promise for it.
  const includeCognitive = turn.temporaryGuest ? !turn.legacyGuest : turn.selectedSkills.has('conversation_memory');
  const slim = [turn.complexTurn ? recalled?.knowledgePrompt : '', turn.legacyGuest ? '' : cognitive.impressionPrompt].filter(Boolean).join('\n\n');
  const presence = turn.guestPresence;
  // Alone: 「誰と何を話した？」 with provenance. 友人も一緒: who is here and what she remembers of them.
  const people = presence ? guestPeoplePrompt({ ...presence, items: peopleRecall?.items ?? [] }) : turn.memoryText(peopleRecall?.prompt);
  return [turn.memoryText(includeCognitive ? cognitive.prompt : slim), people];
}

/**
 * Today's focus (marked when others can hear; none where the owner is not there to release a protected line), what she does in her own
 * time (the owner alone; with someone beside him only what she saw of the room, marked), and his agent work (on a platform, his alone).
 */
function ownBlocks(turn: VoiceConversation, parts: TurnParts): string[] {
  const { dependencies: deps, scopeKey, threadId } = turn;
  const skills = turn.selectedSkills;
  const focus = turn.legacyGuest || turn.openOnly || !skills.has('daily_mind') ? '' : deps.dailyMind?.promptFor(scopeKey, deps.now()) ?? '';
  const gate = new DisclosureGate(turn.present, parts.memory.captured, deps.conversationStore, scopeKey);
  const pursuit = () => deps.autonomy?.pursuitPrompt(scopeKey);
  const own = turn.temporaryGuest || turn.openOnly ? '' : turn.alone ? pursuit() : guardedShannonSeenPrompt(pursuit() ?? '', gate.unlabelledMarker);
  const ownerWork = !turn.seat || turn.alone;
  const tasks = turn.legacyGuest || !ownerWork || !skills.has('agent_status') ? '' : agentTaskPromptProjection(deps.agentTasks.list(scopeKey), threadId);
  return [turn.memoryText(sharedDailyFocus(gate, focus)), own ?? '', tasks];
}

/** Her body (a touch, 2026-10-14; her Minecraft body, his request only while he alone hears), her reads, and her inner note. */
function bodyBlocks(turn: VoiceConversation, parts: TurnParts): Array<string | undefined> {
  const { dependencies: deps, scopeKey, occurredAt } = turn;
  const ownerAlone = turn.alone && !turn.temporaryGuest;
  const touch = deps.reactions?.voiceTouchContext?.(scopeKey, occurredAt, turn.input.reactionLine, ownerAlone) ?? '';
  const note = innerNoteVoice.context(deps.innerNote, scopeKey, turn.alone, turn.guestVoice, occurredAt); // ADR-0012: her inner note.
  return [touch, deps.minecraftLive?.block({ alone: ownerAlone }), parts.capability.prompt, note];
}

/** What the router decided, said to her, and the feeling she is told to show. */
function routeBlocks(turn: VoiceConversation, parts: TurnParts): string[] {
  const { decision, dependencies: deps } = turn;
  const route = ['[Voice route]', `Conversation class: ${decision.conversationClass}. Expected latency: ${decision.latencyClass}.`,
    `Selected capabilities: ${decision.selectedSkills.join(', ') || 'none'}.`,
    `Concrete-solution probability: ${decision.solutionWantedProbability.toFixed(2)}.`,
    decision.solutionWantedProbability < 0.4 ? innerNoteVoice.presence(deps.innerNote)
      : 'Lead with the useful answer or next concrete step while keeping the spoken reply natural.'].join('\n');
  const audience = turn.guestVoice ? 'guest' : turn.alone ? 'owner' : 'others';
  const includeCognitive = turn.temporaryGuest ? !turn.legacyGuest : turn.selectedSkills.has('conversation_memory');
  const still = turn.alone && turn.emotionState && !includeCognitive ? stillFeltLine(turn.emotionState, turn.occurredAt) : '';
  return [route, innerNoteVoice.expressive(deps.innerNote)(turn.provisionalExpressiveEmotion, audience), still,
    turn.temporaryGuest ? guestSpeakerReminder : '', buildConversationOrchestrationPrompt(turn.orchestrationState, deps.agentTasks.list(turn.scopeKey))];
}

const CONFIRMED_IMPLEMENTATION = (request: string) => `[Confirmed implementation clarification]\nThe owner's immediately preceding request was: ${request}\n`
  + 'Your previous reply explicitly asked whether to show an implementation proposal; the owner has now confirmed. Return a concrete taskProposal '
  + 'for that request. The visible proposal card is the start boundary; do not claim code work has begun.';

/** The turn's own grounding last: a confirmed proposal, the voice's grounding, the look, an unclear transcript, a platform's seat. */
function groundingBlocks(turn: VoiceConversation): string[] {
  const confirmed = turn.confirmedImplementationRequest;
  const interpretation = voiceTranscriptInterpretationPrompt(turn.unclearTranscript, turn.rawTranscript, turn.uncertainTranscript);
  // One head: the platform's audience and channel (its typed turn's own blocks, spoken).
  return [confirmed ? CONFIRMED_IMPLEMENTATION(confirmed) : '', turn.backendInstructions, turn.roomLook.prompt, interpretation, turn.seat?.prompt ?? ''];
}

/** The prompt of a spoken turn, its replay, and an FCA turn begun once everything it records is known. */
export function composeVoiceTurn(turn: VoiceConversation, parts: TurnParts): VoiceComposed {
  const call = turn.temporaryGuest ? [guestTurnPositionInstruction(turn.guestCall?.introductionStart === true || turn.guestHistory.length === 0)] : [];
  const turnContext = composedTurnContext([...call, parts.identity.state, ...memoryBlocks(turn, parts), ...ownBlocks(turn, parts), ...bodyBlocks(turn, parts),
    ...routeBlocks(turn, parts), ...groundingBlocks(turn)]);
  // The owner's thread is replayed by character budget; a 「友人も一緒」 call keeps its own in-call turns; a platform's is its conversation's.
  const { dependencies: deps, scopeKey, threadId } = turn;
  const replay = turn.temporaryGuest ? null : turnReplay(voiceTurnStages(deps), { channel: 'voice', captured: parts.memory.captured, scopeKey, threadId,
    present: turn.present, tools: toolTraceReader(deps.toolServer, scopeKey), openOnly: turn.openOnly, at: turn.occurredAt });
  const fcaStartedAt = performance.now(); // From the FCA bridge to the finished tool offer: where 2026-10-12's turns stalled.
  return { parts, basePrompt: basePromptOf(turn, parts), turnContext, replay, fcaTurn: beginVoiceFca(turn, parts), fcaStartedAt };
}

function beginVoiceFca(turn: VoiceConversation, parts: TurnParts): VoiceComposed['fcaTurn'] {
  const { fca, fcaInput } = turn;
  if (!fca || !fcaInput || turn.unclearTranscript || notHisWordsToHer(turn.decision)) return null;
  const { dependencies: deps, scopeKey, threadId } = turn;
  const recalled = [...parts.memory.cognitive.frame.recalledMemoryIDs, ...parts.memory.peopleRecall?.ids ?? []];
  return fca.begin({ ...fcaInput, observedAt: turn.occurredAt,
    recalledMemoryIds: conversationFcaProvenance(parts.memory.captured, deps.conversationStore, scopeKey, threadId, recalled),
    readSourceIds: parts.capability.readSourceIds, ownerAlone: () => deps.toolServer?.audience.othersKnown(scopeKey) === false });
}

