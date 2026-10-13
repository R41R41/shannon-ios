import { memoryIdentifier } from './memory.js';
import type { CompanionStateSnapshot, MemoryControl } from './types.js';

/**
 * What one forgotten, rejected or corrected memory withholds from model
 * context. The rule is a pure function of the current controls, so restoring
 * the item removes the rule and everything it withheld becomes usable again.
 */
export interface MemoryWithholdingRule {
  memoryId: string;
  /** Only text produced at or before this instant can have used the item. */
  boundary: string;
  /** Each group is one key term of the withheld content with its shorter variants. */
  terms: readonly (readonly string[])[];
  /** Distinct key terms a text must contain to count as restating the item. */
  needed: number;
  /** No key term could be derived: every earlier reply is withheld (the pre-provenance boundary). */
  wide: boolean;
}

const MAXIMUM_BASIS_CHARACTERS = 1_000;
const MAXIMUM_TERMS = 40;

/** Words that name the speaker, time, or the act of remembering, not the remembered content. */
const STOP_TERMS = new Set([
  'ユーザー', 'シャノン', 'ライ', 'ボク', 'トーク',
  '自分', '今日', '明日', '明後日', '昨日', '一昨日', '今週', '来週', '先週', '今月', '来月', '先月', '今年', '来年', '去年',
  '毎日', '毎週', '毎月', '毎朝', '毎晩', '今朝', '今夜', '今晩', '週末', '最近', '時間', '本当', '大丈夫', '一緒', '以前', '以後',
  '今度', '今回', '次回', '必要', '場合', '感じ', '一番', '記憶', '会話', '約束', '予定', '事実', '内容', '情報', '確認', '名前',
  '仕事', '趣味', '大好', '苦手', '得意', '好物', '相談', '質問', '返事', '返答', '連絡', '場所', '気持',
  '話', '事', '人', '時', '日', '今', '前', '後', '中', '上', '下', '方', '物', '所', '気', '目', '手', '私', '僕', '俺', '君', '彼',
  '何', '誰', '年', '月', '週', '朝', '昼', '夜', '件', '分', '回', '度', '点', '的', '等', '氏', '様', '他', '別', '次', '間', '好', '嫌',
  'わたし', 'ぼく', 'あなた', 'こと', 'もの', 'それ', 'これ', 'あれ', 'ところ', 'とき', 'すき', 'きらい', 'です', 'ます', 'する', 'した',
  'いる', 'ある', 'ない', 'という', 'ください', 'おねがい', 'ありがとう', 'そう', 'どれ', 'ここ', 'そこ', 'きみ', 'はい', 'うん',
  'ので', 'から', 'けど', 'って', 'でし', 'まし', 'だよ', 'だね', 'よね', 'すね', 'した', 'して', 'です', 'ます',
  'the', 'and', 'for', 'you', 'ok', 'is', 'to', 'of', 'in', 'it', 'my', 'me',
]);
const RUN = /[一-龠々〆]+|[ァ-ヴー]{2,}|[a-z][a-z0-9+#.-]*|[0-9]+(?:[.:/][0-9]+)*[一-龠]?|[ぁ-ん]+/gu;
const PARTICLE = /[がをはにでともへのやか]/u;

/**
 * The same texts are normalized again and again (every remembered turn, a skill's body, under every rule of every check): kept for
 * a while, a pure value of the text. Bounded; cleared when full.
 */
const NORMALIZED = new Map<string, string>();
const NORMALIZED_KEPT = 4_096, NORMALIZED_CHARACTERS = 2_000_000;
let normalizedCharacters = 0;
function normalized(value: string): string {
  // A short text is normalized faster than it is looked up and kept.
  if (value.length < 256) return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
  const known = NORMALIZED.get(value);
  if (known !== undefined) return known;
  const result = value.normalize('NFKC').toLocaleLowerCase('ja-JP');
  if (value.length > 50_000) return result;
  if (NORMALIZED.size >= NORMALIZED_KEPT || normalizedCharacters + value.length * 2 > NORMALIZED_CHARACTERS) {
    NORMALIZED.clear();
    normalizedCharacters = 0;
  }
  NORMALIZED.set(value, result);
  normalizedCharacters += value.length + result.length;
  return result;
}

/**
 * Key terms of a remembered statement: kanji and katakana words, Latin words
 * and numbers with their counter. Hiragana is used only when nothing else
 * exists, because it is mostly particles and inflection. Deterministic.
 */
export function memoryKeyTerms(text: string): readonly (readonly string[])[] {
  const source = normalized(text).slice(0, MAXIMUM_BASIS_CHARACTERS);
  const groups = new Map<string, readonly string[]>();
  const add = (term: string, variants: readonly string[] = []) => {
    if (!STOP_TERMS.has(term) && !groups.has(term)) groups.set(term, [term, ...variants.filter(variant => !STOP_TERMS.has(variant))]);
  };
  const hiragana: string[] = [];
  for (const match of source.matchAll(RUN)) {
    const run = match[0];
    const next = source[match.index + run.length] ?? '';
    if (/^[ぁ-ん]+$/u.test(run)) { hiragana.push(run); continue; }
    if (/^ー+$/u.test(run)) continue;
    if (/^[一-龠々〆]+$/u.test(run)) {
      // A single kanji before okurigana is a verb or adjective stem (好き, 住んで), not a topic.
      if (run.length === 1) { if (!/[ぁ-ん]/u.test(next) || PARTICLE.test(next)) add(run); continue; }
      // A long compound is usually several words (写真整理 → 写真 / 整理).
      add(run, run.length >= 4 ? Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)) : []);
      continue;
    }
    if (run.length >= 2) add(run);
  }
  if (!groups.size) {
    // Short pieces are kept here: a junk term only withholds more, while a missed word would leak.
    for (const run of hiragana) for (const piece of run.split(PARTICLE)) if (piece.length >= 2) add(piece);
  }
  return Object.freeze([...groups.values()].slice(0, MAXIMUM_TERMS).map(group => Object.freeze([...group])));
}

