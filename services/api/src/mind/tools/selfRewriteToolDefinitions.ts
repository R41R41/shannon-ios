import type { ShannonToolDefinition } from './shannonTools.js';
const candidateInput = { type: 'string' as const, description: 'inspect で確かめた元 workId/authority/baseRevision と、正確な beforeHash/content/files/diffHash を持つ候補のJSON。候補は権限を増やさない', maxLength: 64_000, minLength: 1 };
export const SELF_REWRITE_TOOLS: readonly ShannonToolDefinition[] = Object.freeze<ShannonToolDefinition[]>([
  { name: 'workspace.inspect', domain: 'vm_workspace', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['autonomy'],
    description: '隔離されたAzure作業場の、今取り組んでいる作業のファイルと基準hashを読む。workId は台帳の pursuit:<id>。対象は作業場の非基幹だけ。',
    input: { type: 'object', properties: { workId: { type: 'string', description: '台帳の元 workId', maxLength: 160, minLength: 1 },
      paths: { type: 'string', description: '読む絶対パスの配列をJSONで書く', maxLength: 8_000, minLength: 1 } }, required: ['workId', 'paths'], additionalProperties: false } },
  { name: 'workspace.rewrite', domain: 'vm_workspace', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['autonomy'],
    description: '元の権限のまま、隔離作業場のJSON/text/markdownと閉じた数値関数.mjsを関所・実テスト・前後snapshotに通して書く。コードはexport functionと数値引数・単一returnの算術式・固定Mathだけ。各exportの実args/expectedを、同じ候補の <code.mjs>.test.json に {schema:"shannon.numeric-tests.v1",cases:[{export:"name",args:[1],expected:2}]} で置く。その他のコードは workspace.propose。unknownは再実行しない。',
    input: { type: 'object', properties: { candidate: candidateInput }, required: ['candidate'], additionalProperties: false } },
  { name: 'workspace.propose', domain: 'vm_workspace', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['autonomy'],
    description: '基幹・本番の改修や未検証コードの正確な候補を、元 workId/diffHash/baseRevision とともに既存の所有者への作業提案へ記録する。適用も配備もしない。',
    input: { type: 'object', properties: { candidate: candidateInput }, required: ['candidate'], additionalProperties: false } },
]);

export const SELF_REWRITE_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  'workspace.inspect': '隔離作業場のファイルと候補の基準を確かめる',
  'workspace.rewrite': '検査した非基幹の候補を元の権限で適用する',
  'workspace.propose': '正確な改修候補を所有者への作業提案にする',
});
export const SELF_REWRITE_DOING: Readonly<Record<string, 'acts' | 'describes'>> = Object.freeze({
  'workspace.inspect': 'describes', 'workspace.rewrite': 'acts', 'workspace.propose': 'acts',
});
/** Decode candidate strings before the existing own-time secret predicate; JSON escapes cannot hide a copied passage. */
export function toolInputWords(name: string, input: Record<string, unknown>): string[] | null {
  const words = Object.values(input).filter((value): value is string => typeof value === 'string');
  if (!['workspace.rewrite', 'workspace.propose'].includes(name) || typeof input.candidate !== 'string') return words;
  try {
    let bounded = true;
    const visit = (value: unknown, depth: number, decodes = 0): void => {
      if (depth > 32 || decodes > 32) { bounded = false; return; }
      if (typeof value === 'string') {
        words.push(value);
        // A JSON file's real keys/values may be escaped inside the candidate's content string.
        // Its own format depth starts at its root, not at the surrounding candidate envelope.
        try {
          const decoded: unknown = JSON.parse(value);
          // Scan every valid JSON string token too: duplicate object keys must not erase an earlier stored passage.
          for (const token of jsonStringTokens(value)) visit(token, 0, decodes + 1);
          if (decoded !== value) visit(decoded, 0, decodes + 1);
        } catch { /* ordinary text */ }
      } else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
        words.push(key); visit(item, depth + 1, decodes);
      });
    };
    visit(input.candidate, 0);
    if (!bounded) return null;
  } catch { /* malformed candidates are refused by the executor's schema gate */ }
  return words;
}
/** Called after whole-input JSON.parse succeeded, so quotes/escapes are known valid; consume all tokens without regex guesses. */
function jsonStringTokens(source: string): string[] {
  const strings: string[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '"') continue;
    const start = index++;
    for (; index < source.length; index++) {
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === '"') { strings.push(JSON.parse(source.slice(start, index + 1)) as string); break; }
    }
  }
  return strings;
}
