import { createHash } from 'node:crypto';
import type { StudyPiece } from './studyStore.js';

/**
 * Her folder on the owner's PC or Mac, as the server sees it (`docs/host-folder-contract.md`).
 *
 * The server never touches that folder and cannot resolve a path in it: the device that
 * owns the folder does the writing and verifies the real location itself. What the server
 * can do, and does here, is refuse by spelling alone: a path must be relative, stay below
 * the folder, and name a plain text file. Everything in this file is pure.
 */
export const HOST_FOLDER_EXTENSIONS: readonly string[] = Object.freeze(['.md', '.txt', '.json', '.csv', '.yaml', '.yml']);

export const HOST_FOLDER_LIMITS = Object.freeze({
  /** Bytes of one file, as UTF-8. */
  bytes: 1_048_576,
  pathCharacters: 240,
  segmentCharacters: 120,
  /** Folders plus the file name. */
  segments: 8,
});

/** The outcome codes a device may report. There is no free text. */
export const HOST_STEP_CODES = Object.freeze({
  path_not_allowed: 'パスが決まりに合わなかった',
  outside_folder: '専用フォルダの外を指していた',
  link_refused: 'リンクやジャンクションをたどることになる',
  extension_not_allowed: '置ける種類のファイルではなかった',
  too_large: '大きすぎた',
  folder_not_configured: '専用フォルダがまだ選ばれていない',
  content_mismatch: '受け取った中身が一致しなかった',
  unsupported_operation: '端末がその操作に対応していない',
  io_error: '書き込みに失敗した',
  unknown: '理由は分からない',
} as const);
export type HostStepCode = keyof typeof HOST_STEP_CODES;

export function isHostStepCode(value: unknown): value is HostStepCode {
  return typeof value === 'string' && Object.hasOwn(HOST_STEP_CODES, value);
}

// Device names Windows reserves in every folder, with or without an extension.
const RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/iu;
// Control characters, DEL, and the characters Windows refuses in a name. `:` also covers drives and alternate streams.
const FORBIDDEN_CHARACTER = /[\u0000-\u001f\u007f-\u009f<>:"|?*]/u;

/**
 * A relative path inside her folder with `/` separators, or the reason it is refused.
 * Lexical only: no file system is asked, so a link or junction on the device is the
 * device's to refuse.
 */
export function hostFolderRelativePath(value: unknown): { path: string } | { problem: string } {
  if (typeof value !== 'string' || !value) return { problem: '相対パスがない' };
  if (value.length > HOST_FOLDER_LIMITS.pathCharacters) return { problem: 'パスが長すぎる' };
  if (FORBIDDEN_CHARACTER.test(value)) return { problem: '使えない文字（ドライブ名や「:」、制御文字など）を含む' };
  const path = value.replace(/\\/gu, '/');
  if (path.startsWith('/')) return { problem: '絶対パスや共有名は指定できない' };
  if (path.startsWith('~')) return { problem: 'ホームからのパスは指定できない' };
  const segments = path.split('/');
  if (segments.length > HOST_FOLDER_LIMITS.segments) return { problem: 'フォルダの階層が深すぎる' };
  for (const segment of segments) {
    if (!segment) return { problem: '空の階層を含む' };
    if (segment === '.' || segment === '..') return { problem: '「.」や「..」は指定できない' };
    if (segment.length > HOST_FOLDER_LIMITS.segmentCharacters) return { problem: '名前が長すぎる' };
    if (segment !== segment.trim() || segment.endsWith('.')) return { problem: '名前の前後に空白や「.」がある' };
    if (RESERVED_NAME.test(segment.split('.')[0]!.trim())) return { problem: 'Windowsの予約名を含む' };
  }
  const name = segments.at(-1)!;
  const dot = name.lastIndexOf('.');
  if (dot < 1 || !HOST_FOLDER_EXTENSIONS.includes(name.slice(dot).toLowerCase())) return { problem: '置けるのはテキストのファイルだけ' };
  return { path: segments.join('/') };
}

/** A note, or a story whose current version she has called 「見せてもいい」. Never a draft, never a piece put away. */
export function copyableStudyPiece(piece: StudyPiece): boolean {
  if (piece.status === 'put_away' || piece.readableVersion !== piece.version) return false;
  return piece.kind === 'note' || piece.status === 'ready' || piece.status === 'shown';
}

/**
 * Where the copy of a piece goes: kind, the owner-local day it was first written, the
 * start of its id, and its version. Built from fixed parts only, so no title (and nothing
 * the model wrote) can shape a path.
 */
export function studyCopyPath(piece: Pick<StudyPiece, 'id' | 'kind' | 'version'>, createdDayKey: string): string | null {
  const id = piece.id.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 8);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/u.test(createdDayKey) || !Number.isInteger(piece.version) || piece.version < 1) return null;
  const folder = piece.kind === 'story' ? 'stories' : 'notes';
  const checked = hostFolderRelativePath(`${folder}/${piece.kind}-${createdDayKey}-${id}-v${piece.version}.md`);
  return 'path' in checked ? checked.path : null;
}

/** The text of the copy: her own title and body, and for a note the pages it came from. Nothing else leaves. */
export function studyCopyContent(piece: Pick<StudyPiece, 'title' | 'body' | 'kind' | 'sources'>): string {
  const sources = piece.kind === 'note' && piece.sources.length
    ? `\n\n出典:\n${piece.sources.map(source => `- ${source.title} ${source.url}`).join('\n')}` : '';
  return `# ${piece.title}\n\n${piece.body}${sources}\n`;
}

export function hostStepContentDigest(content: string): { bytes: number; sha256: string } {
  const buffer = Buffer.from(content, 'utf8');
  return { bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') };
}
