import { createHash } from 'node:crypto';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';
import type { TaskConversationDelivery } from '../taskRuntime/taskConversationDeliveryPorts.js';
import type { FcaConversationPort } from './fcaConversationPorts.js';
import type { FcaVoiceHistoryInput, FcaVoiceInput, FcaVoicePort } from './fcaVoicePorts.js';

/**
 * A client utterance id used again for a new utterance (the Windows app reused one for the same words, 2026-10-14) is not a
 * retry: once the delivery it named is settled (its history bound, its generation failed, or staged longer than a retry can take),
 * or the words differ, the new utterance is delivered under the next occurrence of that id (`<id>#2`, `#3`, …) instead of being
 * refused with 409. Only a delivery still in flight with the same device and words is the same utterance (a retry: 409 as before).
 * The history receipt of the reused id binds the newest occurrence, and is a duplicate only when its reply is the bound one too.
 */
const OCCURRENCES = 8;
const IN_FLIGHT_MILLISECONDS = 120_000;

/** Adapts the existing generated/visible-history boundary. It never emits audio or invents a spoken prefix. */
export function createFcaVoiceBridge(parts: {
  conversation: FcaConversationPort; runtime: TaskRuntime; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean; now?(): string;
}): FcaVoicePort {
  const now = () => Date.parse(parts.now?.() ?? new Date().toISOString());
  const identity = (input: FcaVoiceInput, utteranceId: string) => ({ deviceId: input.deviceId, utteranceId, inputDigest: digest(input.userTranscript) });
  /** The newest occurrence of the client's id, with its own id and number; null when the id is new. */
  const newest = (input: FcaVoiceInput) => {
    let found: { record: TaskConversationDelivery; id: string; occurrence: number } | null = null;
    for (let occurrence = 1; occurrence <= OCCURRENCES; occurrence += 1) {
      const id = occurrenceId(input.utteranceId, occurrence);
      const record = parts.runtime.conversationDelivery(input.scopeKey, input.threadId, id);
      if (!record) break;
      found = { record, id, occurrence };
    }
    return found;
  };
  const matches = (input: FcaVoiceInput, record: TaskConversationDelivery) =>
    record.scopeKey === parts.ownerScope && record.deviceId === input.deviceId && record.inputDigest === digest(input.userTranscript);
  const inFlight = (record: TaskConversationDelivery) => (record.state === 'generating' || record.state === 'staged')
    && !(now() - Date.parse(record.createdAt ?? '') > IN_FLIGHT_MILLISECONDS);
  const source = (input: FcaVoiceHistoryInput, id: string) => {
    const experience = parts.conversations.experiencesById?.(input.scopeKey, [id])[0];
    return Boolean(experience && parts.conversations.threadOfTurn?.(input.scopeKey, id) === input.threadId
      && digest(experience.userMessage) === digest(input.userTranscript)
      && (input.shannonReply === undefined || experience.shannonReply.trim() === input.shannonReply.trim()));
  };
  return {
    inspect(input) {
      const known = newest(input);
      return known && matches(input, known.record) && inFlight(known.record) ? 'duplicate' : 'new';
    },
    begin(input) {
      if (input.scopeKey !== parts.ownerScope || !parts.ownerAlone() || !input.ownerAlone()) return null;
      const known = newest(input);
      const occurrence = known ? known.occurrence + 1 : 1;
      // Past the bound the turn is ordinary voice, without task attachment.
      if (occurrence > OCCURRENCES) return null;
      const utteranceId = occurrenceId(input.utteranceId, occurrence);
      return parts.conversation.begin({ ...input, delivery: identity(input, utteranceId) });
    },
    history(input) {
      const known = newest(input);
      if (!known) return { status: 'untracked' };
      const { record } = known;
      if (!matches(input, record) || input.companionPresent || !parts.ownerAlone()) return { status: 'rejected' };
      // A bound occurrence with another reply is a new utterance whose turn had no task attachment: ordinary history.
      if (record.state === 'bound') return record.experienceId && source(input, record.experienceId)
        ? { status: 'duplicate', experienceId: record.experienceId } : { status: 'untracked' };
      // Failed generation can still keep an actually played prefix through ordinary history. Its children stay stopped.
      return { status: record.state === 'staged' ? 'ready' : 'untracked' };
    },
    recorded(input) {
      const known = newest(input);
      if (!known || !matches(input, known.record) || input.companionPresent || !parts.ownerAlone() || !source(input, input.experienceId)) return false;
      return parts.runtime.bindConversationDelivery(input.scopeKey,
        { ...identity(input, known.id), threadId: input.threadId, experienceId: input.experienceId });
    },
  };
}
const digest = (text: string) => createHash('sha256').update(text.trim()).digest('hex');
/** The id of an occurrence, within the 120 characters of a delivery id: the client's own for the first. */
function occurrenceId(id: string, occurrence: number): string {
  if (occurrence === 1) return id;
  return `${id.length <= 110 ? id : createHash('sha256').update(id).digest('hex').slice(0, 32)}#${occurrence}`;
}
