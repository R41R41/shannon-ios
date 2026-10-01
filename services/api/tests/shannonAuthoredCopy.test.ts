import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommitmentCommand } from '../src/commitmentCommands.js';
import { createInitialCompanionState } from '@shannon/cognition';
import { notificationBody } from '../src/pushNotificationSender.js';
import { groundedWorldOpening } from '../src/worldInterestRelevance.js';

/**
 * Files whose Japanese string literals are spoken or shown as Shannon herself
 * (command replies, initiative messages, notifications, waiting phrases).
 * System status and error codes live elsewhere and stay neutral UI text.
 */
const SHANNON_VOICE_SOURCES = [
  'conversationCommands.ts', 'commitmentCommands.ts', 'conversationOrganize.ts', 'memoryForgetCommand.ts',
  'conversationReference.ts', 'initiativeStore.ts', 'initiativeIntentCandidates.ts', 'pushNotifications.ts',
  'pushNotificationSender.ts', 'voiceWaitingCue.ts', 'autonomyAnnouncer.ts', 'autonomyShowing.ts', 'bodyNudges.ts',
];

// Casual sentence endings, second-person あなた, and third-person self-reference in her own speech.
const OUT_OF_CHARACTER = [
  /(?:だよ|るよ|たよ|いよ|てね|だね|てる|った)[。？]/u,
  /(?:[るた]|くれる)？/u,
  /あなた|ほいさ/u,
  /シャノン(?:自身)?が気になった/u,
];

describe('sentences authored as Shannon', () => {
  it('stay in です・ます, call the owner ライ氏, and never say あなた', () => {
    const offenders: string[] = [];
    for (const file of SHANNON_VOICE_SOURCES) {
      const lines = readFileSync(join(import.meta.dirname, '../src', file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Only quoted text is checked; recognition patterns for the owner's words are regex literals.
        // 「…」 inside a sentence quotes the owner's own words or a title, so it is skipped.
        const quoted = (line.match(/'[^'\n]*'|`[^`\n]*`/gu) ?? []).join(' ').replace(/「[^」]*」/gu, '「」');
        if (OUT_OF_CHARACTER.some(pattern => pattern.test(quoted))) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('speaks fixed fallbacks in the same voice', () => {
    expect(notificationBody('')).toBe('少し話したいことがあります。');
    expect(groundedWorldOpening(undefined, '記事', null)).toBe('これ、少し気になりました。');
    const state = createInitialCompanionState('owner', '2026-10-01T00:00:00.000Z');
    expect(resolveCommitmentCommand(state, 'あの約束を完了にして'))
      .toEqual({ clarification: 'どの約束のことか、約束の内容を短く教えてもらえますか。まだ変更していません。' });
  });

  it('keeps every waiting phrase polite', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/voiceWaitingCue.ts'), 'utf8');
    const phrases = [...source.matchAll(/(?:steady|warm|lively): '([^']+)'/gu)].map(match => match[1]!)
      .filter(phrase => /[ぁ-ん]/u.test(phrase));
    expect(phrases).toHaveLength(48);
    for (const phrase of phrases) expect(phrase, phrase).toMatch(/(?:ます|ますね|です|ですね)。$/u);
  });
});
