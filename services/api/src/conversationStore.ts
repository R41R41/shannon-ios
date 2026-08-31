import type { RecallCandidate } from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';

export interface ShannonExperience extends RecallCandidate {
  userMessage: string;
  shannonReply: string;
}

export class InMemoryConversationStore {
  private readonly conversations = new Map<string, ShannonConversationItem[]>();
  private readonly experiences = new Map<string, ShannonExperience[]>();
  private readonly experienceSequences = new Map<string, number>();

  constructor(
    private readonly maximumConversationItems = 20,
    private readonly maximumExperiences = 200,
  ) {}

  history(scopeKey: string): readonly ShannonConversationItem[] {
    return Object.freeze((this.conversations.get(scopeKey) ?? []).map(item => Object.freeze({ ...item })));
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] {
    return Object.freeze((this.experiences.get(scopeKey) ?? []).map(item => Object.freeze({ ...item })));
  }

  appendTurn(scopeKey: string, userMessage: string, shannonReply: string, observedAt: string): ShannonExperience {
    const conversation = this.conversations.get(scopeKey) ?? [];
    conversation.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: shannonReply },
    );
    this.conversations.set(scopeKey, conversation.slice(-this.maximumConversationItems));

    const experiences = this.experiences.get(scopeKey) ?? [];
    const sequence = (this.experienceSequences.get(scopeKey) ?? 0) + 1;
    this.experienceSequences.set(scopeKey, sequence);
    const experience: ShannonExperience = Object.freeze({
      id: `${scopeKey}:${observedAt}:${sequence}`,
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
  return `ユーザー: ${user} / Shannon: ${shannon}`;
}
