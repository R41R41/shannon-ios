import { randomUUID } from 'node:crypto';
import type { ApiResponse } from '../../contracts/contracts.js';
import type { ShannonChatModelResult } from '../../infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../../infra/models/chatModelTools.js';
import { displayedVoiceText } from '../../infra/models/voiceAudioTags.js';
import { observeSync, observerHandoff } from '../../infra/observer/observerContext.js';
import { placeReply, wantsNearbyPlaces, wantsPlaceDiscovery } from '../../integrations/places/placeDiscovery.js';
import { combinedPlaceSources, runPlaceDiscoverySkill, spokenPlaceReply } from '../../integrations/places/placeDiscoverySkill.js';
import { isExplicitVoyagerUpdateRequest } from '../../integrations/voyager/organize.js';
import { observeFcaConversation } from '../../mind/action/fca/fcaConversationPorts.js';
import { recordCompletedCognitiveCycle } from '../../mind/action/respond/cognitiveCycle.js';
import { withCapabilitySources } from '../../mind/action/respond/conversationCapabilities.js';
import { recordConversationProposal, settleVoiceTaskDecision, voiceTurnSetsImplementation } from '../../mind/action/respond/conversationOrchestration.js';
import { assembledTurn } from '../../mind/action/respond/conversationTurn.js';
import { tierRequest } from '../../mind/action/respond/turnRouting.js';
import { innerNoteVoice } from '../../mind/emotion/companionPresence.js';
import { feelingVoice } from '../../mind/emotion/feelingPorts.js';
import {
  conversationTools, ownerAloneReads, skillProfilePrompt, turnToolResults, turnWroteHerOwnThings, withToolCapabilityLines,
} from '../../mind/tools/shannonToolSession.js';
import { oneHeadEnabled } from '../../contracts/oneHeadContract.js';
import { transcriptTrust } from './voiceTranscriptContext.js';
import { spokenReplyLines } from './voiceConversationInstructions.js';
import { boundedVoiceHistory, GUEST_CALL_MODEL_TURNS } from './voiceGuestCall.js';
import { voiceFinished, voiceOfferAndTier } from './voiceStage2.js';
import { stageFcaVoice } from './fcaVoiceContext.js';
import { visibleVoiceResponse, voiceWorkspace } from './voiceObservation.js';
import { admittedWorkContext, admitVoiceResearch, researchAfterAck, researchSaid, voiceTurnClock } from './voiceResearchTurn.js';
import { conversationHintMenu, followUp, plainVoiceHint, PLAIN_VOICE_HINT } from './voiceConversationHint.js';
import { keepSeatTurn, seatAnswer, seatToolOptions } from './voiceSeat.js';
import { VoiceSentenceGuard } from './voiceSentenceGuard.js';
import type { VoiceConversation } from './voiceConversation.js';

/**
 * A spoken turn's speaking and answer, after the one flow composed its prompt (moved out of `apiLiveVoice.ts` with nothing changed in
 * what it does): research and places admitted, the workspace's and her feeling turn's blocks, her tools narrowed by the menu and FCA,
 * her plain spoken stream (the structured reply where the turn needs a field), her guard lines sentence by sentence (one head), and the
 * answer the stream route speaks, with her face's plan.
 */
type ToolOffer = { tools?: ShannonModelToolSession; toolsWithheld?: true };

export interface VoiceSpoken {
  work: ReturnType<typeof admitVoiceResearch>['work'];
  admitted: ReturnType<typeof followUp>['admitted'];
  placeSkill: Awaited<ReturnType<typeof runPlaceDiscoverySkill>> | null;
  toolOffer: ToolOffer;
  tier: Awaited<ReturnType<typeof voiceOfferAndTier>>['tier'];
  guard: VoiceSentenceGuard | null;
  /** The turn sets an implementation: its task decision is settled from the structured reply. */
  requiresTaskDecision: boolean;
  completion: ShannonChatModelResult;
  metrics: { contextMilliseconds: number; firstModelTokenMilliseconds: number; modelCompleteMilliseconds: number };
}

