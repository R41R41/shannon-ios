import { memoryControlFor } from './memory.js';
import {
  MEMORY_SENSITIVITY_CATEGORIES,
  type CompanionStateSnapshot,
  type MemoryAudience,
  type MemoryDisclosure,
  type MemorySensitivity,
  type MemorySensitivityCategory,
} from './types.js';

/**
 * Audience-scoped memory with a sensitivity gate.
 *
 * Every stored item records who was present when it was said and whether it holds
 * personal information that deserves protection. A context states who is present. An
 * item may reach the model when the owner is alone, when the item is ordinary, or when
 * everyone present was already in the item's audience. Whatever is unknown is treated
 * as owner-only and sensitive.
 */

export const OWNER_AUDIENCE: MemoryAudience = Object.freeze({ kind: 'owner' as const });
/** Someone else is present and their name is not established. Never part of any audience. */
export const UNKNOWN_GUEST_PRESENCE: MemoryAudience = Object.freeze({
  kind: 'people' as const, personIds: Object.freeze([]) as readonly string[], unknownGuest: true,
});

const MAXIMUM_AUDIENCE_PEOPLE = 12;

export function isOwnerOnly(audience: MemoryAudience | undefined): boolean {
  if (!audience || audience.kind === 'owner') return true;
  return audience.kind === 'people' && audience.personIds.length === 0 && audience.unknownGuest !== true;
}

export function peopleAudience(personIds: readonly string[], unknownGuest = false): MemoryAudience {
  const ids = [...new Set(personIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 120))]
    .sort().slice(0, MAXIMUM_AUDIENCE_PEOPLE);
  if (!ids.length && !unknownGuest) return OWNER_AUDIENCE;
  return Object.freeze({ kind: 'people' as const, personIds: Object.freeze(ids), ...(unknownGuest ? { unknownGuest: true } : {}) });
}

export function groupAudience(groupKey: string): MemoryAudience {
  return Object.freeze({ kind: 'group' as const, groupKey: groupKey.slice(0, 200) });
}

/** Restores a stored audience. Anything unreadable is the owner alone. */
export function normalizeAudience(value: unknown): MemoryAudience {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return OWNER_AUDIENCE;
  const row = value as Record<string, unknown>;
  if (row.kind === 'people' && Array.isArray(row.personIds)) {
    return peopleAudience(row.personIds.filter((id): id is string => typeof id === 'string'), row.unknownGuest === true);
  }
  if (row.kind === 'group' && typeof row.groupKey === 'string' && row.groupKey.trim()) return groupAudience(row.groupKey.trim());
  return OWNER_AUDIENCE;
}

export function isSensitivityCategory(value: unknown): value is MemorySensitivityCategory {
  return typeof value === 'string' && (MEMORY_SENSITIVITY_CATEGORIES as readonly string[]).includes(value);
}

/** Restores a stored label. A missing or malformed part stays missing, which the rule reads as the safe side. */
export function normalizeDisclosure(value: unknown): MemoryDisclosure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const disclosure: MemoryDisclosure = {
    ...(row.audience !== undefined ? { audience: normalizeAudience(row.audience) } : {}),
    ...(row.sensitivity === 'sensitive' || row.sensitivity === 'ordinary' ? { sensitivity: row.sensitivity } : {}),
    ...(isSensitivityCategory(row.category) ? { category: row.category } : {}),
    ...(typeof row.reason === 'string' && row.reason.trim() ? { reason: row.reason.trim().slice(0, 80) } : {}),
    ...(row.decidedBy === 'rule' || row.decidedBy === 'owner' ? { decidedBy: row.decidedBy } : {}),
    ...(row.speaker === 'owner' || row.speaker === 'unknown' ? { speaker: row.speaker } : {}),
  };
  return Object.keys(disclosure).length ? Object.freeze(disclosure) : undefined;
}

