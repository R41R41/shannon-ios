import { feelingActor, shannonIdentityPrompt, workExchangeLines, type CompanionStateSnapshot } from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import type { PlatformBridgeConfiguration } from '../mind/memory/platformBridge.js';
import { platformBridgeThreadId } from '../mind/memory/platformBridge.js';
import { bindingFor } from '../mind/memory/platformBridgeBindings.js';
import { withCharacterCore, type InnerNotePort } from '../mind/emotion/innerNotePorts.js';
import type { FeelingPort } from '../mind/emotion/feelingPorts.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonChatModel } from '../infra/models/chatModelContract.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { MinecraftLive } from '../surfaces/minecraft/minecraftLive.js';
import { LiveCommentary } from '../surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../surfaces/minecraft/minecraftLiveSpeech.js';
import { cleanLiveLine, liveWriterPrompt } from '../surfaces/minecraft/minecraftLiveWriter.js';

/**
 * Her Minecraft body's view for the conversations, and her live commentary (session dc-live). Two switches, both off unless said on:
 *
 * - `SHANNON_MINECRAFT_LIVE`: the body's present as a block in every conversation (the app, Discord text, a call), read from the
 *   body's latest frame (`minecraftLive.ts`); the moments her frames show are noticed. Nothing is said without the second switch.
 * - `SHANNON_MINECRAFT_LIVE_SPEECH`: with the first, she says a word of her own about a moment, in the voice channel she is in or the
 *   text channel the body is set to (`minecraftLiveCommentary.ts`), at most one or two a minute, never over someone who is talking.
 *
 * The block is made before the kernel (the kernel is handed it), the commentary after everything else exists.
 */
type Environment = Readonly<Record<string, string | undefined>>;
export const minecraftLiveEnabled = (values: Environment): boolean => switchOn(values, 'SHANNON_MINECRAFT_LIVE');
export const minecraftLiveSpeechEnabled = (values: Environment): boolean => minecraftLiveEnabled(values) && switchOn(values, 'SHANNON_MINECRAFT_LIVE_SPEECH');

export interface MinecraftLiveWiring {
  live: MinecraftLive;
  outbox: LiveSpeechOutbox;
  /** The control exists (after the task runtime): frames and events flow in, and her lines flow out when speech is on. */
  connectControl(control: MinecraftControl): void;
  /** Starts the commentary (only with `SHANNON_MINECRAFT_LIVE_SPEECH`); returns it, or null. */
  startCommentary(parts: CommentaryParts): LiveCommentary | null;
  stop(): void;
}

export interface CommentaryParts {
  scopeKey: string;
  /** The model that writes her line: a fast one (the auxiliary chat model). */
  model: ShannonChatModel;
  innerNote?: InnerNotePort | null;
  feeling?: FeelingPort | null;
  /** Her state (the snapshot her character space reads) and her conversations (where a text line is kept): the one store. */
  store: { snapshot(scopeKey: string): CompanionStateSnapshot } & Pick<ConversationStore, 'appendNoteOnce'>;
  bridge?: PlatformBridgeConfiguration | null;
  now?: () => string;
  log?: (line: string) => void;
}

export function configuredMinecraftLive(values: Environment): MinecraftLiveWiring | null {
  if (!minecraftLiveEnabled(values)) return null;
  let control: MinecraftControl | null = null;
  const natural = switchOn(values, 'SHANNON_NATURAL_TALK');
  const live = new MinecraftLive({ frames: { latest: (id, age) => control?.latest(id, age) ?? null, available: () => control?.available() ?? [] },
    log: line => console.info(line), ...(natural ? { exchanges: minute => workExchangeLines(minute) } : {}) });
  const outbox = new LiveSpeechOutbox();
  let commentary: LiveCommentary | null = null;
  return {
    live, outbox,
    connectControl(next) {
      control = next;
      next.frameListeners.add((bodyId, observation, arrival) => live.frame(bodyId, observation, arrival));
      next.eventListeners.add((bodyId, events) => live.events(bodyId, events));
      if (minecraftLiveSpeechEnabled(values)) next.speech = outbox;
    },
    startCommentary(parts) {
      if (!minecraftLiveSpeechEnabled(values) || commentary) return commentary;
      commentary = createCommentary(live, outbox, parts);
      commentary.start();
      return commentary;
    },
    stop() { commentary?.stop(); },
  };
}

/**
 * A `MinecraftLive` for a YouTube stream when `SHANNON_MINECRAFT_LIVE` is off (`surfaces/stream/`): the same detector over the control's frames
 * and events, so that the moments exist; it makes no conversation block and says nothing (the stream's commentary does).
 */
export function streamOnlyMinecraftLive(control: MinecraftControl): MinecraftLive {
  const frames = { latest: (id: string, age: number) => control.latest(id, age) ?? null, available: () => control.available() };
  const live = new MinecraftLive({ frames, log: line => console.info(line) });
  control.frameListeners?.add((bodyId, observation, arrival) => live.frame(bodyId, observation, arrival));
  control.eventListeners?.add((bodyId, events) => live.events(bodyId, events));
  return live;
}

function createCommentary(live: MinecraftLive, outbox: LiveSpeechOutbox, parts: CommentaryParts): LiveCommentary {
  const clock = parts.now ?? (() => new Date().toISOString());
  const log = parts.log ?? ((line: string) => console.info(line));
  // Always written for a shared room: the line goes where others read or hear it (the identity without his profile, the persona of a group).
  const identity = () => withCharacterCore({ identity: shannonIdentityPrompt('owner', { othersPresent: true }) }, parts.innerNote ?? null).identity;
  const persona = (): string => {
    try {
      const at = clock(), key = feelingActor({ ownerAlone: false, group: true }), snapshot = parts.store.snapshot(parts.scopeKey);
      const lines = parts.feeling?.events.linesFor(parts.scopeKey, key, at, snapshot, '', 'text');
      return lines?.space?.block ?? '';
    } catch { return ''; }
  };
  return new LiveCommentary({
    live, outbox, log,
    async write(request) {
      const { system, message } = liveWriterPrompt({ identity: identity(), persona: persona(), body: live.block({ alone: false }), ...request });
      const result = await parts.model.generate({ scopeKey: parts.scopeKey, systemPrompt: system, history: [], message, skipThinking: true });
      return cleanLiveLine(result.reply, { voice: request.voice });
    },
    delivered(told) {
      log(`Shannon Minecraft live delivered id=${told.id} kind=${told.moment.kind} outcome=${told.outcome} length=${told.text.length}`);
      keepInThread(parts, told);
    },
  });
}

/** Her line is part of what she said in that conversation: kept in its thread, so that an answer to it is understood. */
function keepInThread(parts: CommentaryParts, told: { id: string; text: string; conversationId?: string }): void {
  try {
    if (!told.conversationId || !parts.bridge) return;
    const binding = bindingFor(parts.bridge, 'discord', told.conversationId);
    if (!binding) return;
    parts.store.appendNoteOnce?.(parts.scopeKey, platformBridgeThreadId('discord', told.conversationId), `live:${told.id}`, told.text,
      (parts.now ?? (() => new Date().toISOString()))(), 'minecraft-live', binding.audience === 'owner-private');
  } catch { /* her line was said; keeping it never fails the commentary */ }
}
