import { createHash } from 'node:crypto';
import { memoryIdentifier, type CompanionStateSnapshot, type MemoryKind, type RelationshipInsight, type UserFact } from '@shannon/cognition';
import type { SleepChange } from './memoryService.js';
import type { ImmediateMemoryOutcome, UserFactProposal } from './sleepConsolidation.js';

export const SLEEP_INSTRUCTIONS = `その日のユーザー発言を振り返る。
factsにはユーザーが明示した持続的な情報、relationshipsにはシャノンに望む関わり方、interestsにはユーザーが明示した最近の関心だけを入れる。
日本語では主語が省略される。「寿司が好き」「大きな音が嫌い」「好物はカレー」「苦手な食べ物は納豆」のような直接表現はユーザー本人の持続的な好みとしてfactsに入れる。
質問、第三者についての話、伝聞、過去だけの好み、「たぶん」「かもしれない」など不確かな表現は入れない。
推測、診断、センシティブ属性、秘密、一時的な気分、シャノンの発言由来の情報は含めない。
evidenceは入力中に完全一致する短いユーザー発言をそのまま返す。確信がなければ各配列を空にする。`;

export const EXPLICIT_FACT_PATTERNS = [
  {
    pattern: /^(?:好きな食べ物|一番好きな食べ物|好物)(?:は|：|:)(?:、)?(.{1,60}?)(?:です|だ)?$/u,
    statement: (value: string) => `ユーザーの好きな食べ物は${value}`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^(?:苦手な食べ物|嫌いな食べ物)(?:は|：|:)(?:、)?(.{1,60}?)(?:です|だ)?$/u,
    statement: (value: string) => `ユーザーが苦手な食べ物は${value}`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^(?:食べ物なら|食べ物だと)(.{1,60}?)(?:が)?(?:一番)?(?:大)?好き(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーの好きな食べ物は${value}`,
    accept: directPreferenceValue,
  },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が好き|を好む)/u, statement: (value: string) => `ユーザーは${value}が好き` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が苦手|が嫌い)/u, statement: (value: string) => `ユーザーは${value}が苦手` },
  {
    pattern: /^([^はが、]{1,60}?)(?:が)?(?:一番)?(?:大)?好き(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーは${value}が好き`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^([^はが、]{1,60}?)(?:が)(?:苦手|嫌い)(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーは${value}が苦手`,
    accept: directPreferenceValue,
  },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:をしている|をやっている)/u, statement: (value: string) => `ユーザーは${value}をしている` },
  { pattern: /(?:僕の|私の|自分の)?名前は(?:、)?(.{1,60})/u, statement: (value: string) => `ユーザーの名前は${value}` },
  { pattern: /(?:僕の|私の|自分の)?(?:仕事|職業)は(?:、)?(.{1,100})/u, statement: (value: string) => `ユーザーの仕事は${value}` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:に住んでいる|在住)/u, statement: (value: string) => `ユーザーは${value}に住んでいる` },
  { pattern: /(?:僕の|私の|自分の)?誕生日は(?:、)?(.{1,60})/u, statement: (value: string) => `ユーザーの誕生日は${value}` },
] as const;

export const RELATIONSHIP_PATTERNS = [
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:ないでほしい|ないで欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}ないでほしい` },
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:しないでほしい|しないで欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}しないでほしい` },
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:してほしい|して欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}してほしい` },
  { pattern: /(?:アドバイス|助言)(?:は|が)?(?:いらない|不要)/u, statement: () => 'ユーザーは求めていない時の助言を望まない' },
] as const;

export const INTEREST_PATTERNS = [
  { pattern: /(?:^|[。！？、])(?:最近|いま|今)([^。！？、]{1,100}?)(?:に興味がある|が気になっている)/u, statement: (value: string) => value },
] as const;

interface RulePattern {
  pattern: RegExp;
  statement: (value: string) => string;
  accept?: (value: string, text: string) => boolean;
}

export function appendRuleProposal(
  proposals: UserFactProposal[],
  text: string,
  pattern: RulePattern,
  kind: 'user-fact' | 'relationship' | 'interest',
): void {
  const match = text.match(pattern.pattern);
  if (!match) return;
  const value = (match[1] ?? '').trim().replace(/[。！？].*$/u, '').slice(0, 100);
  if (match[1] !== undefined && !value) return;
  if (pattern.accept && !pattern.accept(value, text)) return;
  proposals.push({ kind, statement: pattern.statement(value), evidence: text.slice(0, 240) });
}

