import { createHash } from 'node:crypto';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaConversationPort } from './fcaConversationPorts.js';
import type { FcaVoiceInput, FcaVoicePort } from './fcaVoicePorts.js';

/** Adapts the existing generated/visible-history boundary. It never emits audio or invents a spoken prefix. */
export function createFcaVoiceBridge(parts: {
  conversation: FcaConversationPort; runtime: TaskRuntime; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean;
}): FcaVoicePort {
  const identity = (input: FcaVoiceInput) => ({ deviceId: input.deviceId, utteranceId: input.utteranceId, inputDigest: digest(input.userTranscript) });
  const existing = (input: FcaVoiceInput) => parts.runtime.conversationDelivery(input.scopeKey, input.threadId, input.utteranceId);
  const matches = (input: FcaVoiceInput, record: NonNullable<ReturnType<typeof existing>>) =>
    record.scopeKey === parts.ownerScope && record.deviceId === input.deviceId && record.inputDigest === digest(input.userTranscript);
  const source = (input: FcaVoiceInput, id: string) => {
    const experience = parts.conversations.experiencesById?.(input.scopeKey, [id])[0];
    return Boolean(experience && parts.conversations.threadOfTurn?.(input.scopeKey, id) === input.threadId
      && digest(experience.userMessage) === digest(input.userTranscript));
  };
  return {
    inspect(input) {
      const record = existing(input);
      return !record ? 'new' : matches(input, record) ? 'duplicate' : 'conflict';
    },
    begin(input) {
      if (input.scopeKey !== parts.ownerScope || !parts.ownerAlone() || !input.ownerAlone()) return null;
      return parts.conversation.begin({ ...input, delivery: identity(input) });
    },
    history(input) {
      const record = existing(input);
      if (!record) return { status: 'untracked' };
      if (!matches(input, record) || input.companionPresent || !parts.ownerAlone()) return { status: 'rejected' };
      if (record.state === 'bound') return record.experienceId && source(input, record.experienceId)
        ? { status: 'duplicate', experienceId: record.experienceId } : { status: 'rejected' };
      // Failed generation can still keep an actually played prefix through ordinary history. Its children stay stopped.
      return { status: record.state === 'staged' ? 'ready' : 'untracked' };
    },
    recorded(input) {
      const record = existing(input);
      if (!record || !matches(input, record) || input.companionPresent || !parts.ownerAlone() || !source(input, input.experienceId)) return false;
      return parts.runtime.bindConversationDelivery(input.scopeKey, { ...identity(input), threadId: input.threadId, experienceId: input.experienceId });
    },
  };
}
const digest = (text: string) => createHash('sha256').update(text.trim()).digest('hex');
