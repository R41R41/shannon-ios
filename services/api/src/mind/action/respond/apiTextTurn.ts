import { randomUUID } from 'node:crypto';
import { withStage5Capabilities, type ShannonStage5Capabilities, withoutUnshownTitles, type CompanionClock, type CompanionStateStore } from '@shannon/cognition';
import { agentTaskPromptProjection } from './apiPromptProjection.js';
import type { AetherContextReader } from '../../../integrations/aether/aetherContext.js';
import type { AetherProposalStore } from '../../../integrations/aether/aetherProposal.js';
import type { AgentTaskStore } from '../agentTasks/agentTasksPorts.js';
import type { ShannonAutonomyService } from '../ownTime/ownTimePorts.js';
import type { CompletedTurn, TurnBackgroundService } from '../../sleep/sleepPorts.js';
import type { ChatAudienceTurn } from '../../perception/perceptionPorts.js';
import type { ShannonChatAttachment, ShannonChatModel, ShannonChatModelResult } from '../../../infra/models/chatModel.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from './cognitiveIntent.js';
import { presentCompanionState, resolveReplyEmotion } from '../../emotion/emotionPorts.js';
import type { ApiRequest, ApiResponse, ChatRequest, ChatResponse } from '../../../contracts/contracts.js';
import {
  NO_CAPABILITY_CONTEXT, conversationCapabilityContext, readToolPlan, type ConversationCapabilityContext, type NotionTurnReader,
} from './conversationCapabilities.js';
import { WEB_CAPABILITY_ENTRY } from '../../tools/toolsPorts.js';
import { withToolMenu } from '../../tools/toolsPorts.js';
import type { ShannonModelToolSession } from '../../../infra/models/chatModelTools.js';
import type { ConversationLookTurn } from '../../perception/perceptionPorts.js';
import { executeConversationCommand } from './conversationCommands.js';
import {
  buildConversationOrchestrationPrompt, observeConversationTurn, recordConversationReceipt, type ConversationOrchestrationStore,
} from './conversationOrchestration.js';
import { prepareConversationOrganize } from '../../../integrations/voyager/conversationOrganize.js';
import type { ConversationStore, ShannonExperience } from '../../memory/memoryPorts.js';
import type { DailyMindReader } from './dailyMind.js';
import { type KnowledgeStore } from '../../memory/memoryPorts.js';
import { companionIdentityPrompt, type LayeredIdentityPrompt } from '../../memory/identityPorts.js';
import { isOrganizeCommand, type OrganizeExtractor, type OrganizeStore, type VoyagerCatalog } from '../../../integrations/voyager/organize.js';
import type { OwnOutreach } from '../../../surfaces/outreach/ownOutreach.js';
import type { OwnerUpcoming } from '../../memory/memoryPorts.js';
import type { PeopleMemory } from '../../memory/memoryPorts.js';
import { heardByEveryoneHere } from '../../memory/platformPeoplePorts.js';
import type { PersonIdentityStore } from '../../memory/memoryPorts.js';
import type { ShannonBody } from '../../../surfaces/body/shannonBody.js';
import { startTurnToolMenu, type ConversationToolServer, type ToolMenuChooser, type TurnChoiceAnswer } from '../../tools/toolsPorts.js';
import type { ShannonToolRunner } from '../../tools/toolsPorts.js';
import { prepareTurnCognitiveContext } from '../../workspace/contextPorts.js';
import { TurnDeadline } from './turnDeadline.js';
import type { TurnMemoryRecall } from '../../recall/recallPorts.js';
import { closedId, minecraftPerception, platformPerception, textPerception, type MindPerceiver, type PerceivedItem } from '../../perception/perceptionPorts.js';
import { framedReport, type MindTurnPorts } from '../../workspace/workspacePorts.js';

