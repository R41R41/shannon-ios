import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { ShannonChatModel } from '../../infra/models/chatModelContract.js';
import type { StreamFeeling } from '../../mind/emotion/streamFeeling.js';
import type { CommentaryFactory } from './streamContract.js';
import type { StreamGate } from './streamGate.js';
import type { StreamMouth } from './streamMouth.js';

/** What the stream place (`StreamService`) is made of: every model, the feeling, the clock and the game are handed in (`wiring/streamWiring.ts`). */
export interface StreamServiceParts {
  scopeKey: string;
  now: () => number;
  /** Her feeling toward the stream (`StreamFeeling`: the port's, or one over an in-memory table). */
  feeling: Pick<StreamFeeling, 'comment' | 'turn'>;
  snapshot: (scopeKey: string) => CompanionStateSnapshot;
  /** Writes her replies, topics, greeting and closing: the primary model of her replies. */
  model: ShannonChatModel;
  /** Writes the commentary's one-liners: the auxiliary model, as Discord's commentary does. */
  auxiliary: ShannonChatModel;
  gate: Pick<StreamGate, 'before' | 'stats'>;
  /** Her identity for a shared room and the persona block of a group; fixed by the wiring (no owner profile in either). */
  identity: () => string;
  persona: (streamId: string) => string;
  /** Her Minecraft body's present written for a shared room; null while she has no body (then a Minecraft stream has no commentary). */
  body?: () => string | null;
  /** The game's commentary engine over this stream's hooks; null while there is no body to hear moments from. */
  commentary?: (() => CommentaryFactory | null) | undefined;
  /** The salt of the viewers' digests (the install's). */
  salt?: string;
  mouth?: StreamMouth;
  log?: (line: string) => void;
  /** The wiring's timer calls `tick` every this many ms; none while 0 (tests). */
  tickMilliseconds?: number;
}
