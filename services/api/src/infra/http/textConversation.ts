import { replySonnetEnabled } from '../../contracts/oneHeadContract.js';
import { randomUUID } from 'node:crypto';
import { withoutUnshownTitles } from '@shannon/cognition';
import type { ChatResponse } from '../../contracts/contracts.js';
import type { FeedbackPorts } from '../../contracts/feedbackContract.js';
import type { ConversationExtrasPorts } from '../../contracts/conversationExtrasContract.js';
import type { ShannonChatModel, ShannonChatModelResult } from '../models/chatModel.js';
import type { ShannonModelToolSession } from '../models/chatModelTools.js';
import { observeSync, observedStep, observerHandoff, textStage } from '../observer/observerContext.js';
import {
  NO_LOOK, answerTextCommand, openTextTurn, perceiveTextTurn, settleTextTools, storedBySurface, textCapabilityAsk, textIdentityAsk, textMemoryAsk,
  textToolStart, textTurnClock, textTurnSystemPrompt, textTurnWorkspace, type BegunTextTurn, type OpenedTextTurn, type TextTurnDependencies,
  type TextTurnInput, type TextTurnPrompt, type TextTurnResult,
} from '../../mind/action/respond/apiTextTurn.js';
import {
  assembledTurn, closedTurn, composedTurnContext, turnReplay, type ConversationModality, type StartedTurnMemory, type TurnParts, type TurnStageDependencies,
} from '../../mind/action/respond/conversationTurn.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../../mind/action/respond/turnDeadline.js';
import { finishTurn, routeTurn, textTurnThinking, tierRequest, type TurnRouting } from '../../mind/action/respond/turnRouting.js';
import { bindCompletedFeedback } from '../../mind/action/respond/turnFeedback.js';
import { withCapabilitySources } from '../../mind/action/respond/conversationCapabilities.js';
import { recordConversationProposal } from '../../mind/action/respond/conversationOrchestration.js';
import { recordCompletedCognitiveCycle } from '../../mind/action/respond/cognitiveCycle.js';
import { admitConversationWork, admittedWorkContext } from '../../mind/action/fca/conversationWork.js';
import { conversationFcaProvenance, observeFcaConversation, type FcaConversationPort } from '../../mind/action/fca/fcaConversationPorts.js';
import {
  commitReplyEmotionLater, innerNoteText, presentCompanionState, replyFeelingOffer, resolveTextReplyEmotion,
} from '../../mind/emotion/companionPresence.js';
import { feelingText, type FeelingPort } from '../../mind/emotion/feelingPorts.js';
import { feelingPortFor } from '../../mind/emotion/textRegisterTurn.js';
import type { InnerNotePort } from '../../mind/emotion/innerNotePorts.js';
import { usableThreadSummary } from '../../mind/memory/memoryVisibility.js';
import type { ConversationLookTurn, PerceivedItem } from '../../mind/perception/perceptionPorts.js';
import type { TurnChooser } from '../../mind/selectors/turnChoices.js';
import {
  conversationTools, toolTraceReader, turnSkillIndex, turnToolResults, turnWroteHerOwnThings, type SkillTurnPorts,
} from '../../mind/tools/shannonToolSession.js';
import { withToolCapabilityLines } from '../../mind/tools/shannonAetherTools.js';
import type { MindTurnPorts } from '../../mind/workspace/workspacePorts.js';
import type { ShannonExperience } from '../../mind/memory/memoryPorts.js';
import { optionalPlaceDiscoverySkill, placeSkillReply } from '../../integrations/places/placeDiscoverySkill.js';
import { isExplicitVoyagerUpdateRequest } from '../../integrations/voyager/organize.js';
import { generateChatTurn, withSentenceStream } from '../../surfaces/text/chatSentenceStream.js';
import { reactionTurnLine } from '../../surfaces/text/apiConversationRead.js';
import { conversationHintMenu } from '../../surfaces/voice/voiceConversationHint.js';
import type { ShannonBody } from '../../surfaces/body/shannonBody.js';

/**
 * A written turn as a modality of the one flow (`conversationTurn.ts`): the apps' Talk (`POST /v1/chat`), a platform's typed reply, her
 * game chat. What is its own: orchestration and a fixed command before anything is read, her feeling turn's Jev call and the tool menu
 * beside recall, the look through her body or the app, the prompt's layers (`textTurnSystemPrompt`), the structured reply streamed as
 * sentences, and storing (the app's Talk, or where the surface keeps it). Moved out of `apiKernel.ts` with nothing changed in what it does.
 */