/**
 * The first half of one text turn of the conversation kernel (`ShannonApiKernel.textTurn`): orchestration, a fixed
 * command, recall, identity and the system prompt. `POST /v1/chat` is its first caller; another surface (her Minecraft
 * body, `minecraftBody.ts`, and the platform reply route, `platformReply.ts`) passes its audience policy and a `surface`
 * that adds its prompt blocks and keeps the turn where that surface keeps it. Split from `apiKernel.ts` for its size.
 */
export interface TextTurnDependencies {
  chatModel: ShannonChatModel; stateStore: CompanionStateStore; conversationStore: ConversationStore; background: TurnBackgroundService;
  knowledgeStore: KnowledgeStore | null; dailyMind: DailyMindReader | null; autonomy: ShannonAutonomyService; agentTasks: AgentTaskStore;
  aetherContext: AetherContextReader | null; aetherProposals: AetherProposalStore; voyagerCatalog: VoyagerCatalog; notion: NotionTurnReader | null;
  upcoming: OwnerUpcoming; ownOutreach: OwnOutreach | null; organizeStore: OrganizeStore; organizeExtractor: OrganizeExtractor;
  personIdentities: PersonIdentityStore; cognitiveIntents: CognitiveIntentStore; conversationOrchestration: ConversationOrchestrationStore;
  memoryRecall: TurnMemoryRecall | null; people: PeopleMemory; toolServer: ConversationToolServer; now: CompanionClock;
  body: Pick<ShannonBody, 'ownerContext'>;
  /** What her Minecraft body reported about the requests it was given (`minecraftBodyRequests.ts`), for a turn the owner alone reads. */
  minecraftRequests: { promptBlock(scopeKey: string, at: string): string } | null;
  /** Syzygy ADR-0008 stage 3: the mind of the turn, when there is one (its data frames frame the reports a turn builds itself). */
  mind?: MindTurnPorts | null;
  stage5Capabilities?: ShannonStage5Capabilities;
}

/** A surface other than the app's text chat, such as her Minecraft body (`minecraftBody.ts`) or a platform reply (`platformReply.ts`). */
export interface TextTurnSurface {
  /** Blocks of this surface, after the audience's instructions. */
  prompt: string;
  /** The fixed title of the surface's conversation; no automatic title is made. */
  threadTitle: string;
  offerMinecraftIntent?: boolean;
  /**
   * Her `minecraft.*` tools are offered by the app's owner-alone rule (a platform conversation bound `owner-private`).
   * Without it a surface is not offered them: game chat asks her body through the turn's intent.
   */
  minecraftTools?: boolean;
  /** Only what may be shown to anyone: every memory entry marked 【機微 is left out (`withoutGuardedEntries`). */
  openOnly?: boolean;
  /**
   * A turn with others present is offered her Aether reading tools, held to 「シャノン用フォルダ」, and nothing else (owner
   * decisions 2026-10-06, Syzygy ADR-0007): the owner's own turn as `'shared'`, someone else's (`openOnly`) as `'guests'`
   * (`conversationTools`). Without it such a turn has no tools (her Minecraft body's game chat keeps its own rule).
   */
  othersFolderReading?: boolean;
  /**
   * Whether the turn is told what she did on her own to reach the owner (`ownOutreach.ts`), by the same audience rules as
   * `/v1/chat` (others present: times only). Each surface decides: her Minecraft body yes on the owner's own turns (owner
   * decision 2026-10-06), never on anyone else's; a platform reply no.
   */
  ownOutreach: boolean;
  /** Keeps the completed turn and returns its experience, or null when it was kept nowhere in the owner's conversation. */
  store(turn: CompletedTurn): ShannonExperience | null;
  /**
   * Syzygy ADR-0008 stage 3: what the mind's normalizer of this surface needs beside the turn's audience, which it copies:
   * which surface, whether the verified owner wrote, and the body (her Minecraft body's device); the conversation is the turn's thread.
   */
  perception?: { surface: 'minecraft' | 'platform'; ownerWrote: boolean; body?: string | null };
}

