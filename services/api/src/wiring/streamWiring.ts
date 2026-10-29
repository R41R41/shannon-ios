import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { feelingActor, shannonIdentityPrompt, type CompanionStateSnapshot } from '@shannon/cognition';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import type { ShannonChatModel } from '../infra/models/chatModelContract.js';
import { FeelingEvents } from '../mind/emotion/feelingEvents.js';
import type { FeelingPort } from '../mind/emotion/feelingPorts.js';
import { withCharacterCore, type InnerNotePort } from '../mind/emotion/innerNotePorts.js';
import { SQLiteFeelingEventStore } from '../mind/emotion/store/feelingEventStore.js';
import { StreamFeeling } from '../mind/emotion/streamFeeling.js';
import type { MinecraftLive } from '../surfaces/minecraft/minecraftLive.js';
import { StreamGate } from '../surfaces/stream/streamGate.js';
import { createStreamRoute, handleStreamBridge } from '../surfaces/stream/streamRoutes.js';
import { streamCommentary } from './streamCommentaryWiring.js';
import type { StreamMouth } from '../surfaces/stream/streamMouth.js';
import { StreamService } from '../surfaces/stream/streamService.js';

/**
 * The YouTube stream's place in the head (owner 2026-10-29, `docs/stream-contract.md`), composed. There is no switch: nothing runs until a
 * stream is started (`POST /v1/stream/start`), and a started stream works whatever `SHANNON_FEELING_*`, `SHANNON_MINECRAFT_LIVE*` and
 * `SHANNON_PLATFORM_REPLY` say. What it needs from them it takes when they exist and does without when they do not:
 *
 * - her feeling toward the stream is the feeling port's `StreamFeeling` when there is one; otherwise a `StreamFeeling` over the port's
 *   events, or (no feeling port at all) over a table in memory that lives and dies with the process. The check before speaking is always on.
 * - the Minecraft moments come from `SHANNON_MINECRAFT_LIVE`'s `MinecraftLive` when it is on, otherwise from one the body wiring makes
 *   for the stream (the same detector, no conversation block). Nothing is said into Discord by this.
 * - Jev (`TYPESAFE_API_KEY`) reads each comment before it is written to; without it the words' own judgement stands in.
 * - the writer is her primary model (the one that writes her replies, Sonnet with `SHANNON_REPLY_SONNET`), the commentary's one-liners are
 *   the auxiliary model's. Neither is ever given the owner's profile, memory, people or tools; and there is no model for a comment that is
 *   declined, on this surface, ever.
 */
export interface StreamWiringParts {
  scopeKey: string;
  now: () => number;
  feeling: FeelingPort | null;
  snapshot: (scopeKey: string) => CompanionStateSnapshot;
  /** Her primary model, unwrapped by the feeling reply check (the stream checks its own drafts). */
  model: ShannonChatModel;
  auxiliary: ShannonChatModel;
  jev: Pick<JevChooser, 'decide'> | null;
  innerNote?: InnerNotePort | null;
  live?: () => MinecraftLive | null;
  salt?: string;
  log?: (line: string) => void;
  tickMilliseconds?: number;
  /** Tests: a mouth with its own keepalive and receipt times. */
  mouth?: StreamMouth;
}

/** Her feeling toward the stream: the port's, one over the port's events, or one over a table in memory. */
export function streamFeelingFor(feeling: FeelingPort | null, now: () => number): StreamFeeling {
  if (feeling?.stream) return feeling.stream;
  if (feeling) return new StreamFeeling({ events: feeling.events, days: feeling.days ?? null, replyCheck: true });
  const events = new FeelingEvents({ store: new SQLiteFeelingEventStore(new DatabaseSync(':memory:')), now: () => new Date(now()).toISOString(),
    timeZone: 'Asia/Tokyo', partWord: () => '体' });
  return new StreamFeeling({ events, days: null, replyCheck: true });
}

export function configuredStream(parts: StreamWiringParts) {
  const feeling = streamFeelingFor(parts.feeling, parts.now);
  const iso = () => new Date(parts.now()).toISOString();
  // Always written for a shared room: the identity without the owner's profile and the persona of a group (as the Minecraft commentary's).
  const identity = () => withCharacterCore({ identity: shannonIdentityPrompt('owner', { othersPresent: true }) }, parts.innerNote ?? null).identity;
  const persona = (streamId: string): string => {
    try {
      const key = feelingActor({ ownerAlone: false, group: true, sceneId: `stream:${streamId}` });
      return parts.feeling?.events.linesFor(parts.scopeKey, key, iso(), parts.snapshot(parts.scopeKey), '', 'text')?.space?.block ?? '';
    } catch { return ''; }
  };
  const service = new StreamService({
    scopeKey: parts.scopeKey, now: parts.now, feeling, snapshot: parts.snapshot, model: parts.model, auxiliary: parts.auxiliary,
    gate: new StreamGate({ jev: parts.jev, scopeKey: parts.scopeKey }), identity, persona,
    body: () => parts.live?.()?.block({ alone: false }) ?? null, commentary: streamCommentary(() => parts.live?.() ?? null),
    ...(parts.salt ? { salt: parts.salt } : {}),
    ...(parts.log ? { log: parts.log } : {}), ...(parts.mouth ? { mouth: parts.mouth } : {}), tickMilliseconds: parts.tickMilliseconds ?? 500,
  });
  const route = createStreamRoute({ service, ownerScope: parts.scopeKey });
  return {
    service,
    /** The desktop's routes (`/v1/stream/*`), after authentication. True when answered. */
    serve: (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<boolean> =>
      route(request, response, principal, url),
    /** The ear's routes (`/v1/platform/stream/*`), after the bridge token was checked. */
    bridge: {
      handle: (path: string, request: IncomingMessage, response: ServerResponse): Promise<void> => handleStreamBridge(path, request, response, service),
    },
    stop: () => service.stop(),
  };
}
export type ConfiguredStream = ReturnType<typeof configuredStream>;
