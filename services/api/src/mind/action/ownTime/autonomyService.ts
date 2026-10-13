import {
  SHANNON_AUTONOMY_SYSTEM_DOMAIN,
  SHANNON_CONVERSATION_ACTION_DOMAIN,
  buildShannonOwnWorkPrompt,
  buildShannonPursuitsPrompt,
  buildShannonSeenPrompt,
  withAutonomyRunning,
  type ShannonPursuit,
  type ShannonPursuitLink,
  type ShannonPursuitStatus,
} from '@shannon/cognition';
import type { AgentTask, AgentTaskStore } from '../agentTasks/agentTasksPorts.js';
import { DisabledAutonomyAnnouncer, type AutonomyAnnouncer } from './autonomyAnnouncer.js';
import { type AutonomyLoopStatus } from '../../inhibition/inhibitionPorts.js';
import { autonomyLoopStatus } from '../../inhibition/autonomyReadPorts.js';
import {
  authorizeAutonomousAction, autonomyBudgetStatus, autonomyDayKey, configuredAutonomy, formatYen, yenFromUsd, type AutonomousActionRequest, type AutonomyActivityDay,
  type AutonomyActivityEntry, type AutonomyBudgetStatus, type AutonomyConfig, type AutonomyDecision, type GateRefusalObserver,
} from '../../inhibition/inhibitionPorts.js';
import {
  autonomyModel, autonomyModelAllowedFor, autonomyModelChoices, autonomyModelCostUsd, isAutonomyModelPurpose, type AutonomyModelUsage,
} from './autonomyModels.js';
import { HostFolderDesk } from './autonomyHostFolderDesk.js';
import { HostFolderOperations } from './hostFolderOperations.js';
import { ShannonToolRunner, type ToolAetherPorts } from '../../tools/toolRunnerPorts.js';
import { StudyAether } from './studyAether.js';
import { resolvePhysicalPath, type AutonomyPathResolver } from '../../inhibition/autonomyReadPorts.js';
import type { ShannonAgentTaskProposal, ShannonProposalDraft } from './store/autonomyProposals.js';
import type { PursuitDraft, PursuitRejection } from '../../self/selfPorts.js';
import { autonomyPacing } from './autonomyLoopConfig.js';
import { autonomySessionView } from './autonomySessionView.js';
import { SQLiteAutonomyStore, type AutonomyBudgetRequest } from './store/autonomyStore.js';
import { StudyDesk, type StudyReactionTap } from './studyDesk.js';
import { clip, pursuitStatusPhrase, type AutonomyOverview } from './autonomyServiceParts.js';

/**
 * The live side of bounded autonomy: it hands `authorizeAutonomousAction` the current stop switch and budget, writes every
 * decision to the activity record, and offers the only functions through which Shannon's own activity may write (each one asks
 * the gate first). The owner-side functions back the HTTP routes. The activity loop (`autonomyLoop.ts`, its own process) is the
 * only caller of the Shannon-side functions.
 */