/** Places and research, admitted before the prompt is finished (a research task only on words trusted to act, review M2). */
async function admittedWork(turn: VoiceConversation) {
  const { transcript, decision, scopeKey, dependencies: deps } = turn;
  const fcaTurn = turn.composed.fcaTurn;
  const location = turn.input.deviceContext?.location;
  const near = wantsNearbyPlaces(transcript) && location ? { latitude: location.latitude, longitude: location.longitude } : {};
  const placeContext = turn.selectedSkills.has('place_discovery') || wantsPlaceDiscovery(transcript) ? { ...near, spoken: true } : undefined;
  const research = !turn.uncertainTranscript && (turn.selectedSkills.has('current_web') || Boolean(placeContext));
  const admitted = admitVoiceResearch(fcaTurn, { transcript, route: turn.routeInput, research, places: placeContext, at: turn.occurredAt,
    timeZone: turn.input.deviceContext?.timeZoneIdentifier });
  const next = followUp(fcaTurn, transcript, admitted);
  const model = deps.auxiliaryChatModel ?? deps.chatModel;
  const placeSkill = !admitted.work && placeContext
    ? await turn.bounded('places_timeout', runPlaceDiscoverySkill(model, { scopeKey, message: transcript, context: placeContext }), () => null) : null;
  turn.input.observer?.signal?.throwIfAborted();
  const directHint = Boolean(fcaTurn) && plainVoiceHint(decision, transcript, turn.unclearTranscript);
  return { work: admitted.work, next, placeSkill, directHint };
}

/** Stage 3: the workspace's blocks (voice: at most two lines) follow the turn's context, which stays byte for byte as it was; ADR-0013 last. */
async function replayedTurn(turn: VoiceConversation, work: Awaited<ReturnType<typeof admittedWork>>) {
  const { composed, dependencies: deps, scopeKey, threadId } = turn;
  const turnPrompt = [composed.turnContext, work.placeSkill?.prompt ?? '', composed.fcaTurn?.context() ?? '', admittedWorkContext(work.work), work.next.hint,
    work.directHint ? PLAIN_VOICE_HINT : ''].filter(Boolean).join('\n\n');
  if (deps.mind?.sync) await deps.mind.sync();
  const fallback = { ...(turnPrompt ? { turnContext: turnPrompt } : {}), history: boundedVoiceHistory(turn.guestHistory, GUEST_CALL_MODEL_TURNS) };
  const captured = composed.parts.memory.captured;
  const workspace = turn.memoryText(voiceWorkspace(deps.mind, { scopeKey, threadId, present: turn.present, perceived: turn.perceivedTurn, snapshot: captured,
    snapshotNow: () => deps.stateStore.snapshot(scopeKey), store: deps.conversationStore, at: turn.occurredAt }));
  return assembledTurn(composed.replay?.request(turnPrompt) ?? fallback, workspace, feelingVoice.block(turn.feelingTurn, turn.decision.feeling));
}

/** Her tools: the offer by audience and trust, the menu and the tier, FCA's narrowing, the hint menu. */
async function offeredTools(turn: VoiceConversation, work: Awaited<ReturnType<typeof admittedWork>>) {
  const { dependencies: deps, scopeKey, threadId, transcript, decision } = turn;
  const utteranceId = turn.utterance?.id;
  const offered = conversationTools(deps.autonomy, scopeKey, 'voice', turn.toolAudience, deps.toolServer ?? {}, `${threadId}\n${transcript}`, turn.deadline,
    { trust: transcriptTrust(decision, turn.utterance), ...(utteranceId ? { utteranceId } : {}) },
    { ...ownerAloneReads(turn.toolAudience), ...(deps.toolHints ? { sourceHints: true } : {}), ...seatToolOptions(turn.seat) });
  const turnFacts = { scopeKey, threadId, deadline: turn.deadline, at: turn.occurredAt };
  const { offer, tier } = turn.choices ? await turn.bounded('tool_menu_timeout', voiceOfferAndTier(deps.turnRouting, offered, turn.choices, turnFacts),
    () => ({ offer: offered, tier: null })) : { offer: offered, tier: null };
  const fcaTurn = turn.composed.fcaTurn;
  const tools = offer.tools;
  const narrowed = fcaTurn?.selectTools && tools && !work.directHint && !work.work ? { ...offer, tools: await turn.bounded('tool_select_timeout',
    fcaTurn.selectTools(tools, { goal: transcript, state: turn.composed.parts.memory.cognitive.prompt }), () => tools) } : offer;
  return { toolOffer: { ...narrowed, tools: conversationHintMenu(narrowed.tools, work.directHint || Boolean(work.work)) }, tier };
}

