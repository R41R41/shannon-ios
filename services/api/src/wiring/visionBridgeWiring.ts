import { VISION_SOURCE_KINDS } from '../contracts/visionContract.js';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';
import { configuredDatabasePath } from '../infra/sqlite/sqliteStore.js';
import { serveMindSocket } from '../infra/ipc/mindSocket.js';
import { visionBridgeSocketPath, visionSwitches } from '../infra/config/visionConfig.js';
import { configuredResponseModel } from '../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured } from '../infra/models/claude/claudeStructured.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { visionLook, visionPerception, type MindPerceiver } from '../mind/perception/perceptionPorts.js';
import type { FcaAffectEvidence } from '../mind/emotion/emotionPorts.js';
import { createConfiguredRoomLookViewer } from '../surfaces/body/bodyLookVision.js';
import { VisionEscalation } from '../surfaces/vision/visionEscalate.js';
import { VisionNoticeSpeaker } from '../surfaces/vision/visionNotice.js';

/**
 * The API's side of the vision worker (Syzygy ADR-0011 §9, option C): an owner-only Unix socket the worker calls, over the same
 * framed IPC as the mind worker (`infra/ipc/mindSocket.ts`). The API stays the authority on who is present and what is said:
 * - `vision.audience`: who can see or hear her now (the kernel's audience watch);
 * - `vision.percept` / `vision.presence`: a closed percept into the workspace (§5), never a picture;
 * - `vision.notice`: her one short line in the Talk, re-checked against the audience (`VisionNoticeSpeaker`), with an appraisal;
 * - `vision.escalate`: a closer look by the look model, with no Talk context (`VisionEscalation`).
 * Null with `SHANNON_VISION_WORKER` off: no socket, nothing changes.
 */
export interface VisionBridgeConversation {
  listThreads(scopeKey: string): readonly { threadId: string }[];
  threadId(scopeKey: string, threadId?: string): string;
  recentMessages(scopeKey: string, threadId: string, limit: number): readonly { role: string; observedAt: string }[];
  appendNoteOnce(scopeKey: string, threadId: string, messageId: string, content: string, observedAt: string, noteKind: string, ownerAlone?: boolean): unknown;
}
export interface VisionBridgeParts {
  databasePath: string;
  ownerScope: string;
  now(): number;
  presence(scopeKey: string): 'alone' | 'others' | 'unknown';
  perceiver: MindPerceiver | null;
  conversations: VisionBridgeConversation;
  usage: Pick<LlmUsageStore, 'recordLlmUsage'>;
  affect?: { applyFcaAffectEvidence(scopeKey: string, evidence: FcaAffectEvidence, visible: () => boolean): unknown };
  /** The foreground speaking right (ADR-0008 answer 3), when the mind provides one. */
  foreground?<T>(scopeKey: string, work: () => Promise<T>): Promise<T>;
  log(line: string): void;
}

const NOTICE_SCHEMA = Object.freeze({ type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false });
const NOTICE_VALUE: Readonly<Record<string, number>> = Object.freeze({
  owner_returned: 0.3, owner_waved: 0.3, showing_something: 0.2, new_object: 0.1, owner_looks_tired: -0.2,
});

type Args = Record<string, unknown>;
const text = (args: Args, key: string, pattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u) => {
  const value = args[key];
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('VISION_BRIDGE_ARGS');
  return value;
};
const time = (args: Args, key: string) => {
  const value = args[key];
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('VISION_BRIDGE_ARGS');
  return value;
};
const integer = (args: Args, key: string, maximum: number) => {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('VISION_BRIDGE_ARGS');
  return value;
};

function lastThread(conversations: VisionBridgeConversation, scopeKey: string): string {
  return conversations.listThreads(scopeKey)[0]?.threadId ?? conversations.threadId(scopeKey);
}

