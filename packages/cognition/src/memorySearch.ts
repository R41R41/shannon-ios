/**
 * Deterministic full-text plan for experience and thread-summary search.
 * SQLite FTS5 with the trigram tokenizer can only match terms of three or
 * more characters, so one- and two-character terms are kept separately for a
 * bounded substring (LIKE) fallback. No model is involved.
 */
export interface MemorySearchPlan {
  /** Terms of three or more characters, matched through FTS5 trigram phrases. */
  readonly longTerms: readonly string[];
  /** Two-character terms that trigram cannot index; matched by substring. */
  readonly shortTerms: readonly string[];
}

export const MAXIMUM_MEMORY_SEARCH_TERMS = 8;

const SCRIPT_RUN = /[一-龠々〆ヵヶ]+|[ァ-ヴー]+|[a-z0-9][a-z0-9+#.-]*|[ぁ-ん]+/gu;
/** Hiragana runs are mostly particles and inflections; keep only clear nouns. */
const HIRAGANA_STOP = /^(?:について|ってなに|なんだっけ|なんだった|だったっけ|おぼえてる|おぼえている|どうだった|ください|してた|している|したい|ありがとう|それから|そういえば|ところで|なんでしたっけ)$/u;

function normalizedQuery(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, ' ').trim().slice(0, 500);
}

export function buildMemorySearchPlan(text: string): MemorySearchPlan {
  const query = normalizedQuery(text);
  const longTerms: string[] = [];
  const shortTerms: string[] = [];
  const hiraganaOnly = !/[一-龠々ァ-ヴa-z0-9]/u.test(query);
  for (const run of query.match(SCRIPT_RUN) ?? []) {
    const isHiragana = /^[ぁ-ん]+$/u.test(run);
    if (isHiragana && (!hiraganaOnly || run.length < 3 || HIRAGANA_STOP.test(run))) continue;
    if (/^ー+$/u.test(run)) continue;
    const bucket = run.length >= 3 ? longTerms : run.length === 2 ? shortTerms : null;
    if (bucket && !bucket.includes(run)) bucket.push(run);
    // A four-kanji compound is usually two words (写真整理 → 写真 / 整理).
    if (/^[一-龠々]{4}$/u.test(run)) {
      for (const half of [run.slice(0, 2), run.slice(2)]) if (!shortTerms.includes(half)) shortTerms.push(half);
    }
  }
  const byLength = (left: string, right: string) => right.length - left.length || left.localeCompare(right);
  return Object.freeze({
    longTerms: Object.freeze(longTerms.sort(byLength).slice(0, MAXIMUM_MEMORY_SEARCH_TERMS)),
    shortTerms: Object.freeze(shortTerms.sort(byLength).slice(0, MAXIMUM_MEMORY_SEARCH_TERMS)),
  });
}

export function isEmptyMemorySearchPlan(plan: MemorySearchPlan): boolean {
  return plan.longTerms.length === 0 && plan.shortTerms.length === 0;
}

/** FTS5 MATCH expression: quoted phrases OR-ed. Quotes inside terms are doubled. */
export function memorySearchMatchExpression(plan: MemorySearchPlan): string | null {
  if (!plan.longTerms.length) return null;
  return plan.longTerms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' OR ');
}

/**
 * Pure scorer shared by the in-memory store and deterministic evaluation.
 * Returns the fraction of planned terms contained in the text (0 when none).
 */
export function scoreMemorySearchText(plan: MemorySearchPlan, text: string): number {
  const terms = [...plan.longTerms, ...plan.shortTerms];
  if (!terms.length) return 0;
  const haystack = normalizedQuery(text);
  let weight = 0;
  let matched = 0;
  for (const term of terms) {
    const termWeight = term.length >= 3 ? 1 : 0.6;
    weight += termWeight;
    if (haystack.includes(term)) matched += termWeight;
  }
  return matched / weight;
}

export interface MemorySearchDocument {
  id: string;
  text: string;
  observedAt: string;
}

/** Deterministic in-memory search with the same term semantics as SQLite. */
export function searchMemoryDocuments(
  text: string,
  documents: readonly MemorySearchDocument[],
  limit = 12,
): readonly MemorySearchDocument[] {
  const plan = buildMemorySearchPlan(text);
  if (isEmptyMemorySearchPlan(plan) || limit < 1) return [];
  return documents
    .map(document => ({ document, score: scoreMemorySearchText(plan, document.text) }))
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score
      || right.document.observedAt.localeCompare(left.document.observedAt)
      || left.document.id.localeCompare(right.document.id))
    .slice(0, limit)
    .map(row => row.document);
}
