import { DatabaseSync } from 'node:sqlite';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
import { aetherErrorCode, type AetherAccess } from './aetherAccess.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { studyWriteKey } from './studyAether.js';
import { studyMigrationRows, studyScopes, type StudyMigrationRow } from './studyAetherLinks.js';
import { STUDY_KIND_LABEL, STUDY_STATUS_LABEL, type StudyPieceKind, type StudyPieceStatus } from './studyStore.js';

/**
 * Moving her study to Aether (Syzygy ADR-0007, revised 2026-10-06, owner decision): her stories go to 「シャノンの書斎」
 * (documents tagged 書斎 in 「シャノン用フォルダ」, `inStudy: true`), her notes to 「シャノン用フォルダ」 (`inStudy: false`).
 * The owner sees what moves before it moves: the plan (`migrationPlan`, printed by `migrationReport`) is metadata only,
 * never a body. `applyMigration` moves the current version of each piece, idempotently (the same piece and version is the
 * same Aether write, so a run that stopped half way is run again), and records the mapping from the piece's id to its Aether
 * document (`study_aether_links`), so the owner's reactions, the links in her messages (`shannon-study://<id>`) and the
 * app's piece ids keep working. Every version stays in Shannon, so the owner keeps reading the version she showed.
 *
 * What stays in Shannon: her notes about a look at the room and what she jotted after an unanswered message (hers to think
 * with; with others present her Aether folder may be read), and pieces in her trash.
 */
export type StudyMigrationTarget = 'study' | 'shannon_folder' | 'stays';

export interface StudyMigrationItem {
  pieceId: string;
  kind: StudyPieceKind;
  title: string;
  /** Characters (code points) of the current version's body. */
  characters: number;
  status: StudyPieceStatus;
  /** The owner can read a version of it (she called it 「見せてもいい」 at least once). */
  shown: boolean;
  target: StudyMigrationTarget;
  /** Why it stays, or that it has moved already. */
  note?: 'room_look' | 'reach_out' | 'trash' | 'moved';
  documentId?: string;
  /**
   * A piece that moved and then changed in Shannon before the services used Aether (between `--apply` and setting the
   * address): its newer version is sent (`update`), or it was put in her trash and is deleted in Aether too (`delete`).
   */
  catchUp?: 'update' | 'delete';
  /** In her trash. */
  trashed: boolean;
}

/** The plan of a scope, every piece (no cap), through the open store (`--apply`). */
export function migrationPlan(store: SQLiteAutonomyStore, scopeKey: string): readonly StudyMigrationItem[] {
  return planOf(store.study.aether.migrationRows(scopeKey));
}

/**
 * The dry run: the plan of every scope (or one), read through a read-only connection. Nothing is created, added or written,
 * also in a database that predates the study's Aether tables; the body of a piece is never read, only its length.
 */
export function readOnlyMigrationPlan(path: string, scopeKey?: string): ReadonlyMap<string, readonly StudyMigrationItem[]> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const scopes = scopeKey ? [scopeKey] : studyScopes(database);
    return new Map(scopes.map(scope => [scope, planOf(studyMigrationRows(database, scope))]));
  } finally {
    database.close();
  }
}

function planOf(rows: readonly StudyMigrationRow[]): readonly StudyMigrationItem[] {
  return Object.freeze(rows.map(row => {
    const note = row.documentId ? 'moved' as const : row.origin ?? (row.deleted ? 'trash' as const : undefined);
    const target: StudyMigrationTarget = row.origin || (row.deleted && !row.documentId) ? 'stays' : row.kind === 'story' ? 'study' : 'shannon_folder';
    // A delete is planned once: never again after Shannon deleted it (or found it gone), also if the owner restored it since.
    const catchUp = !row.documentId ? undefined : row.deleted ? (row.deletedInAether ? undefined : 'delete' as const)
      : row.linkedVersion !== null && row.version > row.linkedVersion ? 'update' as const : undefined;
    return Object.freeze({
      pieceId: row.pieceId, kind: row.kind, title: row.title, characters: row.characters, status: row.status,
      shown: row.readableVersion !== null, target, ...(note ? { note } : {}), ...(row.documentId ? { documentId: row.documentId } : {}),
      ...(catchUp ? { catchUp } : {}), trashed: row.deleted,
    });
  }).sort((left, right) => order(left) - order(right)));
}