export interface AutonomyServiceDependencies {
  store: SQLiteAutonomyStore;
  config: AutonomyConfig;
  now: () => string;
  announcer?: AutonomyAnnouncer;
  agentTasks?: AgentTaskStore;
  /** The Talk an owner-started proposal belongs to. */
  defaultThread?: (scopeKey: string) => string;
  defaultAgentHost?: string | null;
  resolvePath?: AutonomyPathResolver;
  /** Every look at the room in the last hour and today, with the overall limits; null while looks are switched off. Only the activity loop's service has it. */
  roomLooks?: (scopeKey: string, at: string) => { lastHour: number; maximumPerHour: number; today: number; maximumPerDay: number } | null;
  /** Messages she started on her own today, with the limit. Only the activity loop's service has it. */
  reachOuts?: (scopeKey: string, at: string) => { today: number; maximumPerDay: number } | null;
  /** Second calls after a message of hers got no answer today, with the limit. Only the activity loop's service has it. */
  reachOutFollowUps?: (scopeKey: string, at: string) => { today: number; maximumPerDay: number } | null;
  /** Whether a call to the owner's iPhone may be placed now. Only the activity loop's service has it. */
  calls?: (scopeKey: string, at: string) => { available: boolean } | null;
  /** When the owner first wrote or spoke after an instant, or null: a timestamp, for what followed a message of hers. */
  ownerFirstActiveAfter?: (scopeKey: string, after: string) => string | null;
  /** Aether (Syzygy ADR-0007 revised): her study's text and her Aether folder, and the owner's proposal inbox; absent, none of it. */
  aether?: Pick<ToolAetherPorts, 'access' | 'proposals' | 'ownerDocuments'> & { studyScopeKey?: string };
  /** Syzygy ADR-0008 stage 1: told the reaction (the enum only) after the owner reacted to a story; absent, nothing is told. */
  storyReacted?: StudyReactionTap;
  /** Syzygy ADR-0008 §14: told each step the gate did not allow, to write it as withheld (`withheldRules.ts`); absent, nothing is told. */
  withheld?: GateRefusalObserver;
}

export interface RecordedDecision extends AutonomyDecision {
  /** The activity-record entry of this decision. */
  activityId: string;
}

export type { AutonomyControlLabel, AutonomyOverview } from './autonomyServiceParts.js';

export type AutonomyOwnerError =
  | 'BUDGET_REQUEST_NOT_FOUND' | 'BUDGET_REQUEST_DECIDED' | 'BUDGET_REQUEST_EXPIRED' | 'BUDGET_AMOUNT_INVALID'
  | 'PROPOSAL_NOT_FOUND' | 'PROPOSAL_DECIDED' | 'AGENT_TASKS_UNAVAILABLE' | PursuitRejection;

export interface ActionReport {
  /** The allowed decision this action was carried out under. */
  decisionId: string;
  summary: string;
  outcome: 'done' | 'failed';
  link?: string;
  tool?: string;
  /** Actual usage of a paid step, from the provider response. */
  usage?: AutonomyModelUsage & { purpose?: string };
  /** Why a step failed, as a code from a closed set. */
  reasonCode?: string;
}

export class ShannonAutonomyService {
  private readonly store: SQLiteAutonomyStore;
  private readonly config: AutonomyConfig;
  private readonly now: () => string;
  private readonly announcer: AutonomyAnnouncer;
  private readonly resolvePath: AutonomyPathResolver;
  /** The owner's side of her study: reading, reacting, asking her to put a piece away. */
  readonly study: StudyDesk;
  /** Her folder on the owner's machines: the queue she fills and the bound device empties. Both ends ask the gate. */
  readonly folder: HostFolderDesk;
  /** v2: operations in her folder that her tools queue, and the long-poll claim of the bound device (`hostFolderOperations.ts`). */
  readonly folderOperations: HostFolderOperations;
  /** Her tools over her study and her folder (`shannonTools.ts`), for every surface. */
  readonly tools: ShannonToolRunner;
  /** Her study in Aether while Aether is configured (`studyAether.ts`); null, the SQLite study is the whole study. */
  readonly studyAether: StudyAether | null;

  constructor(private readonly dependencies: AutonomyServiceDependencies) {
    this.store = dependencies.store;
    this.config = dependencies.config;
    this.now = dependencies.now;
    this.announcer = dependencies.announcer ?? new DisabledAutonomyAnnouncer();
    this.resolvePath = dependencies.resolvePath ?? resolvePhysicalPath;
    this.studyAether = dependencies.aether?.access ? new StudyAether(this.store, dependencies.aether.access, this.now, dependencies.aether.studyScopeKey) : null;
    this.study = new StudyDesk(this.store, at => autonomyDayKey(at, this.config), this.now,
      this.config.maximumReachOutFollowUpsPerDay > 0 ? { timeZone: this.config.timeZone, ...(dependencies.ownerFirstActiveAfter ? { ownerFirstActiveAfter: dependencies.ownerFirstActiveAfter } : {}) } : null, this.studyAether, dependencies.storyReacted ?? null);
    this.folder = new HostFolderDesk(this.store, this.config, this.now, this);
    this.folderOperations = new HostFolderOperations(this.store, this.config, this.now, this, this.folder);
    this.tools = new ShannonToolRunner(this.store, this.folderOperations, this, this.now, undefined,
      { access: dependencies.aether?.access ?? null, study: this.studyAether, proposals: dependencies.aether?.proposals ?? null, ownerDocuments: dependencies.aether?.ownerDocuments === true });
  }

