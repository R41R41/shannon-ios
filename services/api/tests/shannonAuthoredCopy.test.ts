import { describe, expect, it } from 'vitest';
import { resolveCommitmentCommand } from '../src/mind/action/respond/commitmentCommands.js';
import { createInitialCompanionState } from '@shannon/cognition';
import { notificationBody } from '../src/surfaces/outreach/pushNotificationSender.js';
import { groundedWorldOpening } from '../src/integrations/world/worldInterestRelevance.js';
import { readApiSource } from './support/sources.js';

/**
 * Files whose Japanese string literals are spoken or shown as Shannon herself
 * (command replies, initiative messages, notifications, waiting phrases).
 * System status and error codes live elsewhere and stay neutral UI text.
 * Where a file was split (Syzygy ADR-0008 stage 3, S2), the part that holds the words is listed (`pushNotificationStore.ts`,
 * `autonomyAnnouncerStore.ts`), not the file that re-exports it; every listed file must hold quoted Japanese (the test below).
 */
const SHANNON_VOICE_SOURCES = [
  'conversationCommands.ts', 'commitmentCommands.ts', 'conversationOrganize.ts', 'memoryForgetCommand.ts',
  'conversationReference.ts', 'initiativeStore.ts', 'initiativeIntentCandidates.ts', 'pushNotificationStore.ts',
  'pushNotificationSender.ts', 'voiceWaitingCue.ts', 'autonomyAnnouncerStore.ts', 'autonomyShowing.ts', 'bodyLookLines.ts',
];

// Casual sentence endings, second-person あなた, and third-person self-reference in her own speech.
const OUT_OF_CHARACTER = [
  /(?:だよ|るよ|たよ|いよ|てね|だね|てる|った)[。？]/u,
  /(?:[るた]|くれる)？/u,
  /あなた|ほいさ/u,
  /シャノン(?:自身)?が気になった/u,
];

describe('sentences authored as Shannon', () => {
  it('lists only files that hold her words, so the check below cannot go vacuous after a split', () => {
    const empty = SHANNON_VOICE_SOURCES.filter(file => !readApiSource(file).split('\n')
      .some(line => (line.match(/'[^'\n]*'|`[^`\n]*`/gu) ?? []).some(quoted => /[ぁ-んァ-ヶ]/u.test(quoted))));
    expect(empty).toEqual([]);
  });

  it('stay in です・ます, call the owner ライ氏, and never say あなた', () => {
    const offenders: string[] = [];
    expect(SHANNON_VOICE_SOURCES.length).toBeGreaterThan(0);
    for (const file of SHANNON_VOICE_SOURCES) {
      const lines = readApiSource(file).split('\n');
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
    const source = readApiSource('voiceWaitingCue.ts');
    const phrases = [...source.matchAll(/(?:steady|warm|lively): '([^']+)'/gu)].map(match => match[1]!)
      .filter(phrase => /[ぁ-ん]/u.test(phrase));
    expect(phrases).toHaveLength(21); // External lookups only (owner feedback 2026-10-13): seven categories, three wordings each.
    for (const phrase of phrases) expect(phrase, phrase).toMatch(/(?:ます|ますね|です|ですね)。$/u);
  });
});
