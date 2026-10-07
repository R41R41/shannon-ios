import { randomUUID } from 'node:crypto';
import { aetherErrorCode, type AetherWriteResult } from '../../integrations/aether/aetherAccess.js';
import type { SQLiteAutonomyStore } from '../action/ownTime/store/autonomyStore.js';
import { aetherToolFailure } from './shannonAetherTools.js';
import { numberInput, stringInput, type ToolInput } from './shannonToolInput.js';
import { clip, type PreparedToolCall, type ToolExecutionContext, type ToolExecutor, type ToolRun } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ShannonToolDefinition, type ToolResult } from './shannonTools.js';
import { studyWriteKey, syncedWithin, type StudyAether } from '../action/ownTime/studyAether.js';
import { type StudyPiece, type StudyPieceKind, type StudyPieceStatus, type StudyRejection } from '../action/ownTime/store/studyStore.js';
import { STUDY_KIND_LABEL, STUDY_LIMITS, STUDY_STATUS_LABEL } from '../action/ownTime/studyPorts.js';

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
 *
 * With Aether configured (`aether`, Syzygy ADR-0007 revised) every call first brings in what Aether has (`StudyAether.sync`),
 * a new piece is written to Aether first (a story with `inStudy: true`, a note with `false`), and a piece that lives there is
 * revised and deleted there first, with its version as `baseVersion`; the local version and its link follow in the same
 * transaction as the record. A piece that has not moved yet is written here only, as before.
 */
const DUPLICATE_MILLISECONDS = 15 * 60_000;
/** What a call may spend bringing in Aether before it goes on with what Shannon has. */
const SYNC_MILLISECONDS = 4_000;

export function studyExecutors(store: SQLiteAutonomyStore, now: () => string, aether: StudyAether | null = null): Readonly<Record<string, ToolExecutor>> {
  // Her study is in Aether for one scope only (the owner's, `aetherStudyScope`); every other scope keeps the SQLite study.
  const local = buildStudyExecutors(store, now, null);
  if (!aether) return local;
  const remote = buildStudyExecutors(store, now, aether);
  return Object.freeze(Object.fromEntries(Object.keys(local).map(name => [name,
    ((input, context) => (aether.covers(context.scopeKey) ? remote : local)[name]!(input, context)) satisfies ToolExecutor])));
}