export function directPreferenceValue(value: string): boolean {
  return !/(?:食べ物なら|食べ物だと|たぶん|多分|かも|かな|気がする|彼|彼女|あの人|友達|家族|母|父|兄|姉|弟|妹|さん|くん|ちゃん|何|どれ)/u.test(value);
}

export function consolidateProposals(
  proposals: readonly UserFactProposal[],
  source: string,
  current: CompanionStateSnapshot,
  observedAt: string,
  initialConfidence: number,
): ImmediateMemoryOutcome {
  const facts: UserFact[] = [];
  const relationships: RelationshipInsight[] = [];
  const interests: string[] = [];
  for (const proposal of proposals) {
    const kind = proposal.kind ?? 'user-fact';
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    if (!statement || !evidence || !source.includes(evidence)) continue;
    const id = memoryId(kind, statement);
    const control = current.memoryControls.find(item => item.memoryId === id);
    if (control && control.status !== 'active') continue;
    if (conflictingCurrent(current, kind, statement)) continue;
    if (kind === 'user-fact') {
      const previous = current.userFacts.find(item => item.id === id);
      facts.push({
        id, statement,
        confidence: Math.min(0.9, previous ? previous.confidence + 0.08 : initialConfidence),
        observedAt, evidence,
      });
    } else if (kind === 'relationship') {
      const previous = current.relationships.find(item => item.id === id);
      relationships.push({
        id, statement,
        confidence: Math.min(0.9, previous ? previous.confidence + 0.08 : initialConfidence),
        observedAt, evidence,
      });
    } else if (!current.interests.includes(statement)) {
      interests.push(statement);
    }
  }
  return Object.freeze({
    facts: Object.freeze(facts.slice(0, 8)),
    relationships: Object.freeze(relationships.slice(0, 6)),
    interests: Object.freeze(interests.slice(0, 6)),
  });
}

export function parseProposalRows(value: unknown, kind: UserFactProposal['kind']): UserFactProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Partial<UserFactProposal>;
    return typeof row.statement === 'string' && typeof row.evidence === 'string'
      ? [{ kind, statement: row.statement, evidence: row.evidence }]
      : [];
  });
}

export function memoryId(kind: Exclude<MemoryKind, 'experience'>, statement: string): string {
  if (kind === 'interest') return memoryIdentifier(kind, statement);
  return `${kind}-${createHash('sha256').update(statement.toLowerCase()).digest('hex').slice(0, 20)}`;
}

export function conflictingCurrent(
  current: CompanionStateSnapshot,
  kind: Exclude<MemoryKind, 'experience'>,
  candidate: string,
): { id: string; text: string } | null {
  if (kind === 'interest') return null;
  const candidatePolarity = polarity(candidate);
  if (candidatePolarity === 0) return null;
  const candidateTopic = topic(candidate);
  const rows = kind === 'user-fact'
    ? current.userFacts.map(item => ({ id: item.id, text: item.statement }))
    : current.relationships.map(item => ({ id: item.id, text: item.statement }));
  return rows.find(row => polarity(row.text) === -candidatePolarity && topic(row.text) === candidateTopic) ?? null;
}

export function polarity(value: string): number {
  if (/(苦手|嫌い|いらない|不要|望まない|しないで)/u.test(value)) return -1;
  if (/(好き|好む|ほしい|欲しい|望む|している)/u.test(value)) return 1;
  return 0;
}

export function topic(value: string): string {
  return value.replace(/ユーザーは(?:シャノンに)?|が好き|を好む|が苦手|が嫌い|をしている|してほしい|しないでほしい|を望まない|いらない|不要/gu, '')
    .replace(/\s+/g, '').trim();
}

export function makeChange(kind: MemoryKind, memoryIdValue: string, text: string, reason: string, evidence: string): SleepChange {
  return { kind, memoryId: memoryIdValue, text, reason, evidence };
}

export function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function deduplicateProposals(proposals: readonly UserFactProposal[]): UserFactProposal[] {
  const seen = new Set<string>();
  return proposals.flatMap(proposal => {
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    const key = `${proposal.kind ?? 'user-fact'}:${statement.toLowerCase()}`;
    if (!statement || !evidence || seen.has(key)) return [];
    seen.add(key);
    return [{ ...(proposal.kind ? { kind: proposal.kind } : {}), statement, evidence }];
  });
}

export function parseJson(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('OPENAI_SLEEP_NON_JSON'); }
}

export function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as { type?: unknown; text?: unknown };
      return row.type === 'output_text' && typeof row.text === 'string' ? [row.text] : [];
    });
  }).join('').trim();
}
