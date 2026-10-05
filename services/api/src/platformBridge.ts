import { createHash } from 'node:crypto';
import {
  OWNER_AUDIENCE,
  buildCompanionStatePrompt,
  groupAudience,
  type CompanionClock,
  type CompanionStateStore,
  type MemoryAudience,
} from '@shannon/cognition';
import { resolveReplyEmotion } from './companionPresence.js';
import { DisclosureGate, sharedProfilePrompt } from './memoryDisclosure.js';
import {
  platformConversationLabel, platformPeopleEnabled,
  type PlatformConversationKind, type PlatformPeople, type PlatformSourceKind,
} from './platformPeople.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import { platformImpressionLines } from './impressionRecall.js';
import { bindingFor, composedPlatformBridgeConfiguration, sharedAudienceHeader } from './platformBridgeBindings.js';

export const SHANNON_PLATFORM_TURN_PATH = '/v1/platform/turns';
export const SHANNON_PLATFORM_CONTEXT_PATH = '/v1/platform/context';

const platforms = ['discord', 'line', 'minecraft', 'x', 'youtube'] as const;
export type ShannonPlatform = typeof platforms[number];

export interface PlatformBridgeBinding {
  platform: ShannonPlatform;
  conversationId?: string;
  conversationIdPrefix?: string;
  ownerUserId: string;
  title: string;
  /** Server-configured only. Missing/unknown audiences never receive owner memory. */
  audience?: 'shared' | 'owner-private';
}

export interface PlatformBridgeConfiguration {
  token: string;
  scopeKey: string;
  bindings: ReadonlyMap<string, PlatformBridgeBinding>;
  prefixBindings: readonly PlatformBridgeBinding[];
}

export interface PlatformTurnRequest {
  platform: ShannonPlatform;
  requestId: string;
  conversationId: string;
  sourceUserId: string;
  userMessage: string;
  shannonReply: string;
  observedAt: string;
  /** Present only on a turn written by someone other than the owner. */
  sourceDisplayName?: string;
  conversationKind?: PlatformConversationKind;
  sourceKind?: PlatformSourceKind;
}

export interface PlatformTurnResponse {
  duplicate: boolean;
  threadId: string;
  /** The stored turn. Empty when the message was received and deliberately not stored. */
  experienceId: string;
  /** Why a non-owner message was not stored: `bot`, `system`, `conversation_cap`, `daily_cap`, `forgotten_person`. */
  ignored?: string;
  /** The person a non-owner message was attributed to. */
  personId?: string;
}

export interface PlatformContextResponse {
  schemaVersion: 1;
  stateVersion: number;
  updatedAt: string;
  projection: string;
}

/** What `PlatformBridgeService.audiencePolicy` decides for one conversation and speaker. */
export interface PlatformAudiencePolicy {
  binding: PlatformBridgeBinding;
  threadId: string;
  /** The verified owner wrote the message. */
  ownerWrote: boolean;
  /** Who can read the reply. */
  present: MemoryAudience;
  /** False in a friend's DM: the owner is not there to release a protected line. */
  ownerPresent: boolean;
  gate: DisclosureGate;
  snapshot: ReturnType<CompanionStateStore['snapshot']>;
  /** What she remembers of the people here, and her impressions of them, as this audience may read them. */
  peopleLines: readonly string[];
  impressionLines: readonly string[];
}

export class PlatformBridgeError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'PLATFORM_CONVERSATION_DENIED' | 'PLATFORM_ACTOR_DENIED' | 'PLATFORM_TURN_CONFLICT'
      | 'PLATFORM_PEOPLE_DISABLED' | 'RATE_LIMITED',
    readonly status: 400 | 403 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformBridgeError';
  }
}

export class PlatformBridgeService {
  constructor(
    private readonly configuration: PlatformBridgeConfiguration,
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly background: TurnBackgroundService,
    private readonly now: CompanionClock,
    /** People met on platforms. Without it, and while the kill switch is off, only the owner's turns are accepted. */
    private readonly people: PlatformPeople | null = null,
    private readonly peopleEnabled: () => boolean = () => platformPeopleEnabled(),
  ) {}