const TARGET_LABEL: Readonly<Record<StudyMigrationTarget, string>> = Object.freeze({
  study: 'Aetherの書斎（シャノン用フォルダ・タグ「書斎」）', shannon_folder: 'Aetherのシャノン用フォルダ', stays: 'Shannonに残す',
});
const NOTE_LABEL: Readonly<Record<NonNullable<StudyMigrationItem['note']>, string>> = Object.freeze({
  room_look: '部屋を見たメモ', reach_out: '話しかけたあとのメモ', trash: 'ゴミ箱', moved: '移動済み',
});
const CATCH_UP_LABEL: Readonly<Record<NonNullable<StudyMigrationItem['catchUp']>, string>> = Object.freeze({
  update: '移したあとの直しをAetherへ送る', delete: '移したあとでゴミ箱に入れたので、Aetherでも消す',
});

/** The dry run as the owner reads it: counts, then one line per piece. Titles and lengths only; never a body. */
export function migrationReport(scopeKey: string, items: readonly StudyMigrationItem[], applied = false): string {
  const count = (target: StudyMigrationTarget) => items.filter(item => item.target === target && item.note !== 'moved').length;
  const moved = items.filter(item => item.note === 'moved').length;
  return [
    applied ? `シャノンの書斎 → Aether（移しました）  scope: ${scopeKey}` : `シャノンの書斎 → Aether（確認用。まだ何も移していません）  scope: ${scopeKey}`,
    `物語 ${count('study')}件 → ${TARGET_LABEL.study}`,
    `メモ ${count('shannon_folder')}件 → ${TARGET_LABEL.shannon_folder}`,
    `Shannonに残す ${count('stays')}件（部屋を見たメモ・話しかけたあとのメモ・ゴミ箱）${moved ? `／移動済み ${moved}件` : ''}`,
    '',
    '種類｜題名｜字数｜状態｜見せたか｜移す先｜id',
    ...items.map(item => [
      // A piece in her trash or one that stays in Shannon is listed without its title; an unshown draft keeps it (the owner reads this).
      STUDY_KIND_LABEL[item.kind], item.trashed || item.target === 'stays' ? '（題名は伏せる）' : `「${line(item.title)}」`, `${item.characters.toLocaleString('en-US')}字`, STUDY_STATUS_LABEL[item.status],
      item.shown ? '見せている' : 'まだ見せていない',
      item.note ? `${TARGET_LABEL[item.target]}（${NOTE_LABEL[item.note]}${item.documentId ? `: ${item.documentId}` : ''}${item.catchUp ? `、${CATCH_UP_LABEL[item.catchUp]}` : ''}）` : `→ ${TARGET_LABEL[item.target]}`,
      item.pieceId,
    ].join('｜')),
    '',
    applied ? '移した物語とメモの本文は、Aetherのものが正本です。版の記録と感想はShannonに残っています。' : '移すには --apply をつけて、もう一度実行してください。本文はここには出しません。',
  ].join('\n');
}

export interface StudyMigrationOutcome {
  moved: readonly { pieceId: string; documentId: string; version: number }[];
  /** Moved pieces whose later change in Shannon was sent (a newer version, or a delete). */
  caughtUp: readonly { pieceId: string; documentId: string; version: number }[];
  failed: readonly { pieceId: string; code: string }[];
}