function buildStudyExecutors(store: SQLiteAutonomyStore, now: () => string, aether: StudyAether | null): Readonly<Record<string, ToolExecutor>> {
  /** What each owner message's turns created, for a retry of the same message (in this process, 15 minutes). */
  const recent = new Map<string, { id: string; title: string; at: number }[]>();
  /** Parts appended for each owner message (in this process, 15 minutes), so a retry does not append them twice. */
  const appended = new Map<string, number>();
  /**
   * The piece she names by id or by title (2026-10-05, Build 138: she knew 『名脇役のハッチを叩いて』 only by its title and
   * could not read it). An id first, then the exact title, then a title that matches once width, spacing, case and the
   * quotes 『』「」 around it are set aside. Two pieces under one title are not guessed: she is given both with their ids.
   */
  const piece = (context: ToolExecutionContext, input: ToolInput, includeDeleted = false, prefer: 'live' | 'trashed' = 'live'): StudyPiece | ToolResult => {
    const named = stringInput(input, 'id')?.trim() ?? '';
    const byId = named ? store.study.find(context.scopeKey, named, includeDeleted) : null;
    if (byId) return byId;
    const pieces = store.study.list(context.scopeKey, 500, includeDeleted ? 'include' : 'exclude');
    const exact = pieces.filter(item => item.title.trim() === named);
    const all = exact.length ? exact : pieces.filter(item => titleKey(item.title) === titleKey(named) && titleKey(named) !== '');
    // One live and one trashed piece under a title: restoring means the one in the trash, everything else the live one.
    const preferred = all.filter(item => (prefer === 'trashed') === Boolean(item.deletedAt));
    const matches = all.length > 1 && preferred.length ? preferred : all;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      return toolFailure('conflict', [`題名「${clip(named, 60)}」のものが${matches.length}つある。どれかの id で呼び直す:`, ...matches.slice(0, 10).map(pieceLine)].join('\n'),
        { retryable: false, refusal: { why: '同じ題名のものが複数ある', wouldWork: 'id を書いて呼び直す' } });
    }
    return toolFailure('not_found', `id か題名が「${clip(named, 40)}」のものは書斎に${includeDeleted ? '' : '（ゴミ箱の外に）'}ない。study.list で確かめる。`,
      { retryable: false, refusal: { why: 'その id や題名のものがない', wouldWork: 'study.list で id と題名を確かめて呼び直す' } });
  };
  const immediate = (summary: string, run: () => ToolRun): PreparedToolCall => ({ summary, run: async () => run() });
  /**
   * A write: `text` is what she reads, `record` what the owner's record says; `newId` adds the id the write made. With
   * `aether` the write goes to Aether first; what Aether refused writes nothing here, and what it took is linked in `apply`.
   */
  const write = (summary: string, text: string, record: string, apply: () => StudyPiece | StudyRejection,
    options: { link?: string; newId?: true; text?: true; early?: (documentIds: readonly string[]) => void; aether?: { scopeKey: string; push: (signal?: AbortSignal) => Promise<AetherWriteResult | null> } } = {}): PreparedToolCall => ({
    summary, run: async signal => {
      let pushed: AetherWriteResult | null = null;
      try { pushed = options.aether && aether ? await options.aether.push(signal) : null; } catch (error) {
        return { result: aetherToolFailure(error), record: { summary: 'Aetherの書斎に書こうとしましたが、できませんでした。', outcome: 'failed', reasonCode: `aether_${aetherErrorCode(error).toLowerCase()}` } };
      }
      if (pushed && options.text) options.early?.([pushed.documentId]);
      // A write of her words (`text`) names the piece it wrote, for the provenance mark of her own time; filled in by `apply`.
      const wrote: string[] = [];
      return {
        result: toolOk(text), record: { summary: record, outcome: 'done', ...(options.link ? { link: options.link } : {}) },
        ...(options.text ? { documents: { wrote } } : {}),
        apply: () => {
          const outcome = apply();
          if (typeof outcome === 'string') throw new Error(outcome);
          if (pushed && aether && options.aether) aether.commit(options.aether.scopeKey, outcome, pushed);
          wrote.push(`shannon-study://${outcome.id}`, ...(pushed ? [pushed.documentId] : []));
          return options.newId ? `id: ${outcome.id}` : undefined;
        },
      };
    },
  });
  /** The same write retried (the same owner message and input) is the same Aether write; any other is another. */
  const key = (context: ToolExecutionContext, name: string, input: ToolInput) => studyWriteKey(context.scopeKey, context.memory.turnKey ?? randomUUID(), name, JSON.stringify(input));

  const executors: Readonly<Record<string, ToolExecutor>> = Object.freeze({
    'study.list': (input, context) => {
      const status = stringInput(input, 'status');
      const kind = stringInput(input, 'kind');
      const query = stringInput(input, 'query')?.trim().toLowerCase();
      const limit = numberInput(input, 'limit') ?? 20;
      const all = store.study.list(context.scopeKey, 500, status === 'deleted' ? 'only' : 'exclude')
        .filter(item => (!kind || item.kind === kind) && (!status || status === 'deleted' || item.status === status)
          && (!query || item.title.toLowerCase().includes(query)) && !context.unlisted?.(`shannon-study://${item.id}`));
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
        result: toolOk(found.length ? [`${found.length}件:`, ...found.map(item => `${pieceLine(item)}\n  …${snippet(`${item.title}\n${item.body}`, query)}…${item.origin === 'room_look' ? ROOM_LOOK_MARK : ''}`)].join('\n') : `「${clip(query, 40)}」は見つからなかった。`),
        record: { summary: `書斎の中を探しました（${found.length}件）。`, outcome: 'done' },
        documents: { read: found.map(item => `shannon-study://${item.id}`) },
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
          ...(found.origin === 'room_look' ? [ROOM_LOOK_MARK] : []),
          ...(found.sources.length ? ['出典:', ...found.sources.map(source => `- ${source.title} ${source.url}`)] : []),
          '版の一覧:', ...versions.map(item => `- 第${item.version}稿（${item.createdAt.slice(0, 10)}）: ${clip(item.changeNote, 120)}`),
        ].join('\n')),
        record: { summary: `書斎の${recordLabel(found)}を読みました。`, outcome: 'done', link: `shannon-study://${found.id}` },
        documents: { read: [`shannon-study://${found.id}`] },
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
      // The same piece asked for twice (within this turn, a retry of the same message, or minutes apart) is one piece.
      const twin = duplicate(context, kind, title, body);
      if (twin) {
        return immediate('書斎に同じものがあるか確かめます。', () => ({
          result: toolOk(`同じものがもう書斎にある（二つにはしなかった）。\n${pieceLine(twin)}`),
          record: { summary: `書斎の${recordLabel(twin)}がもうあったので、同じものは書きませんでした。`, outcome: 'done', link: `shannon-study://${twin.id}` },
        }));
      }
      return write(`書斎に${STUDY_KIND_LABEL[kind]}を1つ書きます。`,
        `${STUDY_KIND_LABEL[kind]}「${clip(title, 60)}」を書斎に書いた。${kind === 'story' ? '下書きなので、ライ氏にはまだ見えない。' : ''}`,
        kind === 'story' ? '書斎に物語の下書きを1つ書きました。' : `書斎にメモ「${clip(title, 60)}」を書きました。`,
        () => {
          const created = store.study.create(context.scopeKey, { kind, title, body, ...(changeNote ? { changeNote } : {}), ...(pursuitId ? { pursuitId } : {}) }, now());
          if (typeof created !== 'string' && context.memory.turnKey) remember(context.memory.turnKey, created.id, title);
          return created;
        }, { newId: true, text: true, ...(context.informedWrite ? { early: context.informedWrite } : {}), ...(aether ? { aether: { scopeKey: context.scopeKey, push: signal => aether.create(context.scopeKey, { kind, title: title.replace(/\s+/gu, ' ').trim(), body: body.trim(), ...(changeNote ? { changeNote } : {}) }, key(context, 'study.create', input), signal) } } : {}) });
    },
    'study.update': (input, context) => {
      const found = piece(context, input);
      if (!('id' in found)) return found;
      const part = stringInput(input, 'body')!;
      const append = stringInput(input, 'mode') === 'append';
      // The same part appended again for the same owner message (a retry of it) is not appended twice.
      const appendKey = append && context.memory.turnKey ? `${context.memory.turnKey}\n${found.id}\n${part.replace(/\s+/gu, '')}` : null;
      const appendedAt = appendKey ? appended.get(appendKey) : undefined;
      if (appendedAt !== undefined && Date.parse(now()) - appendedAt < DUPLICATE_MILLISECONDS) {
        return toolOk(`この続きはもう足してあった（二度は足さなかった）。\n${pieceLine(found)}`);
      }
      const revised = revise(context, input, {
        body: append ? `${found.body}${/^\s/u.test(part) ? '' : '\n\n'}${part}` : part,
        title: stringInput(input, 'title')?.trim() || undefined, changeNote: stringInput(input, 'changeNote')!,
      }, append ? '続きを足した' : '書き直した');
      if (!appendKey || !('run' in revised)) return revised;
      return { ...revised, run: async signal => {
        const run = await revised.run(signal);
        const apply = run.apply;
        return apply ? { ...run, apply: () => {
          const line = apply();
          const at = Date.parse(now());
          for (const [key, when] of appended) if (at - when >= DUPLICATE_MILLISECONDS) appended.delete(key);
          appended.set(appendKey, at);
          return line;
        } } : run;
      } };
    },
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
      const linked = aether?.link(context.scopeKey, found.id);
      return write('書斎のものを1つゴミ箱に入れます。', linked ? 'ゴミ箱に入れた。Aetherでは「最近削除した項目」に移り、戻せるのはライ氏（iPhone）。版はボクの中にも残る。' : 'ゴミ箱に入れた。版も残っていて、study.restore で戻せる。',
        `書斎の${recordLabel(found)}をゴミ箱に入れました。`, () => store.study.softDelete(context.scopeKey, found.id, now()),
        { link: `shannon-study://${found.id}`, ...(aether && linked ? { aether: { scopeKey: context.scopeKey, push: signal => aether.remove(context.scopeKey, found, key(context, 'study.delete', input), signal) } } : {}) });
    },
    'study.restore': (input, context) => {
      const found = piece(context, input, true, 'trashed');
      if (!('id' in found)) return found;
      if (!found.deletedAt) return toolOk('ゴミ箱には入っていない。');
      // A piece that lives in Aether comes back only once the owner restored it there (the sync before this call takes it back out).
      if (aether?.link(context.scopeKey, found.id)) {
        return toolFailure('refused', 'Aetherで消されたか、シャノン用フォルダの外に移されている。戻せるのはライ氏だけ。', { retryable: false, refusal: { why: 'Aetherで消されたものは「最近削除した項目」から、フォルダの外に移されたものはフォルダに戻すことで、ライ氏が戻す', wouldWork: 'ライ氏に戻してもらう（戻ると書斎にも戻る）' } });
      }
      if (found.kind === 'story' && (found.status === 'draft' || found.status === 'ready') && openStories(store, context.scopeKey) >= STUDY_LIMITS.openStories) {
        return toolFailure('limit', `書きかけの物語が${STUDY_LIMITS.openStories}本あって、戻せない。`, { retryable: false, refusal: { why: '書きかけの物語の上限', wouldWork: 'どれかをしまってから' } });
      }
      return write('ゴミ箱から1つ戻します。', 'ゴミ箱から戻した。', `書斎の${recordLabel(found)}をゴミ箱から戻しました。`,
        () => store.study.restore(context.scopeKey, found.id, now()), { link: `shannon-study://${found.id}` });
    },
  });
  return aether ? Object.freeze(Object.fromEntries(Object.entries(executors).map(([name, executor]) => [name, synced(aether, name, executor)]))) : executors;

  /**
   * A piece this one would repeat: for the same owner message (a retry of it), the same kind and title with a similar
   * body; or anywhere, the same kind, title and body within 15 minutes. Two different notes under one title are two.
   */
  function duplicate(context: ToolExecutionContext, kind: StudyPieceKind, title: string, body: string): StudyPiece | null {
    const at = Date.parse(now());
    const same = (left: string, right: string) => left.replace(/\s+/gu, '') === right.replace(/\s+/gu, '');
    const earlier = context.memory.turnKey ? (recent.get(context.memory.turnKey) ?? []).filter(item => at - item.at < DUPLICATE_MILLISECONDS && same(item.title, title)) : [];
    for (const item of earlier) {
      const found = store.study.get(context.scopeKey, item.id);
      if (found && found.kind === kind && similarBodies(found.body, body)) return found;
    }
    return store.study.list(context.scopeKey, 50).find(item => item.kind === kind && at - Date.parse(item.createdAt) < DUPLICATE_MILLISECONDS
      && same(item.title, title) && same(item.body, body)) ?? null;
  }

  function remember(turnKey: string, id: string, title: string): void {
    const at = Date.parse(now());
    for (const [key, items] of recent) if (items.every(item => at - item.at >= DUPLICATE_MILLISECONDS)) recent.delete(key);
    recent.set(turnKey, [...(recent.get(turnKey) ?? []), { id, title, at }].slice(-10));
  }

  function revise(context: ToolExecutionContext, input: ToolInput, change: { body: string; title?: string; changeNote: string }, done: string): PreparedToolCall | ToolResult {
    const found = piece(context, input);
    if (!('id' in found)) return found;
    if (found.status === 'put_away') return toolFailure('conflict', 'しまってあるので直せない。先に study.move で take_back する。', { retryable: false });
    const maximum = found.kind === 'story' ? STUDY_LIMITS.storyBody : STUDY_LIMITS.noteBody;
    if (change.body.trim().length > maximum) return toolFailure('invalid_input', `${STUDY_KIND_LABEL[found.kind]}の本文は${maximum}字まで（いま${change.body.trim().length}字）。`, { retryable: false });
    return write(`書斎の${STUDY_KIND_LABEL[found.kind]}を直します。`,
      `${done}（第${found.version + 1}稿）。${found.kind === 'story' ? '物語は下書きに戻った。ライ氏は見せた版を読み続ける。' : ''}`,
      `書斎の${recordLabel(found)}を直しました（第${found.version + 1}稿）。`,
      () => store.study.revise(context.scopeKey, found.id, change, now()), { link: `shannon-study://${found.id}`, text: true, ...(context.informedWrite ? { early: context.informedWrite } : {}), ...(aether ? { aether: {
        scopeKey: context.scopeKey,
        push: (signal?: AbortSignal) => aether.update(context.scopeKey, found, { body: change.body.trim(), changeNote: change.changeNote, ...(change.title ? { title: change.title.replace(/\s+/gu, ' ').trim() } : {}) }, key(context, `study.revise:${found.version}`, input), signal),
      } } : {}) });
  }
}

