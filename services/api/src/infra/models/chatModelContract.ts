/** The conversation model's contract: what a turn asks of a model and what it answers (Syzygy ADR-0008 stage 3, S3: moved unchanged out of `chatModel.ts`, which re-exports it). */
import type { ShannonModelToolSession, ShannonTierRequest } from './chatModelTools.js';
import type { PlaceSearchContext, ShannonPlace } from '../../integrations/places/placeDiscovery.js';
import type { ChatReplyFeeling } from '../../mind/emotion/chatReplyFeeling.js';
import type { MinecraftIntent } from '../../surfaces/minecraft/minecraftIntent.js';

export type ShannonChatMode = 'openai' | 'local-stub' | 'anthropic';

export interface ShannonConversationItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ShannonChatAttachment {
  name: string;
  mimeType: string;
  text: string;
}

/**
 * The prompt layers of a conversation request, by how often each changes (Syzygy ADR-0003 principle 4). `systemPrompt`
 * comes first and should not change within a Talk (her identity); `profilePrompt`, what she knows of the owner, follows
 * the fixed instructions of the adapter; `turnContext`, everything that changes from turn to turn (the shared state, time,
 * recall, people, focus, capabilities, work, audience, replay summary, tool trace), comes last. A caller with one fixed
 * prompt passes only `systemPrompt`.
 */
export interface ShannonPromptLayers {
  systemPrompt: string;
  profilePrompt?: string;
  turnContext?: string;
}

/**
 * What she said just before the owner's words, which he is answering (her reaction to a touch, `apiLiveVoice.ts`): sent
 * as her message directly before his, after the turn's context, never in the replayed history.
 */
export interface ShannonPrecedingReply {
  precedingReply?: string;
}

export interface ShannonChatModelRequest extends ShannonPromptLayers, ShannonPrecedingReply, ShannonTierRequest {
  generateThreadTitle?: boolean;
  priorThreadSummary?: string;
  scopeKey: string;
  history: readonly ShannonConversationItem[];
  message: string;
  attachments?: readonly ShannonChatAttachment[];
  useWebSearch?: boolean;
  /** The turn chooser selected the real read tool; do not accept a promise in place of its receipt. */
  requireWebSearch?: true;
  placeSearch?: PlaceSearchContext;
  /** The structured reply gets a `roomLook` field: she may choose one look at the room (`bodyLook.ts`). */
  offerRoomLook?: boolean;
  /** The structured reply gets a `feeling` field: she says what she feels in this reply and how strongly (`chatReplyFeeling.ts`). */
  offerReplyFeeling?: boolean;
  /** The structured reply gets an `appLook` field: she may choose one look through the camera of the owner's app (`appLook.ts`). */
  offerAppLook?: boolean;
  /** The structured reply gets a `minecraftIntent` field: in a game-chat turn of the owner she may ask her Minecraft body to do something (`minecraftBody.ts`). */
  offerMinecraftIntent?: boolean;
  /** Her registry tools for this turn (`chatModelTools.ts`); offered unless the turn forces a web search. */
  tools?: ShannonModelToolSession;
  /** The server withheld her tools because others may be present: she is told so in one line. */
  toolsWithheld?: true;
}

export interface ShannonVoiceModelRequest extends ShannonPromptLayers, ShannonPrecedingReply, ShannonTierRequest {
  scopeKey: string;
  history: readonly ShannonConversationItem[];
  message: string;
  useWebSearch: boolean;
  conversationClass: 'greeting' | 'direct' | 'skill_simple' | 'skill_complex';
  /** Her registry tools for this turn; offered unless the turn uses web search. */
  tools?: ShannonModelToolSession;
  toolsWithheld?: true;
}

export interface ShannonWebSource {
  title: string;
  url: string;
}

export interface ShannonGeneratedArtifact {
  name: string;
  mimeType: string;
  content: string;
  summary?: string;
}

export interface ShannonChatModelResult {
  /** The actual server-owned execution tier, independent of the provider shared by Haiku and Sonnet. */
  servedTier?: 'luna' | 'luna_plus' | 'sonnet';
  threadTitle?: string;
  threadSummary?: string;
  mode: ShannonChatMode;
  model: string;
  reply: string;
  webSources?: ShannonWebSource[];
  places?: ShannonPlace[];
  roomLook?: 'asked' | 'curious';
  /** The feeling she decided for this reply, only in a turn that offered the field. */
  replyFeeling?: ChatReplyFeeling;
  /** What she chose for the app's camera, as the structured reply carried it (`appLookContract.ts`). */
  appLook?: string;
  /** What she asked her Minecraft body to do, only in a turn that offered the field. */
  minecraftIntent?: MinecraftIntent;
  artifacts?: ShannonGeneratedArtifact[];
  taskProposal?: ShannonTaskProposal;
  taskDecision?: ShannonTaskDecision;
  intentPlan?: ShannonIntentPlan;
  /** A voice reply that reached its output limit; `reply` ends at its last complete sentence. */
  truncated?: boolean;
  /** A turn with her tools ran out of time: `reply` ends with her fixed line, and nothing may be added to it. */
  outOfTime?: true;
  /** Stage 2: the turn was escalated once (luna to `luna_plus`) at a round boundary. */
  escalated?: true;
}

export interface ShannonIntentPlan {
  nextStep: string;
  steps: readonly string[];
}

export type ShannonTaskDisposition = 'none' | 'clarify' | 'propose';

export interface ShannonTaskDecision {
  disposition: ShannonTaskDisposition;
  reason: string;
}

export interface ShannonTaskProposal {
  title: string;
  goal: string;
  hostHint?: string;
  projectHint?: string;
  risk?: string;
}

export interface ShannonChatModel {
  readonly mode: ShannonChatMode;
  readonly model: string;
  /** Query-only external read; used by the ordinary read tool, without the conversation's private context. */
  searchWeb?: import('./webSearch.js').WebSearchOperation;
  /** Capture a primary model once at admission, before recall/routing awaits. The returned view never rereads preferences. */
  forTurn?(scopeKey: string): ShannonChatModel;
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult>;
  /** `generate` with the reply reported while it is written. The pieces are a prefix of the returned `reply`. */
  generateStreaming?(
    request: ShannonChatModelRequest,
    onReplyText: (text: string) => void | Promise<void>,
  ): Promise<ShannonChatModelResult>;
  generateVoice?(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult>;
  generateVoiceStreaming?(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShannonChatModelResult>;
}
