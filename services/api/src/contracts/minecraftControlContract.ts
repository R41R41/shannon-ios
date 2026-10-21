import type { ActionLease } from '@shannon/mind';
import type { BodyActionReceipt, BodyCandidateDraft, BodyObservation, BodyOperation, BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext } from './bodyControlContract.js';

/** Separate from the legacy game-chat/body request contract: no planner executes on this device. */
export const MINECRAFT_CONTROL_PATH = '/v1/body/minecraft/control';
export interface MinecraftSkillDefinition {
  name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; readOnly: boolean;
  /** How long the body lets this skill run, when it says (`minecraftSkillMilliseconds`); optional. */
  maxDurationMs?: number;
}
export interface MinecraftControlCommand {
  schemaVersion: 1; id: string; serverId: string; connectionId: string;
  kind: 'skill' | 'reflex' | 'stop' | 'release' | 'capture';
  context: BodyTaskContext; lease: ActionLease; deadlineAt: string;
  skill?: string; arguments?: Readonly<Record<string, unknown>>;
  operation?: BodyOperation; stop?: BodyStopRequest;
}
export interface MinecraftControlReceipt {
  id: string; connectionId: string; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
  inputsReleased: boolean; observedAt: string; result?: string;
  /** Why a skill failed, as the body's closed code (`minecraftRetryHint`), and whether it thinks it can recover; both optional. */
  failureType?: string; recoverable?: boolean;
  /**
   * A failed skill that made part of what it was asked (mb-r23: `use-item-on-block` with a count made 6 of 10 obsidian). Optional; a body
   * that does not send it is read from the frames (`minecraftProgress.ts`). `true` makes the failure no failed step of the run.
   */
  partial?: boolean;
  action?: BodyActionReceipt; stop?: BodyStopAcknowledgement;
  /** Ephemeral pixels only: the companion stores an expiring reference, never this field in SQLite. */
  image?: { dataUrl: string; capturedAt: string };
}
/**
 * A line of hers for the room she plays in (session dc-live, SHANNON_MINECRAFT_LIVE_SPEECH): the API writes it, the body puts it where she is
 * (a voice channel she is in, else a text channel) or declines. At most one in a reply. A body that does not know speech ignores it.
 */
export interface MinecraftLiveSpeech {
  id: string; text: string; urgency: 'ordinary' | 'urgent';
  /** Past this the body says nothing (a line about a moment that is over). */
  expiresAt: string;
  /** The kind of moment it comes from (@shannon/mind LiveMomentKind), for the body's journal. */
  kind: string;
}
/** What the body did with a line: said it (spoken) or wrote it (posted), did not (declined: busy, nobody there, expired), or could not (ailed). */
export interface MinecraftLiveSpeechReceipt {
  id: string; outcome: 'spoken' | 'posted' | 'declined' | 'failed';
  /** A closed reason of the body's (usy, expired, 
o_room, 
o_channel, error). */
  reason?: string;
  /** The Discord conversation it went into (discord:<guild>:<channel>), when it went into one: the API keeps her line in that thread. */
  conversationId?: string;
}
/** The room she plays in, as the body reads it each poll: in a voice channel or not, someone speaking, and how long since someone spoke or wrote. */
export interface MinecraftLiveRoom { voice: boolean; humanSpeaking: boolean; sinceHumanMs: number | null }

export interface MinecraftControlPoll {
  schemaVersion: 1; serverId: string; connectionId: string;
  observation: BodyObservation; candidates: readonly BodyCandidateDraft[];
  /** Whole catalog on initial connection and changes. Not selected by a second game planner. */
  skills?: readonly MinecraftSkillDefinition[];
  receipts: readonly MinecraftControlReceipt[]; activeOperationIds: readonly string[];
  /** What changed while the body works (`@shannon/mind` WorkingEvent), oldest first, at most 32; a body before mb-arch sends none. */
  events?: readonly unknown[];
  /** What the body did with the lines it was handed (speech of an earlier reply), and the room it plays in: only when it can speak. */
  speechReceipts?: readonly MinecraftLiveSpeechReceipt[];
  liveRoom?: MinecraftLiveRoom;
}
export interface MinecraftControlReply {
  schemaVersion: 1; mode: 'common-fca';
  commands: readonly MinecraftControlCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
  /** The highest event `seq` taken from this connection; sent only when the poll carried events (the body drops those). */
  eventsThrough?: number;
  /** A line of hers for the room (at most one), while SHANNON_MINECRAFT_LIVE_SPEECH is on. */
  speech?: readonly MinecraftLiveSpeech[];
}