export interface TextConversationParts {
  deps: TextTurnDependencies;
  model: ShannonChatModel;
  auxiliaryChatModel: ShannonChatModel;
  fcaConversation: (() => FcaConversationPort | null) | null;
  mind: MindTurnPorts | null;
  feeling: FeelingPort | null;
  innerNote: InnerNotePort | null;
  turnChooser: TurnChooser | null;
  readTools: boolean;
  toolHints: boolean;
  skills: SkillTurnPorts | null;
  turnRouting: TurnRouting | null;
  feedback: FeedbackPorts | null;
  turnLooks: ShannonBody['turnLooks'];
  extras(): ConversationExtrasPorts | null;
  ownerAlone(scopeKey: string): boolean;
}

/** The one flow's shared stages, from what a text turn is handed. */
export function textTurnStages(parts: Pick<TextConversationParts, 'deps' | 'innerNote'>): TurnStageDependencies {
  const { deps } = parts;
  return { stateStore: deps.stateStore, conversationStore: deps.conversationStore, memoryRecall: deps.memoryRecall, innerNote: parts.innerNote,
    autonomy: deps.autonomy, ...(deps.stage5Capabilities ? { stage5Capabilities: deps.stage5Capabilities } : {}) };
}

type ToolOffer = { tools?: ShannonModelToolSession; toolsWithheld?: true };
type Finished = Awaited<ReturnType<typeof finishTurn>> | null;
type Settled = Awaited<ReturnType<typeof settleTextTools>> | null;

export class TextConversation implements ConversationModality<TextTurnResult> {
  private readonly scopeKey: string;
  private readonly deadline: TurnDeadline;
  private readonly fca: FcaConversationPort | null;
  private opened!: OpenedTextTurn;
  private begun!: BegunTextTurn;
  private feelingTurn: ReturnType<typeof feelingText.start> = null;
  private perceived: PerceivedItem | null = null;
  private tools!: ReturnType<typeof textToolStart>;
  private turnParts!: TurnParts;
  private roomLook: ConversationLookTurn = NO_LOOK;
  private layered!: TextTurnPrompt;
  private systemPrompt = '';
  private priorThreadSummary: string | undefined;
  private fcaTurn: ReturnType<FcaConversationPort['begin']> | undefined;
  private toolOffer: ToolOffer = {};
  private settled: Settled = null;
  private work: ReturnType<typeof admitConversationWork> = null;
  private placeSkill: Awaited<ReturnType<typeof optionalPlaceDiscoverySkill>> | null = null;
  private tier: ReturnType<typeof routeTurn> = null;
  private completion!: ShannonChatModelResult;

  constructor(private readonly parts: TextConversationParts, private readonly input: TextTurnInput) {
    this.scopeKey = input.body.scopeKey;
    this.fca = !input.surface && input.audience.alone ? parts.fcaConversation?.() ?? null : null;
    this.deadline = input.deadline ?? new TurnDeadline(TEXT_TURN_DEADLINE, () => Date.parse(parts.deps.now()));
  }

  open(): null {
    this.opened = openTextTurn(this.parts.deps, this.input, this.parts.deps.now());
    return null;
  }

  memoryAsk() { return textMemoryAsk(this.parts.deps, this.input, this.opened); }

  /** Beside recall: her feeling turn's Jev call, the turn as the mind perceives it, and (ADR-0008 stage 2) the tool menu's Jev call. */
  begin(memory: StartedTurnMemory): void {
    const { input, parts } = this;
    const { audience, surface, message } = input;
    this.begun = { ...this.opened, captured: memory.captured, peopleRecall: memory.peopleRecall!, deterministicContext: memory.deterministic };
    this.feelingTurn = feelingText.start(feelingPortFor(surface, parts.feeling),
      { scopeKey: this.scopeKey, alone: audience.alone, surface, message, begun: this.begun });
    this.perceived = observeSync('perception', { message, audience: audience.audience }, () => perceiveTextTurn(parts.mind, input, this.opened.occurredAt),
      value => ({ eventId: value?.itemId ?? null }));
    const commonFca = !surface && audience.alone && Boolean(parts.fcaConversation?.());
    this.tools = textToolStart(input, this.begun, { autonomy: parts.deps.autonomy, toolServer: parts.deps.toolServer, turnChooser: parts.turnChooser,
      commonFca, readTools: parts.readTools, toolHints: parts.toolHints });
  }