  // MARK: The gate

  /** Fresh read-only recheck for an already recorded, pending effect; grants no new execution. */
  inspectAuthorization(scopeKey: string, request: AutonomousActionRequest, at = this.now()): AutonomyDecision {
    const dayKey = autonomyDayKey(at, this.config);
    let paused = true;
    // A stop switch that cannot be read counts as on.
    try { paused = this.store.control(scopeKey).paused; } catch { paused = true; }
    const budget = this.budget(scopeKey, dayKey);
    const looks = this.dependencies.roomLooks?.(scopeKey, at) ?? null;
    const reachOuts = this.dependencies.reachOuts?.(scopeKey, at) ?? null;
    const followUps = this.dependencies.reachOutFollowUps?.(scopeKey, at) ?? null;
    let calls: { available: boolean } | null = null;
    try { calls = this.dependencies.calls?.(scopeKey, at) ?? null; } catch { calls = null; }
    const decision = authorizeAutonomousAction(request, {
      enabled: this.config.enabled,
      paused,
      budget,
      isKnownModel: model => autonomyModel(model) !== null,
      places: this.config.places,
      resolvePath: this.resolvePath,
      publicReadsToday: this.store.activity.countForDay(scopeKey, dayKey, 'public_read', 'allowed'),
      maximumPublicReadsPerDay: this.config.maximumPublicReadsPerDay,
      notionReadsToday: this.store.activity.countForDay(scopeKey, dayKey, 'notion_read', 'allowed'),
      maximumNotionReadsPerDay: this.config.maximumNotionReadsPerDay,
      ...(looks ? { roomLooks: {
        activityToday: this.store.activity.countForDay(scopeKey, dayKey, 'room_look', 'allowed'),
        maximumActivityPerDay: this.config.maximumRoomLooksPerDay, ...looks,
      } } : {}),
      ...(reachOuts ? { reachOuts } : {}),
      ...(followUps ? { reachOutFollowUps: followUps } : {}),
      // A session that read the owner's documents or a shared Notion page reaches nobody else (ADR-0007, owner decisions 2026-10-06).
      ...(calls ? { calls } : {}), ...(this.store.informed.openSessionInformed(scopeKey) ? { ownerInformed: true } : {}),
    });
    return decision;
  }

  /** Decides one autonomous step and appends its original authorization to the activity record. */
  authorize(scopeKey: string, request: AutonomousActionRequest): RecordedDecision {
    const at = this.now(), dayKey = autonomyDayKey(at, this.config);
    const decision = this.inspectAuthorization(scopeKey, request, at);
    const declared = request && typeof request === 'object' ? request : {} as Partial<AutonomousActionRequest>;
    const entry = this.store.activity.append(scopeKey, dayKey, at, {
      kind: 'decision',
      actor: 'shannon',
      summary: typeof declared.summary === 'string' && declared.summary.trim() ? declared.summary : '形の正しくない依頼がありました。',
      detail: decision.explanation,
      domain: decision.domain === 'unknown' && typeof declared.domain === 'string' && declared.domain ? declared.domain : decision.domain,
      ...(typeof declared.paid?.model === 'string' ? { model: declared.paid.model } : {}),
      ...(typeof declared.tool === 'string' ? { tool: declared.tool } : {}),
      outcome: decision.decision === 'allow' ? 'allowed' : decision.decision === 'needs_approval' ? 'needs_approval' : 'refused',
      approval: decision.decision === 'needs_approval' ? 'needed' : 'not_needed',
      reasonCode: decision.reason,
    });
    if (decision.decision !== 'allow') { try { this.dependencies.withheld?.(scopeKey, declared, decision, at); } catch { /* the refusal stands */ } }
    return Object.freeze({ ...decision, activityId: entry.id });
  }

