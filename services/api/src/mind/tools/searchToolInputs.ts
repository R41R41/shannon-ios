import type { ToolInputProperty } from './shannonTools.js';
/** Optional fields keep the short query-only call valid. Dates are instants; before is exclusive. */
export const SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  match: { type: 'string', description: 'phrase（語句そのまま）、all（空白で分けた全語）、any（いずれかの語）', enum: ['phrase', 'all', 'any'] },
  after: { type: 'string', description: 'この日時以降。ISO 8601の日時とタイムゾーン（例: 2026-10-01T00:00:00+09:00）', maxLength: 40 },
  before: { type: 'string', description: 'この日時より前。ISO 8601の日時とタイムゾーン', maxLength: 40 },
  offset: { type: 'integer', description: '結果の先頭から飛ばす件数。範囲・条件は前回と同じにする', minimum: 0, maximum: 1000 },
  order: { type: 'string', description: 'relevance（関連度）、newest（新しい順）、oldest（古い順）。変更時刻で並べる', enum: ['relevance', 'newest', 'oldest'] },
});

const WHEN: ToolInputProperty = { type: 'string', description: '期間をライ氏の言葉のまま（例: 来週の水曜の午後、今週末、10月30日の15時から17時）。今日から31日先まで', maxLength: 60 };
const AFTER: ToolInputProperty = { ...SEARCH_INPUTS.after!, description: 'when で書けない時だけ: この日時以降（ISO 8601、タイムゾーンつき）' } as ToolInputProperty;

export const SCHEDULE_SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  when: WHEN,
  query: { type: 'string', description: '題名・場所・参加者・カレンダー名の言葉。空白で分けた全語で絞る', maxLength: 160 },
  who: { type: 'string', description: '一緒の人の名前（参加者と題名を見る）', maxLength: 80 },
  place: { type: 'string', description: '場所の言葉', maxLength: 80 },
  calendar: { type: 'string', description: 'カレンダーの名前（例: 仕事）。読点で区切るといずれか', maxLength: 80 },
  kind: { type: 'string', description: 'calendar（カレンダー）、promise（約束）、task（Voyagerタスク）', enum: ['calendar', 'promise', 'task'] },
  after: AFTER, before: SEARCH_INPUTS.before!, offset: SEARCH_INPUTS.offset!,
  limit: { type: 'integer', description: '最大件数（1〜50。書かなければ12）', minimum: 1, maximum: 50 },
  range: { type: 'string', description: 'when がない時の長さ: day（48時間。ふだんはこれ）か week（8日）', enum: ['day', 'week'] },
});

/** The schedule tools' descriptions (the registry appends its read rule) and their one-line summaries. */
export const SCHEDULE_DESCRIPTIONS = Object.freeze({
  upcoming: 'ライ氏の予定・期日のある約束・日付のあるタスクを見る・探す（見るだけ）。期間は when にライ氏の言葉のまま書く。'
    + 'query・who・place・calendar で絞れる。カレンダーはアプリが共有している分だけ分かる。',
  free: 'ライ氏の空いている時間を、カレンダーの予定の間から探す（見るだけ）。終日の予定・約束・移動の時間は数えない。',
});
export const SCHEDULE_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  'schedule.upcoming': 'ライ氏の予定と約束を期間・人・場所・カレンダーで探す', 'schedule.free_time': 'ライ氏の空いている時間を探す',
});

export const SCHEDULE_FREE_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  when: { ...WHEN, description: '探す期間をライ氏の言葉のまま（例: 来週の午後、明日）。書かなければ今日から7日' } as ToolInputProperty,
  after: AFTER, before: SEARCH_INPUTS.before!,
  minMinutes: { type: 'integer', description: '要る長さ（分）。書かなければ30', minimum: 5, maximum: 720 },
  fromHour: { type: 'integer', description: '各日の何時から探すか。書かなければ when の時間帯か9時', minimum: 0, maximum: 23 },
  toHour: { type: 'integer', description: '各日の何時までか（24まで）。書かなければ when の時間帯か21時', minimum: 1, maximum: 24 },
});

export const STUDY_SEARCH_INPUTS: Readonly<Record<string, ToolInputProperty>> = Object.freeze({
  ...SEARCH_INPUTS,
      field: { type: 'string', description: 'title（題名）、body（本文）、both（両方。省略時）', enum: ['title', 'body', 'both'] },
      kind: { type: 'string', description: 'story（物語）か note（メモ）', enum: ['story', 'note'] },
      status: { type: 'string', description: '工程で絞る', enum: ['draft', 'ready', 'shown', 'put_away'] },
      });