  identityAsk(memory: StartedTurnMemory) { return textIdentityAsk(this.parts.deps, this.input, memory.captured); }

  capabilityAsk() { return textCapabilityAsk(this.parts.deps, this.input, this.begun, Boolean(this.fca)); }

  /** The prompt's layers; a fixed command or organizing is answered here, with the prompt it would have had. */
  compose(parts: TurnParts) {
    this.turnParts = parts;
    const { input } = this;
    const { audience, surface, message, threadId, request } = input;
    this.roomLook = surface ? NO_LOOK : this.parts.turnLooks.turn(this.scopeKey, message, this.opened.occurredAt, audience.audience, request);
    observerHandoff('recall', 'context', { recalledCount: parts.memory.cognitive.frame.recalledMemoryIDs.length });
    this.layered = observeSync('context', { threadId }, () => textTurnSystemPrompt(this.parts.deps, input, this.begun, { basePrompt: parts.identity,
      cognitiveContext: parts.memory.cognitive, capability: parts.capability, roomLook: this.roomLook }),
    value => ({ contextCharacters: value.turnContext.length }));
    this.systemPrompt = this.layered.prompt;
    if (this.opened.explicitCommand || this.opened.organizeTurn) {
      return answerTextCommand(this.parts.deps, input, this.begun, parts.memory.cognitive, this.systemPrompt).then(closedTurn);
    }
    this.beginFca();
    return null;
  }

  /** A summary has no label of its own: none where only open items may be given (a turn someone other than the owner wrote). */
  private beginFca(): void {
    const { audience, surface, threadId } = this.input;
    const { captured, occurredAt, peopleRecall } = this.begun;
    const { conversationStore } = this.parts.deps;
    this.priorThreadSummary = surface?.openOnly ? undefined : usableThreadSummary(captured, conversationStore, this.scopeKey, threadId, audience.present);
    this.fcaTurn = this.fca?.begin({ scopeKey: this.scopeKey, threadId, observedAt: occurredAt,
      recalledMemoryIds: conversationFcaProvenance(captured, conversationStore, this.scopeKey, threadId,
        [...this.turnParts.memory.cognitive.frame.recalledMemoryIDs, ...peopleRecall.ids]),
      readSourceIds: this.turnParts.capability.readSourceIds, ownerAlone: () => this.parts.ownerAlone(this.scopeKey) });
  }

  /** Her tools, then the model; without a Jev call, a place search or an FCA narrowing nothing is awaited before the call (not a tick). */
  speak(): Promise<void> {
    const offering = this.offerTools();
    return offering instanceof Promise ? offering.then(() => this.ask()) : this.ask();
  }

  private async ask(): Promise<void> {
    const { input, parts } = this;
    const { body, threadId, audience, surface, request, message } = input;
    const web = body.webSearch === true || Boolean(this.placeSkill) || this.settled?.web === true;
    // Step 6: her skills' index; her character space's core (owner 2026-10-20; none: as it was).
    this.layered = feelingText.staged(this.feelingTurn, turnSkillIndex(this.layered, parts.skills, this.scopeKey, this.toolOffer.tools, web));
    this.systemPrompt = this.layered.prompt;
    // Stage 2, step 4: the tier from Jev's difficulty answers (none without the routing). ADR-0013: her feeling turn, ≤200 ms more.
    this.tier = routeTurn(parts.turnRouting, { scopeKey: this.scopeKey, surface: 'text', threadId, answer: this.settled?.answer ?? null,
      at: this.opened.occurredAt });
    if (parts.mind?.sync) await parts.mind.sync();
    const feelingBlock = this.feelingTurn ? await feelingText.block(this.feelingTurn) : ''; // Without a port, not even a tick.
    const turn = { body, threadId, audience, capability: this.turnParts.capability, placeSearch: this.placeSkill !== null,
      ...(surface?.voice ? { voice: true } : feelingText.paced(this.feelingTurn, message)) };
    const modelRequest = this.modelRequest(feelingBlock);
    this.completion = await observeFcaConversation(this.fcaTurn, () => generateChatTurn(parts.model, request.chatSentences, turn, modelRequest));
  }

