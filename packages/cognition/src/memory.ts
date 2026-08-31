import type { CompanionStateSnapshot, MemoryKind } from './types.js';

export function memoryIdentifier(kind: MemoryKind, text: string): string {
  let hash = 2_166_136_261;
  const normalized = text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ja-JP');
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${kind}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function memoryControlFor(snapshot: CompanionStateSnapshot, memoryId: string) {
  return snapshot.memoryControls.find(control => control.memoryId === memoryId);
}

export function visibleMemoryText(
  snapshot: CompanionStateSnapshot,
  memoryId: string,
  originalText: string,
): string | null {
  const control = memoryControlFor(snapshot, memoryId);
  if (control && control.status !== 'active') return null;
  return control?.overrideText || originalText;
}
