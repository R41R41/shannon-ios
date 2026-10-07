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
    'services/api/src/mind/action/ownTime/autonomyLoopPrompts.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopPlan.ts',
    // The words for what her steps led to, and the prompt of the one second call after an unanswered message.
    'services/api/src/mind/action/ownTime/autonomyLoopObservePrompts.ts',
    // The words for her sessions and the facts of her budget; what she may see of the owner's and the output rule that goes with it.
    'services/api/src/mind/action/ownTime/autonomyLoopSessionPrompts.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopOwnerContext.ts',
  ]),
  persona: Object.freeze([
    'packages/cognition/src/persona.ts',
    'packages/cognition/src/capabilities.ts',
    'packages/cognition/src/autonomy.ts',
    'packages/cognition/src/prompt.ts',
    'services/api/src/mind/action/respond/apiPromptProjection.ts',
    'services/api/src/surfaces/voice/voiceConversationInstructions.ts',
    'services/api/src/surfaces/voice/voiceIntroductionInstructions.ts',
    'services/api/src/infra/models/chatModelSupport.ts',
    // What she is told, and how her line is read, when she is touched.
    'services/api/src/surfaces/body/bodyReactionPrompt.ts',
  ]),
  emotion: Object.freeze([
    'packages/cognition/src/affect.ts',
    'packages/cognition/src/emotionState.ts',
    // Her awake clock, the one table of how long feelings last, and what stays underneath the feeling of the moment.
    'packages/cognition/src/emotionTime.ts',
    'packages/cognition/src/emotionContinuity.ts',
    'services/api/src/mind/emotion/emotionTiming.ts',
    'services/api/src/mind/emotion/autonomyAwakeClock.ts',
    // The record of her mood written beside each committed state write; it reads the state and never changes it.
    'services/api/src/mind/emotion/store/moodHistory.ts',
    'packages/cognition/src/emotionOverrides.ts',
    'packages/cognition/src/replyEmotion.ts',
    'packages/cognition/src/expression.ts',
    'packages/cognition/src/temperament.ts',
    'packages/cognition/src/state.ts',
    'packages/cognition/src/stateRestore.ts',
    'services/api/src/mind/emotion/companionPresence.ts',
    'services/api/src/mind/emotion/voiceEmotionPlan.ts',
    // The strength of a text reply's feeling, decided by the chat model and handed to the one resolver.
    'services/api/src/mind/emotion/chatReplyFeeling.ts',
    // A touch as an input to the one emotion state: the touch → feeling table, and the one entrance that applies it.
    'packages/cognition/src/touchEmotion.ts',
    'services/api/src/mind/emotion/bodyTouch.ts',
    // Syzygy ADR-0005 stage 1b: the parts where only the reflex moves her, and the vocabulary of how she took a touch.
    'services/api/src/surfaces/body/bodyTouchReflex.ts',
    // Syzygy ADR-0006: the prediction layer and the new dynamics of her feeling, their record, and the shadow taps of stage 1.
    'packages/cognition/src/prediction.ts',
    'packages/cognition/src/predictionDomains.ts',
    'packages/cognition/src/affectDynamics.ts',
    'services/api/src/mind/prediction/store/predictionStore.ts',
    'services/api/src/mind/prediction/predictionShadow.ts',
    'services/api/src/mind/prediction/predictionShadowFold.ts',
    'services/api/src/mind/prediction/predictionShadowReadings.ts',
    // Syzygy ADR-0006 stage 2: a touch's startle and her stance's prediction error move her (`SHANNON_PREDICTION`).
    'packages/cognition/src/touchAppraisal.ts',
    'services/api/src/mind/prediction/bodyTouchPrediction.ts',
    // Syzygy ADR-0008 stage 1: the pure package of the prediction ledger, calibration, reward, values and the mood exit.
    'packages/learning/',
    // Syzygy ADR-0008 stage 1: the learning part (prediction and choice ledgers, settlement, value table, their stores): every file below.
    'services/api/src/mind/learning/',
    // Syzygy ADR-0008 stage 1: the nightly pass of the ledgers (expiry, delayed credit, retention).
    'services/api/src/mind/sleep/valueSleep.ts',
    // Syzygy ADR-0008 stage 1, step 7b: settled choices of hers move her mood (the emotion source).
    'services/api/src/mind/emotion/rewardMood.ts',
    // Syzygy ADR-0008 stage 1: the wiring that hands the ledgers their connections and the parts their taps, and their shared vocabulary.
    'services/api/src/wiring/cognitionLedgerWiring.ts',
    'services/api/src/wiring/cognitionLedgerTaps.ts',
    'services/api/src/contracts/cognitionLedgerContract.ts',
    // Syzygy ADR-0008 stage 2, owner answer I-3: the wiring that scores her conversation choices into reward, mood and values.
    'services/api/src/wiring/turnRoutingWiring.ts',
  ]),
  authentication: Object.freeze([
    'services/api/src/infra/auth/apiAuth.ts',
    'services/api/src/infra/auth/deviceAuth.ts',
    'services/api/src/authCli.ts',
    'services/api/src/infra/auth/serverPairingRoute.ts',
    'services/api/src/infra/auth/serverDeviceRoutes.ts',
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
    'services/api/src/infra/sqlite/sqliteStore.ts',
    'services/api/src/infra/sqlite/sqliteStoreContext.ts',
    'services/api/src/infra/sqlite/sqliteStoreCodecs.ts',
    'services/api/src/infra/sqlite/sqliteMigrations.ts',
    // Syzygy ADR-0008 stage 1: the write lock of the shared file, taken and measured the same way by every cognition writer.
    'services/api/src/infra/sqlite/lockWaits.ts',
    'services/api/src/infra/sqlite/sqliteCompanionRepository.ts',
    'services/api/src/infra/sqlite/sqliteConversationRepository.ts',
    'services/api/src/infra/sqlite/sqliteBackgroundJobRepository.ts',
    'services/api/src/mind/memory/store/sqliteMemorySearch.ts',
    'services/api/src/mind/memory/store/sqliteMemoryEmbeddings.ts',
    'services/api/src/mind/memory/store/sqliteShannonKnowledge.ts',
    'services/api/src/mind/memory/store/conversationStore.ts',
    'services/api/src/mind/memory/store/knowledgeStore.ts',
    'services/api/src/mind/sleep/knowledgeConsolidation.ts',
    // Syzygy ADR-0008 stage 2, step 6: her skill memory (the SKILL.md codec, the store, the service and its window), the sleep
    // builder, what a turn is handed of it, and its wiring.
    'services/api/src/mind/memory/skillDocument.ts',
    'services/api/src/mind/memory/skillMemory.ts',
    'services/api/src/mind/memory/memoryPorts.ts',
    'services/api/src/mind/memory/store/sqliteSkills.ts',
    'services/api/src/mind/sleep/skillConsolidation.ts',
    'services/api/src/mind/sleep/skillSleepModel.ts',
    'services/api/src/mind/sleep/skillSleepRules.ts',
    'services/api/src/contracts/skillMemoryContract.ts',
    'services/api/src/wiring/skillMemoryWiring.ts',
    // Step 7: her skills' readable copies in Aether, and the owner's edits of them adopted.
    'services/api/src/integrations/aether/skillExport.ts',
    // Review M3: every file of the memory part, so a new one is covered at once (a file listed by name elsewhere keeps its area);
    // her skills' lineage, copies and helpers among them, and the worker's note of her own writes to her skills' copies.
    'services/api/src/mind/memory/',
    'services/api/src/wiring/skillCopyWiring.ts',
    // Step 8: tree recall (the beam, its tree and Jev's questions) and its wiring.
    'services/api/src/mind/recall/treeBeam.ts',
    'services/api/src/mind/recall/treeRecall.ts',
    'services/api/src/wiring/treeRecallWiring.ts',
    'services/api/src/mind/memory/memoryService.ts',
    'services/api/src/mind/recall/memoryModels.ts',
    'services/api/src/mind/memory/memoryProjection.ts',
    'services/api/src/mind/memory/memoryProjectionSafety.ts',
    'services/api/src/mind/memory/memoryVisibility.ts',
    'services/api/src/mind/inhibition/memoryDisclosure.ts',
    // What her own activity may see of the owner's, and the stores its process opens to read it.
    'services/api/src/mind/action/ownTime/autonomyOwnerContext.ts',
    'services/api/src/wiring/autonomyOwnerContextWiring.ts',
    'services/api/src/mind/memory/peopleMemory.ts',
    'services/api/src/mind/memory/store/peopleMemoryStore.ts',
    'services/api/src/mind/memory/peopleMemoryPrompts.ts',
    'services/api/src/infra/http/apiPeopleMemoryRoutes.ts',
    'services/api/src/surfaces/platform/platformPeople.ts',
    'services/api/src/surfaces/platform/platformPeopleSummaries.ts',
    // Her impressions of people: what is kept, what reaches a reply, and how the owner forgets them.
    'services/api/src/mind/memory/impressions.ts',
    'services/api/src/mind/memory/store/sqliteImpressions.ts',
    'services/api/src/mind/recall/impressionRecall.ts',
    'services/api/src/mind/memory/impressionUpdater.ts',
    'services/api/src/mind/memory/impressionViews.ts',
    'services/api/src/surfaces/platform/platformBridge.ts',
    'services/api/src/surfaces/platform/platformBridgeBindings.ts',
    'services/api/src/surfaces/voice/voiceCompanionPresence.ts',
    'services/api/src/mind/memory/memoryForgetCommand.ts',
    'services/api/src/mind/memory/memoryEmbeddingWorker.ts',
    'services/api/src/mind/memory/prospectiveMemory.ts',
    'services/api/src/mind/memory/store/turnCaptures.ts',
    'services/api/src/mind/sleep/sleepConsolidation.ts',
    'services/api/src/mind/sleep/sleepConsolidationRules.ts',
    'services/api/src/mind/sleep/backgroundWorker.ts',
    'services/api/src/mind/sleep/backgroundUpdates.ts',
    // The owner's upcoming items: calendar snapshots from the apps, and the one projection that reaches a prompt.
    'services/api/src/contracts/calendarContract.ts',
    'services/api/src/infra/http/calendarRoutes.ts',
    'services/api/src/mind/memory/store/upcomingStore.ts',
    'services/api/src/mind/memory/ownerUpcoming.ts',
    'services/api/src/wiring/ownerUpcomingWiring.ts',
    // A touch as an experience she recalls, and her line while it waits outside the conversation.
    'services/api/src/surfaces/body/store/bodyTouchMemory.ts',
    'services/api/src/surfaces/body/store/bodyReactionStore.ts',
    // What happened to her Minecraft body as an experience, and the replay of her game-chat answers.
    'services/api/src/surfaces/minecraft/store/gameBodyMemory.ts',
    'services/api/src/surfaces/minecraft/store/minecraftTurnStore.ts',
    // Syzygy ADR-0008 stage 3 (`docs/mind-workspace-contract.md`): the pure rules of what she keeps and forgets about people and
    // talks, listed by name so they are memory's although `packages/mind/` is the response path's: two-clock decay, the identity
    // tiers, the temporal rules of facts, the trust fold and the compaction template.
    'packages/mind/src/evidenceDecay.ts',
    'packages/mind/src/identityTiers.ts',
    'packages/mind/src/temporalFacts.ts',
    'packages/mind/src/trustFold.ts',
    'packages/mind/src/compaction.ts',
  ]),
  approval_and_budget: Object.freeze([
    'services/api/src/mind/inhibition/autonomyCore.ts',
    'services/api/src/mind/inhibition/autonomyPaths.ts',
    'services/api/src/mind/inhibition/autonomyPolicy.ts',
    // The window other parts of the mind import the gate and the budget through (Syzygy ADR-0008 §10).
    'services/api/src/mind/inhibition/inhibitionPorts.ts',
    'services/api/src/mind/inhibition/autonomyBudget.ts',
    // Review M3: every file of the inhibition part (a file listed by name elsewhere keeps its area), her withheld actions among
    // them, with their contract and wiring.
    'services/api/src/mind/inhibition/',
    'services/api/src/contracts/withheldActionContract.ts',
    'services/api/src/wiring/withheldWiring.ts',
    // Syzygy ADR-0008 stage 3 (owner answer 2): the proactive gate at the delivery points of her own messages is the guard's, by
    // name, although the attention part is the response path's.
    'services/api/src/mind/attention/proactiveDelivery.ts',
    'services/api/src/mind/attention/store/proactiveTopicsStore.ts',
    'services/api/src/wiring/proactiveGateWiring.ts',
    'services/api/src/mind/action/ownTime/autonomyModels.ts',
    'services/api/src/mind/action/ownTime/store/autonomyStore.ts',
    'services/api/src/mind/self/autonomyPursuits.ts',
    'services/api/src/mind/action/ownTime/store/autonomyProposals.ts',
    'services/api/src/mind/action/ownTime/autonomyService.ts',
    'services/api/src/mind/action/ownTime/autonomyServiceParts.ts',
    'services/api/src/mind/action/ownTime/autonomyAnnouncer.ts',
    'services/api/src/infra/http/apiAutonomyRoutes.ts',
    // The activity loop: every step it takes passes the gate, the budget, and the record.
    'services/api/src/mind/action/ownTime/autonomyLoop.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopConfig.ts',
    'services/api/src/mind/action/ownTime/store/autonomyLoopState.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopSteps.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopStepText.ts',
    'services/api/src/mind/action/ownTime/autonomyReader.ts',
    'services/api/src/mind/action/ownTime/autonomyShowing.ts',
    'services/api/src/mind/action/ownTime/autonomyTextModel.ts',
    'services/api/src/autonomyWorker.ts',
    // Her folder on the owner's machines: what may leave, the queue, and the device routes.
    'services/api/src/mind/action/ownTime/autonomyHostFolderPath.ts',
    'services/api/src/mind/action/ownTime/store/autonomyHostFolderSteps.ts',
    'services/api/src/mind/action/ownTime/autonomyHostFolderDesk.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopFolderStep.ts',
    'services/api/src/infra/http/apiAutonomyHostStepRoutes.ts',
    // Her tools (Syzygy ADR-0003 stage 1): the one registry, the one gate entry, the runner, the executors over her study and
    // her folder, the v2 folder operations and their device results, the step of her own time, and the conversation's offer
    // (the function-calling rounds are in the response path).
    'services/api/src/mind/tools/shannonTools.ts',
    'services/api/src/mind/inhibition/shannonToolGate.ts',
    'services/api/src/mind/tools/shannonToolInput.ts',
    'services/api/src/mind/tools/shannonToolTypes.ts',
    'services/api/src/mind/tools/shannonToolRunner.ts',
    'services/api/src/mind/tools/shannonToolSession.ts',
    'services/api/src/mind/inhibition/shannonToolAudience.ts',
    'services/api/src/mind/inhibition/conversationSecrets.ts',
    'services/api/src/mind/tools/shannonStudyTools.ts',
    'services/api/src/mind/tools/shannonFolderTools.ts',
    // Syzygy ADR-0008 stage 2, step 3: the executors of her read tools (Notion, Voyager tasks, the schedule, place search).
    'services/api/src/mind/tools/shannonReadTools.ts',
    // Step 6: the executor of skill.read.
    'services/api/src/mind/tools/shannonSkillTools.ts',
    // The window other parts of the mind read what her tools did in a turn through (Syzygy ADR-0008 §10).
    'services/api/src/mind/tools/toolsPorts.ts',
    // Aether (Syzygy ADR-0007 revised): the client of her access and the executors of her Aether tools.
    'services/api/src/integrations/aether/aetherAccess.ts',
    'services/api/src/mind/tools/shannonAetherTools.ts',
    // Her own time reading the owner's documents (ADR-0007, owner decision 2026-10-06): the executors, and the provenance mark
    // that keeps what she wrote after them from anyone else present.
    'services/api/src/mind/tools/shannonOwnerDocumentTools.ts',
    'services/api/src/mind/inhibition/store/ownerInformedMarks.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopProvenance.ts',
    'services/api/src/mind/action/ownTime/hostFolderOperations.ts',
    'services/api/src/mind/action/ownTime/store/hostFolderOperationsStore.ts',
    'services/api/src/mind/action/ownTime/hostFolderOperationResults.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopToolStep.ts',
    // Looking at the room in her own time: the gated step, the look it opens, and the model call charged to her budget.
    'services/api/src/mind/action/ownTime/autonomyLoopLookStep.ts',
    'services/api/src/surfaces/body/bodyLookActivity.ts',
    'services/api/src/surfaces/body/store/bodyLookActivityStore.ts',
    'services/api/src/surfaces/body/bodyLookActivityVision.ts',
    // Speaking up on her own: the gated step and the one way its message leaves.
    'services/api/src/mind/action/ownTime/autonomyLoopReachOutStep.ts',
    'services/api/src/surfaces/outreach/reachOutDelivery.ts',
    // Phoning the owner's iPhone on her own: the gated step, and asking the API process for the call.
    'services/api/src/mind/action/ownTime/autonomyLoopPhoneStep.ts',
    'services/api/src/surfaces/outreach/incomingCallRequests.ts',
    // Act, observe, think again: what a step led to as closed facts, the wait after a message of hers, the thinking step,
    // the one second call, and what her body reports about a message.
    'services/api/src/mind/action/ownTime/store/autonomyLoopObservations.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopObserve.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopThinkStep.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopFollowUpStep.ts',
    'services/api/src/mind/action/ownTime/autonomyLoopCalls.ts',
    'services/api/src/surfaces/outreach/store/reachOutReports.ts',
    // She paces her own day: when a session may begin, what stops it, when the next begins, and what the owner is shown of it.
    'services/api/src/mind/action/ownTime/autonomyLoopPacing.ts',
    'services/api/src/mind/action/ownTime/store/autonomyLoopSessions.ts',
    'services/api/src/mind/action/ownTime/autonomySessionView.ts',
    'services/api/src/infra/models/llmUsage.ts',
    'services/api/src/mind/action/agentTasks/agentTaskStore.ts',
    'services/api/src/mind/action/agentTasks/store/agentTaskPersistence.ts',
    'services/api/src/mind/action/agentTasks/store/agentTaskPersistenceSupport.ts',
    'services/api/src/infra/http/apiAgentRoutes.ts',
    'services/api/src/integrations/agentHost/codexTaskBridge.ts',
    'services/api/src/integrations/agentHost/codexTaskCommands.ts',
    'services/api/src/integrations/agentHost/codexTaskEvents.ts',
    'services/api/src/integrations/agentHost/codexTaskRuntime.ts',
    'services/api/src/agentHost.ts',
    'services/api/src/integrations/agentHost/agentHostConfig.ts',
    // Syzygy ADR-0008 stage 1 (抑制系): one content-free trace per decision, and the gateway wrapper that writes it.
    'services/api/src/contracts/decisionTraceContract.ts',
    'services/api/src/mind/inhibition/decisionTraces.ts',
    'services/api/src/mind/inhibition/store/sqliteDecisionTraces.ts',
    'services/api/src/mind/inhibition/tracedVoiceDecision.ts',
    // Syzygy ADR-0008 stage 1: the owner's controls of her value table on the server's command line.
    'services/api/scripts/shannon-values.ts',
  ]),
  activity_record: Object.freeze([
    'services/api/src/mind/inhibition/store/autonomyActivity.ts',
    'services/api/src/mind/inhibition/autonomyDayLog.ts',
  ]),
  response_path: Object.freeze([
    'services/api/src/server.ts',
    'services/api/src/infra/http/serverHttp.ts',
    'services/api/src/infra/http/apiKernel.ts',
    // Moved out of the kernel and the voice delegation for their size (Syzygy ADR-0008 §10), unchanged.
    'services/api/src/infra/http/apiTestFlightRoutes.ts',
    'services/api/src/surfaces/voice/voiceGrounding.ts',
    'services/api/src/surfaces/text/apiTextTurn.ts',
    'services/api/src/infra/http/apiValidation.ts',
    'services/api/src/surfaces/voice/apiLiveVoice.ts',
    'services/api/src/surfaces/voice/apiVoiceTurns.ts',
    'services/api/src/infra/models/chatModel.ts',
    'services/api/src/contracts/contracts.ts',
    'services/api/src/mind/action/respond/turnCognitiveContext.ts',
    'services/api/src/mind/recall/turnMemoryRecall.ts',
    'services/api/src/mind/action/respond/conversationOrchestration.ts',
    'services/api/src/mind/action/respond/conversationCommands.ts',
    'services/api/src/surfaces/voice/serverLiveVoiceStreamRoute.ts',
    'services/api/src/surfaces/text/chatSentenceStream.ts',
    'services/api/src/surfaces/text/chatSentenceSplitter.ts',
    'services/api/src/surfaces/text/serverChatSentenceStream.ts',
    'services/api/src/infra/models/chatModelTurn.ts',
    'services/api/src/infra/models/chatModelTools.ts',
    'services/api/src/infra/models/chatModelVoiceTools.ts',
    'services/api/src/mind/action/respond/turnDeadline.ts',
    'services/api/src/infra/models/chatModelStream.ts',
    'services/api/src/infra/models/chatModelVoiceStream.ts',
    'services/api/src/surfaces/voice/spokenSentences.ts',
    'services/api/src/infra/models/chatReplyStreamDecoder.ts',
    'services/api/src/surfaces/voice/serverGeminiLiveRoute.ts',
    'services/api/src/surfaces/voice/serverGeminiSpeechRoute.ts',
    // The reflex from a touch to her answer, and its one model call.
    'services/api/src/surfaces/body/bodyReaction.ts',
    'services/api/src/surfaces/body/bodyReactionModel.ts',
    // Her Minecraft body's game chat: who may speak as it, the gate and people it goes through, and its delivery note.
    'services/api/src/surfaces/minecraft/minecraftBody.ts',
    'services/api/src/contracts/minecraftBodyContract.ts',
    'services/api/src/surfaces/minecraft/minecraftIntent.ts',
    'services/api/src/surfaces/minecraft/minecraftBodyState.ts',
    'services/api/src/surfaces/minecraft/serverMinecraftBodyRoute.ts',
    // The platform surface both her Minecraft body and the platform reply route answer through, and that route.
    'services/api/src/surfaces/platform/platformSurface.ts',
    'services/api/src/surfaces/platform/platformReply.ts',
    'services/api/src/surfaces/platform/serverPlatformBridgeRoute.ts',
    // Syzygy ADR-0008 stage 1: the Jev client's call count and price.
    'services/api/src/infra/models/jev/',
    // Routes of her voice surface moved out of `server.ts` (Syzygy ADR-0008 §6, surfaces/voice).
    'services/api/src/surfaces/voice/transcriptionRoute.ts',
    // Syzygy ADR-0008 stage 1: the owner's view and controls of her value table.
    'services/api/src/infra/http/learningRoutes.ts',
    // Stage 2 (review scope gap): the owner's view and pins of her skills; the install's salt of the trace digests; the column
    // guards of stage 2's own tables.
    'services/api/src/infra/http/skillRoutes.ts',
    'services/api/src/wiring/installSalt.ts',
    'services/api/src/infra/sqlite/schemaColumns.ts',
    // Syzygy ADR-0008 stage 2: the difficulty policy. Listed by name, so it is the response path's, not emotion's
    // (`packages/learning/` is emotion's; a file listed by name wins over its directory).
    'packages/learning/src/difficultyPolicy.ts',
    // Syzygy ADR-0008 stage 2: the turn's Jev call (the tool menu), the session it narrows, and their wiring.
    'services/api/src/mind/selectors/toolMenu.ts',
    'services/api/src/mind/selectors/turnChoices.ts',
    'services/api/src/mind/tools/shannonToolMenu.ts',
    'services/api/src/wiring/skillRoutingWiring.ts',
    // Syzygy ADR-0008 stage 2, step 4: the tier of a turn, the verifier and its luna checker, the competence table, and the voice glue.
    'services/api/src/mind/action/respond/turnRouting.ts',
    'services/api/src/mind/selectors/turnVerifier.ts',
    'services/api/src/mind/selectors/selectorsPorts.ts',
    'services/api/src/mind/selectors/tierCompetence.ts',
    'services/api/src/mind/selectors/store/sqliteTierOutcomes.ts',
    'services/api/src/infra/models/turnChecker.ts',
    'services/api/src/contracts/turnRoutingContract.ts',
    'services/api/src/surfaces/voice/voiceStage2.ts',
    // Syzygy ADR-0008 stage 2, step 5: the Sonnet tier (the Anthropic adapter, its rounds and settings), the tiered model, its wiring.
    'services/api/src/infra/models/anthropic/',
    'services/api/src/infra/models/tieredChatModel.ts',
    'services/api/src/wiring/sonnetWiring.ts',
    // Syzygy ADR-0008 stage 3 (`docs/mind-workspace-contract.md`): perception, attention (the proactive gate among it) and the
    // workspace, every file below each, and the pure package of the stage. The memory outbox and its one writer are the memory
    // part's (`services/api/src/mind/memory/`, above), so they are memory's from their first file.
    'services/api/src/mind/perception/',
    'services/api/src/mind/attention/',
    'services/api/src/mind/workspace/',
    'packages/mind/',
    // Their wiring and the contract of the mind's inbox (what another process may hand the mind).
    'services/api/src/wiring/mindWiring.ts',
    'services/api/src/contracts/mindInboxContract.ts',
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
    'services/api/src/integrations/testflight/store/testflightDeliveryStore.ts',
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
 *
 * A file listed by name wins over a directory that contains it, and a deeper directory over a shallower one (Syzygy
 * ADR-0008 stage 2: `packages/learning/src/difficultyPolicy.ts` is the response path's although `packages/learning/` is
 * emotion's). So whether a path is core never changes; only a listed file inside another area's directory changes area.
 * `autonomyCore.test.ts` holds that every other file of the repository keeps the area the first listed entry gave it.
 */
export function coreAreaForRepositoryPath(path: string): CorePathMatch | null {
  const normalized = normalizedRepositoryPath(path)?.toLowerCase();
  if (!normalized) return null;
  let best: (CorePathMatch & { length: number }) | null = null;
  for (const [area, entries] of Object.entries(SHANNON_CORE_PATHS) as Array<[ShannonCoreAreaId, readonly string[]]>) {
    for (const entry of entries) {
      const candidate = entry.toLowerCase();
      if (!candidate.endsWith('/')) {
        if (normalized === candidate) return { area, entry };
        continue;
      }
      const matches = normalized === candidate.slice(0, -1) || normalized.startsWith(candidate);
      if (matches && (!best || candidate.length > best.length)) best = { area, entry, length: candidate.length };
    }
  }
  return best ? { area: best.area, entry: best.entry } : null;
}

export function allCorePaths(): readonly string[] {
  return Object.values(SHANNON_CORE_PATHS).flat();
}