export function sameDisclosure(left: MemoryDisclosure | undefined, right: MemoryDisclosure | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** True when everyone in `present` was already in `audience`. An unidentified guest never is. */
export function audienceCovers(audience: MemoryAudience | undefined, present: MemoryAudience): boolean {
  if (isOwnerOnly(present)) return true;
  if (!audience) return false;
  if (present.kind === 'group') return audience.kind === 'group' && audience.groupKey === present.groupKey;
  if (present.kind !== 'people' || present.unknownGuest === true) return false;
  return audience.kind === 'people' && present.personIds.every(id => audience.personIds.includes(id));
}

/**
 * The disclosure rule. `present` is who can hear or read the reply.
 * Unknown audience is owner-only; unknown sensitivity is sensitive.
 */
export function mayDisclose(disclosure: MemoryDisclosure | undefined, present: MemoryAudience): boolean {
  if (isOwnerOnly(present)) return true;
  if ((disclosure?.sensitivity ?? 'sensitive') === 'ordinary') return true;
  return audienceCovers(disclosure?.audience, present);
}

/** The stored label with the owner's own 機微／ふつう choice applied. */
export function resolveDisclosure(
  snapshot: Pick<CompanionStateSnapshot, 'memoryControls'>,
  memoryId: string,
  stored: MemoryDisclosure | undefined,
): MemoryDisclosure {
  const chosen = memoryControlFor(snapshot as CompanionStateSnapshot, memoryId)?.sensitivity;
  return Object.freeze({
    ...stored,
    audience: stored?.audience ?? OWNER_AUDIENCE,
    sensitivity: chosen ?? stored?.sensitivity ?? 'sensitive',
    ...(chosen ? { decidedBy: 'owner' as const } : {}),
  });
}

/** Whether the user side of a turn is the owner's own words. With anyone else present it is not assumed. */
export function ownerSpoke(disclosure: MemoryDisclosure | undefined): boolean {
  if (disclosure?.speaker) return disclosure.speaker === 'owner';
  return isOwnerOnly(disclosure?.audience);
}

/** Everyone who has heard it: used when the same fact is stated again in front of other people. */
export function widenAudience(current: MemoryAudience | undefined, next: MemoryAudience | undefined): MemoryAudience {
  const left = current ?? OWNER_AUDIENCE;
  const right = next ?? OWNER_AUDIENCE;
  if (left.kind === 'group' || right.kind === 'group') return left;
  const ids = [...(left.kind === 'people' ? left.personIds : []), ...(right.kind === 'people' ? right.personIds : [])];
  const unknown = (left.kind === 'people' && left.unknownGuest === true) || (right.kind === 'people' && right.unknownGuest === true);
  return peopleAudience(ids, unknown);
}

const NAME = '[一-龠々ァ-ヶー]{1,8}さん|[一-龠々ァ-ヶーぁ-ん]{2,8}(?:くん|ちゃん)';
const SENSITIVITY_RULES: ReadonlyArray<readonly [MemorySensitivityCategory, RegExp]> = [
  ['secret', /内緒|ないしょ|秘密|ひみつ|誰にも言わない|言わないで|ここだけの話|オフレコ|他の人には/u],
  ['health', /病院|通院|入院|診断|診察|手術|薬|持病|症状|体調|熱が|風邪|妊娠|検査|アレルギー|怪我|けが|骨折|歯医者|医者|クリニック|血圧|ワクチン|病気/u],
  ['mental', /うつ|鬱|不安|つらい|辛い|しんどい|死にたい|消えたい|カウンセリング|メンタル|眠れない|不眠|パニック|ストレス|落ち込|泣い|孤独|寂しい|悩み/u],
  ['money', /給料|年収|月収|収入|借金|ローン|貯金|口座|家賃|残高|クレジットカード|[0-9０-９]+\s*万?円|投資|株|保険料|税金/u],
  ['contact', /住所|番地|郵便番号|電話番号|メールアドレス|メアド|パスワード|暗証番号|マイナンバー|免許証|パスポート|保険証|誕生日|生年月日|本名|LINE\s?ID|0\d{1,4}-?\d{1,4}-?\d{3,4}|[\w.+-]+@[\w-]+\.[\w.]+/iu],
  ['romance_family', /恋人|彼女|彼氏|好きな人|片思い|告白|付き合っ|デート|結婚|離婚|別れ|浮気|不倫|妊活|婚活|元カノ|元カレ|夫|妻|嫁|旦那|奥さん|両親|父|母|兄|姉|弟|妹|息子|娘|子ども|子供|家族|実家|親戚|祖父|祖母|介護/u],
  ['work', /会社|職場|上司|部下|同僚|転職|退職|辞め|解雇|クビ|昇進|異動|取引先|顧客|クライアント|社外秘|機密|契約|面接|内定|給与|人事|残業|勤務|仕事|案件|納期|開発|実装|改善|改修|リリース|デプロイ|配信|バグ|コード|設計|仕様|プロジェクト/u],
  ['legal', /警察|逮捕|裁判|訴訟|訴え|弁護士|違反|罰金|示談|被害届|事故|トラブル/u],
  ['schedule', /予定|スケジュール|明日|明後日|あさって|今夜|今晩|来週|今週|来月|週末|[0-9０-９一二三四五六七八九十]+時|[0-9０-９]+月[0-9０-９]+日|出張|旅行|帰省|に行く|に行き|に行っ|にいる|にいます|自宅|留守|待ち合わせ|予約/u],
  ['third_party', new RegExp(`(?:友達|友だち|友人|同僚|知り合い|知人|あの人)(?:が|は|の|も|と|に)|${NAME}`, 'u')],
];
/** Honorific words that are not a person's name. */
const NOT_A_NAME = /シャノンさん|皆さん|みなさん|お客さん|たくさん|赤ちゃん/gu;

export interface SensitivityDecision {
  sensitivity: MemorySensitivity;
  category?: MemorySensitivityCategory;
  reason: string;
}

/**
 * Deterministic first pass over text that is about to be stored. Over-matching is
 * intended: a wrongly protected item is only withheld while others are present.
 */
export function classifySensitivity(text: string): SensitivityDecision {
  const value = text.normalize('NFKC').replace(NOT_A_NAME, ' ').slice(0, 4_000);
  for (const [category, pattern] of SENSITIVITY_RULES) {
    const match = pattern.exec(value);
    if (match) return { sensitivity: 'sensitive', category, reason: `「${match[0].slice(0, 20)}」を含む` };
  }
  return { sensitivity: 'ordinary', reason: '守るべき個人情報の語を含まない' };
}

/** The label written with an item: who was present, and the rule's decision on its text. */
export function disclosureFor(
  text: string,
  audience: MemoryAudience = OWNER_AUDIENCE,
  options: { speaker?: 'owner' | 'unknown'; force?: MemorySensitivityCategory } = {},
): MemoryDisclosure {
  const forced = options.force ?? (audience.kind === 'people' && audience.unknownGuest === true ? 'unknown_audience' as const : undefined);
  const decision = classifySensitivity(text);
  return Object.freeze({
    audience,
    sensitivity: forced ? 'sensitive' as const : decision.sensitivity,
    ...(forced ? { category: forced } : decision.category ? { category: decision.category } : {}),
    reason: forced ? (forced === 'unknown_audience' ? '相手の名前が分からない場での会話' : 'ほかの人についての情報') : decision.reason,
    decidedBy: 'rule' as const,
    ...(options.speaker ? { speaker: options.speaker } : {}),
  });
}

/**
 * The snapshot as it may be shown to a model while `present` can hear the reply.
 * With only the owner present it is returned unchanged. Otherwise unlabelled
 * projections (interests, cached active memories) are dropped.
 */
export function discloseSnapshot(snapshot: CompanionStateSnapshot, present: MemoryAudience): CompanionStateSnapshot {
  if (isOwnerOnly(present)) return snapshot;
  const allowed = (id: string, stored: MemoryDisclosure | undefined) => mayDisclose(resolveDisclosure(snapshot, id, stored), present);
  return Object.freeze({
    ...snapshot,
    interests: Object.freeze([]),
    activeMemories: Object.freeze([]),
    userFacts: Object.freeze(snapshot.userFacts.filter(item => allowed(item.id, item.disclosure))),
    relationships: Object.freeze(snapshot.relationships.filter(item => allowed(item.id, item.disclosure))),
    prospectiveMemories: Object.freeze(snapshot.prospectiveMemories.filter(item => allowed(item.id, item.disclosure))),
  });
}

export const SENSITIVITY_CATEGORY_LABELS: Readonly<Record<MemorySensitivityCategory, string>> = Object.freeze({
  secret: '内緒にと言われたこと',
  health: '健康',
  mental: '心の状態',
  money: 'お金',
  contact: '住所・連絡先・番号',
  romance_family: '恋愛・家族',
  work: '仕事',
  legal: '法律・トラブル',
  schedule: '予定・居場所',
  third_party: 'ほかの人のこと',
  unknown_audience: '相手が分からない場での会話',
});

/** 「ライ氏と二人の時」「ミキさんと一緒の時」: how an audience is shown to the owner and to the model. */
export function describeAudience(audience: MemoryAudience | undefined, nameOf: (personId: string) => string | undefined = () => undefined): string {
  if (!audience || isOwnerOnly(audience)) return 'ライ氏と二人の時';
  if (audience.kind === 'group') return 'グループの会話';
  if (audience.kind !== 'people') return 'ライ氏と二人の時';
  const names = audience.personIds.map(id => nameOf(id)).filter((name): name is string => Boolean(name)).map(name => `${name}さん`);
  const unnamed = audience.unknownGuest === true || names.length < audience.personIds.length;
  const everyone = [...names, ...(unnamed ? ['名前を聞いていない方'] : [])];
  return `${everyone.join('・')}と一緒の時`;
}
