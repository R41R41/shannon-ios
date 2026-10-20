import { createHash } from 'node:crypto';
import { SHANNON_OWNER_NAME, shannonIdentityPrompt, type CompanionClock } from '@shannon/cognition';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import { PlatformBridgeError, platformBridgeThreadId, type PlatformBridgeService } from '../../mind/memory/platformMemoryPorts.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { displayedVoiceText } from '../../infra/models/voiceAudioTags.js';
import { PLATFORM_VOICE_LIMITS, badRequest, bodyText, identifier, notBound, recordOf } from './platformVoiceRequest.js';
import { situationBlock, heardBlock } from './platformVoicePrompt.js';
import { VOICE_MOUTH_LIMITS } from './voiceMouth.js';
import { VOICE_ROOM_LIMITS, clipVoiceText, type HeardLine, type VoiceRooms } from './voiceRoom.js';

/**
 * What her mouth in a voice channel asks of the head besides the turn (dc-voice, 2026-10-20, `dc-speak-interface.md`): to keep what she
 * said by herself, or what was heard of a reply before someone talked over her (`said`), and to put event facts into her words
 * (`wording`). Both answer for a bound conversation only.
 */
export interface VoiceWordsDependencies {
  scopeKey: string;
  bridge: PlatformBridgeService;
  conversationStore: ConversationStore;
  chatModel: Pick<ShannonChatModel, 'generate'>;
  now: CompanionClock;
  rooms: VoiceRooms;
}

const WORDING_PER_MINUTE = 20;
const NOTHING_TO_SAY = /^[（(]?なし[）)]?[。.]?$/u;

const WORDING_INSTRUCTIONS = [
  '[Discordのボイスチャンネルで、自分から一言いう]',
  `いまボクは、${SHANNON_OWNER_NAME}と友だちがいるボイスチャンネルで、声で話している。次の出来事を見て、自分から一言いうなら、その一言だけを書く。`,
  '- 1文、長くても40字。声に出す自然な日本語。かぎかっこ・絵文字・見出しは使わない。',
  '- 出来事にある事実だけを言う。ないことは足さない。個人的なことや秘密には触れない。',
  '- 言うほどのことでなければ、「（なし）」とだけ書く。',
].join('\n');

export class VoiceWords {
  private readonly wordingTimes: number[] = [];

  constructor(private readonly dependencies: VoiceWordsDependencies) {}

  private bound(conversationId: string): void {
    if (!this.dependencies.bridge.bindingOf({ platform: 'discord', conversationId })) throw notBound();
  }

  /**
   * What she said by herself (a line from her mouth) or the part of a reply that was heard before someone spoke over her, kept in
   * the conversation as her own words, so that the next turn knows what was and was not said.
   */
  said(value: unknown): void {
    const body = recordOf(value);
    if (!identifier(body.conversationId, 240)) throw badRequest('conversationId is invalid.');
    if (!bodyText(body.text, 1_200)) throw badRequest('text is invalid.');
    if (body.source !== 'mouth' && body.source !== 'reply') throw badRequest('source is invalid.');
    if (typeof body.at !== 'string' || !Number.isFinite(Date.parse(body.at))) throw badRequest('at is invalid.');
    if (body.interrupted !== undefined && typeof body.interrupted !== 'boolean') throw badRequest('interrupted is invalid.');
    if (body.spokenText !== undefined && typeof body.spokenText !== 'string') throw badRequest('spokenText is invalid.');
    this.bound(body.conversationId);
    const content = this.kept(body.text, body.interrupted === true, typeof body.spokenText === 'string' ? body.spokenText : '');
    const at = new Date(Date.parse(body.at)).toISOString();
    const digest = createHash('sha256').update(`${body.conversationId}\u0000${at}\u0000${body.source}\u0000${content}`).digest('hex');
    this.note(body.conversationId, `dcv-said:${digest.slice(0, 32)}`, content);
  }

  private kept(text: string, interrupted: boolean, spokenText: string): string {
    const limit = PLATFORM_VOICE_LIMITS.replyCharacters;
    if (!interrupted) return displayedVoiceText(text).trim().slice(0, limit);
    const spoken = displayedVoiceText(spokenText).trim().slice(0, limit);
    const what = spoken ? `「${spoken}」までしか言えなかった` : '言えなかった';
    return `（直前の返事は、人に話をかぶせられて${what}）`;
  }

  private note(conversationId: string, id: string, content: string): void {
    const { scopeKey, conversationStore, now } = this.dependencies;
    try {
      conversationStore.appendNoteOnce?.(scopeKey, platformBridgeThreadId('discord', conversationId), id, content, now(), 'discord_voice_said', false);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'TASK_NOTE_CONFLICT') throw error;
    }
  }

  private admitWording(): void {
    const at = Date.parse(this.dependencies.now());
    while (this.wordingTimes.length && at - this.wordingTimes[0]! >= 60_000) this.wordingTimes.shift();
    if (this.wordingTimes.length >= WORDING_PER_MINUTE) {
      throw new PlatformBridgeError('RATE_LIMITED', 429, 'Too many wording requests; retry after a minute.');
    }
    this.wordingTimes.push(at);
  }

  private heardFrom(value: unknown): HeardLine[] {
    if (!Array.isArray(value)) return [];
    const lines: HeardLine[] = [];
    for (const line of value as Array<Partial<HeardLine> | null>) {
      const sound = line && identifier(line.userId, 160) && bodyText(line.name, 80) && bodyText(line.text, 600);
      if (sound && Number.isFinite(Date.parse(line.at as string))) lines.push(line as HeardLine);
    }
    return lines;
  }

  /** Event facts put into her words for a line from her mouth, or nothing when there is nothing worth saying (`{ say: false }`). */
  async wording(value: unknown): Promise<{ say: boolean; text?: string }> {
    const body = recordOf(value);
    if (!identifier(body.conversationId, 240)) throw badRequest('conversationId is invalid.');
    const facts = body.facts;
    const factsValid = Array.isArray(facts) && facts.length > 0 && facts.length <= VOICE_MOUTH_LIMITS.facts
      && facts.every(fact => bodyText(fact, VOICE_MOUTH_LIMITS.factCharacters));
    if (!factsValid) throw badRequest('facts is invalid.');
    if (!identifier(body.source, VOICE_MOUTH_LIMITS.sourceCharacters)) throw badRequest('source is invalid.');
    this.bound(body.conversationId);
    this.admitWording();
    const { rooms, scopeKey, chatModel } = this.dependencies;
    rooms.noteHeard(body.conversationId, this.heardFrom(body.heard));
    const situation = typeof body.situation === 'string' ? clipVoiceText(body.situation, VOICE_ROOM_LIMITS.situationCharacters)
      : rooms.situation(body.conversationId) ?? rooms.situation('default');
    const result = await chatModel.generate({
      scopeKey,
      systemPrompt: [shannonIdentityPrompt('guest'), WORDING_INSTRUCTIONS, situationBlock(situation, null), heardBlock(rooms.heard(body.conversationId))]
        .filter(Boolean).join('\n\n'),
      history: [],
      message: `出来事:\n${(facts as string[]).map(fact => `- ${fact}`).join('\n')}`,
    });
    const text = displayedVoiceText(result.reply).replace(/\s+/gu, ' ').trim();
    if (!text || NOTHING_TO_SAY.test(text)) return { say: false };
    return { say: true, text: clipVoiceText(text, VOICE_MOUTH_LIMITS.textCharacters) };
  }
}
