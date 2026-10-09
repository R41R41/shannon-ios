import type { ToolInputProperty } from './shannonTools.js';
/** Optional fields keep the short query-only call valid. Dates are instants; before is exclusive. */
export const SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  match: { type: 'string', description: 'phrase（語句そのまま）、all（空白で分けた全語）、any（いずれかの語）', enum: ['phrase', 'all', 'any'] },
  after: { type: 'string', description: 'この日時以降。ISO 8601の日時とタイムゾーン（例: 2026-10-01T00:00:00+09:00）', maxLength: 40 },
  before: { type: 'string', description: 'この日時より前。ISO 8601の日時とタイムゾーン', maxLength: 40 },
  offset: { type: 'integer', description: '結果の先頭から飛ばす件数。範囲・条件は前回と同じにする', minimum: 0, maximum: 1000 },
  order: { type: 'string', description: 'relevance（関連度）、newest（新しい順）、oldest（古い順）。変更時刻で並べる', enum: ['relevance', 'newest', 'oldest'] },
});

export const SCHEDULE_SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  query: { type: 'string', description: '予定・約束・タスクの題名と場所。空白で分けた全語で絞る', maxLength: 160 },
      kind: { type: 'string', description: 'calendar（カレンダー）、promise（約束）、task（Voyagerタスク）', enum: ['calendar', 'promise', 'task'] },
      after: SEARCH_INPUTS.after!, before: SEARCH_INPUTS.before!, offset: SEARCH_INPUTS.offset!,
      limit: { type: 'integer', description: '最大件数（1〜50）。受信済みの範囲だけ。期間指定は現在から31日先まで', minimum: 1, maximum: 50 }, 
});

export const STUDY_SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  ...SEARCH_INPUTS,
      field: { type: 'string', description: 'title（題名）、body（本文）、both（両方。省略時）', enum: ['title', 'body', 'both'] },
      kind: { type: 'string', description: 'story（物語）か note（メモ）', enum: ['story', 'note'] },
      status: { type: 'string', description: '工程で絞る', enum: ['draft', 'ready', 'shown', 'put_away'] },
      });
