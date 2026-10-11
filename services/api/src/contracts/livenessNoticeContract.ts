/**
 * The owner-visible notice of a liveness incident (Syzygy ADR-0009 §9, stage 1): one iPhone notification per incident episode,
 * neutral status text, delivered by the existing APNs path. Nothing of it reaches Shannon's mind or her prompts.
 */
export const LIVENESS_EPISODE_TABLE = 'ops_liveness_episodes';
export const LIVENESS_NOTICE_TITLE = 'シャノン · 動作の確認';

const NOTICE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  sleep_stalled: '夜の整理が30時間以上終わっていません。運用画面の「動作の確認」で状況を確かめられます。',
  own_time_stalled: '自分の時間が6時間以上止まっています。運用画面の「動作の確認」で状況を確かめられます。',
  mind_worker_restarting: '心の処理が再起動を繰り返しています。運用画面の「動作の確認」で状況を確かめられます。',
});

/** The notice text of an incident code; a code without text is not announced. */
export function livenessNoticeText(incident: string): string | null {
  return Object.hasOwn(NOTICE_TEXT, incident) ? NOTICE_TEXT[incident]! : null;
}