/** The voice model's request: her identity and profile, the replay, his words, her tools, his clock, how this spoken reply is said. */
function voiceModelRequest(turn: VoiceConversation, replayed: Awaited<ReturnType<typeof replayedTurn>>, work: Awaited<ReturnType<typeof admittedWork>>,
  offered: Awaited<ReturnType<typeof offeredTools>>) {
  const { dependencies: deps, scopeKey, transcript, decision, composed } = turn;
  const { toolOffer, tier } = offered;
  const web = turn.selectedSkills.has('current_web');
  const profile = skillProfilePrompt(composed.parts.identity.profile, deps.skills, scopeKey, toolOffer.tools, web || Boolean(work.placeSkill));
  const reaction = turn.input.reactionLine;
  const spokenLines = spokenReplyLines(transcript, composed.parts.capability.prompt, toolOffer.tools, decision, turn.utterance?.source === 'camera');
  return observeSync('context', { surface: 'voice' }, () => withToolCapabilityLines({ // Her body's and Aether's lines exactly when their tools are offered.
    scopeKey, systemPrompt: composed.basePrompt, ...profile, ...replayed,
    // What she said when she was touched is what he is answering: it directly precedes his words, in every mode, as context only.
    ...(reaction ? { precedingReply: reaction } : {}),
    message: turn.seat ? turn.seat.message : transcript, ...toolOffer, ...tierRequest(tier, turn.deadline.left()),
    ...voiceTurnClock(turn.occurredAt, turn.input.deviceContext?.timeZoneIdentifier), spokenLines,
    useWebSearch: !work.work && !work.placeSkill && web,
    conversationClass: decision.conversationClass === 'no_response' ? 'direct' as const : decision.conversationClass,
  }), value => ({ messageCharacterCount: value.message.length, historyCount: value.history?.length ?? 0,
    contextCharacterCount: value.turnContext?.length ?? 0, toolCount: value.tools?.definitions.length ?? 0 }));
}

/** Her words as they are written: the first token's time, research's acknowledgement, her guard lines, her face updated once. */
class SpokenStream {
  firstToken: number | undefined;
  prefix = '';
  private faced = false;

  constructor(private readonly turn: VoiceConversation, private readonly startedAt: number, private readonly guard: VoiceSentenceGuard | null,
    private readonly work: VoiceSpoken['work']) {}

  readonly delta = async (delta: string): Promise<void> => {
    const { turn } = this;
    const observer = turn.input.observer;
    if (!observer) return;
    this.firstToken ??= Math.max(0, Math.round(performance.now() - this.startedAt));
    turn.input.timing.mark('firstToken');
    this.prefix = `${this.prefix}${delta}`.slice(0, 2_000);
    const said = this.guard ? this.guard.pass(researchSaid(delta, this.work)) : researchSaid(delta, this.work);
    if (!this.guard || said) await observer.onTextDelta(said);
    if (this.faced || !/[。！？!?\n]/u.test(this.prefix)) return;
    this.faced = true;
    turn.expressiveEmotion = turn.emotionWith(displayedVoiceText(this.prefix));
    turn.voicePlan = turn.planFor(turn.expressiveEmotion);
    await observer.onPlan(turn.voicePlan);
  };
}