export interface TextTurnInput {
  scopeKey: string;
  /** Already resolved by the caller. */
  threadId: string;
  message: string;
  audience: ChatAudienceTurn;
  /** The request body as the sentence stream reads it (`stream`). */
  body: ChatRequest;
  attachments: readonly ShannonChatAttachment[];
  placeOptions: { placeSearch?: { latitude?: number; longitude?: number } };
  deadline?: TurnDeadline;
  /** The HTTP request: its sentence sink, and the device and body a look reads. */
  request: Pick<ApiRequest, 'chatSentences' | 'deviceId' | 'body'>;
  surface?: TextTurnSurface;
}

export interface TextTurnResult {
  response: ApiResponse;
  /** The model's answer; absent for a fixed command reply. */
  completion?: ShannonChatModelResult;
  experienceId?: string;
}

/**
 * What a surface's turn is told of her own outreach (`TextTurnSurface.ownOutreach`): nothing when the surface switches it
 * off (a platform reply, or a turn someone other than the owner wrote: `platformTextTurnInput`); otherwise by the audience
 * rules of the app: the owner alone, everything; others able to read with him, times only (`guarded`). Where the owner is
 * not there at all (`openOnly`), nothing.
 */
function surfaceOwnOutreach(surface: TextTurnSurface, audience: ChatAudienceTurn): boolean | 'guarded' {
  if (!surface.ownOutreach || surface.openOnly) return false;
  return audience.alone ? true : 'guarded';
}

/** A surface has no look at the room or through the app. */
export const NO_LOOK: ConversationLookTurn = Object.freeze({ prompt: '', request: Object.freeze({}), decide: () => ({}) });