  /** Her tools: the menu narrows the schemas sent (awaited only with a Jev call), research and places are admitted, FCA narrows. */
  private offerTools(): Promise<void> | void {
    const { input, parts } = this;
    const offer: ToolOffer = conversationTools(parts.deps.autonomy, this.scopeKey, 'text', this.tools.toolAudience, parts.deps.toolServer,
      `${input.threadId}\n${input.message}`, this.deadline, undefined, this.tools.toolOptions);
    const choices = this.tools.choices;
    if (!choices) return this.afterMenu(offer, null);
    return textStage('tool_menu_timeout', settleTextTools(offer, choices), () => null).then(settled => this.afterMenu(offer, settled));
  }

  private afterMenu(offer: ToolOffer, settled: Settled): Promise<void> | void {
    const { input, parts } = this;
    const { body, message } = input;
    const placeSearch = input.placeOptions.placeSearch;
    this.settled = settled;
    const research = body.webSearch === true || Boolean(placeSearch) || settled?.web === true;
    this.work = admitConversationWork(this.fcaTurn, { message, research, places: placeSearch, at: this.opened.occurredAt });
    const menued = settled ? settled.offer : offer;
    if (this.work || !placeSearch) return this.narrowed(menued);
    return textStage('places_timeout', optionalPlaceDiscoverySkill(parts.auxiliaryChatModel, this.scopeKey, message, placeSearch), () => null)
      .then(place => this.placed(place, menued));
  }

  private placed(place: TextConversation['placeSkill'], offer: ToolOffer): Promise<void> | void {
    this.placeSkill = place;
    return this.narrowed(offer);
  }

  /** FCA narrows the tools for its own turn; then the hint menu (`conversationHintMenu`). */
  private narrowed(offer: ToolOffer): Promise<void> | void {
    const fcaTurn = this.fcaTurn;
    const tools = offer.tools;
    if (!fcaTurn?.selectTools || !tools || this.work) return this.offered(offer);
    const state = this.turnParts.memory.cognitive.prompt;
    return textStage('tool_select_timeout', fcaTurn.selectTools(tools, { goal: this.input.message, state }), () => tools)
      .then(selected => this.offered({ ...offer, tools: selected }));
  }

  private offered(offer: ToolOffer): void {
    this.toolOffer = { ...offer, tools: conversationHintMenu(offer.tools, Boolean(this.work)) };
    if (this.settled) observerHandoff('jevt', 'context', { tools: this.toolOffer.tools?.definitions.map(tool => tool.name) ?? [] });
  }
  /** The model's request: her fixed identity first, what she knows of the owner next, the turn's context with the replay last. */
  private modelRequest(feelingBlock: string) {
    const { input, parts } = this;
    const { body, threadId, message, attachments, audience, surface } = input;
    const settled = this.settled;
    const inline = !this.work && !this.placeSkill;
    const thinking = textTurnThinking({ tier: this.tier, tools: this.toolOffer.tools, readAloud: body.readAloud, answer: settled?.answer,
      research: [this.work, this.placeSkill, input.placeOptions.placeSearch, attachments.length, body.webSearch, settled?.web] });
    return withToolCapabilityLines({
      scopeKey: this.scopeKey, systemPrompt: this.layered.systemPrompt, ...(this.layered.profilePrompt ? { profilePrompt: this.layered.profilePrompt } : {}),
      ...this.replayed(feelingBlock), ...(this.priorThreadSummary ? { priorThreadSummary: this.priorThreadSummary } : {}),
      message, threadKey: threadId, ...textTurnClock(this.opened.occurredAt),
      ...(attachments.length ? { attachments } : {}), ...this.roomLook.request, ...replyFeelingOffer(audience.alone), ...this.toolOffer,
      ...(inline && (body.webSearch === true || settled?.web) ? { useWebSearch: true } : {}),
      ...(inline && settled?.answer.menu?.chosen.includes('web_search') ? { requireWebSearch: true as const } : {}), ...thinking,
      ...(surface?.offerMinecraftIntent ? { offerMinecraftIntent: true } : {}), ...tierRequest(this.tier), ...feelingText.route(this.feelingTurn),
      ...(replySonnetEnabled() ? { conversationReply: true as const } : {}), // SHANNON_REPLY_SONNET: her reply is Sonnet's; off, as it was.
      richBlocks: !surface,
      // A surface's conversation has its own fixed title.
      generateThreadTitle: surface ? false : parts.deps.conversationStore.needsAutomaticThreadTitle(this.scopeKey, threadId),
    });
  }

