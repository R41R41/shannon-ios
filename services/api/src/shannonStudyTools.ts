import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { numberInput, stringInput, type ToolInput } from './shannonToolInput.js';
import { clip, type PreparedToolCall, type ToolExecutionContext, type ToolExecutor, type ToolRun } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ToolResult } from './shannonTools.js';
import {
  STUDY_KIND_LABEL, STUDY_LIMITS, STUDY_STATUS_LABEL,
  type StudyPiece, type StudyPieceStatus, type StudyRejection,
} from './studyStore.js';

/**
 * The study tools (`study.*` in `shannonTools.ts`): her own study, fully server-side and immediate.
 *
 * Her study is hers (owner decision 2026-10-05): she reads every piece, also a story she has not shown, one she
 * or the owner put away, and one in her trash. The canonical store stays the SQLite study with its versions,
 * 「見せてもいい」 and the owner's reactions. Nothing here shows a story to the owner or marks it 「見せてもいい」:
 * that stays the `ready` step of her own time (ADR-0002), so there is no new outward path.
 *
 * What reaches the activity record (which the owner reads) never carries text of hers, and names a story only
 * while the owner can read the version it names; otherwise it says 「まだ見せていない物語」.
 */
export function studyExecutors(store: SQLiteAutonomyStore, now: () => string): Readonly<Record<string, ToolExecutor>> {
  const piece = (context: ToolExecutionContext, input: ToolInput, includeDeleted = false): StudyPiece | ToolResult => {
    const id = stringInput(input, 'id')?.trim() ?? '';
    return store.study.find(context.scopeKey, id, includeDeleted)
      ?? toolFailure('not_found', `id「${clip(id, 40)}」のものは書斎に${includeDeleted ? '' : '（ゴミ箱の外に）'}ない。study.list で確かめる。`, { retryable: false });
  };
  const immediate = (summary: string, run: () => ToolRun): PreparedToolCall => ({ summary, run: async () => run() });
  /** A write: `text` is what she reads, `record` what the owner's record says; `newId` adds the id the write made. */
  const write = (summary: string, text: string, record: string, apply: () => StudyPiece | StudyRejection, options: { link?: string; newId?: true } = {}): PreparedToolCall =>
    immediate(summary, () => ({
      result: toolOk(text), record: { summary: record, outcome: 'done', ...(options.link ? { link: options.link } : {}) },
      apply: () => {
        const outcome = apply();
        if (typeof outcome === 'string') throw new Error(outcome);
        return options.newId ? `id: ${outcome.id}` : undefined;
      },
    }));

  return Object.freeze({
    'study.list': (input, context) => {
      const status = stringInput(input, 'status');
      const kind = stringInput(input, 'kind');
      const query = stringInput(input, 'query')?.trim().toLowerCase();
      const limit = numberInput(input, 'limit') ?? 20;
      const all = store.study.list(context.scopeKey, 500, status === 'deleted' ? 'only' : 'exclude')
        .filter(item => (!kind || item.kind === kind) && (!status || status === 'deleted' || item.status === status)
          && (!query || item.title.toLowerCase().includes(query)));
      return immediate('書斎の一覧を見ます。', () => ({
        result: toolOk(all.length ? [`${all.length}件${all.length > limit ? `（新しい順に${limit}件）` : ''}:`, ...all.slice(0, limit).map(pieceLine)].join('\n') : '当てはまるものはない。'),
        record: { summary: '書斎の一覧を見ました。', outcome: 'done' },
      }));
    },
    'study.search': (input, context) => {
      const query = stringInput(input, 'query')!.trim();
      const limit = numberInput(input, 'limit') ?? 10;
      const found = store.study.search(context.scopeKey, query, limit, input.includeDeleted === true ? 'include' : 'exclude');
      return immediate('書斎の中を探します。', () => ({
        result: toolOk(found.length ? [`${found.length}件:`, ...found.map(item => `${pieceLine(item)}\n  …${snippet(`${item.title}\n${item.body}`, query)}…`)].join('\n') : `「${clip(query, 40)}」は見つからなかった。`),
        record: { summary: `書斎の中を探しました（${found.length}件）。`, outcome: 'done' },
      }));
    },
    'study.read': (input, context) => {
      const found = piece(context, input, true);
      if (!('id' in found)) return found;
      const versions = store.study.versions(context.scopeKey, found.id);
      const asked = numberInput(input, 'version');
      const version = asked === undefined ? null : versions.find(item => item.version === asked);
      if (asked !== undefined && !version) return toolFailure('not_found', `第${asked}稿はない（第1〜${found.version}稿）。`, { retryable: false });
      const title = version?.title ?? found.title;
      const body = version?.body ?? found.body;
      return immediate(`書斎の${STUDY_KIND_LABEL[found.kind]}を1つ読みます。`, () => ({
        result: toolOk([
          pieceLine(found),
          `読んでいる版: 第${version?.version ?? found.version}稿${found.readableVersion !== null ? `（ライ氏が読めるのは第${found.readableVersion}稿）` : '（ライ氏にはまだ見せていない）'}`,
          `題名: ${title}`, '本文:', body,
          ...(found.sources.length ? ['出典:', ...found.sources.map(source => `- ${source.title} ${source.url}`)] : []),
          '版の一覧:', ...versions.map(item => `- 第${item.version}稿（${item.createdAt.slice(0, 10)}）: ${clip(item.changeNote, 120)}`),
        ].join('\n')),
        record: { summary: `書斎の${recordLabel(found)}を読みました。`, outcome: 'done', link: `shannon-study://${found.id}` },
      }));
    },
    'study.create': (input, context) => {
      const kind = stringInput(input, 'kind') === 'story' ? 'story' : 'note';
      const body = stringInput(input, 'body')!;
      const maximum = kind === 'story' ? STUDY_LIMITS.storyBody : STUDY_LIMITS.noteBody;
      if (body.trim().length > maximum) return toolFailure('invalid_input', `${STUDY_KIND_LABEL[kind]}の本文は${maximum}字まで（いま${body.trim().length}字）。`, { retryable: false });
      const pursuitId = stringInput(input, 'pursuitId')?.trim();
      if (pursuitId && !store.pursuits.get(context.scopeKey, pursuitId)) return toolFailure('not_found', `台帳に id「${clip(pursuitId, 40)}」のやりたいことはない。`, { retryable: false });
      if (kind === 'story' && openStories(store, context.scopeKey) >= STUDY_LIMITS.openStories) {
        return toolFailure('limit', `書きかけの物語が${STUDY_LIMITS.openStories}本あって、もう置けない。`, { retryable: false, refusal: { why: '書きかけの物語の上限', wouldWork: 'どれかをしまうか、ゴミ箱に入れてから' } });
      }
      const title = stringInput(input, 'title')!;
      const changeNote = stringInput(input, 'changeNote');
      return write(`書斎に${STUDY_KIND_LABEL[kind]}を1つ書きます。`,
        `${STUDY_KIND_LABEL[kind]}「${clip(title, 60)}」を書斎に書いた。${kind === 'story' ? '下書きなので、ライ氏にはまだ見えない。' : ''}`,
        kind === 'story' ? '書斎に物語の下書きを1つ書きました。' : `書斎にメモ「${clip(title, 60)}」を書きました。`,
        () => store.study.create(context.scopeKey, { kind, title, body, ...(changeNote ? { changeNote } : {}), ...(pursuitId ? { pursuitId } : {}) }, now()), { newId: true });
    },
    'study.update': (input, context) => revise(context, input, {
      body: stringInput(input, 'body')!, title: stringInput(input, 'title')?.trim() || undefined, changeNote: stringInput(input, 'changeNote')!,
    }, '書き直した'),
    'study.rename': (input, context) => {
      const found = piece(context, input);
      if (!('id' in found)) return found;
      const title = stringInput(input, 'title')!.trim();
      return revise(context, input, { body: found.body, title, changeNote: `題名を「${clip(found.title, 60)}」から「${clip(title, 60)}」に変えました。` }, '題名を変えた');
    },
    'study.move': (input, context) => {
      const found = piece(context, input);
      if (!('id' in found)) return found;
      const to = stringInput(input, 'to');
      const link = `shannon-study://${found.id}`;
      if (to === 'put_away') {
        if (found.status === 'put_away') return toolOk('もうしまってある。');
        return write('書斎のものを1つしまいます。', 'しまった。中身と版は残っていて、take_back で戻せる。',
          `書斎の${recordLabel(found)}をしまいました。`, () => store.study.putAway(context.scopeKey, found.id, 'shannon', now()), { link });
      }
      if (to === 'take_back') {
        if (found.status !== 'put_away') return toolOk('しまってはいない。');
        // What the owner asked her to put away comes back out only when he is the one asking now.
        if (found.putAwayBy === 'owner' && context.surface === 'autonomy') {
          return toolFailure('refused', 'ライ氏がしまうよう頼んだものは、自分の時間には戻さない。', { retryable: false, refusal: { why: 'ライ氏がしまうよう頼んだもの', wouldWork: 'ライ氏との会話で、戻してと言われた時' } });
        }
        if (found.kind === 'story' && openStories(store, context.scopeKey) >= STUDY_LIMITS.openStories) {
          return toolFailure('limit', `書きかけの物語が${STUDY_LIMITS.openStories}本あって、戻せない。`, { retryable: false, refusal: { why: '書きかけの物語の上限', wouldWork: 'どれかをしまってから' } });
        }
        return write('しまったものを1つ戻します。', found.kind === 'story' ? '下書きとして戻した。' : 'メモとして戻した。',
          `しまってあった${recordLabel(found)}を戻しました。`, () => store.study.takeBack(context.scopeKey, found.id, now()), { link });
      }
      const pursuitId = stringInput(input, 'pursuitId')?.trim() ?? '';
      if (pursuitId && !store.pursuits.get(context.scopeKey, pursuitId)) return toolFailure('not_found', `台帳に id「${clip(pursuitId, 40)}」のやりたいことはない。`, { retryable: false });
      return write('書斎のものの棚を変えます。', pursuitId ? 'やりたいことの棚を変えた。' : '棚から外した。',
        `書斎の${recordLabel(found)}の棚を変えました。`, () => store.study.setPursuit(context.scopeKey, found.id, pursuitId || null, now()), { link });
    },
    'study.delete': (input, context) => {
      const found = piece(context, input);
      if (!('id' in found)) return found;
      return write('書斎のものを1つゴミ箱に入れます。', 'ゴミ箱に入れた。版も残っていて、study.restore で戻せる。',
        `書斎の${recordLabel(found)}をゴミ箱に入れました。`, () => store.study.softDelete(context.scopeKey, found.id, now()), { link: `shannon-study://${found.id}` });
    },
    'study.restore': (input, context) => {
      const found = piece(context, input, true);
      if (!('id' in found)) return found;
      if (!found.deletedAt) return toolOk('ゴミ箱には入っていない。');
      if (found.kind === 'story' && (found.status === 'draft' || found.status === 'ready') && openStories(store, context.scopeKey) >= STUDY_LIMITS.openStories) {
        return toolFailure('limit', `書きかけの物語が${STUDY_LIMITS.openStories}本あって、戻せない。`, { retryable: false, refusal: { why: '書きかけの物語の上限', wouldWork: 'どれかをしまってから' } });
      }
      return write('ゴミ箱から1つ戻します。', 'ゴミ箱から戻した。', `書斎の${recordLabel(found)}をゴミ箱から戻しました。`,
        () => store.study.restore(context.scopeKey, found.id, now()), { link: `shannon-study://${found.id}` });
    },
  });

  function revise(context: ToolExecutionContext, input: ToolInput, change: { body: string; title?: string; changeNote: string }, done: string): PreparedToolCall | ToolResult {
    const found = piece(context, input);
    if (!('id' in found)) return found;
    if (found.status === 'put_away') return toolFailure('conflict', 'しまってあるので直せない。先に study.move で take_back する。', { retryable: false });
    const maximum = found.kind === 'story' ? STUDY_LIMITS.storyBody : STUDY_LIMITS.noteBody;
    if (change.body.trim().length > maximum) return toolFailure('invalid_input', `${STUDY_KIND_LABEL[found.kind]}の本文は${maximum}字まで（いま${change.body.trim().length}字）。`, { retryable: false });
    return write(`書斎の${STUDY_KIND_LABEL[found.kind]}を直します。`,
      `${done}（第${found.version + 1}稿）。${found.kind === 'story' ? '物語は下書きに戻った。ライ氏は見せた版を読み続ける。' : ''}`,
      `書斎の${recordLabel(found)}を直しました（第${found.version + 1}稿）。`,
      () => store.study.revise(context.scopeKey, found.id, change, now()), { link: `shannon-study://${found.id}` });
  }
}