/**
 * A study tool with Aether: what Aether has is brought in first (within a few seconds), then the call is prepared again from
 * it. When Aether could not be reached, a read answers from what Shannon has and says so; a write to Aether fails on its own.
 */
function synced(aether: StudyAether, name: string, executor: ToolExecutor): ToolExecutor {
  return (input, context) => {
    const first = executor(input, context);
    // A call that cannot work whatever Aether has (an input out of bounds) is answered at once; a piece not found yet may be new in Aether.
    if (!('run' in first) && first.failure !== 'not_found') return first;
    return {
      summary: 'run' in first ? first.summary : '書斎を確かめます。', ...('run' in first && first.folder ? { folder: first.folder } : {}),
      run: async signal => {
        const reached = await syncedWithin(aether, context.scopeKey, Math.min(SYNC_MILLISECONDS, (context.timeMilliseconds ?? 2 * SYNC_MILLISECONDS) / 2), signal);
        const again = executor(input, context);
        if (!('run' in again)) return { result: again, record: { summary: `書斎の道具「${name}」を使おうとしましたが、できませんでした。`, outcome: 'failed', ...(again.failure ? { reasonCode: again.failure } : {}) } };
        const run = await again.run(signal);
        return reached || !run.result.ok || run.apply ? run
          : { ...run, result: { ...run.result, text: `${run.result.text}\n（Aetherにつながらなかったので、ボクの中にある写しで答えた）` } };
      },
    };
  };
}