  // MARK: Shannon's own writes (each asks the gate first)

  /** Records what an allowed step did and, for a paid step, what it actually cost. */
  recordAction(scopeKey: string, report: ActionReport): AutonomyActivityEntry {
    const decision = this.store.activity.get(scopeKey, report.decisionId);
    if (!decision || decision.kind !== 'decision' || decision.outcome !== 'allowed'
      || this.store.activity.followUps(scopeKey, decision.id, 'action') > 0) {
      throw new Error('AUTONOMY_ACTION_NOT_AUTHORIZED');
    }
    // Usage is accepted only for the model the gate priced.
    if (report.usage && !decision.model) throw new Error('AUTONOMY_ACTION_NOT_AUTHORIZED');
    const at = this.now();
    const dayKey = autonomyDayKey(at, this.config);
    return this.store.transaction(() => {
      let costYen = 0;
      if (report.usage && decision.model) {
        const costUsd = autonomyModelCostUsd(decision.model, report.usage, this.config.modelPrices);
        if (costUsd === null) throw new Error('AUTONOMY_MODEL_UNKNOWN');
        costYen = yenFromUsd(costUsd, this.config);
        this.store.recordSpend(scopeKey, dayKey, at, {
          model: decision.model, purpose: report.usage.purpose, inputTokens: report.usage.inputTokens,
          outputTokens: report.usage.outputTokens, costUsd, costYen, activityId: decision.id,
        });
      }
      return this.store.activity.append(scopeKey, dayKey, at, {
        kind: 'action', actor: 'shannon', summary: report.summary, domain: decision.domain,
        ...(decision.model ? { model: decision.model } : {}),
        ...(report.tool ?? decision.tool ? { tool: report.tool ?? decision.tool } : {}),
        costYen, outcome: report.outcome, ...(report.link ? { link: report.link } : {}),
        ...(report.reasonCode ? { reasonCode: report.reasonCode } : {}),
        approval: 'not_needed', relatedId: decision.id,
      });
    });
  }

  /**
   * Something she did inside a conversation with the owner, such as one look at the room.
   * It was not an autonomous step, so no gate decision precedes it and no budget is spent
   * from her own day; it is appended to the same record so the owner can see it happened.
   */
  recordConversationAction(scopeKey: string, report: { summary: string; tool: string; outcome: 'done' | 'failed'; reasonCode?: string }): AutonomyActivityEntry {
    return this.record(scopeKey, {
      kind: 'action', actor: 'shannon', summary: report.summary, domain: SHANNON_CONVERSATION_ACTION_DOMAIN.id, tool: report.tool,
      outcome: report.outcome, approval: 'not_needed', ...(report.reasonCode ? { reasonCode: report.reasonCode } : {}),
    });
  }

  /** An own-time folder operation that closed after its loop step stopped waiting (late report, lease ran out): what became of it. */
  recordLateFolderAction(scopeKey: string, report: { summary: string; tool: string; outcome: 'done' | 'failed'; reasonCode?: string }): AutonomyActivityEntry {
    return this.record(scopeKey, {
      kind: 'action', actor: 'shannon', summary: report.summary, domain: 'host_folder', tool: report.tool,
      outcome: report.outcome, approval: 'not_needed', ...(report.reasonCode ? { reasonCode: report.reasonCode } : {}),
    });
  }

