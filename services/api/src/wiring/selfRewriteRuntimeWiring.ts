import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { ServerEnvironment } from '../infra/config/serverEnvironment.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import { actionResource, type ActionThreads } from '../contracts/actionThreadContract.js';
import { taskTreeAuthority } from '@shannon/mind';
import type { AgentTaskStore } from '../mind/action/agentTasks/agentTasksPorts.js';
import type { ShannonAutonomyService, SQLiteAutonomyStore } from '../mind/action/ownTime/ownTimePorts.js';
import { autonomyBudgetStatus, autonomyDayKey, type AutonomyConfig } from '../mind/inhibition/inhibitionPorts.js';
import { resolvePhysicalPath } from '../mind/inhibition/autonomyReadPorts.js';
import { checkRewriteData, safeRewriteData } from '../mind/inhibition/selfRewriteDataChecks.js';
import { SELF_REWRITE_SCHEMA, type SelfRewriteAuthority, type SelfRewriteCandidate, type SelfRewriteFile, type SelfRewriteRuntimePort } from '../mind/inhibition/selfRewritePorts.js';
import { selfRewriteContentHash } from '../mind/inhibition/selfRewriteService.js';
import { selfRewriteTargets, selfRewriteWiring } from './selfRewriteWiring.js';

export interface SelfRewriteRuntimeOptions {
  environment: ServerEnvironment; path: string; ownerScope: string; now: () => string;
  config: AutonomyConfig; autonomy: ShannonAutonomyService; autonomyStore: SQLiteAutonomyStore;
  tasks: AgentTaskStore | null; actions: ActionThreads | null;
  /** True only in the own-time executor lifecycle. API readers must leave it false. */
  recoverInterrupted?: boolean;
}
/** Real stop/authority/action ports and actual isolated data/numeric-code checks. Never a second execution engine. */
export function selfRewriteRuntimeWiring(options: SelfRewriteRuntimeOptions) {
  const enabled = stage5Enabled(options.environment);
  const places = { isolatedRoot: options.config.places.workspaceRoot, ...options.config.places };
  const authority = (workId: string, scope: string): SelfRewriteAuthority | null => {
    if (!enabled || scope !== options.ownerScope) return null;
    if (workId.startsWith('task:')) {
      const task = options.tasks?.get(scope, workId.slice(5)), tree = task?.taskTree;
      if (!task || !tree || ['completed', 'failed', 'cancelled'].includes(task.status)) return null;
      const original = taskTreeAuthority({ origin: tree.origin, budgetLane: tree.budgetLane, ownerInformed: tree.ownerInformed, permissionId: tree.permissionId });
      return original ? { ...original, sourceId: task.id } : null;
    }
    if (!workId.startsWith('pursuit:')) return null;
    const pursuit = options.autonomyStore.pursuits.get(scope, workId.slice(8));
    return pursuit?.status === 'active' && pursuit.origin !== 'seed' ? { sourceId: pursuit.id, origin: 'own_time', budgetLane: 'autonomy',
      ownerInformed: pursuit.origin === 'conversation', permissionId: workId } : null;
  };
  const executionRights = async (candidate: SelfRewriteCandidate, original: SelfRewriteAuthority): Promise<boolean> => {
    const execution = currentActionExecution();
    if (!execution || !options.actions || execution.signal.aborted) return false;
    const view = (await options.actions.list(candidate.scopeKey)).find(item => item.id === execution.lease.id);
    if (!view || !['running', 'waiting'].includes(view.state) || view.origin !== original.origin
      || view.generation !== execution.lease.generation || view.holder !== execution.lease.holder) return false;
    if (candidate.workId.startsWith('task:')) {
      if (view.kind !== 'agentTask' || view.sourceId !== original.sourceId) return false;
    } else if (view.kind !== 'ownTime' || options.autonomyStore.loop.openCycle(candidate.scopeKey)?.id !== view.sourceId) return false;
    return !execution.signal.aborted && await execution.permit();
  };
  const provenanceSession = async (candidate: SelfRewriteCandidate): Promise<{ id: string; informed: boolean; cycle: boolean } | null> => {
    const original = authority(candidate.workId, candidate.scopeKey), execution = currentActionExecution();
    if (!original || !execution || !options.actions || !await executionRights(candidate, original)) return null;
    const view = (await options.actions.list(candidate.scopeKey)).find(item => item.id === execution.lease.id);
    if (!view || !['running', 'waiting'].includes(view.state) || view.generation !== execution.lease.generation
      || view.holder !== execution.lease.holder || execution.signal.aborted) return null;
    if (view.kind === 'ownTime' && view.sourceId === options.autonomyStore.loop.openCycle(candidate.scopeKey)?.id) {
      return { id: view.sourceId, informed: options.autonomyStore.informed.sessionInformedAt(view.sourceId) !== null, cycle: true };
    }
    return view.kind === 'agentTask' && view.sourceId === original.sourceId
      ? { id: view.sourceId, informed: original.ownerInformed, cycle: false } : null;
  };
  const rights = async (candidate: SelfRewriteCandidate, original: SelfRewriteAuthority): Promise<boolean> => {
    if (!await executionRights(candidate, original)) return false;
    if (original.budgetLane === 'autonomy') {
      const day = autonomyDayKey(options.now(), options.config);
      if (autonomyBudgetStatus(day, options.autonomyStore.spentYen(candidate.scopeKey, day),
        options.autonomyStore.approvedExtraYen(candidate.scopeKey, day), options.config).exhausted) return false;
    }
    if (original.budgetLane === 'autonomy' && options.autonomy.authorize(candidate.scopeKey, {
      domain: 'vm_workspace', paths: candidate.files.map(file => file.path), summary: '元の自分の作業の権限で候補を検査する。', tool: 'workspace.rewrite',
    }).decision !== 'allow') return false;
    return await currentActionExecution()!.permit([actionResource(candidate.scopeKey, 'folder:vm')]);
  };
  let runtime: ReturnType<typeof selfRewriteWiring>;
  const currentBase = (candidate: SelfRewriteCandidate): string | null => {
    const files = readFiles(candidate.files.map(file => file.path)); if (!files) return null;
    const work = runtime?.service?.store.work(candidate.scopeKey, candidate.workId);
    if (work?.state === 'applying' && work.activeCandidate === candidate.id
      && files.every((file, index) => file.beforeHash === candidate.files[index]!.beforeHash
        || file.beforeHash === (candidate.files[index]!.content === null ? null : selfRewriteContentHash(candidate.files[index]!.content!)))) {
      // Earlier writes of this exact, still-owned candidate may already be visible. Other changes still fail the live gate.
      return rewriteBaseRevision(candidate.files);
    }
    return rewriteBaseRevision(files);
  };
  runtime = selfRewriteWiring({ enabled, path: options.path, ownerScope: options.ownerScope, now: options.now, places,
    recoverInterrupted: options.recoverInterrupted === true,
    beforeIsolatedWrite: async (candidate, targets) => {
      try {
        const session = await provenanceSession(candidate); if (!session) return false;
        if (session.informed) options.autonomyStore.informed.markDocuments(candidate.scopeKey,
          targets.paths.map(rewriteDocumentKey), session.id, options.now());
        return true;
      } catch { return false; }
    }, checks: { authority, currentBase,
      control: candidate => {
        const original = authority(candidate.workId, candidate.scopeKey);
        const control = original?.budgetLane === 'autonomy' ? options.autonomyStore.control(candidate.scopeKey) : null;
        return { enabled, stopped: !original || control?.paused === true || currentActionExecution()?.signal.aborted === true,
          banned: !original, generation: control?.changedAt ? Date.parse(control.changedAt) : 0 };
      }, budgetAndRights: rights,
      tests: async candidate => checkRewriteData(candidate), safetyDiff: async candidate => safeRewriteData(candidate),
    } });
  const port: SelfRewriteRuntimePort | null = !runtime.service ? null : {
    inspect: async (scope, workId, paths) => {
      const original = authority(workId, scope); if (!original || !Array.isArray(paths) || !paths.length || paths.length > 64) return null;
      const candidate: SelfRewriteCandidate = { schema: SELF_REWRITE_SCHEMA, id: randomUUID(), scopeKey: scope, workId,
        sourceId: original.sourceId, origin: original.origin, budgetLane: original.budgetLane,
        baseRevision: 'unread', diffHash: '', files: paths.map(path => ({ path, beforeHash: null, content: null })) };
      const targets = selfRewriteTargets(candidate, places);
      if (!targets?.isolated || targets.approvalRequired || !await rights(candidate, original)) return null;
      try {
        const session = await provenanceSession(candidate); if (!session) return null;
        if (targets.paths.some(path => options.autonomyStore.informed.marked(scope, rewriteDocumentKey(path))) && !session.informed) {
          // Like an explicit study.read, this deliberate read marks its original session before any contents are read.
          if (!session.cycle) return null;
          options.autonomyStore.informed.markSession(session.id, options.now());
          if (!options.autonomyStore.informed.sessionInformedAt(session.id)) return null;
        }
        const immediate = selfRewriteTargets(candidate, places);
        if (!immediate || JSON.stringify(immediate) !== JSON.stringify(targets)) return null;
      } catch { return null; }
      const files = readFiles(paths); if (!files) return null;
      return { authority: original, baseRevision: rewriteBaseRevision(files), files };
    },
    execute: async (scope, candidate) => {
      if (scope !== options.ownerScope || candidate?.scopeKey !== scope) return { state: 'refused', gate: 'provenance', code: 'scope_invalid' };
      try { runtime.service!.submit(candidate); } catch { return { state: 'refused', gate: 'provenance', code: 'candidate_invalid' }; }
      return runtime.service!.dispatch(scope, candidate.id);
    },
    propose: async (scope, candidate) => {
      if (scope !== options.ownerScope || candidate?.scopeKey !== scope || !currentActionExecution() || currentActionExecution()!.signal.aborted) return null;
      try { runtime.service!.submit(candidate); } catch { return null; }
      const original = authority(candidate.workId, scope);
      if (!original || !await executionRights(candidate, original)) return null;
      const old = runtime.service!.store.proposalFor(scope, candidate.id);
      if (old) return { proposalId: old };
      // No unbounded writer is handed an owner approval. The existing task proposal keeps the exact candidate for review.
      const proposed = options.autonomy.proposeAgentTask(scope, { title: '自己改修の候補', domain: 'core', paths: candidate.files.map(file => file.path),
        goal: `正確な候補 shannon-rewrite://${candidate.id} を確認する。workId=${candidate.workId}; diffHash=${candidate.diffHash}; baseRevision=${candidate.baseRevision}。適用前に元権限と実検査を照合する。`,
        reason: '基幹・本番または実行コードの変更は、この候補に一致する所有者の承認と実検査を経て進めます。' });
      if (!proposed.proposal) return null;
      runtime.service!.store.attachProposal(scope, candidate.id, proposed.proposal.id);
      return { proposalId: proposed.proposal.id };
    },
  };
  if (port) options.autonomy.tools.useSelfRewrite(port);
  return { ...runtime, port };
}
export function rewriteBaseRevision(files: readonly SelfRewriteFile[]): string {
  return createHash('sha256').update(JSON.stringify(files.map(file => ({ path: resolvePhysicalPath(file.path), hash: file.beforeHash })))).digest('hex');
}
/** Canonical physical path only, hashed before entering the existing sticky mark table. No path or contents are stored there. */
export function rewriteDocumentKey(physicalPath: string): string {
  return `shannon-workspace://${createHash('sha256').update(physicalPath).digest('hex')}`;
}
function readFiles(paths: readonly string[]): SelfRewriteFile[] | null {
  try {
    if (new Set(paths).size !== paths.length) return null;
    return paths.map(path => {
      const physical = resolvePhysicalPath(path); if (!physical) throw new Error('REWRITE_PATH');
      if (!existsSync(physical)) return { path, beforeHash: null, content: null };
      const stat = lstatSync(physical); if (!stat.isFile() || stat.size > 64_000) throw new Error('REWRITE_LIMIT');
      const content = readFileSync(physical, 'utf8'); return { path, beforeHash: selfRewriteContentHash(content), content };
    });
  } catch { return null; }
}