/**
 * How the model is asked: the structured reply where the turn needs a field (places, a goal, a task decision, a confirmed proposal; one
 * head: the owner's request to her body, streamed), else her plain spoken stream, which the stream route may already have opened with
 * the plan's waiting phrase (then the model's tool rounds add no second one).
 */
function askModel(turn: VoiceConversation, request: ReturnType<typeof voiceModelRequest>, stream: SpokenStream, structured: boolean) {
  const { dependencies: deps, threadId } = turn;
  const observer = turn.input.observer;
  const intentField = turn.seat?.offerMinecraftIntent ? { offerMinecraftIntent: true as const } : {};
  const asked = { ...request, generateThreadTitle: false, spokenReply: true, ...intentField };
  if (structured) return deps.chatModel.generate(asked);
  if (observer && turn.seat?.offerMinecraftIntent && deps.chatModel.generateStreaming) return deps.chatModel.generateStreaming(asked, stream.delta);
  if (observer && deps.chatModel.generateVoiceStreaming) {
    return deps.chatModel.generateVoiceStreaming({ ...request, threadKey: threadId, ...turn.waitingSaid }, stream.delta, observer.signal);
  }
  return deps.chatModel.generateVoice ? deps.chatModel.generateVoice({ ...request, threadKey: threadId }) : deps.chatModel.generate(asked);
}

export async function speakVoiceTurn(turn: VoiceConversation): Promise<VoiceSpoken> {
  const work = await admittedWork(turn);
  const replayed = await replayedTurn(turn, work);
  // One head: with her guard lines read (her space's region, or the audience's questions with others there), each sentence is checked first.
  const guard = oneHeadEnabled() ? VoiceSentenceGuard.of(feelingVoice.guard(turn.feelingTurn)) : null;
  const offered = await offeredTools(turn, work);
  turn.input.timing.add('fca', performance.now() - turn.composed.fcaStartedAt);
  observerHandoff('recall', 'context', { surface: 'voice', semantic: turn.composed.parts.memory.recalled !== null });
  const request = voiceModelRequest(turn, replayed, work, offered);
  const startedAt = performance.now();
  const contextMilliseconds = Math.max(0, Math.round(startedAt - turn.contextStartedAt));
  const stream = new SpokenStream(turn, startedAt, guard, work.work);
  const observer = turn.input.observer;
  observer?.signal?.addEventListener('abort', () => turn.roomLook.cutOff(turn.threadId, displayedVoiceText(stream.prefix)), { once: true });
  const taskDecision = voiceTurnSetsImplementation(turn.orchestrationState, turn.transcript, turn.occurredAt);
  const structured = Boolean(work.placeSkill || (!work.work && turn.provisionalIntent) || taskDecision || turn.confirmedImplementationRequest);
  const completion = await observeFcaConversation(turn.composed.fcaTurn, () => askModel(turn, request, stream, structured));
  observer?.signal?.throwIfAborted();
  const unsaid = guard?.end(); // The last sentence, checked, once the model is done.
  if (unsaid) await observer?.onTextDelta(unsaid);
  const modelCompleteMilliseconds = Math.max(0, Math.round(performance.now() - startedAt));
  turn.input.timing.mark('firstToken'); // Unstreamed, the whole reply is its first token.
  return { work: work.work, admitted: work.next.admitted, placeSkill: work.placeSkill, toolOffer: offered.toolOffer, tier: offered.tier, guard,
    requiresTaskDecision: taskDecision, completion,
    metrics: { contextMilliseconds, firstModelTokenMilliseconds: stream.firstToken ?? modelCompleteMilliseconds, modelCompleteMilliseconds } };
}