  addPursuit(scopeKey: string, draft: PursuitDraft): { decision: RecordedDecision; pursuit?: ShannonPursuit; rejection?: PursuitRejection } {
    const decision = this.authorize(scopeKey, { domain: 'thinking', summary: `やりたいこと「${clip(draft?.title, 60)}」を自分の台帳に書きます。` });
    if (decision.decision !== 'allow') return { decision };
    const result = this.store.pursuits.add(scopeKey, draft, this.now());
    if (typeof result === 'string') return { decision, rejection: result };
    this.record(scopeKey, {
      kind: 'pursuit', actor: 'shannon', summary: `やりたいこと「${clip(result.title, 60)}」を台帳に書きました。`,
      detail: result.why, domain: 'thinking', outcome: 'recorded', approval: 'not_needed', relatedId: decision.activityId,
    });
    return { decision, pursuit: result };
  }

  updatePursuit(
    scopeKey: string,
    pursuitId: string,
    change: { status?: ShannonPursuitStatus; why?: string; links?: readonly ShannonPursuitLink[] },
  ): { decision: RecordedDecision; pursuit?: ShannonPursuit; rejection?: PursuitRejection } {
    const decision = this.authorize(scopeKey, { domain: 'thinking', summary: 'やりたいことの台帳を書き直します。' });
    if (decision.decision !== 'allow') return { decision };
    const result = this.store.pursuits.update(scopeKey, pursuitId, change, this.now());
    if (typeof result === 'string') return { decision, rejection: result };
    this.record(scopeKey, {
      kind: 'pursuit', actor: 'shannon', summary: `やりたいこと「${clip(result.title, 60)}」を${pursuitStatusPhrase(result.status, change.status)}。`,
      domain: 'thinking', outcome: 'recorded', approval: 'not_needed', relatedId: decision.activityId,
      ...(result.links[0] ? { link: result.links[0].url } : {}),
    });
    return { decision, pursuit: result };
  }

  /** 「せがむ」: one request per owner-local day, with a reason and an amount. */
  requestBudget(scopeKey: string, input: { reason: string; amountYen: number }):
    { decision?: RecordedDecision; request?: AutonomyBudgetRequest; rejection?: 'BUDGET_REQUEST_INVALID' | 'BUDGET_REQUEST_ALREADY_MADE' } {
    const reason = typeof input?.reason === 'string' ? input.reason.replace(/\s+/gu, ' ').trim() : '';
    const amountYen = typeof input?.amountYen === 'number' ? Math.round(input.amountYen) : Number.NaN;
    if (!reason || reason.length > 300 || !Number.isFinite(amountYen) || amountYen < 1 || amountYen > this.config.maximumExtraYenPerDay) {
      return { rejection: 'BUDGET_REQUEST_INVALID' };
    }
    const decision = this.authorize(scopeKey, { domain: 'owner_message', summary: '今日の予算を増やしてほしいと、所有者にお願いします。' });
    if (decision.decision !== 'allow') return { decision };
    const at = this.now();
    const dayKey = autonomyDayKey(at, this.config);
    const request = this.store.createBudgetRequest(scopeKey, dayKey, reason, amountYen, at);
    if (!request) return { decision, rejection: 'BUDGET_REQUEST_ALREADY_MADE' };
    this.record(scopeKey, {
      kind: 'budget', actor: 'shannon', summary: `今日の予算をあと${formatYen(amountYen)}増やしてほしいとお願いしました。`,
      detail: reason, domain: 'owner_message', outcome: 'requested', approval: 'needed', relatedId: decision.activityId,
    });
    // The request is already durable and visible in the app; a failed message must not undo it.
    try {
      this.announcer.announceBudgetRequest(scopeKey, {
        requestId: request.id, dayKey, reason, requestedYen: amountYen, capYen: this.budget(scopeKey, dayKey).capYen,
      }, at);
    } catch { /* the app still shows the request */ }
    return { decision, request };
  }