function controlBasis(snapshot: CompanionStateSnapshot, control: MemoryControl): string {
  const fact = snapshot.userFacts.find(item => item.id === control.memoryId)
    ?? snapshot.relationships.find(item => item.id === control.memoryId);
  const promise = snapshot.prospectiveMemories.find(item => item.id === control.memoryId);
  const interest = snapshot.interests.find(item => memoryIdentifier('interest', item) === control.memoryId);
  // A forgotten correction withholds the corrected wording as well as the original.
  return [control.sourceEvidence, control.withheldText, control.status !== 'active' ? control.overrideText : undefined,
    fact?.statement, fact?.evidence, promise?.summary, promise?.evidence, interest]
    .filter((value): value is string => Boolean(value)).join('\n');
}

/** One rule per forgotten, rejected or corrected item. An active, uncorrected item withholds nothing. */
export function memoryWithholdingRules(snapshot: CompanionStateSnapshot): readonly MemoryWithholdingRule[] {
  return Object.freeze(snapshot.memoryControls.flatMap(control => {
    const hidden = control.status !== 'active';
    if (!hidden && !control.overrideText) return [];
    const original = memoryKeyTerms(controlBasis(snapshot, control));
    // A correction replaces only what it no longer says; terms it keeps stay usable.
    const corrected = !hidden && control.overrideText ? normalized(control.overrideText) : null;
    const terms = corrected ? original.filter(group => !corrected.includes(group[0]!)) : original;
    return [Object.freeze({
      memoryId: control.memoryId,
      boundary: control.contextInvalidatedAt ?? control.updatedAt,
      terms,
      needed: terms.length <= 6 ? 1 : terms.length <= 16 ? 2 : 3,
      wide: original.length === 0,
    })];
  }));
}

/** Whether a text restates the withheld item: it contains enough of the item's key terms. */
export function restatesWithheldMemory(rule: MemoryWithholdingRule, text: string): boolean {
  if (!rule.terms.length) return false;
  const haystack = normalized(text);
  let matched = 0;
  for (const group of rule.terms) {
    if (group.some(term => haystack.includes(term)) && (matched += 1) >= rule.needed) return true;
  }
  return false;
}

/** A reply produced no later than the rule's boundary that restates the item, or any such reply under a wide rule. */
export function ruleWithholdsText(rule: MemoryWithholdingRule, text: string, observedAt: string): boolean {
  return observedAt <= rule.boundary && (rule.wide || restatesWithheldMemory(rule, text));
}