  /** The history is a character budget (the replay summary covers the rest). Stage 3's blocks, then ADR-0013's, follow the turn's context. */
  private replayed(feelingBlock: string) {
    const { input, parts } = this;
    const { audience, surface, threadId } = input;
    const { deps } = parts;
    const { occurredAt, captured } = this.begun;
    const replay = turnReplay(textTurnStages(parts), { channel: 'text', captured, scopeKey: this.scopeKey, threadId, present: audience.present,
      tools: toolTraceReader(deps.toolServer, this.scopeKey), openOnly: surface?.openOnly ?? false });
    const reaction = reactionTurnLine(parts.extras(), { scopeKey: this.scopeKey, threadId, alone: audience.alone, surface,
      ownerAlone: () => parts.ownerAlone(this.scopeKey) });
    const fcaContext = observedStep('fcaContext', () => this.fcaTurn?.context() ?? '');
    const turnContext = composedTurnContext([this.layered.turnContext, this.placeSkill?.prompt ?? '', fcaContext,
      admittedWorkContext(this.work), reaction, innerNoteText.context(parts.innerNote, this.scopeKey, audience.alone, Boolean(surface), occurredAt)]);
    const workspace = observeSync('workspace', { threadId }, () => textTurnWorkspace(parts.mind, input, this.perceived, this.begun, deps.conversationStore,
      () => deps.stateStore.snapshot(this.scopeKey)), value => ({ available: value !== undefined && value !== null }));
    return assembledTurn(replay.request(turnContext), workspace, feelingBlock);
  }

  async close(): Promise<TextTurnResult> {
    const { completion, input, parts } = this;
    const { audience, threadId } = input;
    const answered = completion.outOfTime ? completion.reply : placeSkillReply(withCapabilitySources(completion, this.turnParts.capability), this.placeSkill);
    const finished = parts.turnRouting ? await finishTurn(parts.turnRouting, { scopeKey: this.scopeKey, surface: 'text', threadId,
      presence: audience.alone ? 'alone' : 'others', reply: answered, outOfTime: completion.outOfTime === true, decision: this.tier,
      tools: this.toolOffer.tools,
      remainingMs: this.deadline.left(), at: this.opened.occurredAt, answeredBy: completion.mode, servedTier: completion.servedTier }) : null;
    return this.answered(finished?.reply ?? answered, finished);
  }

  abandon(): void { this.fcaTurn?.abort(); }

  /** Her feeling for this reply, from state already in hand (stored after the response), and the response. */
  private responseOf(reply: string) {
    const { completion, input, parts } = this;
    const { audience, message, threadId } = input;
    const { captured, occurredAt } = this.begun;
    const failed = turnToolResults(this.toolOffer.tools).some(call => !call.ok);
    const resolved = resolveTextReplyEmotion({ snapshot: captured, userMessage: message, reply, now: occurredAt }, completion, audience.alone);
    const noted = innerNoteText.reply(parts.innerNote, this.scopeKey, occurredAt, resolved, captured, message, completion, audience.alone, failed);
    const { messageEmotion, expressiveEmotion } = feelingText.face(this.feelingTurn, noted, captured, occurredAt);
    const response: ChatResponse = {
      mode: completion.mode, model: completion.model, reply, threadId, audience: audience.audience,
      snapshotVersion: captured.version, messageEmotion, systemPrompt: withoutUnshownTitles(this.systemPrompt), // Her unshown titles stay on the server.
      state: presentCompanionState(captured, occurredAt, expressiveEmotion),
      ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
      ...feelingText.register(this.feelingTurn, message, reply, completion, turnToolResults(this.toolOffer.tools)), // ADR-0013 item 10
    };
    if (this.placeSkill?.places.length) response.uiBlocks = [{ type: 'place_search', places: this.placeSkill.places }];
    return { response, expressiveEmotion };
  }

  private completedTurn(reply: string, response: ChatResponse) {
    const { completion, input } = this;
    const { surface, threadId, message, audience } = input;
    const { captured, occurredAt, peopleRecall } = this.begun;
    const title = surface ? { threadTitle: surface.threadTitle } : completion.threadTitle ? { threadTitle: completion.threadTitle } : {};
    return {
      scopeKey: this.scopeKey, threadId, capturedState: captured, userMessage: message, shannonReply: reply, ...title,
      ...(completion.threadSummary ? { threadSummary: completion.threadSummary } : {}), ...audience.turnLabel,
      messageEmotion: response.messageEmotion,
      ...(completion.taskDecision ? { taskDecision: completion.taskDecision } : {}),
      ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
      completedAt: occurredAt, recalledMemoryIds: [...this.turnParts.memory.cognitive.frame.recalledMemoryIDs, ...peopleRecall.ids],
      summaryContinuesChain: Boolean(this.priorThreadSummary && completion.threadSummary),
    };
  }