  private readonly recentPeopleTurns: number[] = [];

  ingest(value: unknown): PlatformTurnResponse {
    const request = validatedPlatformTurn(value, this.now());
    const binding = this.boundConversation(request);
    if (request.sourceUserId !== binding.ownerUserId) return this.ingestPersonTurn(request, binding);

    const threadId = platformBridgeThreadId(request.platform, request.conversationId);
    const capturedState = this.stateStore.snapshot(this.configuration.scopeKey);
    const { messageEmotion } = resolveReplyEmotion({
      snapshot: capturedState, userMessage: request.userMessage, reply: request.shannonReply, now: request.observedAt,
    });
    const completedTurn = {
      scopeKey: this.configuration.scopeKey,
      threadId,
      capturedState,
      userMessage: request.userMessage,
      shannonReply: request.shannonReply,
      messageEmotion,
      completedAt: request.observedAt,
      // Everyone in that conversation saw it; the verified owner wrote the user side.
      audience: platformAudience(binding, request),
      speaker: 'owner' as const,
    };
    let persisted;
    try {
      persisted = this.conversationStore.ingestPlatformTurn({
        ...completedTurn,
        platform: request.platform,
        requestId: request.requestId,
        payloadHash: platformTurnPayloadHash(request),
        observedAt: request.observedAt,
        context: {
          threadTitle: binding.title,
          messageEmotion,
          capturedStateVersion: capturedState.version,
          audience: completedTurn.audience,
          speaker: completedTurn.speaker,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') {
        throw new PlatformBridgeError(
          'PLATFORM_TURN_CONFLICT',
          409,
          'The requestId was already used for different platform turn content.',
        );
      }
      throw error;
    }
    if (!persisted.duplicate) this.background.schedule(completedTurn, persisted.experience.id);
    return {
      duplicate: persisted.duplicate,
      threadId,
      experienceId: persisted.experience.id,
    };
  }

  /**
   * A message written by someone other than the owner. It is attributed to the person behind the platform
   * account and kept as person memory with the conversation as its audience; nothing reaches the owner's
   * threads, experience log, profile, promises or goals.
   */
  private ingestPersonTurn(request: PlatformTurnRequest, binding: PlatformBridgeBinding): PlatformTurnResponse {
    const threadId = platformBridgeThreadId(request.platform, request.conversationId);
    // Without the new fields this is the request shape that has always been refused.
    if (!request.conversationKind || !request.sourceDisplayName || platformAudience(binding, request).kind === 'owner') throw actorDenied();
    if (!this.people || !this.peopleEnabled()) {
      throw new PlatformBridgeError('PLATFORM_PEOPLE_DISABLED', 403, 'Turns from people other than the owner are not being accepted.');
    }
    const now = Date.parse(this.now());
    while (this.recentPeopleTurns.length && now - this.recentPeopleTurns[0]! >= 60_000) this.recentPeopleTurns.shift();
    if (this.recentPeopleTurns.length >= PEOPLE_TURNS_PER_MINUTE) {
      throw new PlatformBridgeError('RATE_LIMITED', 429, 'Too many turns from people other than the owner. Retry after a minute.');
    }
    this.recentPeopleTurns.push(now);
    try {
      const result = this.people.ingest(this.configuration.scopeKey, {
        platform: request.platform, requestId: request.requestId, payloadHash: platformTurnPayloadHash(request), threadKey: threadId,
        label: platformConversationLabel(request.platform, binding.title), conversationKind: request.conversationKind,
        sourceUserId: request.sourceUserId, sourceDisplayName: request.sourceDisplayName, sourceKind: request.sourceKind ?? 'person',
        message: request.userMessage, shannonReply: request.shannonReply, observedAt: request.observedAt,
      });
      return { duplicate: result.duplicate, threadId, experienceId: result.itemId,
        ...(result.outcome === 'stored' ? {} : { ignored: result.outcome }), ...(result.personId ? { personId: result.personId } : {}) };
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') {
        throw new PlatformBridgeError('PLATFORM_TURN_CONFLICT', 409, 'The requestId was already used for different platform turn content.');
      }
      throw error;
    }
  }

  context(value: unknown): PlatformContextResponse {
    const policy = this.audiencePolicy(value);
    const { gate, snapshot } = policy;
    // A conversation other people can read: items that must not reach a model are removed, protected ones are
    // marked, and the projection carries the check to make before saying them.
    const projection = gate.ownerOnly
      ? buildCompanionStatePrompt(snapshot, { maximumCharacters: 2_400 })
      : [sharedAudienceHeader(policy.ownerWrote), ...policy.peopleLines, ...policy.impressionLines, sharedProfilePrompt(gate, 16, !policy.ownerPresent)].join('\n').slice(0, 2_400);
    return Object.freeze({
      schemaVersion: 1 as const,
      stateVersion: gate.ownerOnly ? snapshot.version : 0,
      updatedAt: gate.ownerOnly ? snapshot.updatedAt : this.now(),
      projection,
    });
  }

  /**
   * Who is present in a bound conversation and what she knows of the people there: the one policy behind `context`,
   * also used by her Minecraft body's turn through the conversation kernel (`platformSurface.ts`). Refuses as
   * `context` does.
   */
  audiencePolicy(value: unknown): PlatformAudiencePolicy {
    const request = validatedPlatformContext(value);
    const binding = this.boundConversation(request);
    const scopeKey = this.configuration.scopeKey;
    const snapshot = this.stateStore.snapshot(scopeKey);
    const ownerWrote = request.sourceUserId === binding.ownerUserId;
    const friend = ownerWrote ? null : this.people && this.peopleEnabled() && request.conversationKind
      ? this.people.person(scopeKey, request.platform, request.sourceUserId) : null;
    if (!ownerWrote && (!request.conversationKind || !this.people || !this.peopleEnabled())) throw actorDenied();
    const threadId = platformBridgeThreadId(request.platform, request.conversationId);
    // A DM with a friend is that friend alone; any other conversation is one audience as a whole.
    const present = ownerWrote ? platformAudience(binding, request) : this.people!.audience(request.conversationKind!, threadId, friend?.id);
    // The owner's private conversation is never projected for anyone else.
    if (!ownerWrote && platformAudience(binding, request).kind === 'owner') throw actorDenied();
    const gate = new DisclosureGate(present, snapshot, this.conversationStore, scopeKey);
    // Owner decision 2026-10-06 (S6): a turn anyone else wrote, in a DM or a shared conversation, is given only what may
    // be shown to anyone; nobody but the owner himself releases a protected line, so none is given.
    const ownerPresent = ownerWrote;
    const userIds = [...new Set([...(ownerWrote ? [] : [request.sourceUserId]), ...(request.participants ?? [])])]
      .filter(id => id !== binding.ownerUserId).slice(0, MAXIMUM_CONTEXT_PARTICIPANTS);
    const peopleLines = this.people && this.peopleEnabled() && !gate.ownerOnly
      ? this.people.contextLines(scopeKey, request.platform, userIds, present, ownerPresent) : [];
    // Her impressions of the people here, only those everyone in this conversation has seen form.
    const impressionLines = peopleLines.length ? platformImpressionLines(this.conversationStore, snapshot, scopeKey, {
      personIds: userIds.flatMap(id => this.people!.person(scopeKey, request.platform, id)?.id ?? []), present, at: this.now() }) : [];
    return { binding, threadId, ownerWrote, present, ownerPresent, gate, snapshot, peopleLines, impressionLines };
  }

  private boundConversation(request: { platform: ShannonPlatform; conversationId: string }): PlatformBridgeBinding {
    const binding = bindingFor(this.configuration, request.platform, request.conversationId);
    if (!binding) {
      throw new PlatformBridgeError(
        'PLATFORM_CONVERSATION_DENIED',
        403,
        'This platform conversation is not allowlisted.',
      );
    }
    return binding;
  }
}

/** Non-owner turns accepted per minute over all conversations. */
const PEOPLE_TURNS_PER_MINUTE = 120;
const MAXIMUM_CONTEXT_PARTICIPANTS = 20;

function actorDenied(): PlatformBridgeError {
  return new PlatformBridgeError('PLATFORM_ACTOR_DENIED', 403, 'This external actor is not bound to the Shannon owner.');
}

export function configuredPlatformBridge(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PlatformBridgeConfiguration | null {
  const token = environment.SHANNON_PLATFORM_BRIDGE_TOKEN?.trim() ?? '';
  const scopeKey = environment.SHANNON_PLATFORM_BRIDGE_SCOPE_KEY?.trim() ?? '';
  const rawBindings = environment.SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON?.trim() ?? '';
  if (!token && !scopeKey && !rawBindings) return null;
  if (token.length < 32) throw new Error('SHANNON_PLATFORM_BRIDGE_TOKEN must contain at least 32 characters');
  if (!boundedIdentifier(scopeKey, 160)) throw new Error('SHANNON_PLATFORM_BRIDGE_SCOPE_KEY is invalid');
  if (!rawBindings) throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON is required');

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBindings);
  } catch {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON must be valid JSON');
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 64) {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON must contain 1..64 bindings');
  }
  return composedPlatformBridgeConfiguration(token, scopeKey, decoded.map(validatedBinding), 'SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON');
}

