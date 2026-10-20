import {
  withStage5Capabilities, type CompanionStateSnapshot, type CompanionStateStore, type MemoryAudience, type ShannonStage5Capabilities,
} from '@shannon/cognition';
import { observeAsync, observedStep, observeSync } from '../../../infra/observer/observerContext.js';
import { prepareTurnCognitiveContext, type TurnCognitiveContext } from '../../workspace/contextPorts.js';
import { withWorkspace } from '../../workspace/workspacePorts.js';
import { conversationReplay, type TurnMemoryRecall } from '../../recall/recallPorts.js';
import { withCharacterCore, type InnerNotePort } from '../../emotion/innerNotePorts.js';
import type { LayeredIdentityPrompt } from '../../memory/identityPorts.js';
import type { ConversationStore, PeopleMemory } from '../../memory/memoryPorts.js';
import type { CognitiveIntentStore, extractExplicitUserIntent } from './cognitiveIntent.js';
import {
  NO_CAPABILITY_CONTEXT, conversationCapabilityContext, type ConversationCapabilityContext, type ConversationCapabilitySelection,
  type ConversationReadCapabilities,
} from './conversationCapabilities.js';
import { withoutGuardedEntries } from './apiTextTurn.js';
import type { TurnTiming } from '../../../infra/observer/turnTiming.js';

/**
 * One turn of her conversation, written or spoken, through one flow (one head, owner 2026-10-20: 「頭は 1 つ、入口は耳と口だけ」). The apps'
 * Talk, a platform's text and her game chat (`ShannonApiKernel.textTurn`, `textConversation.ts`), and the apps' voice and a Discord voice
 * channel (`apiLiveVoice.ts`, `voiceConversation.ts`), each a modality of this flow:
 *
 *   open → remember → (begin) → identify → read → compose → speak → close
 *
 * The middle is one implementation for both: what she remembers (`startTurnMemory`: the state, the people here, the deterministic context
 * and, when the modality asks for it, the semantic recall), who she is (`identifyTurn`: her identity's source, her character core, her
 * own-time wording and stage 5's lines), what she may read (`startTurnCapability`), and the prompt's last assembly (`turnReplay`,
 * `assembledTurn`). A modality decides what only it knows: who is there and whether to answer (a voice turn's router, a command), its
 * blocks and their order, how the model is asked (her plain spoken stream, or the structured reply), and what is answered and kept.
 */
type MaybePromise<T> = T | Promise<T>;

export interface ClosedTurn<R> { readonly closed: R }

export const closedTurn = <R>(answer: R): ClosedTurn<R> => ({ closed: answer });

export interface ConversationModality<R> {
  /** Who is there, whether she answers at all; a turn answered without the model (a command, silence, a duplicate) closes here. */
  open(): MaybePromise<ClosedTurn<R> | null>;
  memoryAsk(): TurnMemoryAsk;
  /** Right after the state is read: what starts beside recall (a text turn's feeling turn, perception and tool menu). */
  begin(memory: StartedTurnMemory): void;
  identityAsk(memory: StartedTurnMemory): TurnIdentityAsk;
  capabilityAsk(identity: LayeredIdentityPrompt): TurnCapabilityAsk | null;
  /** The prompt from what was remembered, who she is and what she read; a text command closes here (its answer shows the prompt). */
  compose(parts: TurnParts): MaybePromise<ClosedTurn<R> | null>;
  speak(): Promise<void>;
  close(): MaybePromise<R>;
  /** The turn failed after its work began (an FCA turn begun in `compose` is abandoned). */
  abandon(): void;
}

export interface TurnStageDependencies {
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  memoryRecall?: TurnMemoryRecall | null;
  innerNote?: InnerNotePort | null;
  autonomy?: { identityProjection(scopeKey: string, prompt: string): string } | null;
  stage5Capabilities?: ShannonStage5Capabilities;
}

/** The one flow. Without a semantic recall or an asynchronous read nothing is awaited between its stages (not even a tick). */
export async function runConversationTurn<R>(stages: TurnStageDependencies, turn: ConversationModality<R>): Promise<R> {
  const opening = turn.open();
  const opened = opening instanceof Promise ? await opening : opening;
  if (opened) return opened.closed;
  const memory = startTurnMemory(stages, turn.memoryAsk());
  turn.begin(memory);
  const { identity, pending } = observedStep('identity', () => {
    const who = identifyTurn(stages, turn.identityAsk(memory));
    return { identity: who, pending: startTurnCapability(turn.capabilityAsk(who)) };
  });
  const remembered = memory.semantic ? await settledTurnMemory(memory) : rememberedTurn(memory, null);
  const capability = pending instanceof Promise ? await pending : pending;
  const composing = turn.compose({ memory: remembered, identity, capability });
  const composed = composing instanceof Promise ? await composing : composing;
  if (composed) return composed.closed;
  try {
    await turn.speak();
    return await turn.close();
  } catch (error) {
    try { turn.abandon(); } catch { /* the error that failed the turn is the one thrown */ }
    throw error;
  }
}

