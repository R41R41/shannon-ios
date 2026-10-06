import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_CAPABILITIES, SHANNON_CONDITIONAL_CAPABILITIES, SHANNON_MINECRAFT_BODY_CAPABILITY, withAetherAccessCapability, SHANNON_LIMITATIONS, SHANNON_ROOM_LOOK_RULES, SHANNON_TOUCH_FEELINGS, SHANNON_TOUCH_KINDS, isForgetCitedMemoriesCommand, shannonCapabilityPrompt, withAutonomyRunning,
  type ShannonCapabilityId,
  autonomyDomain,
} from '@shannon/cognition';
import { FileAetherContextReader } from '../src/integrations/aether/aetherContext.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { HostFolderDesk } from '../src/autonomyHostFolderDesk.js';
import { ShannonAutonomyLoop } from '../src/autonomyLoop.js';
import { prepareFolderCopy } from '../src/autonomyLoopFolderStep.js';
import { HttpAetherAccess, configuredAetherAccess } from '../src/integrations/aether/aetherAccess.js';
import { aetherExecutors } from '../src/mind/tools/shannonAetherTools.js';
import { folderExecutors, folderToolForHosts } from '../src/mind/tools/shannonFolderTools.js';
import { authorizeToolInput, gatedAether } from '../src/mind/inhibition/shannonToolGate.js';
import { StudyAether } from '../src/studyAether.js';
import { prepareRoomLook } from '../src/autonomyLoopLookStep.js';
import { preparePhoneCall } from '../src/autonomyLoopPhoneStep.js';
import { prepareReachOut } from '../src/autonomyLoopReachOutStep.js';
import { AUTONOMY_CALL_DOMAIN } from '../src/mind/inhibition/autonomyPolicy.js';
import { incomingCallsEnabled } from '../src/contracts/incomingCallContract.js';
import { IncomingCallRequests } from '../src/surfaces/outreach/incomingCallRequests.js';
import { IncomingCalls } from '../src/surfaces/outreach/incomingCalls.js';
import { APNsVoipPushSender } from '../src/surfaces/outreach/voipPushSender.js';
import { calendarIngestEnabled } from '../src/contracts/calendarContract.js';
import { dispatchCalendarRequest } from '../src/calendarRoutes.js';
import { OwnerUpcoming, asksAboutSchedule } from '../src/mind/memory/ownerUpcoming.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteUpcomingStore } from '../src/mind/memory/store/upcomingStore.js';
import { roomLookNotePrompt } from '../src/autonomyLoopPrompts.js';
import { BoundedPublicReader } from '../src/autonomyReader.js';
import { ShannonAutonomyService, createInMemoryAutonomyService } from '../src/autonomyService.js';
import { SQLiteStudyShowing } from '../src/autonomyShowing.js';
import { StudyStore } from '../src/studyStore.js';
import { HostFolderOperations } from '../src/hostFolderOperations.js';
import { prepareToolStep } from '../src/autonomyLoopToolStep.js';
import { ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import { asksAboutOwnThings, conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { offeredTools } from '../src/mind/tools/shannonTools.js';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import { minecraftExecutors, withMinecraftBodyLine } from '../src/mind/tools/shannonMinecraftTools.js';
import { FileAetherProposalStore } from '../src/integrations/aether/aetherProposal.js';
import { BodyLooks } from '../src/surfaces/body/bodyLook.js';
import { BodyReactions } from '../src/surfaces/body/bodyReaction.js';
import { OpenAIBodyReactionSpeaker } from '../src/surfaces/body/bodyReactionModel.js';
import { BodyTouches } from '../src/mind/emotion/bodyTouch.js';
import { ActivityRoomLooks } from '../src/surfaces/body/bodyLookActivity.js';
import { GeminiActivityRoomLookViewer } from '../src/surfaces/body/bodyLookActivityVision.js';
import { OpenAIRoomLookViewer, roomLookInstructions } from '../src/surfaces/body/bodyLookVision.js';
import { validatedChatAttachments } from '../src/apiValidation.js';
import { OpenAIResponsesChatModel } from '../src/chatModel.js';
import { GENERATED_ARTIFACT_INSTRUCTIONS, ROOM_LOOK_SCHEMA, WEB_SEARCH_INSTRUCTIONS, agentTaskInstructions } from '../src/chatModelSupport.js';
import { executeConversationCommand } from '../src/conversationCommands.js';
import { prepareConversationOrganize } from '../src/integrations/voyager/conversationOrganize.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { readNotionForActivity } from '../src/integrations/notion/notionAutonomousRead.js';
import { NOTION_READ_ENDPOINTS, notionReadOperation } from '../src/integrations/notion/notionClient.js';
import { asksAboutNotion, notionTurnProjection } from '../src/integrations/notion/notionConversation.js';
import { BoundedNotionSource, configuredNotionSource } from '../src/integrations/notion/notionSource.js';
import { isOrganizeCommand } from '../src/integrations/voyager/organizeSupport.js';
import { PeopleMemory } from '../src/mind/memory/peopleMemory.js';
import { establishedGuestName } from '../src/surfaces/voice/voiceGuestNames.js';
import { wantsPlaceDiscovery } from '../src/integrations/places/placeDiscovery.js';
import { distributeLatestInternalBuild } from '../src/testflightDistributor.js';
import { VOICE_SKILLS, mandatorySkillPatterns, type VoiceSkill } from '../src/contracts/voiceDecisionContract.js';
import { voiceLookTurn } from '../src/surfaces/voice/voiceAppLook.js';
import { asksForLookAloud, voiceRoomLookTurn } from '../src/surfaces/voice/voiceRoomLook.js';
import { dispatchAppLookRequest } from '../src/surfaces/body/apiAppLookRoutes.js';
import { AppLooks } from '../src/surfaces/body/appLook.js';
import { APP_LOOK_SCHEMA, configuredAppLook } from '../src/contracts/appLookContract.js';
import { appLookUnavailablePrompt } from '../src/surfaces/body/appLookLines.js';
import { ConversationLooks } from '../src/surfaces/body/conversationLooks.js';
import { createConfiguredVoiceVisionGateway } from '../src/surfaces/voice/voiceVision.js';
import { apiSourceFiles } from './support/sources.js';

const voiceSkill = (skill: VoiceSkill) => (VOICE_SKILLS as readonly string[]).includes(skill);
const exists = (...values: unknown[]) => values.every(value => typeof value === 'function');

/**
 * One code-path flag per capability named in the canonical description. The record is
 * keyed by `ShannonCapabilityId`, so describing a capability without adding a flag is a
 * type error, and a flag that stops being true fails here. A flag proves the path exists
 * in this build; it does not prove the production integration is configured.
 */
type ConditionalCapabilityId = typeof SHANNON_CONDITIONAL_CAPABILITIES[number]['id'];
// The fixed description and the lines the API adds while it has them (`SHANNON_CONDITIONAL_CAPABILITIES`) need the same evidence.
const capabilityEvidence: Record<ShannonCapabilityId | ConditionalCapabilityId, () => boolean> = {
  conversation: () => exists(OpenAIResponsesChatModel.prototype.generate,
    OpenAIResponsesChatModel.prototype.generateVoiceStreaming),
  memory_and_promises: () => voiceSkill('conversation_memory') && exists(executeConversationCommand)
    && isForgetCitedMemoriesCommand('それは忘れて'),
  people_memory: () => exists(PeopleMemory.prototype.rememberCall, PeopleMemory.prototype.recall, PeopleMemory.prototype.forgetPerson)
    && establishedGuestName('はじめまして、ミキと言います') === 'ミキ',
  web_search: () => voiceSkill('current_web') && WEB_SEARCH_INSTRUCTIONS.includes('Web検索が有効')
    && mandatorySkillPatterns.current_web!.test('今日の天気を調べて'),
  place_search: () => voiceSkill('place_discovery') && wantsPlaceDiscovery('近くのカフェを探して'),
  photo_understanding: () => exists(createConfiguredVoiceVisionGateway),
  // One look: the model chooses it in the structured reply, the body answers, and the frame is seen under the four rules.
  room_look: () => exists(BodyLooks.prototype.turn, BodyLooks.prototype.answer, OpenAIRoomLookViewer.prototype.see)
    && ROOM_LOOK_SCHEMA.enum.includes('asked') && SHANNON_ROOM_LOOK_RULES.every(rule => roomLookInstructions([]).includes(rule))
    // In a voice turn with the owner alone: the same look, chosen before the spoken reply.
    && exists(BodyLooks.prototype.voiceTurn, voiceRoomLookTurn) && asksForLookAloud('うん、じゃあ部屋を見て。')
    // In her own time: the loop step, the look it opens and waits for, the model call with her own key, under the same four rules.
    && exists(prepareRoomLook, ActivityRoomLooks.prototype.look, GeminiActivityRoomLookViewer.prototype.see)
    && SHANNON_ROOM_LOOK_RULES.every(rule => roomLookNotePrompt().system.includes(rule))
    && configuredAutonomy({}).maximumRoomLooksPerDay === Number.POSITIVE_INFINITY && configuredAutonomy({ SHANNON_AUTONOMY_MAX_ROOM_LOOKS: '30' }).maximumRoomLooksPerDay === 30 && configuredAutonomy({ SHANNON_AUTONOMY_MAX_ROOM_LOOKS: '0' }).maximumRoomLooksPerDay === 0,
  // One look through the app the turn came from: offered in a text turn, chosen before the reply in a voice turn, answered with one frame.
  app_look: () => exists(AppLooks.prototype.turn, AppLooks.prototype.answer, ConversationLooks.prototype.turn, voiceLookTurn, dispatchAppLookRequest)
    && APP_LOOK_SCHEMA.enum.includes('asked_back') && APP_LOOK_SCHEMA.enum.includes('curious_front')
    && roomLookInstructions([], { camera: 'back' }).includes('アプリ') && configuredAppLook({}).enabled && !configuredAppLook({ SHANNON_APP_LOOK: 'off' }).enabled
    && (['background', 'denied', 'switched_off'] as const).every(reason => appLookUnavailablePrompt(reason, 'ios').includes('見られない')),
  text_attachments: () => validatedChatAttachments([{ name: 'memo.md', mimeType: 'text/markdown', text: '内容' }])?.length === 1
    && validatedChatAttachments(Array.from({ length: 5 }, (_, index) => (
      { name: `${index}.txt`, mimeType: 'text/plain', text: 'x' }))) === null
    && GENERATED_ARTIFACT_INSTRUCTIONS.includes('[生成物]'),
  aether_read: () => voiceSkill('aether_notes') && exists(FileAetherContextReader, FileAetherProposalStore),
  // Read-only: the reader exists, the routing rule fires on the story's name, and no write request is on the allowlist.
  notion_read: () => exists(BoundedNotionSource.prototype.search, BoundedNotionSource.prototype.readPage,
    BoundedNotionSource.prototype.queryDatabase, notionTurnProjection, readNotionForActivity)
    && asksAboutNotion('ウサカテの伏線を見て') && !asksAboutNotion('おはよう')
    && configuredNotionSource({}).connected === false
    && NOTION_READ_ENDPOINTS.length === 6 && notionReadOperation('PATCH', '/v1/pages/44444444444444444444444444444444') === null,
  // Her study through the registry on every surface (owner decision 2026-10-05): every verb has a tool, deleting is soft and
  // restorable, and with anyone else present none of them is offered (only her Aether reading tools may be, inside her folder).
  own_study: () => exists(StudyStore.prototype.softDelete, StudyStore.prototype.restore, StudyStore.prototype.takeBack, StudyStore.prototype.search,
    ShannonToolRunner.prototype.call, prepareToolStep, conversationTools)
    && ['list', 'search', 'read', 'create', 'update', 'rename', 'move', 'delete', 'restore'].every(verb => (['text', 'voice', 'autonomy'] as const)
      .every(surface => offeredTools(surface, 'owner_alone').some(tool => tool.name === `study.${verb}`)))
    && (['text', 'voice'] as const).every(surface => offeredTools(surface, 'others').every(tool => tool.effect === 'read' && tool.name.startsWith('aether')))
    && createInMemoryAutonomyService(() => '2026-10-05T00:00:00.000Z').tools.offered('text', 'others').length === 0 && asksAboutOwnThings('書斎のメモ読んで'),
  // Her folder (contract v2): the tools queue operations for the bound device, which long-polls, carries them out and reports;
  // every overwrite and delete goes to the trash on the device. Without a registered device there is no folder
  // (the line says 「用意してくれている時」). In her own time she places copies with the same tools, and while her study is
  // Shannon's also with the v1 copy step (with Aether it is gone: stories live in Aether only, Syzygy ADR-0007 revised).
  // The owner's PC or Mac (A18 S1): a device learns its host from the binding route, two hosts are named in her tools, and a
  // device that reads only (the Mac app in S2) is never planned a copy. The line names both.
  own_folder: () => exists(folderExecutors, prepareFolderCopy, HostFolderDesk.prototype.enqueue, HostFolderDesk.prototype.claim, HostFolderDesk.prototype.report,
    HostFolderOperations.prototype.run, HostFolderOperations.prototype.claim, HostFolderOperations.prototype.report,
    HostFolderOperations.prototype.boundHostOf, HostFolderDesk.prototype.copyHosts, folderToolForHosts)
    && ['list', 'search', 'read', 'create', 'update', 'rename', 'move', 'delete'].every(verb => offeredTools('text', 'owner_alone').some(tool => tool.name === `folder.${verb}`))
    && offeredTools('autonomy', 'owner_alone').some(tool => tool.name === 'folder.create')
    && Object.keys(configuredAutonomy({}).places.hostDevices ?? {}).length === 0,
  // Phase 4 of her Minecraft body: the tool queues a request, the body claims it, reports progress and a result, and the
  // result reaches her turns with the owner. Only in a conversation with the owner alone (never in her own time, never with others),
  // and the runner offers it only while the configured body is claiming (the line says 「入っている時」). The line itself is
  // conditional: it is in the owner's description only while the configured body is in the game (`withMinecraftBodyLine`).
  minecraft_body: () => exists(MinecraftBodyRequests.prototype.enqueue, MinecraftBodyRequests.prototype.claim, MinecraftBodyRequests.prototype.report,
    MinecraftBodyRequests.prototype.promptBlock, minecraftExecutors)
    && offeredTools('text', 'owner_alone').some(tool => tool.name === 'minecraft.request')
    && !offeredTools('autonomy', 'owner_alone').some(tool => tool.domain === 'minecraft_body') && offeredTools('text', 'others').every(tool => tool.domain !== 'minecraft_body')
    && createInMemoryAutonomyService(() => '2026-10-05T00:00:00.000Z').tools.offered('text', 'owner_alone', 'owner').every(tool => tool.domain !== 'minecraft_body'),
  voyager_tasks: () => voiceSkill('voyager_tasks') && isOrganizeCommand('整理して') && exists(prepareConversationOrganize),
  agent_tasks: () => voiceSkill('agent_status') && agentTaskInstructions().includes('TestFlight')
    && exists(distributeLatestInternalBuild),
  // Read-only: a device sends a bounded snapshot, and the one projection gives it to a turn that asks about the schedule. Nothing writes a calendar.
  calendar_read: () => exists(dispatchCalendarRequest, SQLiteUpcomingStore.prototype.replaceCalendar, OwnerUpcoming.prototype.promptFor)
    && asksAboutSchedule('今日の予定は？') && !asksAboutSchedule('おはよう') && calendarIngestEnabled({}) && !calendarIngestEnabled({ SHANNON_CALENDAR_INGEST: 'off' })
    && !Object.getOwnPropertyNames(SQLiteUpcomingStore.prototype).some(name => /event(?:Create|Update|Write)/iu.test(name)),
  // The day's one topic or due promise, and, from her own activity, messages of her own with no count a day (0 switches them off).
  // A touch reaches her feeling and memory through one entrance, and she may answer it with one line.
  body_touch: () => exists(BodyTouches.prototype.observe, BodyReactions.prototype.react, OpenAIBodyReactionSpeaker.prototype.decide)
    && SHANNON_TOUCH_KINDS.every(kind => SHANNON_TOUCH_FEELINGS[kind].steps.length > 0),
  initiative: () => exists(SQLiteInitiativeStore, prepareReachOut, SQLiteReachOutSpeaker.prototype.say)
    && configuredAutonomy({}).maximumReachOutsPerDay === Number.POSITIVE_INFINITY && configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: '0' }).maximumReachOutsPerDay === 0,
  // Her own step in her own time: the gated step, the request the API process sends, and the push that rings. Only while he switched it on.
  // Aether as her place (Syzygy ADR-0007 revised): the client, the gate that holds others-present reading to her folder, the
  // executors, her study in Aether, and the proposal inbox. Only while Aether is configured (the line is conditional).
  aether_access: () => exists(HttpAetherAccess.prototype.search, HttpAetherAccess.prototype.read, HttpAetherAccess.prototype.update,
    gatedAether, authorizeToolInput, aetherExecutors, StudyAether.prototype.sync, FileAetherProposalStore)
    && configuredAetherAccess({}) === null
    && ['search', 'read'].every(verb => offeredTools('text', 'others').some(tool => tool.name === `aether.${verb}`))
    && ['list', 'create', 'update', 'delete'].every(verb => offeredTools('text', 'owner_alone').some(tool => tool.name === `aetherFolder.${verb}`))
    && offeredTools('text', 'owner_alone').some(tool => tool.name === 'aether.propose') && !offeredTools('autonomy', 'owner_alone').some(tool => tool.name === 'aether.propose')
    && !shannonCapabilityPrompt('owner').includes(SHANNON_AETHER_ACCESS_CAPABILITY.text)
    && withAetherAccessCapability(shannonCapabilityPrompt('owner')).includes(SHANNON_AETHER_ACCESS_CAPABILITY.text),
  phone_call: () => exists(preparePhoneCall, IncomingCallRequests.prototype.request, IncomingCalls.prototype.tick, APNsVoipPushSender.prototype.send)
    && autonomyDomain(AUTONOMY_CALL_DOMAIN)?.rule === 'free' && incomingCallsEnabled({}) && !incomingCallsEnabled({ SHANNON_INCOMING_CALLS: 'off' }),
};