/** A study tool as it is offered while her study lives in Aether: the description says where its text is. */
const AETHER_STUDY_TOOLS = new Map<string, ShannonToolDefinition>();
export function aetherStudyTool(tool: ShannonToolDefinition): ShannonToolDefinition {
  if (!tool.name.startsWith('study.')) return tool;
  const key = `${tool.name}\n${tool.description}`;
  const known = AETHER_STUDY_TOOLS.get(key);
  if (known) return known;
  const description = tool.description.replace('正本はシャノンのデータベース', '物語とメモの正本はAetherのシャノン用フォルダ（物語は書斎）。版ごとの記録はボクの中に残る')
    + (tool.name === 'study.delete' ? 'Aetherにあるものは「最近削除した項目」に移り、戻せるのはライ氏（iPhone）。' : tool.name === 'study.restore' ? 'Aetherにあるものは、ライ氏がAetherで戻した時に書斎にも戻る。' : '');
  const changed = Object.freeze({ ...tool, description });
  AETHER_STUDY_TOOLS.set(key, changed);
  return changed;
}

/** Her note about a look at the owner's room: hers to think with, never put into a file (coordinator decision 2026-10-05). */
const ROOM_LOOK_MARK = '（部屋を見たメモ。考える材料で、フォルダのファイルには書かない）';

/**
 * Two bodies that are one piece written twice: one empty, one containing the other, or sharing at least 60% of their
 * two-character pieces (Dice). A retry that wrote the same story again in other words is usually above that; a
 * different note under a reused title is not.
 */
export function similarBodies(left: string, right: string): boolean {
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');
  const a = compact(left);
  const b = compact(right);
  if (!a || !b || a.includes(b) || b.includes(a)) return true;
  const pairs = (value: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index + 2 <= value.length; index += 1) counts.set(value.slice(index, index + 2), (counts.get(value.slice(index, index + 2)) ?? 0) + 1);
    return counts;
  };
  const left2 = pairs(a);
  const right2 = pairs(b);
  let shared = 0;
  for (const [pair, count] of left2) shared += Math.min(count, right2.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, a.length - 1 + b.length - 1) >= 0.6;
}

/** A title as she may say it: width, case, spacing and the quotes around a title set aside. */
function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s『』「」【】〈〉《》“”‘’"']/gu, '');
}

/** One line of a piece for her, with everything she needs to name it in the next call (its id, or its title). */
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