function noteSayer(parts: VisionBridgeParts) {
  return (scopeKey: string, decisionId: string, line: string, at: string) => {
    const threadId = lastThread(parts.conversations, scopeKey);
    // Marked as said with the owner alone: a replay with anyone else present does not re-feed it.
    parts.conversations.appendNoteOnce(scopeKey, threadId, decisionId, line, at, 'vision-notice', true);
    return { threadId };
  };
}

function ownerLastActiveAt(conversations: VisionBridgeConversation, scopeKey: string): string | null {
  try {
    const messages = conversations.recentMessages(scopeKey, lastThread(conversations, scopeKey), 12);
    return [...messages].reverse().find(message => message.role === 'user')?.observedAt ?? null;
  } catch {
    return null;
  }
}

function noticeSpeaker(values: Readonly<Record<string, string | undefined>>, parts: VisionBridgeParts): VisionNoticeSpeaker {
  const selected = configuredResponseModel(values, 'SHANNON_LLM_MODEL');
  const claude = selected ? claudeBackground(selected.model, { apiKey: selected.apiKey, usageStore: parts.usage }) : null;
  return new VisionNoticeSpeaker({
    compose: async (scopeKey, instructions, signal) => {
      if (!claude) return null;
      const input = [{ role: 'user' as const, content: '一言だけ話しかけてください。' }];
      const answer = await completeStructured<{ line?: unknown }>('vision_notice', instructions, input, NOTICE_SCHEMA,
        { claude, scopeKey, maximumOutputTokens: 120, effort: 'none', signal });
      return answer.ok && typeof answer.value.line === 'string' ? answer.value.line : null;
    },
    alone: scopeKey => parts.presence(scopeKey) === 'alone',
    ownerLastActiveAt: scopeKey => ownerLastActiveAt(parts.conversations, scopeKey),
    say: noteSayer(parts),
    ...(parts.foreground ? { foreground: parts.foreground } : {}),
    now: parts.now,
  });
}

function appraise(parts: VisionBridgeParts, scopeKey: string, decisionId: string, category: string, at: string): void {
  const value = NOTICE_VALUE[category];
  if (value === undefined || !parts.affect) return;
  try {
    parts.affect.applyFcaAffectEvidence(scopeKey, {
      eventId: `vision:${decisionId}`, taskId: 'vision-camera', revision: 1, observedAt: at, value, expectedValue: null, unexpected: null,
      cause: `vision.notice:${category}`, target: 'app_camera', sources: [],
    }, () => parts.presence(scopeKey) === 'alone');
  } catch { /* the notice stands without its appraisal */ }
}

function perceive(parts: VisionBridgeParts, scopeKey: string, args: Args): true {
  const sourceKind = text(args, 'sourceKind');
  if (!(VISION_SOURCE_KINDS as readonly string[]).includes(sourceKind) || args.privacy !== 'owner_private') throw new Error('VISION_BRIDGE_ARGS');
  const probability = typeof args.probability === 'number' && args.probability >= 0 && args.probability <= 1 ? args.probability : 0;
  const code = text(args, 'code');
  const event = visionPerception({ code, probability, sourceId: text(args, 'sourceId'), sourceKind, privacy: 'owner_private',
    body: typeof args.body === 'string' ? text(args, 'body') : null, ttlMs: integer(args, 'ttlMs', 30 * 60_000), frameRef: null, at: time(args, 'at') });
  if (event) parts.perceiver?.perceive(scopeKey, event, { code, tool: sourceKind, reason: null });
  return true;
}

