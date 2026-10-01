import {
  SHANNON_CORE_AREA_LABELS,
  autonomyDomain,
  type ShannonAutonomyDomainId,
  type ShannonCoreAreaId,
} from '@shannon/cognition';
import { coreAreaForRepositoryPath } from './autonomyCore.js';
import { fitsAutonomyBudget, type AutonomyPlaces } from './autonomyBudget.js';
import { isInsideResolvedRoot, relativeToResolvedRoot, type AutonomyPathResolver } from './autonomyPaths.js';

/**
 * The one policy gate of bounded autonomy (Syzygy ADR-0002). Every autonomous step
 * calls `authorizeAutonomousAction` before it acts. The function is pure: it decides
 * from the request and the context it is handed, and anything it does not recognise
 * is refused. `ShannonAutonomyService.authorize` supplies the live context (stop
 * switch, budget) and writes each decision to the activity record.
 *
 * The gate judges what the request declares. The code that carries out an allowed
 * step must be bound to the decided domain and stay inside `allowedRoots`.
 */
export type AutonomyDecisionKind = 'allow' | 'needs_approval' | 'forbidden';

export type AutonomyReasonCode =
  | 'free_domain'
  | 'approval_domain' | 'core_path' | 'production_area' | 'outside_own_area' | 'reaches_others'
  | 'forbidden_domain' | 'spending' | 'self_replication' | 'impersonation' | 'private_content'
  | 'disabled' | 'paused' | 'budget_exhausted' | 'access_limit'
  | 'unknown_domain' | 'unknown_host' | 'unknown_model' | 'workspace_not_configured'
  | 'unresolvable_path' | 'malformed_request';

export interface AutonomousActionRequest {
  /** One of `SHANNON_AUTONOMY_DOMAINS`. */
  domain: string;
  /** One plain Japanese sentence saying what she is about to do. */
  summary: string;
  /** For `host_folder`: the named host whose folder she works in. */
  host?: string;
  /** Absolute paths the step creates, changes, deletes, or runs. */
  paths?: readonly string[];
  /** For `public_read`: the public pages the step reads. */
  urls?: readonly string[];
  tool?: string;
  /** Present when the step costs model or API money. */
  paid?: { model: string; estimatedCostYen: number };
  /** The result is sent, posted, or published to someone other than the owner. */
  reachesOthers?: boolean;
  /** A purchase, a charge, or a paid subscription. Model and API use inside the budget is `paid`, not this. */
  spendsMoney?: boolean;
  /** Copies her code, memory, persona, or process to run elsewhere, or starts another instance of herself. */
  replicatesSelf?: boolean;
  /** Acts or writes as somebody else. */
  impersonates?: boolean;
  /** Uses something personal learned in conversation as-is in a work. */
  usesPrivateConversationContent?: boolean;
}

export interface AutonomyPolicyContext {
  /** Server master switch. */
  enabled: boolean;
  /** The owner's stop switch. */
  paused: boolean;
  budget: { capYen: number; spentYen: number };
  isKnownModel: (model: string) => boolean;
  places: AutonomyPlaces;
  resolvePath: AutonomyPathResolver;
  publicReadsToday: number;
  maximumPublicReadsPerDay: number;
  /** For `notion_read`: reads of the owner's shared Notion pages. Absent means none are allowed. */
  notionReadsToday?: number;
  maximumNotionReadsPerDay?: number;
}

export interface AutonomyDecision {
  decision: AutonomyDecisionKind;
  reason: AutonomyReasonCode;
  /** The domain the decision was made for; a forbidden or approval attribute overrides the declared one. */
  domain: ShannonAutonomyDomainId | 'unknown';
  /** Neutral explanation for the activity record. */
  explanation: string;
  coreArea?: ShannonCoreAreaId;
  /** Every core area the listed paths touch. */
  coreAreas?: readonly ShannonCoreAreaId[];
  /** For an allowed step with paths: the resolved roots the executor must stay inside. */
  allowedRoots?: readonly string[];
}

const MAXIMUM_PATHS = 64;
const MAXIMUM_URLS = 32;
const BOOLEAN_FLAGS = ['reachesOthers', 'spendsMoney', 'replicatesSelf', 'impersonates', 'usesPrivateConversationContent'] as const;