/** One line of a piece for her, with everything she needs to name it in the next call. */
function pieceLine(item: StudyPiece): string {
  const status: StudyPieceStatus = item.status;
  return `- id: ${item.id}｜${STUDY_KIND_LABEL[item.kind]}「${clip(item.title, 60)}」｜${STUDY_STATUS_LABEL[status]}${item.deletedAt ? '・ゴミ箱' : ''}｜第${item.version}稿｜${item.body.length}字｜更新 ${item.updatedAt.slice(0, 10)}${item.pursuitId ? `｜棚 ${item.pursuitId}` : ''}`;
}

/** The piece as the owner's record may name it: a story's title only while he can read that version. */
function recordLabel(item: StudyPiece): string {
  if (item.kind === 'note' || item.readableVersion === item.version) return `${STUDY_KIND_LABEL[item.kind]}「${clip(item.title, 60)}」`;
  return 'まだ見せていない物語';
}

function openStories(store: SQLiteAutonomyStore, scopeKey: string): number {
  return store.study.list(scopeKey, 500).filter(item => item.kind === 'story' && (item.status === 'draft' || item.status === 'ready')).length;
}

function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/gu, ' ');
  const at = Math.max(0, flat.toLowerCase().indexOf(query.toLowerCase()));
  return flat.slice(Math.max(0, at - 50), at + query.length + 60);
}