  setModelPreference(scopeKey: string, input: { purpose: string; modelId: string; reason: string }):
    { decision?: RecordedDecision; rejection?: 'MODEL_PREFERENCE_INVALID' } {
    const reason = typeof input?.reason === 'string' ? input.reason.replace(/\s+/gu, ' ').trim() : '';
    if (!isAutonomyModelPurpose(input?.purpose) || !autonomyModelAllowedFor(input.modelId, input.purpose) || !reason || reason.length > 300) {
      return { rejection: 'MODEL_PREFERENCE_INVALID' };
    }
    const model = autonomyModel(input.modelId)!;
    const decision = this.authorize(scopeKey, { domain: 'thinking', summary: `使うモデルを${model.label}に選び直します。` });
    if (decision.decision !== 'allow') return { decision };
    this.store.setModelPreference(scopeKey, { purpose: input.purpose, modelId: model.id, reason, updatedAt: this.now() });
    this.record(scopeKey, {
      kind: 'model', actor: 'shannon', summary: `使うモデルを${model.label}に選びました。`, detail: reason,
      domain: 'thinking', model: model.id, outcome: 'recorded', approval: 'not_needed', relatedId: decision.activityId,
    });
    return { decision };
  }

  /** A proposal from her own activity. It records the proposal and nothing else: no task, no command. */
  proposeAgentTask(scopeKey: string, draft: ShannonProposalDraft & { paths?: readonly string[]; domain?: 'core' | 'suite_app_code' | 'owner_content' }):
    { decision: RecordedDecision; proposal?: ShannonAgentTaskProposal } {
    const decision = this.authorize(scopeKey, {
      domain: draft?.domain ?? 'core', summary: `改修「${clip(draft?.title, 60)}」を提案します。`,
      ...(draft?.paths ? { paths: draft.paths } : {}),
    });
    if (decision.decision !== 'needs_approval') return { decision };
    const proposal = this.store.proposals.create(scopeKey, {
      title: draft.title, goal: draft.goal, reason: draft.reason,
      ...(draft.projectHint ? { projectHint: draft.projectHint } : {}),
      coreAreas: decision.coreAreas ?? (decision.coreArea ? [decision.coreArea] : []),
    }, this.now());
    if (!proposal) return { decision };
    this.record(scopeKey, {
      kind: 'proposal', actor: 'shannon', summary: `改修「${clip(proposal.title, 60)}」を所有者に提案しました。`,
      detail: proposal.reason, domain: decision.domain, outcome: 'needs_approval', approval: 'needed',
      link: `shannon-proposal://${proposal.id}`, relatedId: decision.activityId,
    });
    return { decision, proposal };
  }

  // MARK: Owner

  overview(scopeKey: string): AutonomyOverview {
    const at = this.now();
    const dayKey = autonomyDayKey(at, this.config);
    const control = this.store.control(scopeKey);
    const proposals = this.store.proposals.list(scopeKey);
    const budget = this.budget(scopeKey, dayKey);
    const session = autonomyPacing() === 'sessions' ? autonomySessionView(this.store.loop, scopeKey, at, this.config.timeZone) : null;
    return Object.freeze({
      control: {
        state: !this.config.enabled ? 'disabled' as const : control.paused ? 'paused' as const : 'active' as const,
        enabled: this.config.enabled, paused: control.paused, changedAt: control.changedAt,
      },
      loop: this.loopStatus(scopeKey, at, control.paused, budget),
      ...(session ? { session } : {}),
      budget,
      budgetRequest: this.store.budgetRequest(scopeKey, dayKey),
      maximumExtraYen: this.config.maximumExtraYenPerDay,
      pursuits: this.store.pursuits.list(scopeKey, at),
      modelChoices: autonomyModelChoices(this.store.modelPreferences(scopeKey)),
      proposals: [...proposals.filter(item => item.status === 'proposed'), ...proposals.filter(item => item.status !== 'proposed').slice(0, 10)],
    });
  }

  activityDays(scopeKey: string, days = 14): readonly AutonomyActivityDay[] {
    const span = Math.max(1, Math.min(90, Math.trunc(days)));
    const since = new Date(Date.parse(this.now()) - (span - 1) * 24 * 60 * 60_000).toISOString();
    return this.store.activity.days(scopeKey, { sinceDayKey: autonomyDayKey(since, this.config) });
  }

