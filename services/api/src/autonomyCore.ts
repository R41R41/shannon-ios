import type { ShannonCoreAreaId } from '@shannon/cognition';

/**
 * CORE, as code (Syzygy ADR-0002).
 *
 * The nine core areas mapped to repository paths. A path ending in `/` covers the
 * whole directory. Shannon may propose a change to any of these from background
 * activity; applying one needs the owner's approval, and `authorizeAutonomousAction`
 * answers `needs_approval` for every path listed here. `autonomyCore.test.ts` fails
 * when a listed path no longer exists, so a rename has to update this map.
 *
 * Paths are relative to the Shannon repository root and use `/`.
 */
export const SHANNON_CORE_PATHS: Readonly<Record<ShannonCoreAreaId, readonly string[]>> = Object.freeze({
  purpose: Object.freeze([
    'AGENTS.md',
    'README.md',
    'docs/architecture.md',
    'packages/cognition/src/pursuits.ts',
    // What her own activity is asked to do, and from which materials.
    'services/api/src/autonomyLoopPrompts.ts',
    'services/api/src/autonomyLoopPlan.ts',
    // The words for what her steps led to, and the prompt of the one second call after an unanswered message.
    'services/api/src/autonomyLoopObservePrompts.ts',
    // The words for her sessions and the facts of her budget; what she may see of the owner's and the output rule that goes with it.
    'services/api/src/autonomyLoopSessionPrompts.ts',
    'services/api/src/autonomyLoopOwnerContext.ts',
  ]),
  persona: Object.freeze([
    'packages/cognition/src/persona.ts',
    'packages/cognition/src/capabilities.ts',
    'packages/cognition/src/autonomy.ts',
    'packages/cognition/src/prompt.ts',
    'services/api/src/apiPromptProjection.ts',
    'services/api/src/voiceConversationInstructions.ts',
    'services/api/src/voiceIntroductionInstructions.ts',
    'services/api/src/chatModelSupport.ts',
    // What she is told, and how her line is read, when she is touched.
    'services/api/src/bodyReactionPrompt.ts',
  ]),
  emotion: Object.freeze([
    'packages/cognition/src/affect.ts',
    'packages/cognition/src/emotionState.ts',
    // Her awake clock, the one table of how long feelings last, and what stays underneath the feeling of the moment.
    'packages/cognition/src/emotionTime.ts',
    'packages/cognition/src/emotionContinuity.ts',
    'services/api/src/emotionTiming.ts',
    'services/api/src/autonomyAwakeClock.ts',
    // The record of her mood written beside each committed state write; it reads the state and never changes it.
    'services/api/src/moodHistory.ts',
    'packages/cognition/src/emotionOverrides.ts',
    'packages/cognition/src/replyEmotion.ts',
    'packages/cognition/src/expression.ts',
    'packages/cognition/src/temperament.ts',
    'packages/cognition/src/state.ts',
    'packages/cognition/src/stateRestore.ts',
    'services/api/src/companionPresence.ts',
    'services/api/src/voiceEmotionPlan.ts',
    // The strength of a text reply's feeling, decided by the chat model and handed to the one resolver.
    'services/api/src/chatReplyFeeling.ts',
    // A touch as an input to the one emotion state: the touch → feeling table, and the one entrance that applies it.
    'packages/cognition/src/touchEmotion.ts',
    'services/api/src/bodyTouch.ts',
  ]),
  authentication: Object.freeze([
    'services/api/src/apiAuth.ts',
    'services/api/src/deviceAuth.ts',
    'services/api/src/authCli.ts',
    'services/api/src/serverPairingRoute.ts',
    'services/api/src/serverDeviceRoutes.ts',
    'apps/ios/Sources/ShannonAppCore/Features/Connection/',
  ]),
  memory: Object.freeze([
    'packages/cognition/src/memory.ts',
    'packages/cognition/src/withholding.ts',
    'packages/cognition/src/disclosure.ts',
    'packages/cognition/src/recall.ts',
    'packages/cognition/src/memorySearch.ts',
    'packages/cognition/src/semanticRecall.ts',
    'packages/cognition/src/shannonKnowledge.ts',
    'packages/cognition/src/types.ts',
    'services/api/src/sqliteStore.ts',
    'services/api/src/sqliteStoreContext.ts',
    'services/api/src/sqliteStoreCodecs.ts',
    'services/api/src/sqliteMigrations.ts',
    'services/api/src/sqliteCompanionRepository.ts',
    'services/api/src/sqliteConversationRepository.ts',
    'services/api/src/sqliteBackgroundJobRepository.ts',
    'services/api/src/sqliteMemorySearch.ts',
    'services/api/src/sqliteMemoryEmbeddings.ts',
    'services/api/src/sqliteShannonKnowledge.ts',
    'services/api/src/conversationStore.ts',
    'services/api/src/knowledgeStore.ts',
    'services/api/src/knowledgeConsolidation.ts',
    'services/api/src/memoryService.ts',
    'services/api/src/memoryModels.ts',
    'services/api/src/memoryProjection.ts',
    'services/api/src/memoryProjectionSafety.ts',
    'services/api/src/memoryVisibility.ts',
    'services/api/src/memoryDisclosure.ts',
    // What her own activity may see of the owner's, and the stores its process opens to read it.
    'services/api/src/autonomyOwnerContext.ts',
    'services/api/src/autonomyOwnerContextWiring.ts',
    'services/api/src/peopleMemory.ts',
    'services/api/src/peopleMemoryStore.ts',
    'services/api/src/peopleMemoryPrompts.ts',
    'services/api/src/apiPeopleMemoryRoutes.ts',
    'services/api/src/platformPeople.ts',
    'services/api/src/platformPeopleSummaries.ts',
    // Her impressions of people: what is kept, what reaches a reply, and how the owner forgets them.
    'services/api/src/impressions.ts',
    'services/api/src/sqliteImpressions.ts',
    'services/api/src/impressionRecall.ts',
    'services/api/src/impressionUpdater.ts',
    'services/api/src/impressionViews.ts',
    'services/api/src/platformBridge.ts',
    'services/api/src/voiceCompanionPresence.ts',
    'services/api/src/memoryForgetCommand.ts',
    'services/api/src/memoryEmbeddingWorker.ts',
    'services/api/src/prospectiveMemory.ts',
    'services/api/src/turnCaptures.ts',
    'services/api/src/sleepConsolidation.ts',
    'services/api/src/sleepConsolidationRules.ts',
    'services/api/src/backgroundWorker.ts',
    'services/api/src/backgroundUpdates.ts',
    // The owner's upcoming items: calendar snapshots from the apps, and the one projection that reaches a prompt.
    'services/api/src/calendarContract.ts',
    'services/api/src/calendarRoutes.ts',
    'services/api/src/upcomingStore.ts',
    'services/api/src/ownerUpcoming.ts',
    'services/api/src/ownerUpcomingWiring.ts',
    // A touch as an experience she recalls, and her line while it waits outside the conversation.
    'services/api/src/bodyTouchMemory.ts',
    'services/api/src/bodyReactionStore.ts',
  ]),
  approval_and_budget: Object.freeze([
    'services/api/src/autonomyCore.ts',
    'services/api/src/autonomyPaths.ts',
    'services/api/src/autonomyPolicy.ts',
    'services/api/src/autonomyBudget.ts',
    'services/api/src/autonomyModels.ts',
    'services/api/src/autonomyStore.ts',
    'services/api/src/autonomyPursuits.ts',
    'services/api/src/autonomyProposals.ts',
    'services/api/src/autonomyService.ts',
    'services/api/src/autonomyServiceParts.ts',
    'services/api/src/autonomyAnnouncer.ts',
    'services/api/src/apiAutonomyRoutes.ts',
    // The activity loop: every step it takes passes the gate, the budget, and the record.
    'services/api/src/autonomyLoop.ts',
    'services/api/src/autonomyLoopConfig.ts',
    'services/api/src/autonomyLoopState.ts',
    'services/api/src/autonomyLoopSteps.ts',
    'services/api/src/autonomyReader.ts',
    'services/api/src/autonomyShowing.ts',
    'services/api/src/autonomyTextModel.ts',
    'services/api/src/autonomyWorker.ts',
    // Her folder on the owner's machines: what may leave, the queue, and the device routes.
    'services/api/src/autonomyHostFolderPath.ts',
    'services/api/src/autonomyHostFolderSteps.ts',
    'services/api/src/autonomyHostFolderDesk.ts',
    'services/api/src/autonomyLoopFolderStep.ts',
    'services/api/src/apiAutonomyHostStepRoutes.ts',
    // Her tools (Syzygy ADR-0003 stage 1): the one registry, the one gate entry, the runner, the executors over her study and
    // her folder, the v2 folder operations and their device results, the step of her own time, and the conversation's offer
    // (the function-calling rounds are in the response path).
    'services/api/src/shannonTools.ts',
    'services/api/src/shannonToolGate.ts',
    'services/api/src/shannonToolInput.ts',
    'services/api/src/shannonToolTypes.ts',
    'services/api/src/shannonToolRunner.ts',
    'services/api/src/shannonToolSession.ts',
    'services/api/src/shannonToolAudience.ts',
    'services/api/src/conversationSecrets.ts',
    'services/api/src/shannonStudyTools.ts',
    'services/api/src/shannonFolderTools.ts',
    'services/api/src/hostFolderOperations.ts',
    'services/api/src/hostFolderOperationsStore.ts',
    'services/api/src/hostFolderOperationResults.ts',
    'services/api/src/autonomyLoopToolStep.ts',
    // Looking at the room in her own time: the gated step, the look it opens, and the model call charged to her budget.
    'services/api/src/autonomyLoopLookStep.ts',
    'services/api/src/bodyLookActivity.ts',
    'services/api/src/bodyLookActivityStore.ts',
    'services/api/src/bodyLookActivityVision.ts',
    // Speaking up on her own: the gated step and the one way its message leaves.
    'services/api/src/autonomyLoopReachOutStep.ts',
    'services/api/src/reachOutDelivery.ts',
    // Phoning the owner's iPhone on her own: the gated step, and asking the API process for the call.
    'services/api/src/autonomyLoopPhoneStep.ts',
    'services/api/src/incomingCallRequests.ts',
    // Act, observe, think again: what a step led to as closed facts, the wait after a message of hers, the thinking step,
    // the one second call, and what her body reports about a message.
    'services/api/src/autonomyLoopObservations.ts',
    'services/api/src/autonomyLoopObserve.ts',
    'services/api/src/autonomyLoopThinkStep.ts',
    'services/api/src/autonomyLoopFollowUpStep.ts',
    'services/api/src/autonomyLoopCalls.ts',
    'services/api/src/reachOutReports.ts',
    // She paces her own day: when a session may begin, what stops it, when the next begins, and what the owner is shown of it.
    'services/api/src/autonomyLoopPacing.ts',
    'services/api/src/autonomyLoopSessions.ts',
    'services/api/src/autonomySessionView.ts',
    'services/api/src/llmUsage.ts',
    'services/api/src/agentTaskStore.ts',
    'services/api/src/agentTaskPersistence.ts',
    'services/api/src/agentTaskPersistenceSupport.ts',
    'services/api/src/apiAgentRoutes.ts',
    'services/api/src/codexTaskBridge.ts',
    'services/api/src/codexTaskCommands.ts',
    'services/api/src/codexTaskEvents.ts',
    'services/api/src/codexTaskRuntime.ts',
    'services/api/src/agentHost.ts',
    'services/api/src/agentHostConfig.ts',
  ]),
  activity_record: Object.freeze([
    'services/api/src/autonomyActivity.ts',
    'services/api/src/autonomyDayLog.ts',
  ]),
  response_path: Object.freeze([
    'services/api/src/server.ts',
    'services/api/src/serverHttp.ts',
    'services/api/src/apiKernel.ts',
    'services/api/src/apiValidation.ts',
    'services/api/src/apiLiveVoice.ts',
    'services/api/src/apiVoiceTurns.ts',
    'services/api/src/chatModel.ts',
    'services/api/src/contracts.ts',
    'services/api/src/turnCognitiveContext.ts',
    'services/api/src/turnMemoryRecall.ts',
    'services/api/src/conversationOrchestration.ts',
    'services/api/src/conversationCommands.ts',
    'services/api/src/serverLiveVoiceStreamRoute.ts',
    'services/api/src/chatSentenceStream.ts',
    'services/api/src/chatSentenceSplitter.ts',
    'services/api/src/serverChatSentenceStream.ts',
    'services/api/src/chatModelTurn.ts',
    'services/api/src/chatModelTools.ts',
    'services/api/src/chatModelVoiceTools.ts',
    'services/api/src/turnDeadline.ts',
    'services/api/src/chatModelStream.ts',
    'services/api/src/chatModelVoiceStream.ts',
    'services/api/src/spokenSentences.ts',
    'services/api/src/chatReplyStreamDecoder.ts',
    'services/api/src/serverGeminiLiveRoute.ts',
    'services/api/src/serverGeminiSpeechRoute.ts',
    // The reflex from a touch to her answer, and its one model call.
    'services/api/src/bodyReaction.ts',
    'services/api/src/bodyReactionModel.ts',
  ]),
  deployment: Object.freeze([
    'deploy/',
    'scripts/',
    'ci_scripts/',
    'docs/self-improvement-runbook.md',
    'docs/BRANCHING.md',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'services/api/package.json',
    'services/api/src/testflightDistributor.ts',
    'services/api/src/testflightDeliveryStore.ts',
    'apps/ios-app/ShannonApp.xcodeproj/',
    'apps/macos-app/ShannonDesk.xcodeproj/',
    'Shannon.xcworkspace/',
  ]),
});