/**
 * Who can read a bound conversation. Only an exact conversation the server marked
 * `owner-private` is the owner alone; every other binding is a group, identified by the
 * same opaque key as its thread.
 */
export function platformAudience(
  binding: PlatformBridgeBinding,
  request: { platform: ShannonPlatform; conversationId: string },
): MemoryAudience {
  return binding.audience === 'owner-private' && binding.conversationId
    ? OWNER_AUDIENCE : groupAudience(platformBridgeThreadId(request.platform, request.conversationId));
}

export function platformBridgeThreadId(platform: ShannonPlatform, conversationId: string): string {
  const digest = createHash('sha256').update(`${platform}\u0000${conversationId}`).digest('hex').slice(0, 32);
  return `platform:${platform}:${digest}`;
}

function platformTurnPayloadHash(request: PlatformTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.platform,
    request.conversationId,
    request.sourceUserId,
    request.userMessage,
    request.shannonReply,
    request.observedAt,
    // Appended only for turns that carry them, so the hash of today's owner turns is unchanged.
    ...(request.conversationKind ? [request.sourceDisplayName ?? '', request.conversationKind, request.sourceKind ?? 'person'] : []),
  ])).digest('hex');
}

function validatedPlatformTurn(value: unknown, now: string): PlatformTurnRequest {
  if (!recordValue(value)) throw badRequest('JSON object body is required.');
  if (!isPlatform(value.platform)) throw badRequest('platform is invalid.');
  if (!boundedIdentifier(value.requestId, 160)) throw badRequest('requestId is invalid.');
  if (!boundedIdentifier(value.conversationId, 240)) throw badRequest('conversationId is invalid.');
  if (!boundedIdentifier(value.sourceUserId, 160)) throw badRequest('sourceUserId is invalid.');
  if (!boundedText(value.userMessage, 8_000)) throw badRequest('userMessage is invalid.');
  const people = validatedPeopleFields(value);
  // A message Shannon saw without answering has no reply; the owner's mirrored turn always has one.
  const silent = people.conversationKind !== undefined && (value.shannonReply === undefined || value.shannonReply === '');
  if (!silent && !boundedText(value.shannonReply, 12_000)) throw badRequest('shannonReply is invalid.');
  if (typeof value.observedAt !== 'string' || !validObservedAt(value.observedAt, now)) {
    throw badRequest('observedAt is invalid or outside the 30-day ingestion window.');
  }
  return {
    platform: value.platform,
    requestId: value.requestId.trim(),
    conversationId: value.conversationId.trim(),
    sourceUserId: value.sourceUserId.trim(),
    userMessage: value.userMessage.trim(),
    shannonReply: silent ? '' : (value.shannonReply as string).trim(),
    observedAt: new Date(value.observedAt).toISOString(),
    ...people,
  };
}

