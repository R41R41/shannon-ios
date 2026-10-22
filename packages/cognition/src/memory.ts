import { evidenceVisibleUnderControls } from './memoryEvidence.js';
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

type MemoryControl = CompanionStateSnapshot['memoryControls'][number];
/**
 * mb-llmc r8 (run 32: the source guard asked 66,674 read-receipt answers in a minute, each looking for its controls by a scan of all of
 * them, twice or more): a snapshot's list of controls is read once into an index by memory id (the first control of an id, as the scan
 * found it). A snapshot's list is never changed in place (a state change makes a new list), so the index is the list's as long as the
 * list lives; a short list is scanned as before.
 */
const controlIndexes = new WeakMap<readonly MemoryControl[], Map<string, MemoryControl>>();
const INDEXED_FROM = 12;
export function memoryControlFor(snapshot: CompanionStateSnapshot, memoryId: string) {
  return snapshot.memoryControls.find(control => control.memoryId === memoryId);
}
/**
 * `memoryControlFor` by the index, for the callers that ask thousands of times for one snapshot (the read-receipt answers). Kept apart from
 * `memoryControlFor`: the recall walks call that one at the very end of a deep stack (`isStackOverflow`), where a larger body of code in the
 * callee changes where the stack runs out.
 */
export function indexedMemoryControlFor(snapshot: CompanionStateSnapshot, memoryId: string): MemoryControl | undefined {
  const controls = snapshot.memoryControls;
  if (controls.length < INDEXED_FROM) return controls.find(control => control.memoryId === memoryId);
  let index = controlIndexes.get(controls);
  if (!index) {
    index = new Map();
    for (const control of controls) if (!index.has(control.memoryId)) index.set(control.memoryId, control);
    controlIndexes.set(controls, index);
  }
  return index.get(memoryId);
}

export function visibleMemoryText(
  snapshot: CompanionStateSnapshot,
  memoryId: string,
  originalText: string,
): string | null {
  const control = memoryControlFor(snapshot, memoryId);
  if (control && control.status !== 'active') return null;
  // A user correction supersedes its original evidence, not other boundaries.
  if (control?.overrideText) return isMemoryEvidenceVisible(snapshot, control.overrideText, memoryId) ? control.overrideText : null;
  if (!isMemoryEvidenceVisible(snapshot, originalText)) return null;
  const derived = snapshot.userFacts.find(item => item.id === memoryId)
    ?? snapshot.relationships.find(item => item.id === memoryId);
  const parent = derived?.sourceExperienceId ? memoryControlFor(snapshot, derived.sourceExperienceId) : undefined;
  if (parent && (parent.status !== 'active' || parent.overrideText)) return null;
  if (derived?.evidence && (!isMemoryEvidenceVisible(snapshot, derived.evidence)
    || (!control?.overrideText && !isOwnerMemoryEvidence(derived.evidence)))) return null;
  return control?.overrideText || originalText;
}

export function isMemoryEvidenceVisible(snapshot: CompanionStateSnapshot, evidence: string, exceptMemoryId?: string): boolean {
  // Only a forgotten, rejected or corrected item can hide evidence: with none, nothing is compared (asked for every remembered turn).
  if (!snapshot.memoryControls.some(control => control.status !== 'active' || control.overrideText)) return true;
  // The withheld evidence is gathered once per state and a verdict is remembered under its exact content (`memoryEvidence.ts`).
  return evidenceVisibleUnderControls(snapshot, evidence, exceptMemoryId);
}

/** Conservative assertion boundary shared by local/model extraction and reuse.
 * A quoted span alone cannot establish ownership: inspect its containing source
 * sentence too, when available. Ambiguous text is left as conversation only. */
export function isOwnerMemoryEvidence(evidence: string, source?: string): boolean {
  const quoted = /「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”/gu;
  const safe = (text: string) => {
    // A person/title inside an explicitly owned preference is its object, not
    // the speaker. A whole quoted first-person assertion still has no owner.
    const ownerPreference = /^(?:僕|私|自分)は、?.{1,100}?(?:が好き|が苦手|が嫌い|を好む)(?:です|だ|なんだ)?よ?[。！!]*$/u.test(text.trim());
    const assertion = ownerPreference ? text.replace(quoted, '作品') : text;
    return !/[「」『』"“”]|[?？]/u.test(assertion)
      && !/(?:例えば|たとえば|仮に|もし|たぶん|多分|かもしれ|気がする|例文|翻訳|という設定|と言った|って言|と言って|そうです|らしい)/u.test(assertion)
      && (ownerPreference || (!/と話し/u.test(assertion)
        && !/(?:友人|友達|友だち|彼女?|あの人|母|父|兄|姉|弟|妹|家族|同僚|上司|先生|\S+さん)(?:の|は|が)/u.test(assertion)))
      && !/(?:では|じゃ)(?:ない|ありません)|(?:好き|嫌い|苦手|好む|在住)(?:で)?(?:ない|ありません)|(?:だった|でした|住んでいない|していない|やっていない)(?:[。！!]|$)/u.test(assertion)
      && !/(?:何|どこ|誰|いつ|どれ)(?:か|だ|な|を|に|[。！!]|$)|知ってる|覚えてる/u.test(assertion);
  };
  if (!safe(evidence)) return false;
  if (!source) return true;
  const sentences = source.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [];
  return sentences.some(sentence => {
    const start = sentence.indexOf(evidence);
    const end = start + evidence.length;
    // A model must not extract a first-person claim from inside a title/quote.
    return start >= 0 && safe(sentence) && ![...sentence.matchAll(quoted)].some(match =>
      (start > match.index && start < match.index + match[0].length)
      || (end > match.index && end < match.index + match[0].length));
  });
}
