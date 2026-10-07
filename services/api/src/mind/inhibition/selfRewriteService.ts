import { createHash } from 'node:crypto';
import { SELF_REWRITE_SCHEMA, type SelfRewriteCandidate, type SelfRewriteChecks, type SelfRewriteGate,
  type SelfRewriteResult, type SelfRewriteSnapshot, type SelfRewriteTargets } from './selfRewritePorts.js';
import { SelfRewriteStore } from './store/selfRewriteStore.js';

export function selfRewriteDiffHash(files: SelfRewriteCandidate['files']): string {
  return createHash('sha256').update(JSON.stringify(files.map(file => ({ path: file.path, beforeHash: file.beforeHash, content: file.content })))).digest('hex');
}
export function selfRewriteContentHash(content: string): string { return createHash('sha256').update(content).digest('hex'); }

/** One sequential gate chain. Its port carries out the existing executor, not a new runner. */
export class SelfRewriteService {
  constructor(readonly store: SelfRewriteStore, private readonly checks: SelfRewriteChecks, private readonly now: () => string) {}
  submit(candidate: SelfRewriteCandidate): void {
    if (!this.provenance(candidate)) throw new Error('REWRITE_PROVENANCE_INVALID');
    this.store.add(candidate, this.now());
  }
  async dispatch(scopeKey: string, id: string): Promise<SelfRewriteResult> {
    const candidate = this.store.candidate(scopeKey, id);
    const refused = (gate: SelfRewriteGate, code: string): SelfRewriteResult => ({ state: 'refused', gate, code });
    if (!candidate || !this.provenance(candidate)) return refused('provenance', 'candidate_invalid');
    const control = this.checks.control(candidate);
    if (!control.enabled || control.stopped || control.banned) return refused('stop', 'stopped_or_banned');
    const current = this.store.work(scopeKey, candidate.workId);
    if (current.frozen) return refused('freeze', 'five_failures');
    if (current.state === 'unknown') return { state: 'unknown', gate: 'unknown', code: 'original_result_required' };
    const work = this.store.claim(candidate, this.now());
    if (!work) return refused('dispatch', 'candidate_not_admissible');
    const fail = (gate: SelfRewriteGate, code: string, count = true): SelfRewriteResult => {
      this.store.close(candidate, count ? 'failed' : 'refused', gate, code, this.now()); return refused(gate, code);
    };
    let applying = false;
    try {
      const authority = this.checks.authority(candidate.workId, scopeKey);
      if (!authority || !await this.checks.budgetAndRights(candidate, authority)) return fail('authority', 'rights_or_budget', false);
      const targets = this.checkedTargets(candidate);
      if (!targets) return fail('paths', 'unresolved_or_outside_targets');
      if (this.checks.currentBase(candidate) !== candidate.baseRevision) return fail('approval', 'base_revision_changed', false);
      if (targets.approvalRequired && !this.store.hasGrant(candidate, work.generation)) return fail('approval', 'exact_owner_grant_required', false);
      if (!await this.checks.tests(candidate, targets)) return fail('tests', 'deterministic_checks_failed');
      if (!await this.checks.safetyDiff(candidate, targets)) return fail('safety', 'safety_not_verified');
      const before = await this.checks.snapshot(candidate, 'before');
      if (!before || !this.beforeMatches(candidate, before)) return fail('snapshot', 'base_snapshot_mismatch');
      const permit = async (): Promise<boolean> => {
        if (!this.provenance(candidate)) return false;
        const latest = this.store.work(scopeKey, candidate.workId);
        if (latest.generation !== work.generation || latest.frozen || latest.activeCandidate !== id
          || !['validating', 'applying'].includes(latest.state)) return false;
        const live = this.checks.control(candidate);
        if (!live.enabled || live.stopped || live.banned || live.generation !== control.generation
          || this.checks.currentBase(candidate) !== candidate.baseRevision) return false;
        const currentTargets = this.checkedTargets(candidate);
        if (!currentTargets || JSON.stringify(currentTargets) !== JSON.stringify(targets)) return false;
        if (targets.approvalRequired && !this.store.hasGrant(candidate, work.generation)) return false;
        const currentAuthority = this.checks.authority(candidate.workId, scopeKey);
        return !!currentAuthority && JSON.stringify(currentAuthority) === JSON.stringify(authority)
          && await this.checks.budgetAndRights(candidate, currentAuthority);
      };
      // Do not trust an earlier async check: re-read both the rights and physical preimage immediately before dispatch.
      if (!await permit()) return fail('dispatch', 'dispatch_rights_changed', false);
      const immediate = await this.checks.snapshot(candidate, 'before');
      if (!immediate || !this.beforeMatches(candidate, immediate)) return fail('dispatch', 'dispatch_snapshot_changed');
      if (!await permit() || !this.store.beginApply(candidate, work.generation, immediate, this.now())) return fail('dispatch', 'dispatch_rights_changed', false);
      applying = true;
      const result = await this.checks.apply(candidate, targets, permit);
      if (result === 'unknown') {
        this.store.close(candidate, 'unknown', 'result', 'executor_outcome_unknown', this.now());
        return { state: 'unknown', gate: 'result', code: 'executor_outcome_unknown' };
      }
      const after = await this.checks.snapshot(candidate, 'after');
      if (!after || result === 'completed' && !this.afterMatches(candidate, after)) {
        this.store.close(candidate, 'unknown', 'snapshot', 'post_snapshot_unknown', this.now());
        return { state: 'unknown', gate: 'snapshot', code: 'post_snapshot_unknown' };
      }
      this.store.close(candidate, result, 'result', result === 'completed' ? 'verified_success' : 'executor_failed', this.now(), after);
      return result === 'completed' ? { state: 'completed', gate: 'result', code: 'verified_success' } : refused('result', 'executor_failed');
    } catch {
      // A generic executor/transport failure proves neither non-delivery nor termination.
      this.store.close(candidate, applying ? 'unknown' : 'failed', applying ? 'result' : 'tests', applying ? 'executor_outcome_unknown' : 'gate_unavailable', this.now());
      return applying ? { state: 'unknown', gate: 'result', code: 'executor_outcome_unknown' } : refused('tests', 'gate_unavailable');
    }
  }
  /** Only a canonical original execution acknowledgement may call this; never an owner resume or a model assertion. */
  acknowledge(scope: string, id: string, outcome: 'completed' | 'failed', after: SelfRewriteSnapshot): boolean {
    const candidate = this.store.candidate(scope, id); if (!candidate) return false;
    const work = this.store.work(scope, candidate.workId);
    if (work.state !== 'unknown' || work.activeCandidate !== id || !after
      || outcome === 'completed' && !this.afterMatches(candidate, after)) return false;
    this.store.close(candidate, outcome, 'result', 'original_acknowledged', this.now(), after); return true;
  }
  private provenance(candidate: SelfRewriteCandidate): boolean {
    if (!candidate || candidate.schema !== SELF_REWRITE_SCHEMA || !symbol(candidate.id) || !symbol(candidate.workId)
      || Object.keys(candidate).some(key => !['schema', 'id', 'workId', 'scopeKey', 'sourceId', 'origin', 'budgetLane', 'baseRevision', 'diffHash', 'files'].includes(key))
      || !symbol(candidate.scopeKey) || !symbol(candidate.sourceId) || !symbol(candidate.baseRevision)
      || !['owner_request', 'own_time'].includes(candidate.origin) || !['owner', 'autonomy'].includes(candidate.budgetLane)
      || !Array.isArray(candidate.files) || candidate.files.length === 0 || candidate.files.length > 64
      || new Set(candidate.files.map(file => file?.path)).size !== candidate.files.length
      || candidate.files.some(file => !file || Object.keys(file).some(key => !['path', 'beforeHash', 'content'].includes(key))
        || typeof file.path !== 'string' || file.path.length > 2000 || file.path.includes('\0')
        || file.beforeHash !== null && !/^[a-f0-9]{64}$/u.test(file.beforeHash)
        || file.content !== null && (typeof file.content !== 'string' || Buffer.byteLength(file.content) > 1_000_000))
      || candidate.diffHash !== selfRewriteDiffHash(candidate.files)) return false;
    const authority = this.checks.authority(candidate.workId, candidate.scopeKey);
    return !!authority && authority.sourceId === candidate.sourceId && authority.origin === candidate.origin && authority.budgetLane === candidate.budgetLane;
  }
  private checkedTargets(candidate: SelfRewriteCandidate): SelfRewriteTargets | null {
    const targets = this.checks.targets(candidate);
    return targets && targets.paths.length === candidate.files.length && new Set(targets.paths).size === targets.paths.length
      && targets.paths.every(path => typeof path === 'string' && path.length > 0)
      && (targets.approvalRequired || targets.isolated) ? targets : null;
  }
  private beforeMatches(candidate: SelfRewriteCandidate, snapshot: SelfRewriteSnapshot): boolean {
    return candidate.files.every(file => Object.hasOwn(snapshot.hashes, file.path) && snapshot.hashes[file.path] === file.beforeHash);
  }
  private afterMatches(candidate: SelfRewriteCandidate, snapshot: SelfRewriteSnapshot): boolean {
    return candidate.files.every(file => Object.hasOwn(snapshot.hashes, file.path)
      && snapshot.hashes[file.path] === (file.content === null ? null : selfRewriteContentHash(file.content)));
  }
}
function symbol(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/u.test(value); }