/** The optional fields that let a turn or a context request be about someone other than the owner. */
function validatedPeopleFields(value: Record<string, unknown>): Pick<PlatformTurnRequest, 'sourceDisplayName' | 'conversationKind' | 'sourceKind'> {
  // Text only: files, images and embeds are never accepted, whoever wrote the message.
  for (const forbidden of ['attachments', 'embeds', 'files']) {
    if (value[forbidden] !== undefined) throw badRequest(`${forbidden} must not be sent.`);
  }
  if (value.conversationKind !== undefined && !['dm', 'group', 'channel'].includes(String(value.conversationKind))) throw badRequest('conversationKind is invalid.');
  if (value.sourceKind !== undefined && !['person', 'bot', 'system'].includes(String(value.sourceKind))) throw badRequest('sourceKind is invalid.');
  if (value.sourceDisplayName !== undefined && !boundedText(value.sourceDisplayName, 80)) throw badRequest('sourceDisplayName is invalid.');
  return {
    ...(typeof value.sourceDisplayName === 'string' ? { sourceDisplayName: value.sourceDisplayName.trim() } : {}),
    ...(value.conversationKind !== undefined ? { conversationKind: value.conversationKind as PlatformConversationKind } : {}),
    ...(value.sourceKind !== undefined ? { sourceKind: value.sourceKind as PlatformSourceKind } : {}),
  };
}