  /** The stop switch. Takes effect at the next `authorize`, because the gate reads it every time. */
  setPaused(scopeKey: string, paused: boolean): AutonomyOverview {
    const before = this.store.control(scopeKey).paused;
    if (before !== paused) {
      this.store.transaction(() => {
        this.store.setPaused(scopeKey, paused, this.now());
        this.record(scopeKey, {
          kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id,
          summary: paused ? '所有者が自律活動を一時停止しました。' : '所有者が自律活動の一時停止を解除しました。',
          outcome: paused ? 'paused' : 'resumed', approval: 'not_needed',
        });
      });
    }
    return this.overview(scopeKey);
  }

  decideBudgetRequest(scopeKey: string, requestId: string, decision: 'approve' | 'decline', amountYen?: number): AutonomyOverview | AutonomyOwnerError {
    const request = this.store.budgetRequestById(scopeKey, requestId);
    if (!request) return 'BUDGET_REQUEST_NOT_FOUND';
    if (request.status !== 'pending') return 'BUDGET_REQUEST_DECIDED';
    const at = this.now();
    // Approval raises only the day it was asked for; yesterday's request cannot raise today.
    if (request.dayKey !== autonomyDayKey(at, this.config)) return 'BUDGET_REQUEST_EXPIRED';
    const amount = decision === 'approve' ? Math.round(amountYen ?? request.requestedYen) : 0;
    if (decision === 'approve' && (!Number.isFinite(amount) || amount < 1 || amount > this.config.maximumExtraYenPerDay)) {
      return 'BUDGET_AMOUNT_INVALID';
    }
    const decided = this.store.transaction(() => {
      const saved = this.store.decideBudgetRequest(scopeKey, requestId, decision === 'approve' ? 'approved' : 'declined', amount, at);
      if (saved) {
        this.record(scopeKey, {
          kind: 'budget', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id,
          summary: decision === 'approve' ? `所有者が今日の予算を${formatYen(amount)}増やしました。` : '所有者が予算の追加を見送りました。',
          detail: request.reason, outcome: decision === 'approve' ? 'approved' : 'declined',
          approval: decision === 'approve' ? 'approved' : 'declined',
        });
      }
      return saved;
    });
    return decided ? this.overview(scopeKey) : 'BUDGET_REQUEST_DECIDED';
  }

  /** The owner may tell her to rest or drop one of her own non-seed pursuits; nothing else is editable. */
  setPursuitStatusByOwner(scopeKey: string, pursuitId: string, status: 'resting' | 'dropped'): AutonomyOverview | AutonomyOwnerError {
    if (this.store.pursuits.get(scopeKey, pursuitId)?.status === status) return this.overview(scopeKey); // Sent once, answered alike (E2).
    const result = this.store.pursuits.update(scopeKey, pursuitId, { status }, this.now(), 'owner');
    if (typeof result === 'string') return result;
    this.record(scopeKey, {
      kind: 'pursuit', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id,
      summary: `所有者が「${clip(result.title, 60)}」を${status === 'resting' ? '休ませる' : 'やめる'}よう伝えました。`,
      outcome: 'recorded', approval: 'not_needed',
    });
    return this.overview(scopeKey);
  }