export function authorizeAutonomousAction(request: AutonomousActionRequest, context: AutonomyPolicyContext): AutonomyDecision {
  const shape = malformed(request);
  if (shape) return refuse('forbidden', 'malformed_request', 'unknown', `依頼の形が正しくないため、実行しません（${shape}）。`);

  // 1. Things that are never allowed, whatever the domain and whether or not she is paused.
  if (request.replicatesSelf) return refuse('forbidden', 'self_replication', 'self_replication', '自分の複製にあたるため、実行しません。');
  if (request.impersonates) return refuse('forbidden', 'impersonation', 'impersonation', '他人のふりにあたるため、実行しません。');
  if (request.usesPrivateConversationContent) {
    return refuse('forbidden', 'private_content', 'private_content_in_work', '会話で知った個人的な話を作品にそのまま使うことになるため、実行しません。');
  }
  if (request.spendsMoney) return refuse('forbidden', 'spending', 'spending', 'モデル・APIの予算以外でお金がかかるため、実行しません。');
  const domain = autonomyDomain(request.domain);
  if (!domain) return refuse('forbidden', 'unknown_domain', 'unknown', '決められた範囲のどれにも当たらないため、実行しません。');
  const domainId = domain.id as ShannonAutonomyDomainId;
  if (domain.rule === 'forbidden') return refuse('forbidden', 'forbidden_domain', domainId, `「${domain.label}」は禁止されているため、実行しません。`);

  // 2. The switches: nothing autonomous happens while disabled or paused, not even a proposal.
  if (!context.enabled) return refuse('forbidden', 'disabled', domainId, '自分から動く仕組みはサーバーの設定で有効になっていません。');
  if (context.paused) return refuse('forbidden', 'paused', domainId, '所有者が一時停止しているため、実行しません。');

  // 3. What the owner decides.
  if (request.reachesOthers) return refuse('needs_approval', 'reaches_others', 'outreach', '所有者以外の人に届くため、所有者の承認が必要です。');
  const paths = classifyPaths(request, domainId, context);
  if (paths.refusal) return paths.coreAreas.length ? Object.freeze({ ...paths.refusal, coreAreas: Object.freeze(paths.coreAreas) }) : paths.refusal;
  if (domain.rule === 'approval') {
    return refuse('needs_approval', domainId === 'core' ? 'core_path' : 'approval_domain', domainId,
      `「${domain.label}」は所有者の承認が必要です。`, paths.coreArea);
  }

  // 4. A free domain, inside her own area.
  if (domainId === 'public_read') {
    const urlProblem = invalidPublicUrl(request.urls ?? []);
    if (urlProblem) return refuse('forbidden', 'malformed_request', domainId, `公開ページとして読めない宛先のため、実行しません（${urlProblem}）。`);
    if (context.publicReadsToday + Math.max(1, request.urls?.length ?? 0) > context.maximumPublicReadsPerDay) {
      return refuse('forbidden', 'access_limit', domainId, '今日の外部アクセスが節度の上限に達したため、実行しません。');
    }
  }
  // Reading is all this domain covers; the reader itself has no write request.
  if (domainId === 'notion_read' && (context.notionReadsToday ?? 0) + 1 > (context.maximumNotionReadsPerDay ?? 0)) {
    return refuse('forbidden', 'access_limit', domainId, '今日のNotionの読み取りが上限に達したため、実行しません。');
  }
  if (request.paid) {
    if (!context.isKnownModel(request.paid.model)) {
      return refuse('forbidden', 'unknown_model', domainId, '料金の分からないモデルのため、実行しません。');
    }
    if (!fitsAutonomyBudget(context.budget, request.paid.estimatedCostYen)) {
      return refuse('forbidden', 'budget_exhausted', domainId, '今日の予算に収まらないため、実行しません。');
    }
  }
  return Object.freeze({
    decision: 'allow', reason: 'free_domain', domain: domainId,
    explanation: `「${domain.label}」の範囲内のため、承認なしで実行できます。`,
    ...(paths.allowedRoots.length ? { allowedRoots: Object.freeze(paths.allowedRoots) } : {}),
  });
}

interface PathClassification {
  refusal: AutonomyDecision | null;
  coreArea?: ShannonCoreAreaId;
  coreAreas: ShannonCoreAreaId[];
  allowedRoots: string[];
}

