import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHANNON_CAPABILITIES, SHANNON_LIMITATIONS, isForgetCitedMemoriesCommand, shannonCapabilityPrompt,
  type ShannonCapabilityId,
} from '@shannon/cognition';
import { FileAetherContextReader } from '../src/aetherContext.js';
import { FileAetherProposalStore } from '../src/aetherProposal.js';
import { validatedChatAttachments } from '../src/apiValidation.js';
import { OpenAIResponsesChatModel } from '../src/chatModel.js';
import { GENERATED_ARTIFACT_INSTRUCTIONS, WEB_SEARCH_INSTRUCTIONS, agentTaskInstructions } from '../src/chatModelSupport.js';
import { executeConversationCommand } from '../src/conversationCommands.js';
import { prepareConversationOrganize } from '../src/conversationOrganize.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { isOrganizeCommand } from '../src/organizeSupport.js';
import { wantsPlaceDiscovery } from '../src/placeDiscovery.js';
import { distributeLatestInternalBuild } from '../src/testflightDistributor.js';
import { VOICE_SKILLS, mandatorySkillPatterns, type VoiceSkill } from '../src/voiceDecisionContract.js';
import { createConfiguredVoiceVisionGateway } from '../src/voiceVision.js';

const voiceSkill = (skill: VoiceSkill) => (VOICE_SKILLS as readonly string[]).includes(skill);
const exists = (...values: unknown[]) => values.every(value => typeof value === 'function');

/**
 * One code-path flag per capability named in the canonical description. The record is
 * keyed by `ShannonCapabilityId`, so describing a capability without adding a flag is a
 * type error, and a flag that stops being true fails here. A flag proves the path exists
 * in this build; it does not prove the production integration is configured.
 */
const capabilityEvidence: Record<ShannonCapabilityId, () => boolean> = {
  conversation: () => exists(OpenAIResponsesChatModel.prototype.generate,
    OpenAIResponsesChatModel.prototype.generateVoiceStreaming),
  memory_and_promises: () => voiceSkill('conversation_memory') && exists(executeConversationCommand)
    && isForgetCitedMemoriesCommand('それは忘れて'),
  web_search: () => voiceSkill('current_web') && WEB_SEARCH_INSTRUCTIONS.includes('Web検索が有効')
    && mandatorySkillPatterns.current_web!.test('今日の天気を調べて'),
  place_search: () => voiceSkill('place_discovery') && wantsPlaceDiscovery('近くのカフェを探して'),
  photo_understanding: () => exists(createConfiguredVoiceVisionGateway),
  text_attachments: () => validatedChatAttachments([{ name: 'memo.md', mimeType: 'text/markdown', text: '内容' }])?.length === 1
    && validatedChatAttachments(Array.from({ length: 5 }, (_, index) => (
      { name: `${index}.txt`, mimeType: 'text/plain', text: 'x' }))) === null
    && GENERATED_ARTIFACT_INSTRUCTIONS.includes('[生成物]'),
  aether_read: () => voiceSkill('aether_notes') && exists(FileAetherContextReader, FileAetherProposalStore),
  voyager_tasks: () => voiceSkill('voyager_tasks') && isOrganizeCommand('整理して') && exists(prepareConversationOrganize),
  agent_tasks: () => voiceSkill('agent_status') && agentTaskInstructions().includes('TestFlight')
    && exists(distributeLatestInternalBuild),
  initiative: () => exists(SQLiteInitiativeStore),
};

describe('Shannon capability description', () => {
  it('names only capabilities that have a code path in this build', () => {
    expect(Object.keys(capabilityEvidence).sort()).toEqual(SHANNON_CAPABILITIES.map(item => item.id).sort());
    for (const capability of SHANNON_CAPABILITIES) {
      expect(capabilityEvidence[capability.id](), `no code path for capability "${capability.id}"`).toBe(true);
    }
  });

  it('keeps the stated limitations true', () => {
    const limitations = new Set(SHANNON_LIMITATIONS.map(item => item.id));
    // PDFs and Office files are rejected by the only attachment validator.
    expect(limitations.has('binary_documents')).toBe(true);
    for (const mimeType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      expect(validatedChatAttachments([{ name: 'file', mimeType, text: 'x' }])).toBeNull();
    }
    // No calendar, mail, alarm, or media-generation integration exists in the API sources.
    const sourceDirectory = join(import.meta.dirname, '../src');
    const sources = readdirSync(sourceDirectory).filter(name => name.endsWith('.ts'))
      .map(name => readFileSync(join(sourceDirectory, name), 'utf8')).join('\n');
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
});