  /** Only this call, made by the owner, turns a proposal into an agent task. */
  decideProposal(scopeKey: string, proposalId: string, decision: 'start' | 'decline'):
    { overview: AutonomyOverview; task?: AgentTask } | AutonomyOwnerError {
    const proposal = this.store.proposals.get(scopeKey, proposalId);
    if (!proposal) return 'PROPOSAL_NOT_FOUND';
    if (proposal.status !== 'proposed') return 'PROPOSAL_DECIDED';
    const at = this.now();
    let task: AgentTask | undefined;
    if (decision === 'start') {
      const agentTasks = this.dependencies.agentTasks;
      const threadId = this.dependencies.defaultThread?.(scopeKey);
      if (!agentTasks || !threadId) return 'AGENT_TASKS_UNAVAILABLE';
      const hostHint = agentTasks.resolveHost(proposal.projectHint, 'auto', at, this.dependencies.defaultAgentHost ?? null);
      // The same idempotency key makes a retried start return the one task.
      task = agentTasks.create(scopeKey, {
        ...(agentTasks.taskTrees ? {taskAuthority:{origin:'own_time' as const,budgetLane:'autonomy' as const,ownerInformed:true,permissionId:`proposal:${proposal.id}`}} : {}),
        idempotencyKey: `shannon-proposal:${proposal.id}`, conversationThreadID: threadId,
        title: proposal.title, goal: proposal.goal, summary: `シャノンからの提案です。理由：${proposal.reason}`,
        ...(hostHint ? { hostHint } : {}), ...(proposal.projectHint ? { projectHint: proposal.projectHint } : {}),
      }, at).task;
    }
    const saved = this.store.proposals.decide(scopeKey, proposalId, decision === 'start' ? 'started' : 'declined', at, task?.id);
    if (!saved) return 'PROPOSAL_DECIDED';
    this.record(scopeKey, {
      kind: 'proposal', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id,
      summary: decision === 'start' ? `所有者が提案「${clip(proposal.title, 60)}」の開始を承認しました。` : `所有者が提案「${clip(proposal.title, 60)}」を見送りました。`,
      outcome: decision === 'start' ? 'approved' : 'declined', approval: decision === 'start' ? 'approved' : 'declined',
      ...(task ? { link: `shannon-task://${task.id}` } : {}),
    });
    return { overview: this.overview(scopeKey), ...(task ? { task } : {}) };
  }

  // MARK: Prompt

  /**
   * Bounded projection for an owner one-to-one prompt: her current pursuits and, once she has done
   * or made something, a few lines of what she is working on (among them what followed a message she started
   * on her own today: facts, never words), and her recent notes about what she saw
   * of the room in her own time. Empty when there is nothing to add. With other people present the
   * caller keeps only the last block, marked (`guardedShannonSeenPrompt`).
   */
  pursuitPrompt(scopeKey: string): string {
    try {
      const at = this.now();
      return [buildShannonPursuitsPrompt(this.store.pursuits.list(scopeKey, at)), buildShannonOwnWorkPrompt(this.study.ownWork(scopeKey, at)),
        buildShannonSeenPrompt(this.study.seen(scopeKey, at))].filter(Boolean).join('\n\n');
    } catch { return ''; }
  }

  /** The owner prompt as it is, or without 「仕組みは準備中」 while the activity loop is enabled and running. */
  identityProjection(scopeKey: string, prompt: string): string {
    // The server switch is read first: while it is off the wording cannot change and nothing else is looked up.
    if (!this.config.enabled) return prompt;
    try {
      const at = this.now();
      const budget = this.budget(scopeKey, autonomyDayKey(at, this.config));
      const state = this.loopStatus(scopeKey, at, this.store.control(scopeKey).paused, budget).state;
      return state === 'running' || state === 'budget_exhausted' ? withAutonomyRunning(prompt) : prompt;
    } catch { return prompt; }
  }

  private loopStatus(scopeKey: string, at: string, paused: boolean, budget: AutonomyBudgetStatus): AutonomyLoopStatus {
    return autonomyLoopStatus({
      enabled: this.config.enabled, paused, heartbeat: this.store.loop.heartbeat(), at,
      budgetStopped: budget.exhausted || this.store.loop.budgetBlocked(scopeKey, budget.dayKey, budget.capYen),
    });
  }

  private budget(scopeKey: string, dayKey: string): AutonomyBudgetStatus {
    return autonomyBudgetStatus(dayKey, this.store.spentYen(scopeKey, dayKey), this.store.approvedExtraYen(scopeKey, dayKey), this.config);
  }

  private record(scopeKey: string, draft: Parameters<SQLiteAutonomyStore['activity']['append']>[3]): AutonomyActivityEntry {
    const at = this.now();
    return this.store.activity.append(scopeKey, autonomyDayKey(at, this.config), at, draft);
  }
}