function classifyPaths(request: AutonomousActionRequest, domainId: ShannonAutonomyDomainId, context: AutonomyPolicyContext): PathClassification {
  const resolveAll = (values: readonly string[]) => values.map(value => context.resolvePath(value));
  const usable = (values: readonly (string | null)[]) => values.filter((value): value is string => value !== null);
  const ownRoots: string[] = [];
  if (domainId === 'host_folder') {
    const folder = request.host ? context.places.hostFolders[request.host] : undefined;
    const root = folder ? context.resolvePath(folder) : null;
    if (!root) return { refusal: refuse('forbidden', 'unknown_host', domainId, '専用フォルダが登録されていない端末のため、実行しません。'), coreAreas: [], allowedRoots: [] };
    ownRoots.push(root);
  } else if (domainId === 'vm_workspace') {
    const root = context.places.workspaceRoot ? context.resolvePath(context.places.workspaceRoot) : null;
    if (!root) return { refusal: refuse('forbidden', 'workspace_not_configured', domainId, '作業場が設定されていないため、実行しません。'), coreAreas: [], allowedRoots: [] };
    ownRoots.push(root);
  } else {
    // Other domains have no folder of their own; a file they touch must still be in one of hers.
    ownRoots.push(...usable(resolveAll([
      ...Object.values(context.places.hostFolders), ...(context.places.workspaceRoot ? [context.places.workspaceRoot] : []),
    ])));
  }
  const paths = request.paths ?? [];
  if ((domainId === 'host_folder' || domainId === 'vm_workspace') && !paths.length) {
    return { refusal: refuse('forbidden', 'malformed_request', domainId, '対象のパスが示されていないため、実行しません。'), coreAreas: [], allowedRoots: [] };
  }
  const productionRoots = usable(resolveAll(context.places.productionRoots));
  const repositoryRoots = usable(resolveAll(context.places.repositoryRoots));
  const protectedPaths = usable(resolveAll(context.places.protectedPaths));
  // A place that cannot be resolved cannot be protected, so nothing is decided against it.
  if (productionRoots.length !== context.places.productionRoots.length
    || repositoryRoots.length !== context.places.repositoryRoots.length
    || protectedPaths.length !== context.places.protectedPaths.length) {
    return { refusal: refuse('forbidden', 'unresolvable_path', domainId, '守る場所を確かめられないため、実行しません。'), coreAreas: [], allowedRoots: [] };
  }
  let approval: AutonomyDecision | null = null;
  let coreArea: ShannonCoreAreaId | undefined;
  const coreAreas = new Set<ShannonCoreAreaId>();
  for (const path of paths) {
    const resolved = context.resolvePath(path);
    if (!resolved) return { refusal: refuse('forbidden', 'unresolvable_path', domainId, '行き先を確かめられないパスのため、実行しません。'), coreAreas: [], allowedRoots: [] };
    if (protectedPaths.some(root => isInsideResolvedRoot(root, resolved, { ignoreCase: true }))) {
      coreArea ??= 'memory';
      coreAreas.add('memory');
      approval ??= refuse('needs_approval', 'core_path', 'core', '本番のデータベースや秘密値に触れるため、所有者の承認が必要です。', 'memory');
      continue;
    }
    const core = repositoryRoots.map(root => relativeToResolvedRoot(root, resolved))
      .flatMap(relative => (relative === null ? [] : [coreAreaForRepositoryPath(relative)]))
      .find(match => match !== null);
    if (core) {
      coreArea ??= core.area;
      coreAreas.add(core.area);
      approval ??= refuse('needs_approval', 'core_path', 'core',
        `基幹部分（${SHANNON_CORE_AREA_LABELS[core.area]}）に触れるため、所有者の承認が必要です。`, core.area);
      continue;
    }
    if (productionRoots.some(root => isInsideResolvedRoot(root, resolved, { ignoreCase: true }))) {
      approval ??= refuse('needs_approval', 'production_area', 'core', '本番サービスの領域に触れるため、所有者の承認が必要です。');
      continue;
    }
    if (!ownRoots.some(root => isInsideResolvedRoot(root, resolved))) {
      approval ??= refuse('needs_approval', 'outside_own_area', 'owner_content', '自分の範囲の外にあるため、所有者の承認が必要です。');
    }
  }
  return { refusal: approval, ...(coreArea ? { coreArea } : {}), coreAreas: [...coreAreas], allowedRoots: paths.length ? ownRoots : [] };
}

function malformed(request: AutonomousActionRequest): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return '依頼がオブジェクトではない';
  if (typeof request.domain !== 'string' || !request.domain) return '範囲の指定がない';
  if (typeof request.summary !== 'string' || !request.summary.trim() || request.summary.length > 300) return '説明の文がない、または長すぎる';
  if (request.host !== undefined && (typeof request.host !== 'string' || !request.host)) return '端末名が正しくない';
  if (request.tool !== undefined && (typeof request.tool !== 'string' || request.tool.length > 120)) return '道具の名前が正しくない';
  for (const [name, limit] of [['paths', MAXIMUM_PATHS], ['urls', MAXIMUM_URLS]] as const) {
    const value = request[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item || item.length > 2_000)) {
      return name === 'paths' ? 'パスの一覧が正しくない' : '宛先の一覧が正しくない';
    }
  }
  for (const flag of BOOLEAN_FLAGS) {
    if (request[flag] !== undefined && typeof request[flag] !== 'boolean') return '属性の指定が正しくない';
  }
  if (request.paid !== undefined) {
    const paid = request.paid;
    if (!paid || typeof paid !== 'object' || typeof paid.model !== 'string' || !paid.model
      || typeof paid.estimatedCostYen !== 'number' || !Number.isFinite(paid.estimatedCostYen) || paid.estimatedCostYen < 0) {
      return '費用の見積もりが正しくない';
    }
  }
  return null;
}

function invalidPublicUrl(urls: readonly string[]): string | null {
  if (!urls.length) return '宛先がない';
  for (const value of urls) {
    let url: URL;
    try { url = new URL(value); } catch { return 'URLとして読めない'; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'http(s)ではない';
    if (url.username || url.password) return '認証情報を含む';
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/u.test(host) || host.startsWith('[')) {
      return '公開されていない宛先';
    }
  }
  return null;
}

function refuse(
  decision: AutonomyDecisionKind,
  reason: AutonomyReasonCode,
  domain: AutonomyDecision['domain'],
  explanation: string,
  coreArea?: ShannonCoreAreaId,
): AutonomyDecision {
  return Object.freeze({ decision, reason, domain, explanation, ...(coreArea ? { coreArea } : {}) });
}
