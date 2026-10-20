import type { CompanionClock, CompanionStateStore, ShannonStage5Capabilities } from '@shannon/cognition';
import type { AgentTaskStore } from '../../mind/action/agentTasks/agentTaskStore.js';
import type { ConversationStore, KnowledgeStore, PersonIdentityStore } from '../../mind/memory/memoryPorts.js';
import type { DailyMindReader } from '../../mind/action/respond/dailyMind.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import type { VoiceDecisionGateway } from '../../mind/selectors/voiceDecision.js';
import type { TurnMemoryRecall } from '../../mind/recall/turnMemoryRecall.js';
import type { ConversationCommandDependencies } from '../../mind/action/respond/conversationCommands.js';
import type { CognitiveIntentStore } from '../../mind/action/respond/cognitiveIntent.js';
import type { ConversationReadCapabilities } from '../../mind/action/respond/conversationCapabilities.js';
import type { LiveBodyReader } from '../../mind/action/respond/apiTextTurn.js';
import type { ConversationOrchestrationStore } from '../../mind/action/respond/conversationOrchestration.js';
import type { InnerNotePort } from '../../mind/emotion/companionPresence.js';
import type { FeelingPort } from '../../mind/emotion/feelingPorts.js';
import type { PeopleMemory } from '../../mind/memory/peopleMemory.js';
import type { VoiceLooks } from './voiceAppLook.js';
import type { ShannonToolRunner } from '../../mind/tools/shannonToolRunner.js';
import type { ConversationToolServer, SkillTurnPorts, ToolMenuChooser } from '../../mind/tools/shannonToolSession.js';
import type { FeedbackPorts } from '../../contracts/feedbackContract.js';
import type { TurnRouting } from '../../mind/action/respond/turnRouting.js';
import type { OwnerCalls } from '../../mind/perception/ownerCallElsewhere.js';
import type { MindTurnPorts } from '../../mind/workspace/workspacePorts.js';
import type { FcaVoicePort } from '../../mind/action/fca/fcaVoicePorts.js';
import type { AckStream } from './voiceResearchTurn.js';
import type { TurnTiming } from '../../infra/observer/turnTiming.js';
import type { VoiceSeat } from './voiceSeat.js';

/**
 * What the one voice turn (`apiLiveVoice.ts`) is handed, and what it tells the stream that speaks it. Moved out of `apiLiveVoice.ts`
 * unchanged (2026-10-20, one head: the 500-line ceiling), with the platform's seat added.
 */
export interface LiveVoiceDependencies extends ConversationReadCapabilities, ConversationCommandDependencies {
  /** Looking through her body's camera or the app's (`voiceAppLook.ts`); absent, a voice turn never looks. */
  looks?: VoiceLooks; innerNote?: InnerNotePort; // Syzygy ADR-0012 (SHANNON_INNER_NOTE): her inner note; absent, every prompt as before.
  feeling?: FeelingPort; // Syzygy ADR-0013 (SHANNON_FEELING_EVENTS): her feeling events and turn; absent, every prompt as before.
  personIdentities?: PersonIdentityStore;
  chatModel: ShannonChatModel; auxiliaryChatModel?: ShannonChatModel;
  voiceDecision: VoiceDecisionGateway;
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  /** Her own pursuits and work, and the autonomy wording of the identity block. */
  autonomy?: { pursuitPrompt(scopeKey: string): string; identityProjection(scopeKey: string, prompt: string): string; tools?: ShannonToolRunner };
  agentTasks: AgentTaskStore;
  now: CompanionClock;
  cognitiveIntents: CognitiveIntentStore;
  conversationOrchestration: ConversationOrchestrationStore;
  memoryRecall?: TurnMemoryRecall | null;
  people?: PeopleMemory;
  reactions?: { link(scopeKey: string, reactionId: unknown): { text: string; threadId: string | null } | null; // Her line from a touch, for the turn
    voiceTouchContext?: import('../../contracts/bodyReactionContract.js').VoiceTouchContext }; // and what a turn is told of her body.
  /** Others present as the server knows them, and what her writes must not repeat; absent, no tool is offered. */
  toolServer?: ConversationToolServer;
  ownerCalls?: Pick<OwnerCalls, 'admitTurn'>; // The owner in a call on another device (`ownerCallElsewhere.ts`); absent, nothing is refused.
  turnChooser?: ToolMenuChooser; toolHints?: true; turnRouting?: TurnRouting; skills?: Pick<SkillTurnPorts, 'index'>; feedback?: FeedbackPorts;
  stage5Capabilities?: ShannonStage5Capabilities;
  /** Syzygy ADR-0008 stage 3: what the turn hands the mind (`voicePerception` copies `present`); absent, nothing is perceived. */
  mind?: MindTurnPorts;
  fcaVoice?: () => FcaVoicePort | null; deviceId?: string; minecraftLive?: LiveBodyReader | null; // dc-live: her body in the game.
  /** One head: a platform's seat (a Discord voice channel, `VoiceSeat`); absent, the seat is the paired device's, as it always was. */
  seat?: VoiceSeat;
}

export interface LiveVoiceStreamObserver extends Pick<AckStream, 'flushSpoken'> {
  readonly signal?: AbortSignal;
  readonly timing?: TurnTiming; // The stream's own timing line (`turnTiming.ts`); absent, the delegation writes one itself.
  onPlan(plan: Record<string, unknown>): void | Promise<void>;
  onTextDelta(delta: string): void | Promise<void>;
  /** Whether the plan's waiting phrase has been heard yet (the stream route says it only after a silence); absent, it was said with the plan. */
  waitingSaid?(): boolean;
}