  private answered(reply: string, finished: Finished): TextTurnResult {
    const { completion, input, parts } = this;
    const { audience, surface, threadId, message } = input;
    const { deps } = parts;
    const { response, expressiveEmotion } = this.responseOf(reply);
    const completedTurn = this.completedTurn(reply, response);
    // Another surface decides where its turn is kept (her Minecraft body: the owner's platform thread, or person memory).
    observerHandoff('decode', 'store', { reply });
    const store = () => (surface ? storedBySurface(deps, surface, completedTurn) : deps.background.recordTurn(completedTurn));
    const experience = observeSync('store', { threadId, reply }, store,
      value => ({ experienceId: value?.id ?? null }));
    this.bound(response, experience, finished, reply);
    this.proposal(response, experience);
    response.thread = deps.conversationStore.listThreads(this.scopeKey).find(thread => thread.threadId === threadId);
    Object.assign(response, this.roomLook.decide({ ...completion, reply }, threadId)); // One look, only if this turn offered it (conversationLooks.ts).
    if (experience) {
      deps.background.schedule(completedTurn, experience.id);
      observerHandoff('store', 'memory', { experienceId: experience.id, status: 'scheduled' });
    }
    // Her stored feeling toward the owner moves only on a turn that is his alone.
    if (audience.alone) commitReplyEmotionLater(deps.stateStore, this.scopeKey, expressiveEmotion);
    innerNoteText.ended(parts.innerNote, this.scopeKey, audience.alone && !surface, this.opened.occurredAt, message, reply, expressiveEmotion, experience?.id);
    feelingText.ended(this.feelingTurn, { at: this.opened.occurredAt, message, reply, ...(experience ? { experienceId: experience.id } : {}) }); // ADR-0013
    parts.mind?.turnEnded?.(); // Stage 3: what the mind noted is written after the response.
    return { response: withSentenceStream(completion, { status: 200, body: audience.visible(response) }), completion,
      ...(experience ? { experienceId: experience.id } : {}) };
  }

  /** The stored turn's id on the response, her feedback bound to it, the mind's item re-read at render. */
  private bound(response: ChatResponse, experience: ShannonExperience | null, finished: Finished, reply: string): void {
    const { parts, input } = this;
    if (experience) this.fcaTurn?.commit(experience.id);
    else this.fcaTurn?.abort();
    if (!experience) return;
    response.turnId = experience.id;
    const feedback = bindCompletedFeedback(parts.feedback, this.scopeKey, finished?.feedbackRecordId, input.threadId, experience.id, reply);
    if (feedback) response.feedback = feedback;
    if (this.perceived) parts.mind?.bind?.(this.scopeKey, this.perceived.itemId, `experience:${experience.id}`); // Stage 3: re-read at render.
  }

  /** The cognitive cycle, and an agent task's proposal (none from a surface, nor from a turn that wrote with her own tools). */
  private proposal(response: ChatResponse, experience: ShannonExperience | null): void {
    const { completion, input, parts } = this;
    const { deps } = parts;
    const { audience, surface, message, threadId } = input;
    const { provisionalIntent, occurredAt } = this.begun;
    const completedIntent = experience ? recordCompletedCognitiveCycle(deps.cognitiveIntents, this.scopeKey, this.turnParts.memory.cognitive.frame,
      provisionalIntent, experience.id, { threadId, channel: 'text', action: 'respond', summary: '現在の状況・記憶・意図を使って返答した。', occurredAt },
      provisionalIntent ? completion.intentPlan : undefined) : null;
    const suppressed = !audience.alone || Boolean(surface) || isExplicitVoyagerUpdateRequest(message) || turnWroteHerOwnThings(this.toolOffer.tools);
    const proposal = completion.taskProposal;
    if (!proposal || suppressed) return;
    let state = this.begun.orchestrationState;
    if (state) state = deps.conversationOrchestration.save(recordConversationProposal(state, proposal.goal, occurredAt, deps.agentTasks.list(this.scopeKey)));
    response.uiBlocks = [...(response.uiBlocks ?? []), { type: 'agent_task_proposal', proposalId: state?.resumeToken ?? randomUUID(),
      ...(completedIntent ? { cognitiveIntentID: completedIntent.id } : {}), ...proposal }];
  }
}
