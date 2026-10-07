/** The words and limits of her study (Syzygy ADR-0008 stage 3, S2: moved unchanged out of the study store, so her tools read them without reaching a store). */
import type { StudyPieceKind, StudyPieceStatus } from './store/studyStore.js';

export const STUDY_STATUS_LABEL: Readonly<Record<StudyPieceStatus, string>> = Object.freeze({
  draft: '下書き', ready: '見せてもいい', shown: '見せた', put_away: 'しまった',
});

export const STUDY_KIND_LABEL: Readonly<Record<StudyPieceKind, string>> = Object.freeze({ story: '物語', note: 'メモ' });

export const STUDY_LIMITS = Object.freeze({
  title: 80, storyBody: 4_000, noteBody: 1_200, changeNote: 400, comment: 400, sources: 8, sourceTitle: 160, sourceUrl: 2_000,
  /** Stories that may be open (下書き or 見せてもいい) at once. */
  openStories: 12,
  /** Reactions kept unread per piece; more than this and the oldest stay but no new one is taken. */
  pendingFeedback: 6,
});