export interface CorePathMatch {
  area: ShannonCoreAreaId;
  /** The listed entry that matched. */
  entry: string;
}

/** Normalizes a repository-relative path: `/` separators, no leading `./`, no empty segments. */
export function normalizedRepositoryPath(path: string): string | null {
  const segments = path.replace(/\\/gu, '/').split('/').filter(segment => segment && segment !== '.');
  if (!segments.length || segments.includes('..')) return null;
  return segments.join('/');
}

/**
 * The core area that owns a repository-relative path, or null when it is not core.
 * Comparison ignores case because the owner's Mac and Windows file systems do.
 */
export function coreAreaForRepositoryPath(path: string): CorePathMatch | null {
  const normalized = normalizedRepositoryPath(path)?.toLowerCase();
  if (!normalized) return null;
  for (const [area, entries] of Object.entries(SHANNON_CORE_PATHS) as Array<[ShannonCoreAreaId, readonly string[]]>) {
    for (const entry of entries) {
      const candidate = entry.toLowerCase();
      const matches = candidate.endsWith('/')
        ? normalized === candidate.slice(0, -1) || normalized.startsWith(candidate)
        : normalized === candidate;
      if (matches) return { area, entry };
    }
  }
  return null;
}

export function allCorePaths(): readonly string[] {
  return Object.values(SHANNON_CORE_PATHS).flat();
}
