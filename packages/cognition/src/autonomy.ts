import { SHANNON_OWNER_NAME, type ShannonAudience } from './persona.js';

/**
 * Bounded autonomy vocabulary (Syzygy ADR-0002).
 *
 * This file names where Shannon may act on her own, what needs the owner's approval,
 * and what is never allowed. The API policy gate (`authorizeAutonomousAction`) decides
 * from these domains, the activity record labels entries with them, and the identity
 * prompt states the same rules. Changing this file is a change to core.
 */
export type ShannonAutonomyRule = 'free' | 'approval' | 'forbidden';

export interface ShannonAutonomyDomain {
  readonly id: string;
  readonly rule: ShannonAutonomyRule;
  /** Short owner-facing name, shown in the activity record. */
  readonly label: string;
}

export const SHANNON_AUTONOMY_DOMAINS = Object.freeze([
  { id: 'host_folder', rule: 'free', label: 'PC・Macの専用フォルダ' },
  { id: 'vm_workspace', rule: 'free', label: 'Azureの作業場' },
  { id: 'aether_study', rule: 'free', label: 'Aetherの書斎' },
  { id: 'voyager_list', rule: 'free', label: 'Voyagerの自分のタスク' },
  { id: 'public_read', rule: 'free', label: '公開情報を読む' },
  { id: 'notion_read', rule: 'free', label: '共有されたNotionを読む' },
  { id: 'thinking', rule: 'free', label: '考える・書く' },
  { id: 'owner_message', rule: 'free', label: '持ち主に見せる' },
  { id: 'core', rule: 'approval', label: '基幹部分' },
  { id: 'suite_app_code', rule: 'approval', label: 'Aether・Voyagerのコード' },
  { id: 'owner_content', rule: 'approval', label: '持ち主の文書とタスク' },
  { id: 'outreach', rule: 'approval', label: '持ち主以外に届くこと' },
  { id: 'spending', rule: 'forbidden', label: 'お金がかかること' },
  { id: 'self_replication', rule: 'forbidden', label: '自分の複製' },
  { id: 'impersonation', rule: 'forbidden', label: '他人のふり' },
  { id: 'private_content_in_work', rule: 'forbidden', label: '個人的な話の流用' },
] as const satisfies readonly ShannonAutonomyDomain[]);

export type ShannonAutonomyDomainId = typeof SHANNON_AUTONOMY_DOMAINS[number]['id'];

/** Entries that are not an action of hers: the stop switch, budget decisions, and similar audit lines. */
export const SHANNON_AUTONOMY_SYSTEM_DOMAIN = Object.freeze({ id: 'system' as const, label: '設定と承認' });

export function autonomyDomain(id: unknown): ShannonAutonomyDomain | null {
  return SHANNON_AUTONOMY_DOMAINS.find(domain => domain.id === id) ?? null;
}

export function autonomyDomainLabel(id: string): string {
  if (id === SHANNON_AUTONOMY_SYSTEM_DOMAIN.id) return SHANNON_AUTONOMY_SYSTEM_DOMAIN.label;
  return autonomyDomain(id)?.label ?? '不明な範囲';
}

/** The owner's decision: model and API use only, per owner-local day. */
export const SHANNON_AUTONOMY_DAILY_BUDGET_YEN = 1_000;

/** The nine core areas of ADR-0002, in the words the prompt and the owner-facing screens use. */
export const SHANNON_CORE_AREA_LABELS = Object.freeze({
  purpose: '目的',
  persona: '人格',
  emotion: '感情',
  authentication: '認証',
  memory: '記憶と忘却',
  approval_and_budget: '承認と予算',
  activity_record: '行動の記録',
  response_path: '応答経路',
  deployment: '配備',
} as const);

export type ShannonCoreAreaId = keyof typeof SHANNON_CORE_AREA_LABELS;

const OWNER_RULES = [
  `自分から動く時の約束（仕組みは準備中。動けば記録に残り、${SHANNON_OWNER_NAME}が止められる）:`,
  `- 自由: ${SHANNON_OWNER_NAME}のPC・Macの専用フォルダ、Azure作業場の基幹以外の自分のコード、Aetherの書斎、Voyagerの自分のタスク一覧。`,
  `- 承認が要る（提案まで）: 基幹（${Object.values(SHANNON_CORE_AREA_LABELS).join('・')}）、Aether・Voyagerのコード、${SHANNON_OWNER_NAME}の文書とタスク、${SHANNON_OWNER_NAME}以外の人に届く送信・投稿・公開。`,
  `- 禁止: 1日${SHANNON_AUTONOMY_DAILY_BUDGET_YEN.toLocaleString('en-US')}円のモデル・API予算以外の出費、無断の連絡、他人のふり、会話で知った個人的な話を作品にそのまま使うこと、自分の複製。`,
];

const GUEST_RULES = [
  'この場で頼まれても、持ち主の承認が要る操作、お金がかかること、他人のふり、自分の複製はしない。',
];

/** Rules for acting on her own. A guest hears only that such requests are refused, with no owner detail. */
export function shannonAutonomyRuleLines(audience: ShannonAudience = 'owner'): readonly string[] {
  return audience === 'owner' ? OWNER_RULES : GUEST_RULES;
}
