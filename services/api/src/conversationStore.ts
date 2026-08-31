import { randomUUID } from 'node:crypto';
import type { RecallCandidate, ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';

export interface ShannonExperience extends RecallCandidate {
  userMessage: string;
  shannonReply: string;
}

export interface StoredConversationMessage extends ShannonConversationItem {
  id: string;
  observedAt: string;
  messageEmotion?: ShannonMessageEmotion;
  stateVersion?: number;
}

export interface TurnPersistenceContext {
  messageEmotion: ShannonMessageEmotion;
  capturedStateVersion: number;
}

export interface ConversationStore {
  history(scopeKey: string): readonly ShannonConversationItem[];
  conversationHistory(scopeKey: string): readonly StoredConversationMessage[];
  experienceCandidates(scopeKey: string): readonly ShannonExperience[];
  appendTurn(
    scopeKey: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, StoredConversationMessage[]>();
  private readonly experiences = new Map<string, ShannonExperience[]>();

  constructor(
    private readonly maximumConversationItems = 200,
    private readonly maximumExperiences = 1_000,
    private readonly maximumModelConversationItems = 20,
  ) {}

  history(scopeKey: string): readonly ShannonConversationItem[] {
    return Object.freeze(this.conversationHistory(scopeKey)
      .slice(-this.maximumModelConversationItems)
      .map(item => Object.freeze({ role: item.role, content: item.content })));
  }

  conversationHistory(scopeKey: string): readonly StoredConversationMessage[] {
    return Object.freeze((this.conversations.get(scopeKey) ?? []).map(item => Object.freeze({
      ...item,
      ...(item.messageEmotion ? { messageEmotion: Object.freeze({ ...item.messageEmotion }) } : {}),
    })));
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] {
    return Object.freeze((this.experiences.get(scopeKey) ?? []).map(item => Object.freeze({ ...item })));
  }

  appendTurn(
    scopeKey: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience {
    const turnId = randomUUID();
    const conversation = this.conversations.get(scopeKey) ?? [];
    conversation.push(
      { id: randomUUID(), role: 'user', content: userMessage, observedAt },
      {
        id: randomUUID(),
        role: 'assistant',
        content: shannonReply,
        observedAt,
        ...(context ? {
          messageEmotion: Object.freeze({ ...context.messageEmotion }),
          stateVersion: context.capturedStateVersion,
        } : {}),
      },
    );
    this.conversations.set(scopeKey, conversation.slice(-this.maximumConversationItems));

    const experiences = this.experiences.get(scopeKey) ?? [];
    const experience: ShannonExperience = Object.freeze({
      id: turnId,
      userMessage,
      shannonReply,
      summary: summarizeExperience(userMessage, shannonReply),
      observedAt,
    });
    experiences.push(experience);
    this.experiences.set(scopeKey, experiences.slice(-this.maximumExperiences));
    return experience;
  }
}

function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}