/** A line that begins an entry or a block of a prompt: a bullet, a bracketed header, a marker, or a blank line. */
const ENTRY_START = /^(?:\s*$|- |・|\[|【|#)/u;

/**
 * A line that marks a whole block, up to the next blank line: a marker alone on its line (the block follows), or a marker
 * that opens a block's header on the same line, as the intention frame carries it with others present (`【機微:…】[Current
 * intention frame …]`, upstream e63866a).
 */
const BLOCK_MARKER = /^\s*(?:- )?【機微:[^】]*】\s*(?:\[.*)?$/u;

/**
 * Memory text without its protected entries: the second layer behind the source (`openOnly` of the turn's context, which
 * leaves protected items, his intentions and her unlabelled notes out where they are made). Each protected item carries
 * a 【機微:…】 marker on its first line; an item whose text runs over several lines is left out whole, up to the next
 * entry or block (review N5), and a marker alone on its line, or one that opens a block's header, takes the whole block,
 * up to the next blank line (second review, 2026-10-06).
 */
export function withoutGuardedEntries(text: string): string {
  let dropping: 'entry' | 'block' | null = null;
  return text.split('\n').filter(line => {
    if (BLOCK_MARKER.test(line)) { dropping = 'block'; return false; }
    if (line.includes('【機微:')) { dropping = 'entry'; return false; }
    if (dropping === 'block' && line.trim() !== '') return false;
    if (dropping === 'entry' && !ENTRY_START.test(line)) return false;
    dropping = null;
    return true;
  }).join('\n');
}

/**
 * The first stage, all synchronous as it was inline: orchestration, a fixed command, the state, people recall and the
 * deterministic context. The kernel then awaits recall only when it runs, exactly as before the split.
 */
export function beginTextTurn(dependencies: TextTurnDependencies, input: TextTurnInput) {
  const { audience, threadId, message, surface } = input;
  const body = input.body;
  const occurredAt = dependencies.now();
  // Another surface (her Minecraft body) has no commands, organizing, orchestration, looks or agent-task proposals.
  let orchestrationState = surface ? null : observeConversationTurn({
    previous: dependencies.conversationOrchestration.read(body.scopeKey, threadId),
    scopeKey: body.scopeKey, threadId, message, occurredAt, participantMode: audience.participantMode,
    tasks: dependencies.agentTasks.list(body.scopeKey),
  });
  if (orchestrationState) orchestrationState = dependencies.conversationOrchestration.save(orchestrationState);
  const explicitCommand = !audience.alone || surface ? null : executeConversationCommand(body.scopeKey, threadId,
    { id: randomUUID(), text: message }, occurredAt, {
      stateStore: dependencies.stateStore, conversationStore: dependencies.conversationStore,
      organizeStore: dependencies.organizeStore, aetherProposals: dependencies.aetherProposals, agentTasks: dependencies.agentTasks,
      cognitiveIntents: dependencies.cognitiveIntents, memoryRecall: dependencies.memoryRecall,
    });
  if (orchestrationState && explicitCommand?.receipt) {
    orchestrationState = dependencies.conversationOrchestration.save(
      recordConversationReceipt(orchestrationState, explicitCommand.receipt),
    );
  }
  const captured = dependencies.stateStore.snapshot(body.scopeKey);
  const provisionalIntent = audience.alone ? extractExplicitUserIntent(message, threadId, occurredAt) : null;
  // What she talked about with other people is recalled here too; alone with the owner all of it may be used. On a surface
  // with others (anyone's turn in a shared chat, someone's whisper, the owner's shared-chat turn) only what everyone here
  // already heard, or what the owner made ordinary himself (`heardByEveryoneHere`), as the platform context gives it: one
  // person's whisper never reaches another's turn.
  const recalledPeople = dependencies.people.recall(body.scopeKey, captured, message, audience.present);
  const peopleRecall = surface && !audience.alone ? { ...recalledPeople,
    candidates: recalledPeople.candidates.filter(candidate => heardByEveryoneHere(captured, candidate.id, candidate.disclosure, audience.present)) } : recalledPeople;
  const deterministicContext = prepareTurnCognitiveContext(captured, dependencies.conversationStore, {
    scopeKey: body.scopeKey, message, occurredAt, channel: 'text', present: audience.present,
    threadId, additionalCandidates: peopleRecall.candidates,
    intents: dependencies.cognitiveIntents.list(body.scopeKey, 'active'),
    provisionalIntent, ...(surface?.openOnly ? { openOnly: true } : {}),
    participants: dependencies.personIdentities.list(body.scopeKey).filter(person => person.status === 'active' && message.includes(person.displayName)).map(person => person.displayName),
  });
  const organizeTurn = !surface && audience.alone && isOrganizeCommand(message);
  return { occurredAt, orchestrationState, explicitCommand, captured, provisionalIntent, peopleRecall, deterministicContext, organizeTurn };
}

export type BegunTextTurn = ReturnType<typeof beginTextTurn>;

/**
 * Syzygy ADR-0008 stage 3, step F2: the turn handed to the mind through its surface's normalizer, which copies `audience.present`
 * (the value `prepareTurnCognitiveContext`, the replay and semantic recall receive). Synchronous; never throws, never changes the turn.
 */
export function perceiveTextTurn(mind: MindPerceiver | null, input: TextTurnInput, at: string): PerceivedItem | null {
  if (!mind) return null;
  try {
    const { audience, surface, threadId, message } = input;
    const facts = { message, present: audience.present, alone: audience.alone, at };
    const perception = surface?.perception;
    const event = !surface ? textPerception({ ...facts, threadId, ...(audience.turnLabel.speaker ? { speaker: audience.turnLabel.speaker } : {}) })
      : perception?.surface === 'minecraft' ? minecraftPerception({ ...facts, threadId, ownerWrote: perception.ownerWrote, deviceId: perception.body ?? null })
      : perception?.surface === 'platform' ? platformPerception({ ...facts, threadId, ownerWrote: perception.ownerWrote })
      : null;
    return event ? mind.perceive(input.scopeKey, event) : null;
  } catch { return null; }
}

/**
 * Stage 3, step F3: the workspace's blocks for this turn (`[いまの場]`, the notices, the data frames), or '' without the
 * workspace. The turn's own item and its conversation are not repeated: its words close the prompt and its thread is the history.
 */
export function textTurnWorkspace(mind: MindTurnPorts | null, input: TextTurnInput, perceived: PerceivedItem | null, begun: Pick<BegunTextTurn, 'captured' | 'occurredAt'>,
  store: ConversationStore, snapshotNow?:()=>BegunTextTurn['captured']): string {
  if (!mind?.render) return '';
  try {
    const surface = input.surface?.perception?.surface ?? (input.surface ? null : 'text');
    const blocks = mind.render({
      scopeKey: input.scopeKey, surface: 'text', present: input.audience.present, at: begun.occurredAt, currentItemId: perceived?.itemId ?? null,
      current: surface ? { surface, sourceId: closedId(input.threadId) } : null,
      snapshot: begun.captured, snapshotNow, store,
    });
    // A turn whose reply only open items may reach (`openOnly`: someone else's platform turn) gets the blocks as its context is
    // given, without a guarded entry (stage 3 review: latent, since the audience check already holds them out).
    return input.surface?.openOnly ? withoutGuardedEntries(blocks) : blocks;
  } catch { return ''; }
}

/** Her identity, then what she may read this turn: a promise only when a read is asynchronous (`conversationCapabilityContext`). */
export function textTurnIdentityAndCapability(dependencies: TextTurnDependencies, input: TextTurnInput, begun: BegunTextTurn) {
  const { audience, message, surface } = input;
  const body = input.body;
  const { captured, explicitCommand } = begun;
  // Her Minecraft body's capability line is added to the model request when its tools include `minecraft.request`.
  const identity = audience.identity(() => dependencies.knowledgeStore?.promptProjectionParts(body.scopeKey) ?? companionIdentityPrompt(captured));
  const basePrompt: LayeredIdentityPrompt = { ...identity, identity: withStage5Capabilities(dependencies.autonomy.identityProjection(body.scopeKey, identity.identity), audience.alone ? dependencies.stage5Capabilities : undefined) };
  const capabilityContext = explicitCommand ? NO_CAPABILITY_CONTEXT : conversationCapabilityContext(body.scopeKey, message,
    { aetherContext: dependencies.aetherContext, voyagerCatalog: dependencies.voyagerCatalog, notion: dependencies.notion, upcoming: dependencies.upcoming,
      ownOutreach: dependencies.ownOutreach }, surface ? { ...audience.capabilities, ownOutreach: surfaceOwnOutreach(surface, audience) } : audience.capabilities);
  return { basePrompt, capabilityContext };
}

/**
 * The prompt of the turn, from what the stages before gave and the look the kernel asked for, in the layers the model
 * request keeps apart (Syzygy ADR-0003 principle 4): her fixed identity, what she knows of the owner, and the turn's
 * context, which begins with the shared state and holds everything that changes from turn to turn. `prompt` is the three
 * joined in that order, as the response shows it.
 */
export interface TextTurnPrompt {
  prompt: string;
  systemPrompt: string;
  profilePrompt: string;
  turnContext: string;
}

/** The Minecraft body's reports; with data frames on (stage 3), its reported lines framed as data (`framedReport`). */
function minecraftReport(dependencies: TextTurnDependencies, scopeKey: string, at: string): string {
  const block = dependencies.minecraftRequests?.promptBlock(scopeKey, at) ?? '';
  return block && dependencies.mind?.dataFrames ? framedReport(block, 'minecraft') : block;
}

export function textTurnSystemPrompt(dependencies: TextTurnDependencies, input: TextTurnInput, begun: BegunTextTurn, parts: {
  basePrompt: LayeredIdentityPrompt; cognitiveContext: { prompt: string }; capability: ConversationCapabilityContext; roomLook: ConversationLookTurn;
}): TextTurnPrompt {
  const { audience, threadId, surface } = input;
  const body = input.body;
  const { occurredAt, captured, peopleRecall, orchestrationState } = begun;
  const { basePrompt, cognitiveContext, capability, roomLook } = parts;
  const dailyMindPrompt = [audience.ownFocus(dependencies.dailyMind?.promptFor(body.scopeKey, dependencies.now()) ?? '', dependencies.autonomy.pursuitPrompt(body.scopeKey), captured, dependencies.conversationStore, body.scopeKey),
    surface ? '' : dependencies.body.ownerContext(body.scopeKey, occurredAt, audience.audience), roomLook.prompt,
    // What her Minecraft body did with what it was asked: his matter, given only while he alone reads the reply (also in his whisper in the game).
    audience.alone ? minecraftReport(dependencies, body.scopeKey, occurredAt) : ''].filter(Boolean).join('\n\n');
  // Where nobody may release a protected line (a turn someone other than the owner wrote), none is given.
  const memory = (text: string) => surface?.openOnly ? withoutGuardedEntries(text) : text;
  // Her work with the owner is his: on another surface it is given only while he alone reads the reply.
  const ownerWork = !surface || audience.alone;
  const turnContext = [
    basePrompt.state, memory(cognitiveContext.prompt), memory(peopleRecall.prompt), memory(dailyMindPrompt), memory(capability.prompt),
    ...(ownerWork ? [buildConversationOrchestrationPrompt(orchestrationState, dependencies.agentTasks.list(body.scopeKey)),
      agentTaskPromptProjection(dependencies.agentTasks.list(body.scopeKey), threadId)] : []), audience.instructions, surface?.prompt ?? '',
  ].filter(Boolean).join('\n\n');
  return {
    prompt: [basePrompt.identity, basePrompt.profile, turnContext].filter(Boolean).join('\n\n'),
    systemPrompt: basePrompt.identity, profilePrompt: basePrompt.profile, turnContext,
  };
}

/** A fixed command or organizing turn, answered without the model's reply. Awaits only organizing, as before the split. */
export async function answerTextCommand(dependencies: TextTurnDependencies, input: TextTurnInput, begun: BegunTextTurn,
  cognitiveContext: { frame: Parameters<typeof recordCompletedCognitiveCycle>[2] }, systemPrompt: string): Promise<TextTurnResult> {
  const { audience, threadId, message } = input;
  const body = input.body;
  const { occurredAt, captured, provisionalIntent, explicitCommand } = begun;
  let { session, reply } = explicitCommand
    ? { session: explicitCommand.organizeSession, reply: explicitCommand.reply }
    : await prepareConversationOrganize(body.scopeKey, threadId, occurredAt,
      dependencies.conversationStore, dependencies.organizeStore, dependencies.organizeExtractor);
  // A fixed command reply shows her face but does not change the stored feeling.
  const { messageEmotion } = resolveReplyEmotion({ snapshot: captured, userMessage: message, reply, now: occurredAt });
  const completedTurn = {
    scopeKey: body.scopeKey, threadId, capturedState: captured, userMessage: message, shannonReply: reply,
    messageEmotion, completedAt: occurredAt,
  };
  const experience = dependencies.background.recordTurn(completedTurn);
  recordCompletedCognitiveCycle(dependencies.cognitiveIntents, body.scopeKey, cognitiveContext.frame, provisionalIntent, experience.id, {
    threadId, channel: 'text', action: 'command', summary: '確認済みの会話コマンドを処理した。', occurredAt,
  });
  const lastMessage = dependencies.conversationStore.conversationHistory(body.scopeKey, threadId).at(-1);
  if (lastMessage && session) session = dependencies.organizeStore.setCommandThrough(body.scopeKey, session.id, lastMessage.id, dependencies.now());
  dependencies.background.schedule(completedTurn, experience.id);
  return { response: {
    status: 200,
    body: {
      mode: dependencies.chatModel.mode, model: dependencies.chatModel.model, reply, threadId, turnId: experience.id,
      snapshotVersion: captured.version, messageEmotion, systemPrompt: withoutUnshownTitles(systemPrompt), state: presentCompanionState(captured, occurredAt),
      thread: dependencies.conversationStore.listThreads(body.scopeKey).find(thread => thread.threadId === threadId), audience: audience.audience,
      ...(session ? { uiBlocks: [{ type: 'organize_session' as const, session }] } : {}),
    } satisfies ChatResponse,
  } };
}

/** The turn as another surface keeps it; what her tools did is linked to it as `recordTurn` links it. */
export function storedBySurface(dependencies: TextTurnDependencies, surface: TextTurnSurface, turn: CompletedTurn) {
  const experience = surface.store(turn);
  if (experience) dependencies.toolServer.turns.turnStored(turn.scopeKey, turn.threadId, experience.id, turn.userMessage, !turn.audience, turn.utteranceId);
  return experience;
}

/**
 * Syzygy ADR-0008 stage 2: the turn's tools once its Jev call has answered (awaited only when there is one). The session is
 * narrowed to what Jev chose, and Jev's web entry sets the turn's web search (then no function tools, as before). The turn's
 * projections are what they always were.
 */
export async function settleTextTools<T extends { tools?: ShannonModelToolSession; toolsWithheld?: true }>(
  offered: T, choices: Promise<TurnChoiceAnswer>,
): Promise<{ offer: T; web: boolean; answer: TurnChoiceAnswer }> {
  const answer = await choices;
  const menu = answer.menu;
  const offer = menu && offered.tools ? { ...offered, tools: withToolMenu(offered.tools, menu.chosen) } : offered;
  return { offer, web: menu?.chosen.includes(WEB_CAPABILITY_ENTRY.name) === true && !offered.tools?.definitions.some(tool => tool.name === 'web.search'), answer };
}

/**
 * Who her tools are offered to in a text turn, and Syzygy ADR-0008 stage 2's start: with her read tools (`readTools`), the ones
 * the projections' rules allow, beside the projections, for the owner alone in the app; with a chooser, the turn's Jev call (the menu, and the
 * web entry beside her read tools), started before recall so that it runs in parallel with it. Neither without the wiring.
 */
export function textToolStart(input: TextTurnInput, begun: BegunTextTurn, parts: {
  autonomy: { tools?: ShannonToolRunner }; toolServer: ConversationToolServer; turnChooser: ToolMenuChooser | null; readTools: boolean; toolHints?: boolean;
}) {
  const { audience, surface, body, message, threadId, placeOptions } = input;
  // With others present, her Aether reading tools (owner decisions 2026-10-06): the owner's own turn (app text marked `others`,
  // his turn in a shared platform conversation) as 'shared', someone else's as 'guests'.
  const toolAudience = audience.alone || (!surface ? 'shared' as const : !surface.othersFolderReading ? false : surface.openOnly ? 'guests' as const : 'shared' as const);
  const modelTurn = !begun.explicitCommand && !begun.organizeTurn && body.webSearch !== true && !placeOptions.placeSearch;
  const plan = parts.readTools && !begun.explicitCommand && !begun.organizeTurn && audience.alone && !surface ? readToolPlan(audience.capabilities) : null;
  // Game chat asks her Minecraft body through the turn's intent, not through her tools.
  const toolOptions = {
    ...(surface && !surface.minecraftTools ? { withoutDomains: ['minecraft_body'], ...(surface.openOnly ? { openOnly: true } : {}) } : {}),
    ...(plan ? { reads: plan.offer } : {}), ...(parts.toolHints ? { sourceHints: true } : {}),
  };
  const choices = startTurnToolMenu(modelTurn ? parts.turnChooser : null, parts.autonomy, body.scopeKey, 'text', toolAudience, parts.toolServer, `${threadId}\n${message}`,
    toolOptions, plan && !parts.autonomy.tools?.knownTool(WEB_CAPABILITY_ENTRY.name) ? [WEB_CAPABILITY_ENTRY] : []);
  return { toolAudience, toolOptions, choices };
}