/** What she says: research's acknowledgement and what was heard, what passed her guard lines (one head), a place's or a proposal's line. */
async function spokenReply(turn: VoiceConversation, spoken: VoiceSpoken): Promise<{ reply: string; feedbackRecordId?: string }> {
  const { dependencies: deps, scopeKey, threadId } = turn;
  const { completion, guard } = spoken;
  const { acknowledged, heard } = await researchAfterAck(turn.composed.fcaTurn, spoken.admitted, completion, turn.input.observer);
  const written = `${researchSaid(acknowledged, spoken.work)}${heard}`;
  const answered = turn.confirmedImplementationRequest ? 'よし、ライ氏。実装提案を画面に出しました。内容を確認して開始すると、作業が始まります。'
    : spoken.placeSkill ? spokenPlaceReply(completion.reply) : displayedVoiceText(guard ? guard.reply(written) : written);
  if (!deps.turnRouting) return { reply: answered };
  let feedbackRecordId: string | undefined;
  const reply = await voiceFinished(deps.turnRouting, { scopeKey, threadId, alone: turn.alone, reply: answered,
    feedbackReplySuffix: placeReply('', spoken.placeSkill?.places ?? []), completion, tier: spoken.tier, tools: spoken.toolOffer.tools,
    deadline: turn.deadline, at: turn.occurredAt, onFeedbackRecord: id => { feedbackRecordId = id; } });
  return { reply, ...(feedbackRecordId ? { feedbackRecordId } : {}) };
}

/** The cognitive cycle of a turn that was his words (not a guest's): the intent he stated, with the plan the reply carried. */
function recordVoiceCycle(turn: VoiceConversation, spoken: VoiceSpoken) {
  if (turn.guestVoice) return turn.provisionalIntent;
  const { dependencies: deps, scopeKey, threadId } = turn;
  const intentPlan = turn.provisionalIntent ? spoken.completion.intentPlan : undefined;
  const cycle = { threadId, channel: 'voice' as const, action: 'delegate' as const, summary: 'ライブ音声からバックエンドへ委譲し、検証可能な返答を生成した。',
    occurredAt: turn.occurredAt };
  return recordCompletedCognitiveCycle(deps.cognitiveIntents, scopeKey, turn.composed.parts.memory.cognitive.frame, turn.provisionalIntent, undefined, cycle,
    intentPlan);
}

/** The place cards, and an agent task's proposal (the owner alone in his apps, on words he can be trusted on, not done with her own tools). */
function voiceCards(turn: VoiceConversation, spoken: VoiceSpoken): Array<Record<string, unknown>> | undefined {
  const { dependencies: deps, scopeKey, transcript } = turn;
  const completedIntent = recordVoiceCycle(turn, spoken);
  const places = spoken.placeSkill?.places.length ? [{ type: 'place_search', places: spoken.placeSkill.places }] : [];
  const confirmed = turn.confirmedImplementationRequest;
  const taskProposal = spoken.completion.taskProposal ?? (confirmed ? { title: '依頼された機能の実装', goal: confirmed } : undefined);
  const proposes = turn.alone && !turn.seat && !turn.uncertainTranscript && !isExplicitVoyagerUpdateRequest(transcript);
  if (!taskProposal || !proposes || turnWroteHerOwnThings(spoken.toolOffer.tools)) return places.length ? places : undefined;
  if (turn.orchestrationState) {
    turn.orchestrationState = deps.conversationOrchestration.save(recordConversationProposal(turn.orchestrationState, taskProposal.goal, turn.occurredAt,
      deps.agentTasks.list(scopeKey)));
  }
  return [...places, { type: 'agent_task_proposal', proposalId: turn.orchestrationState?.resumeToken ?? randomUUID(),
    ...(completedIntent ? { cognitiveIntentID: completedIntent.id } : {}), ...taskProposal }];
}
/** Her feeling after the reply (stored only on his own words alone), her inner note and feeling events told, a platform's turn kept. */
function settleVoiceTurn(turn: VoiceConversation, spoken: VoiceSpoken, reply: string): void {
  const { dependencies: deps, scopeKey, threadId } = turn;
  if (!turn.confirmedImplementationRequest) turn.roomLook.open(threadId, reply); // Only if this turn chose a look, she said so, and it still holds.
  turn.expressiveEmotion = turn.emotionWith(reply);
  turn.voicePlan = turn.planFor(turn.expressiveEmotion, turnToolResults(spoken.toolOffer.tools).some(call => !call.ok)); // A failed tool keeps her apology.
  if (turn.alone) deps.stateStore.apply(scopeKey, { type: 'expressive-emotion-updated', emotion: turn.expressiveEmotion });
}

