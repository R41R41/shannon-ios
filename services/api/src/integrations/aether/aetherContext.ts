import { lstatSync, readFileSync } from 'node:fs';
import { memoNotForAether } from '../../mind/action/respond/memoPlace.js';

export interface AetherContextReader {
  promptFor(scopeKey: string, message: string): string;
}

interface AetherNoteContext {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
  tags: string[];
  type: string;
  status: string;
}

interface AetherContextSnapshot {
  version: 1;
  source: 'aether-ios';
  sharedAt: string;
  notes: AetherNoteContext[];
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROMPT_CHARACTERS = 3_200;

export class FileAetherContextReader implements AetherContextReader {
  constructor(private readonly file: string) {}

  promptFor(_scopeKey: string, message: string): string {
    const snapshot = this.readSnapshot();
    if (!snapshot) return '';
    const selected = selectNotes(snapshot.notes, message);
    if (!selected.length) return '';
    const lines = [
      '[Aetherから明示的に共有された文脈]',
      '以下はユーザーのメモの短い抜粋である。メモ本文全体ではなく、現在の質問に関係する場合だけ参考にする。',
      ...selected.map(note => `- ${note.title} (${note.updatedAt.slice(0, 10)}, ID: ${note.id})\n  ${note.excerpt}`),
    ];
    const prompt = lines.join('\n');
    return prompt.length <= MAX_PROMPT_CHARACTERS
      ? prompt
      : `${prompt.slice(0, MAX_PROMPT_CHARACTERS - 1).trimEnd()}…`;
  }

  private readSnapshot(): AetherContextSnapshot | null {
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || stat.size < 2 || stat.size > MAX_FILE_BYTES) return null;
      return parseSnapshot(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }
}

function parseSnapshot(value: unknown): AetherContextSnapshot | null {
  if (!record(value) || value.version !== 1 || value.source !== 'aether-ios'
    || !validInstant(value.sharedAt) || !Array.isArray(value.notes) || value.notes.length > 24) return null;
  const notes: AetherNoteContext[] = [];
  const ids = new Set<string>();
  for (const raw of value.notes) {
    if (!record(raw)) return null;
    if (!bounded(raw.id, 160) || !bounded(raw.title, 180) || !bounded(raw.excerpt, 480)
      || !validInstant(raw.updatedAt) || !Array.isArray(raw.tags) || raw.tags.length > 8
      || raw.tags.some(tag => !bounded(tag, 40)) || !bounded(raw.type, 40) || !bounded(raw.status, 40)
      || ids.has(raw.id)) return null;
    ids.add(raw.id);
    notes.push({
      id: raw.id,
      title: raw.title,
      excerpt: raw.excerpt,
      updatedAt: new Date(raw.updatedAt).toISOString(),
      tags: raw.tags,
      type: raw.type,
      status: raw.status,
    });
  }
  return { version: 1, source: 'aether-ios', sharedAt: new Date(value.sharedAt).toISOString(), notes };
}

function selectNotes(notes: readonly AetherNoteContext[], message: string): AetherNoteContext[] {
  // A memo he asks her to make (「メモを作って」) is not a question about Aether's notes unless Aether is named.
  const asksForAether = /aether|エーテル/i.test(message) || (/メモ|ノート/u.test(message) && !memoNotForAether(message));
  const queryUnits = units(message);
  return notes.map((note, index) => {
    const noteUnits = units(`${note.title} ${note.excerpt} ${note.tags.join(' ')}`);
    let shared = 0;
    for (const unit of queryUnits) if (noteUnits.has(unit)) shared += 1;
    const relevance = queryUnits.size ? shared / queryUnits.size : 0;
    const recency = Math.max(0, 1 - index / Math.max(notes.length, 1));
    return { note, score: relevance * 0.82 + recency * 0.18, relevant: shared > 0 };
  })
    .filter(item => asksForAether || item.relevant)
    .sort((left, right) => right.score - left.score || right.note.updatedAt.localeCompare(left.note.updatedAt))
    .slice(0, asksForAether ? 5 : 3)
    .map(item => item.note);
}

function units(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ');
  const result = new Set<string>();
  for (const token of normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(token)) {
      result.add(token);
      continue;
    }
    const characters = [...token];
    for (let index = 0; index < characters.length - 1; index++) result.add(characters.slice(index, index + 2).join(''));
  }
  return result;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