function validatedPlatformContext(value: unknown): Pick<PlatformTurnRequest, 'platform' | 'conversationId' | 'sourceUserId' | 'conversationKind'> & { participants?: readonly string[] } {
  if (!recordValue(value)) throw badRequest('JSON object body is required.');
  if (!isPlatform(value.platform)) throw badRequest('platform is invalid.');
  if (!boundedIdentifier(value.conversationId, 240)) throw badRequest('conversationId is invalid.');
  if (!boundedIdentifier(value.sourceUserId, 160)) throw badRequest('sourceUserId is invalid.');
  const { conversationKind } = validatedPeopleFields(value);
  if (value.participants !== undefined && (!Array.isArray(value.participants) || value.participants.length > 50
    || !value.participants.every(id => boundedIdentifier(id, 160)))) throw badRequest('participants is invalid.');
  return {
    platform: value.platform,
    conversationId: value.conversationId.trim(),
    sourceUserId: value.sourceUserId.trim(),
    ...(conversationKind ? { conversationKind } : {}),
    ...(Array.isArray(value.participants) ? { participants: (value.participants as string[]).map(id => id.trim()) } : {}),
  };
}

function validatedBinding(value: unknown): PlatformBridgeBinding {
  const exactConversation = recordValue(value) && boundedIdentifier(value.conversationId, 240);
  const prefixConversation = recordValue(value) && validConversationPrefix(value.platform, value.conversationIdPrefix);
  if (!recordValue(value) || !isPlatform(value.platform)
    || exactConversation === prefixConversation
    || !boundedIdentifier(value.ownerUserId, 160)
    || (value.audience !== undefined && value.audience !== 'shared' && value.audience !== 'owner-private')
    || (value.audience === 'owner-private' && !exactConversation)
    || !boundedText(value.title, 80)) {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON contains an invalid binding');
  }
  return {
    platform: value.platform,
    ...(exactConversation ? { conversationId: (value.conversationId as string).trim() } : {}),
    ...(prefixConversation ? { conversationIdPrefix: (value.conversationIdPrefix as string).trim() } : {}),
    ownerUserId: value.ownerUserId.trim(),
    title: value.title.trim(),
    ...(value.audience === 'shared' || value.audience === 'owner-private' ? { audience: value.audience } : {}),
  };
}

function validConversationPrefix(platform: unknown, value: unknown): value is string {
  return platform === 'discord'
    && typeof value === 'string'
    && /^discord:\d{1,32}:$/.test(value.trim());
}

function validObservedAt(value: string, now: string): boolean {
  const observed = Date.parse(value);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return false;
  const maximumFutureSkew = 5 * 60 * 1_000;
  const maximumAge = 30 * 24 * 60 * 60 * 1_000;
  return observed <= current + maximumFutureSkew && observed >= current - maximumAge;
}

function isPlatform(value: unknown): value is ShannonPlatform {
  return typeof value === 'string' && (platforms as readonly string[]).includes(value);
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(message: string): PlatformBridgeError {
  return new PlatformBridgeError('BAD_REQUEST', 400, message);
}
