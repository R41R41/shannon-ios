import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
import { aetherErrorCode, type AetherAccess } from './aetherAccess.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { studyWriteKey } from './studyAether.js';
import { STUDY_KIND_LABEL, STUDY_STATUS_LABEL, type StudyPiece, type StudyPieceKind, type StudyPieceStatus } from './studyStore.js';

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
}

export function migrationPlan(store: SQLiteAutonomyStore, scopeKey: string): readonly StudyMigrationItem[] {
  return Object.freeze(store.study.list(scopeKey, 500, 'include').map((piece: StudyPiece) => {
    const link = store.study.aether.current(scopeKey, piece.id);
    const note = link ? 'moved' as const : piece.origin ?? (piece.deletedAt ? 'trash' as const : undefined);
    const target: StudyMigrationTarget = piece.origin || (piece.deletedAt && !link) ? 'stays' : piece.kind === 'story' ? 'study' : 'shannon_folder';
    return Object.freeze({
      pieceId: piece.id, kind: piece.kind, title: piece.title, characters: [...piece.body].length, status: piece.status,
      shown: piece.readableVersion !== null, target, ...(note ? { note } : {}), ...(link ? { documentId: link.documentId } : {}),
    });
  }).sort((left, right) => order(left) - order(right)));
}

const TARGET_LABEL: Readonly<Record<StudyMigrationTarget, string>> = Object.freeze({
  study: 'Aetherの書斎（シャノン用フォルダ・タグ「書斎」）', shannon_folder: 'Aetherのシャノン用フォルダ', stays: 'Shannonに残す',
});
const NOTE_LABEL: Readonly<Record<NonNullable<StudyMigrationItem['note']>, string>> = Object.freeze({
  room_look: '部屋を見たメモ', reach_out: '話しかけたあとのメモ', trash: 'ゴミ箱', moved: '移動済み',
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
      STUDY_KIND_LABEL[item.kind], `「${line(item.title)}」`, `${item.characters.toLocaleString('en-US')}字`, STUDY_STATUS_LABEL[item.status],
      item.shown ? '見せている' : 'まだ見せていない',
      item.note ? `${TARGET_LABEL[item.target]}（${NOTE_LABEL[item.note]}${item.documentId ? `: ${item.documentId}` : ''}）` : `→ ${TARGET_LABEL[item.target]}`,
      item.pieceId,
    ].join('｜')),
    '',
    applied ? '移した物語とメモの本文は、Aetherのものが正本です。版の記録と感想はShannonに残っています。' : '移すには --apply をつけて、もう一度実行してください。本文はここには出しません。',
  ].join('\n');
}

export interface StudyMigrationOutcome {
  moved: readonly { pieceId: string; documentId: string; version: number }[];
  failed: readonly { pieceId: string; code: string }[];
}

/** Moves every piece the plan says moves. Each piece: one Aether create (idempotent), then its link in one transaction. */
export async function applyMigration(
  store: SQLiteAutonomyStore, access: AetherAccess, scopeKey: string, clock: { now: () => string; dayKey: (at: string) => string }, signal?: AbortSignal,
): Promise<StudyMigrationOutcome> {
  const { now } = clock;
  const moved: { pieceId: string; documentId: string; version: number }[] = [];
  const failed: { pieceId: string; code: string }[] = [];
  for (const item of migrationPlan(store, scopeKey)) {
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
  if (moved.length || failed.length) {
    const at = now();
    store.activity.append(scopeKey, clock.dayKey(at), at, {
      kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, outcome: 'recorded', approval: 'not_needed',
      summary: `書斎の物語とメモをAetherへ移しました（${moved.length}件${failed.length ? `、移せなかったもの${failed.length}件` : ''}）。`,
    });
  }
  return Object.freeze({ moved: Object.freeze(moved), failed: Object.freeze(failed) });
}

function order(item: StudyMigrationItem): number {
  return { study: 0, shannon_folder: 1, stays: 2 }[item.target] + (item.note === 'moved' ? 3 : 0);
}

function line(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