/** Moves every piece the plan says moves. Each piece: one Aether create (idempotent), then its link in one transaction. */
export async function applyMigration(
  store: SQLiteAutonomyStore, access: AetherAccess, scopeKey: string, clock: { now: () => string; dayKey: (at: string) => string }, signal?: AbortSignal,
): Promise<StudyMigrationOutcome> {
  const { now } = clock;
  const moved: { pieceId: string; documentId: string; version: number }[] = [];
  const caughtUp: { pieceId: string; documentId: string; version: number }[] = [];
  const failed: { pieceId: string; code: string }[] = [];
  for (const item of migrationPlan(store, scopeKey)) {
    if (item.catchUp) {
      const outcome = await catchUp(store, access, scopeKey, item, now, signal);
      if ('code' in outcome) failed.push({ pieceId: item.pieceId, code: outcome.code }); else caughtUp.push(outcome);
      continue;
    }
    if (item.target === 'stays' || item.note === 'moved') continue;
    const piece = store.study.find(scopeKey, item.pieceId, true);
    if (!piece) continue;
    try {
      const written = await access.create({
        title: piece.title, body: piece.body, inStudy: piece.kind === 'story',
        idempotencyKey: studyWriteKey(scopeKey, 'migration', piece.id, String(piece.version)),
      }, signal);
      const other = store.study.aether.pieceFor(scopeKey, written.documentId);
      if (other && other !== piece.id) { failed.push({ pieceId: piece.id, code: 'document_taken' }); continue; }
      store.transaction(() => {
        store.study.aether.link(scopeKey, piece.id, piece.version, written.documentId, written.version, now());
        store.study.aether.nameFeedbackDocument(scopeKey, piece.id, written.documentId);
      });
      moved.push({ pieceId: piece.id, documentId: written.documentId, version: written.version });
    } catch (error) {
      failed.push({ pieceId: piece.id, code: `aether_${aetherErrorCode(error).toLowerCase()}` });
    }
  }
  if (moved.length || caughtUp.length || failed.length) {
    const at = now();
    const parts = [...(moved.length ? [`物語とメモを${moved.length}件Aetherへ移しました`] : []), ...(caughtUp.length ? [`移したあとの変更を${caughtUp.length}件Aetherへ送りました`] : [])];
    store.activity.append(scopeKey, clock.dayKey(at), at, {
      kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, outcome: 'recorded', approval: 'not_needed',
      summary: `書斎の移行: ${parts.length ? parts.join('。') : '送れたものはありません'}${failed.length ? `（できなかったもの${failed.length}件）` : ''}。`,
    });
  }
  return Object.freeze({ moved: Object.freeze(moved), caughtUp: Object.freeze(caughtUp), failed: Object.freeze(failed) });
}

/**
 * A moved piece that changed in Shannon before the services used Aether: its current version is sent from the version Aether
 * has (`baseVersion`, so a change the owner made in Aether meanwhile is not overwritten: `aether_stale_version`), or, put in
 * her trash, it is deleted in Aether too. Keyed by piece and version, so a re-run sends nothing twice.
 */
async function catchUp(store: SQLiteAutonomyStore, access: AetherAccess, scopeKey: string, item: StudyMigrationItem, now: () => string, signal?: AbortSignal):
  Promise<{ pieceId: string; documentId: string; version: number } | { code: string }> {
  const piece = store.study.find(scopeKey, item.pieceId, true);
  const link = store.study.aether.current(scopeKey, item.pieceId);
  if (!piece || !link) return { code: 'not_found' };
  const key = studyWriteKey(scopeKey, 'migration-catch-up', piece.id, String(piece.version), item.catchUp!);
  try {
    if (item.catchUp === 'delete') {
      const deleted = await access.delete({ documentId: link.documentId, baseVersion: link.aetherVersion, idempotencyKey: key }, signal);
      store.transaction(() => store.study.aether.noteDeleted(scopeKey, piece.id, link.documentId, now()));
      return { pieceId: piece.id, documentId: deleted.documentId, version: deleted.version };
    }
    const written = await access.update({ documentId: link.documentId, baseVersion: link.aetherVersion, title: piece.title, body: piece.body, idempotencyKey: key }, signal);
    store.transaction(() => store.study.aether.link(scopeKey, piece.id, piece.version, written.documentId, written.version, now()));
    return { pieceId: piece.id, documentId: written.documentId, version: written.version };
  } catch (error) {
    const code = aetherErrorCode(error);
    // Already gone from her folder: her trash agrees, nothing to send.
    if (item.catchUp === 'delete' && (code === 'NOT_FOUND' || code === 'OUTSIDE_SHANNON_FOLDER')) {
      store.transaction(() => store.study.aether.noteDeleted(scopeKey, piece.id, link.documentId, now()));
      return { pieceId: piece.id, documentId: link.documentId, version: link.aetherVersion };
    }
    return { code: `aether_${code.toLowerCase()}` };
  }
}

function order(item: StudyMigrationItem): number {
  return { study: 0, shannon_folder: 1, stays: 2 }[item.target] + (item.note === 'moved' ? 3 : 0);
}

function line(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