export async function answerVoiceTurn(turn: VoiceConversation): Promise<ApiResponse> {
  const { dependencies: deps, scopeKey, threadId, transcript } = turn;
  const spoken = turn.spoken;
  const { completion } = spoken;
  turn.orchestrationState = settleVoiceTaskDecision(deps, turn.orchestrationState, spoken.requiresTaskDecision, completion.taskDecision);
  const { reply, feedbackRecordId } = await spokenReply(turn, spoken);
  settleVoiceTurn(turn, spoken, reply);
  const uiBlocks = voiceCards(turn, spoken);
  const utteranceId = turn.utterance?.id;
  innerNoteVoice.ended(deps.innerNote, scopeKey, turn.alone && !turn.temporaryGuest, turn.occurredAt, transcript, reply, turn.expressiveEmotion, utteranceId);
  feelingVoice.ended(turn.feelingTurn, { at: turn.occurredAt, transcript, reply, ...(utteranceId ? { utteranceId } : {}) }); // ADR-0013
  stageFcaVoice(turn.composed.fcaTurn);
  // One head: a platform keeps its spoken turn where its typed turns go (the apps keep theirs through `/v1/voice/turns`).
  const memory = turn.composed.parts.memory;
  const keptAs = turn.seat ? keepSeatTurn(turn.seat, { scopeKey, threadId, captured: memory.captured, reply: reply.trim(), at: turn.occurredAt,
    recalledMemoryIds: [...memory.cognitive.frame.recalledMemoryIDs, ...memory.peopleRecall?.ids ?? []] }) : undefined;
  deps.mind?.turnEnded?.(); // Stage 3: what the mind noted is written after the response.
  return visibleVoiceResponse(() => ({ status: 200, body: voiceAnswerBody(turn, spoken, { reply, feedbackRecordId, uiBlocks, keptAs, utteranceId }) }));
}

function voiceAnswerBody(turn: VoiceConversation, spoken: VoiceSpoken, answer: { reply: string; feedbackRecordId: string | undefined;
  uiBlocks: Array<Record<string, unknown>> | undefined; keptAs: string | undefined; utteranceId: string | undefined }): Record<string, unknown> {
  const { completion } = spoken;
  const capability = turn.composed.parts.capability;
  const companion = !turn.temporaryGuest && !turn.alone && !turn.seat; // Tells the iPhone to keep marking this call's owner turns.
  return {
    threadId: turn.threadId, model: completion.model, reply: answer.reply.trim(),
    ...(answer.feedbackRecordId ? { feedbackRecordId: answer.feedbackRecordId } : {}),
    webSources: combinedPlaceSources(spoken.placeSkill, withCapabilitySources(completion, capability).webSources),
    ...(answer.uiBlocks ? { uiBlocks: answer.uiBlocks } : {}), ...turn.roomLook.ask(), ...(completion.truncated ? { truncated: true } : {}),
    ...feelingVoice.presented(turn.feelingTurn, turn.expressiveEmotion, turn.emotionState, turn.occurredAt, answer.utteranceId), // ADR-0013 D17
    ...(companion ? { companionPresent: true } : {}), ...(turn.seat ? seatAnswer(completion, answer.keptAs) : {}), // One head: intent, where it was kept.
    voicePlan: turn.voicePlan,
    voiceMetrics: { decisionMilliseconds: turn.decision.elapsedMilliseconds, ...spoken.metrics,
      turnToModelCompleteMilliseconds: Math.max(0, Math.round(performance.now() - turn.turnStartedAt)) },
  };
}