// ── Remember ──────────────────────────────────────────────────────────────

type PeopleRecall = ReturnType<PeopleMemory['recall']>;
type RecalledContext = Awaited<ReturnType<TurnMemoryRecall['enrich']>>;

export interface TurnMemoryAsk {
  scopeKey: string;
  threadId: string;
  /** The words recall reads (a spoken turn's transcript, a typed turn's message). */
  message: string;
  occurredAt: string;
  channel: 'text' | 'voice';
  present: MemoryAudience;
  intents: ReturnType<CognitiveIntentStore['list']>;
  provisionalIntent: ReturnType<typeof extractExplicitUserIntent>;
  participants: readonly string[] | undefined;
  /** Only what may be shown to anyone (someone else's turn on a platform). */
  openOnly?: boolean;
  timeZone?: string | undefined;
  /** The people she remembers who are here, as this modality may give them (a 「友人も一緒」 call, a platform's room). */
  people(captured: CompanionStateSnapshot): PeopleRecall | undefined;
  /** The model-assisted recall, when this turn asks for it: its options and the bound it is waited for. */
  semantic: TurnSemanticAsk | null;
  timing?: TurnTiming;
  /** The observer's attributes of the deterministic and semantic spans (`surface` and what the modality knows). */
  surface: 'text' | 'voice' | 'platform';
}

export interface TurnSemanticAsk {
  options: { memoryTurn?: boolean; complexTurn?: boolean; voiceClass?: string; signal?: AbortSignal };
  span: Record<string, unknown>;
  bounded(work: Promise<RecalledContext>): Promise<RecalledContext | null>;
}

export interface StartedTurnMemory {
  captured: CompanionStateSnapshot;
  peopleRecall: PeopleRecall | undefined;
  deterministic: TurnCognitiveContext;
  semantic: Promise<RecalledContext | null> | null;
  startedAt: number;
  timing?: TurnTiming;
}

export interface RememberedTurn extends Omit<StartedTurnMemory, 'semantic'> {
  /** The model-assisted recall's context, or null when none ran or it was past its bound. */
  recalled: RecalledContext | null;
  /** What the turn uses: the recalled context, else the deterministic one. */
  cognitive: TurnCognitiveContext;
}

/** What she remembers: the state now (after anything a command changed), the people here, the deterministic context; recall started. */
export function startTurnMemory(stages: TurnStageDependencies, ask: TurnMemoryAsk): StartedTurnMemory {
  const startedAt = performance.now();
  return observeSync('recall', { strategy: 'deterministic', surface: ask.surface }, () => {
    const captured = observedStep('snapshot', () => stages.stateStore.snapshot(ask.scopeKey));
    const peopleRecall = observedStep('people', () => ask.people(captured));
    const deterministic = observedStep('deterministic', () => prepareTurnCognitiveContext(captured, stages.conversationStore, {
      scopeKey: ask.scopeKey, message: ask.message, occurredAt: ask.occurredAt, channel: ask.channel, threadId: ask.threadId, present: ask.present,
      intents: ask.intents, provisionalIntent: ask.provisionalIntent, additionalCandidates: peopleRecall?.candidates ?? [],
      ...(ask.timeZone ? { timeZone: ask.timeZone } : {}), ...(ask.openOnly ? { openOnly: true } : {}),
      ...(ask.participants ? { participants: [...ask.participants] } : {}),
    }));
    const semantic = ask.semantic && stages.memoryRecall ? semanticRecall(stages.memoryRecall, ask, ask.semantic, captured, deterministic) : null;
    return { captured, peopleRecall, deterministic, semantic, startedAt, ...(ask.timing ? { timing: ask.timing } : {}) };
  }, value => ({ snapshotVersion: value.captured.version, peopleCount: value.peopleRecall?.ids.length ?? 0,
    characterCount: value.deterministic.prompt.length }));
}

function semanticRecall(recall: TurnMemoryRecall, ask: TurnMemoryAsk, semantic: TurnSemanticAsk, captured: CompanionStateSnapshot,
  deterministic: TurnCognitiveContext): Promise<RecalledContext | null> {
  const work = observeAsync('recall', { strategy: 'semantic', surface: ask.surface, ...semantic.span }, () => recall.enrich(deterministic, {
    scopeKey: ask.scopeKey, message: ask.message, snapshot: captured, threadId: ask.threadId, ...semantic.options,
  }), value => ({ recalledCount: value.frame.recalledMemoryIDs.length, characterCount: value.prompt.length }));
  return semantic.bounded(work);
}

