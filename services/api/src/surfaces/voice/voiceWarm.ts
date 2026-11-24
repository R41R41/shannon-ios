import { shannonIdentityPrompt } from '@shannon/cognition';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../infra/models/chatModel.js';
import { identityOnly } from '../../mind/memory/identityPrompt.js';
import { identifyTurn } from '../../mind/action/respond/conversationTurn.js';
import { feelingVoice } from '../../mind/emotion/feelingPorts.js';
import { voiceTurnStages } from './voiceConversation.js';
import { voiceConversationInstructions } from './voiceConversationInstructions.js';
import type { LiveVoiceDependencies } from './liveVoicePorts.js';

/**
 * The cache of a spoken reply, warmed before the first reply of a call (owner 2026-11-24: the first reply of a call took 7 s, the next ones
 * 3.5 s; the journal says the difference is the model's first token, and it appears only after the provider's one-hour cache has run out).
 *
 * What the first reply reads from the cache is everything before the words: the tools, the system (her identity, the voice's notes, the
 * fixed instructions) and the output format. This builds that part the way a seated voice turn builds it (`voiceConversation.ts`:
 * `identityAsk`, `basePromptOf`), asks the turn's own model for a few tokens with `warmOnly`, and so keeps nothing: no thread, no feeling
 * event, no memory, no scene note, no reply said. It reads her state and identity as any turn does and writes nothing of its own; the
 * request's usage is booked as any request's.
 *
 * The three audiences are three different systems (the owner alone, the owner with others, someone else speaking): a channel warms the ones
 * it may hear (`warmedAudiences`). The test `tests/voiceWarm.test.ts` holds this to a real seated turn's bytes.
 */
export type WarmAudience = 'owner_alone' | 'owner_others' | 'guest';

export interface VoiceWarmAsk {
  scopeKey: string;
  audience: WarmAudience;
  /** The structured reply carries her Minecraft body's field (a channel with the body connected, or the owner's way of speaking). */
  offerMinecraftIntent: boolean;
}

/**
 * The audiences a channel may hear. The owner's own turn is read as a shared one (`owner_others`) wherever the conversation is not bound `owner-private`
 * (the open conversation of the game's voice is not), even with nobody else in the room: `ownerPrivate === false` says so, and that is the one warmed,
 * not `owner_alone` (a warm-up of another system than the one the first reply is made with is read by nobody). Without the conversation known, the owner
 * alone in his room hears only the first; anyone else's presence adds the others.
 */
export function warmedAudiences(others: boolean, ownerPrivate?: boolean): WarmAudience[] {
  if (ownerPrivate === false) return others ? ['owner_others', 'guest'] : ['owner_others'];
  return others ? ['owner_others', 'guest'] : ['owner_alone'];
}

/** Her system for this audience, as `VoiceConversation` makes it for a platform's seat (an owner's turn, a guest's identity). */
function warmSystem(dependencies: LiveVoiceDependencies, ask: VoiceWarmAsk): string {
  const { scopeKey } = ask;
  const alone = ask.audience === 'owner_alone';
  const identity = identifyTurn(voiceTurnStages(dependencies), { scopeKey, projected: true, alone,
    parts: () => identityOnly(ask.audience === 'guest' ? shannonIdentityPrompt('guest') : shannonIdentityPrompt('owner', { othersPresent: !alone })) });
  // Her space's core takes the place of the v2 core by one fixed text (`spaceIdentity`), so the owner-alone key is read, never a scene's.
  const at = dependencies.now();
  const feeling = feelingVoice.start(dependencies.feeling, { scopeKey, alone: true, guest: false, threadId: 'warm', transcript: '', at,
    snapshot: dependencies.stateStore.snapshot(scopeKey), platform: { ownerAlone: true } });
  return feelingVoice.identity(feeling, [identity.identity, voiceConversationInstructions(true)].join('\n\n'));
}

/**
 * The request of a warm-up: a real reply's system and format, no history, no words of anyone's. It answers without thinking first, as a spoken
 * reply does (`skipThinking`): the provider reads nothing of a prefix written under another thinking setting (the live bench of 2026-11-24 read 0
 * of 14,734 written tokens when the warm-up thought `adaptive` and the reply `disabled`), so the usual reply's setting is the one warmed.
 */
export function voiceWarmRequest(dependencies: LiveVoiceDependencies, ask: VoiceWarmAsk): ShannonChatModelRequest {
  return { scopeKey: ask.scopeKey, systemPrompt: warmSystem(dependencies, ask), history: [], message: '（通話の準備。返事はいらない）',
    generateThreadTitle: false, spokenReply: true, warmOnly: true, skipThinking: true, ...(ask.offerMinecraftIntent ? { offerMinecraftIntent: true as const } : {}) };
}

/** Whether this model has a cache a warm-up can fill: only the Claude adapter reads `warmOnly`; any other would answer the request in full. */
export function warmable(model: ShannonChatModel): boolean {
  return model.mode === 'anthropic';
}

/**
 * Sends the warm-up through the turn's own model chain (the owner's model mode, the feeling wrapper), so the tier and thinking are the ones a
 * reply would have. Returns what the provider counted, or null for a model with nothing to warm.
 */
export async function warmVoiceReply(dependencies: LiveVoiceDependencies, ask: VoiceWarmAsk): Promise<ShannonChatModelResult['warmed'] | null> {
  const model = dependencies.chatModel.forTurn?.(ask.scopeKey) ?? dependencies.chatModel;
  if (!warmable(model)) return null;
  const request = voiceWarmRequest(dependencies, ask);
  const result = model.generateStreaming ? await model.generateStreaming(request, () => undefined) : await model.generate(request);
  return result.warmed ?? null;
}