describe('Shannon capability description', () => {
  it('names only capabilities that have a code path in this build', () => {
    expect(Object.keys(capabilityEvidence).sort()).toEqual([...SHANNON_CAPABILITIES, ...SHANNON_CONDITIONAL_CAPABILITIES].map(item => item.id).sort());
    for (const capability of [...SHANNON_CAPABILITIES, ...SHANNON_CONDITIONAL_CAPABILITIES]) {
      expect(capabilityEvidence[capability.id](), `no code path for capability "${capability.id}"`).toBe(true);
    }
  });

  it('says what her Minecraft body can do only while the configured body is in the game, and nowhere else', () => {
    const line = `- ${SHANNON_MINECRAFT_BODY_CAPABILITY.text}`;
    const owner = shannonCapabilityPrompt('owner');
    // The fixed description (and so every recorded prompt hash and length limit) never has it.
    expect(owner).not.toContain(SHANNON_MINECRAFT_BODY_CAPABILITY.text);
    expect((SHANNON_CAPABILITIES as readonly { id: string }[]).some(item => item.id === SHANNON_MINECRAFT_BODY_CAPABILITY.id)).toBe(false);
    // No body, a body that is away, or a reader that fails: the prompt is exactly what it is without one.
    expect(withMinecraftBodyLine(null, 'owner', owner)).toBe(owner);
    expect(withMinecraftBodyLine({ present: () => false }, 'owner', owner)).toBe(owner);
    expect(withMinecraftBodyLine({ present: () => { throw new Error('locked'); } }, 'owner', owner)).toBe(owner);
    // In the game: one line, right after her folder's, and adding it twice changes nothing.
    const present = withMinecraftBodyLine({ present: scopeKey => scopeKey === 'owner' }, 'owner', owner);
    expect(present.split('\n').filter(item => item === line)).toHaveLength(1);
    expect(present.replace(`${line}\n`, '')).toBe(owner);
    expect(withMinecraftBodyLine({ present: () => true }, 'owner', present)).toBe(present);
    // A guest's description has no owner capabilities, and gets no Minecraft line either.
    expect(withMinecraftBodyLine({ present: () => true }, 'owner', shannonCapabilityPrompt('guest'))).toBe(shannonCapabilityPrompt('guest'));
  });

  it('keeps the stated limitations true', () => {
    const limitations = new Set(SHANNON_LIMITATIONS.map(item => item.id));
    // PDFs and Office files are rejected by the only attachment validator.
    expect(limitations.has('binary_documents')).toBe(true);
    for (const mimeType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      expect(validatedChatAttachments([{ name: 'file', mimeType, text: 'x' }])).toBeNull();
    }
    // No mail, alarm, or media-generation integration exists in the API sources, and no calendar is reached from the server:
    // the apps send a snapshot of upcoming events (`calendar_read`); nothing here reads or writes a calendar service.
    const files = apiSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(300);
    const sources = files.map(path => readFileSync(path, 'utf8')).join('\n');
    expect(limitations.has('media_generation')).toBe(true);
    expect(sources).not.toMatch(/image_generation|images\/generations|video_generation/u);
    expect(limitations.has('calendar_mail')).toBe(true);
    expect(sources).not.toMatch(/EventKit|caldav|icalendar|smtp|sendmail|nodemailer/iu);
    // Not machine-checked: commitment reminders go through the throttled initiative loop,
    // approvals stay explicit, and no speaker identification exists. Reviewed by hand.
    for (const id of ['exact_time_alarm', 'owner_content_write', 'speaker_identification'] as const) {
      expect(limitations.has(id)).toBe(true);
    }
  });

  it('is the same text for text chat and voice, and smaller for guests', () => {
    const owner = shannonCapabilityPrompt('owner');
    expect(owner).toBe(shannonCapabilityPrompt());
    expect(shannonCapabilityPrompt('guest').length).toBeLessThan(owner.length);
  });

  it('says she is active on her own only in the wording used while the activity loop runs, and has a code path for each verb', () => {
    // The static description never claims it; `ShannonAutonomyService.identityProjection` swaps the line only while the loop is running.
    expect(shannonCapabilityPrompt('owner')).toContain('仕組みは準備中');
    const running = withAutonomyRunning(shannonCapabilityPrompt('owner'));
    expect(running).toContain('いまは調べて、書斎にメモと物語を書き、見せている。');
    // 調べて: the bounded public reader. 書斎にメモと物語を書き: the study store. 見せている: the initiative path. All driven by the loop.
    expect(exists(ShannonAutonomyLoop.prototype.tick, BoundedPublicReader.prototype.read, StudyStore.prototype.create,
      StudyStore.prototype.revise, SQLiteStudyShowing.prototype.tell, ShannonAutonomyService.prototype.identityProjection)).toBe(true);
  });
});