function rememberedTurn(memory: StartedTurnMemory, recalled: RecalledContext | null): RememberedTurn {
  const { semantic: _semantic, ...rest } = memory;
  memory.timing?.add('recall', performance.now() - memory.startedAt);
  return { ...rest, recalled, cognitive: recalled ?? memory.deterministic };
}

async function settledTurnMemory(memory: StartedTurnMemory): Promise<RememberedTurn> {
  return rememberedTurn(memory, await memory.semantic);
}

// ── Identify ──────────────────────────────────────────────────────────────

export interface TurnIdentityAsk {
  scopeKey: string;
  /** Her identity's source for this audience: the owner's profile, the slim identity, a guest's (the modality knows which). */
  parts(): LayeredIdentityPrompt;
  /** Her own-time wording and stage 5's lines (stage 5's only while the owner alone hears her); false: the identity as it is. */
  projected: boolean;
  alone: boolean;
}

/** Who she is this turn: the identity's source, her character core (`SHANNON_INNER_NOTE`), her own time's wording, stage 5's lines. */
export function identifyTurn(stages: TurnStageDependencies, ask: TurnIdentityAsk): LayeredIdentityPrompt {
  const identity = withCharacterCore(ask.parts(), stages.innerNote ?? null);
  if (!ask.projected) return identity;
  const projected = stages.autonomy?.identityProjection(ask.scopeKey, identity.identity) ?? identity.identity;
  return { ...identity, identity: withStage5Capabilities(projected, ask.alone ? stages.stage5Capabilities : undefined) };
}

// ── Read ──────────────────────────────────────────────────────────────────

export interface TurnCapabilityAsk {
  scopeKey: string;
  message: string;
  readers: ConversationReadCapabilities;
  /** What this audience may read; absent, every reader (conversationCapabilityContext's default). */
  selection: ConversationCapabilitySelection | undefined;
  /** The read sources' ids are kept for an FCA turn's provenance. */
  collectReadSources: boolean;
  /** An asynchronous read, bounded by the modality's stage bound. */
  bounded(work: Promise<ConversationCapabilityContext>): Promise<ConversationCapabilityContext>;
}

/** What she may read this turn (notes, tasks, Notion, his calendar, her outreach), started beside recall; a promise only when a read is. */
export function startTurnCapability(ask: TurnCapabilityAsk | null): ConversationCapabilityContext | Promise<ConversationCapabilityContext> {
  if (!ask) return NO_CAPABILITY_CONTEXT;
  const context = conversationCapabilityContext(ask.scopeKey, ask.message, ask.readers, ask.selection, ask.collectReadSources);
  if (!(context instanceof Promise)) return context;
  const bounded = ask.bounded(context);
  bounded.catch(() => {});
  return bounded;
}

// ── Assemble ──────────────────────────────────────────────────────────────

export interface TurnParts {
  memory: RememberedTurn;
  identity: LayeredIdentityPrompt;
  capability: ConversationCapabilityContext;
}

/** Memory text as this audience may read it: without 【機微 entries where nobody may release a protected line of the owner's. */
export function turnMemoryText(openOnly: boolean | undefined): (text: string | undefined | null) => string {
  return text => (openOnly ? withoutGuardedEntries(text ?? '') : text ?? '');
}

/** The turn's blocks, in the modality's order, joined; an empty block is left out. */
export function composedTurnContext(blocks: ReadonlyArray<string | undefined | null | false>): string {
  return blocks.filter(Boolean).join('\n\n');
}

export interface TurnReplayAsk {
  channel: 'text' | 'voice';
  captured: CompanionStateSnapshot;
  scopeKey: string;
  threadId: string;
  present: MemoryAudience;
  tools: Parameters<typeof conversationReplay>[7];
  openOnly?: boolean;
  at?: string;
}

/** Her conversation's replay: the thread by character budget, from after its last long silence, with the summary of what fell out. */
export function turnReplay(stages: TurnStageDependencies, ask: TurnReplayAsk) {
  return conversationReplay(ask.channel, ask.captured, stages.conversationStore, ask.scopeKey, ask.threadId, ask.present, undefined, ask.tools,
    ask.openOnly ?? false, ask.at);
}

/** The model's turn context and history: the replay of the turn's context, then the workspace's blocks, then her feeling turn's block. */
export function assembledTurn<T extends { turnContext?: string }>(replayed: T, workspace: string, feelingBlock: string): T {
  return withWorkspace(replayed, workspace, feelingBlock);
}