/** One request of the worker. Every argument is checked; anything unexpected is refused without echoing it. */
export function visionBridgeHandler(values: Readonly<Record<string, string | undefined>>, parts: VisionBridgeParts) {
  const notice = noticeSpeaker(values, parts);
  const escalation = new VisionEscalation({
    viewer: visionSwitches(values).escalate ? createConfiguredRoomLookViewer(values, parts.usage) : null,
    alone: scopeKey => parts.presence(scopeKey) === 'alone', say: noteSayer(parts), now: parts.now,
    looked: (scopeKey, look) => visionLook({ scopeKey, source: 'app_camera', purpose: 'escalate', deviceId: look.deviceId, outcome: look.outcome,
      audience: 'owner_alone', at: new Date(parts.now()).toISOString(), perceiver: parts.perceiver,
      image: { format: 'jpeg', width: look.width, height: look.height, byteLength: look.byteLength } }),
  });
  return async (method: string, input: unknown): Promise<unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('VISION_BRIDGE_ARGS');
    const args = input as Args;
    const scopeKey = text(args, 'scopeKey', /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
    if (scopeKey !== parts.ownerScope) throw new Error('VISION_BRIDGE_SCOPE');
    const presence = () => parts.presence(scopeKey);
    if (method === 'vision.audience') return { audience: presence() === 'alone' ? 'owner_alone' : presence() === 'others' ? 'others' : 'unknown' };
    if (method === 'vision.percept') return perceive(parts, scopeKey, args);
    if (method === 'vision.presence') {
      const at = time(args, 'at');
      return perceive(parts, scopeKey, { code: 'presence:others', probability: 1, sourceId: `presence-${Date.parse(at)}`, sourceKind: 'app_camera',
        privacy: 'owner_private', ttlMs: 10 * 60_000, body: text(args, 'deviceId'), at, personCount: integer(args, 'personCount', 64) });
    }
    if (method === 'vision.notice') {
      const decisionId = text(args, 'decisionId');
      const category = text(args, 'category', /^[a-z_]{1,40}$/u);
      const result = await notice.deliver({ scopeKey, decisionId, category, at: time(args, 'at') });
      if (result.delivered) appraise(parts, scopeKey, decisionId, category, time(args, 'at'));
      return { delivered: result.delivered };
    }
    if (method === 'vision.escalate') {
      return escalation.look({ scopeKey, decisionId: text(args, 'decisionId'), deviceId: text(args, 'deviceId'),
        mimeType: text(args, 'mimeType', /^image\/(?:jpeg|png)$/u), base64: text(args, 'base64', /^[A-Za-z0-9+/]{4,280000}={0,2}$/u),
        width: integer(args, 'width', 4096), height: integer(args, 'height', 4096), at: time(args, 'at') });
    }
    throw new Error('VISION_BRIDGE_METHOD');
  };
}

/** Serves the bridge socket while `SHANNON_VISION_WORKER` is on; null otherwise. A socket that cannot be served is logged, never fatal. */
export async function configuredVisionBridge(values: Readonly<Record<string, string | undefined>>, parts: VisionBridgeParts):
  Promise<{ close(): Promise<void> } | null> {
  if (!visionSwitches(values).worker) return null;
  try {
    const served = await serveMindSocket(visionBridgeSocketPath(values, parts.databasePath), visionBridgeHandler(values, parts));
    parts.log('Shannon vision bridge ready');
    return { close: () => served.close() };
  } catch (error) {
    parts.log(`Shannon vision bridge unavailable code=${error instanceof Error && /^[A-Z0-9_]{1,60}$/u.test(error.message) ? error.message : 'unknown'}`);
    return null;
  }
}

/** The API server's bridge, composed from its kernel, mind and store (keeps `server.ts` to one line). */
export function serverVisionBridge(values: Readonly<Record<string, string | undefined>>, parts: {
  kernel: { ownerPresenceForFeedback(scopeKey: string): 'alone' | 'others' | 'unknown' };
  mind: { mind: MindPerceiver } | null;
  store: VisionBridgeConversation & Pick<LlmUsageStore, 'recordLlmUsage'> & NonNullable<VisionBridgeParts['affect']>;
}): Promise<{ close(): Promise<void> } | null> {
  return configuredVisionBridge(values, {
    databasePath: configuredDatabasePath(), ownerScope: configuredOwnerScope(values), now: Date.now, log: line => console.log(line),
    presence: scopeKey => parts.kernel.ownerPresenceForFeedback(scopeKey), perceiver: parts.mind?.mind ?? null,
    conversations: parts.store, usage: parts.store, affect: parts.store,
  });
}
