export const SELF_REWRITE_SCHEMA = 'shannon.self-rewrite.v1' as const;
export interface SelfRewriteFile { path: string; beforeHash: string | null; content: string | null; }
export interface SelfRewriteCandidate {
  schema: typeof SELF_REWRITE_SCHEMA; id: string; workId: string; scopeKey: string;
  sourceId: string; origin: 'owner_request' | 'own_time'; budgetLane: 'owner' | 'autonomy';
  baseRevision: string; diffHash: string; files: readonly SelfRewriteFile[];
}
export interface SelfRewriteAuthority {
  sourceId: string; origin: SelfRewriteCandidate['origin']; budgetLane: SelfRewriteCandidate['budgetLane'];
  permissionId: string; ownerInformed: boolean;
}
export interface SelfRewriteTargets {
  paths: readonly string[]; approvalRequired: boolean; isolated: boolean;
}
export interface SelfRewriteSnapshot { id: string; hashes: Readonly<Record<string, string | null>>; }
export interface SelfRewriteChecks {
  authority(workId: string, scopeKey: string): SelfRewriteAuthority | null;
  control(candidate: SelfRewriteCandidate): { enabled: boolean; stopped: boolean; banned: boolean; generation: number };
  budgetAndRights(candidate: SelfRewriteCandidate, authority: SelfRewriteAuthority): boolean | Promise<boolean>;
  targets(candidate: SelfRewriteCandidate): SelfRewriteTargets | null;
  currentBase(candidate: SelfRewriteCandidate): string | null;
  tests(candidate: SelfRewriteCandidate, targets: SelfRewriteTargets): Promise<boolean>;
  safetyDiff(candidate: SelfRewriteCandidate, targets: SelfRewriteTargets): Promise<boolean>;
  snapshot(candidate: SelfRewriteCandidate, phase: 'before' | 'after'): Promise<SelfRewriteSnapshot | null>;
  /** Existing bounded executor; permit must be called immediately before each real write/dispatch. */
  apply(candidate: SelfRewriteCandidate, targets: SelfRewriteTargets, permit: () => Promise<boolean>): Promise<'completed' | 'failed' | 'unknown'>;
}
export type SelfRewriteGate = 'provenance' | 'stop' | 'freeze' | 'unknown' | 'authority' | 'paths' | 'approval' | 'tests' | 'safety' | 'snapshot' | 'dispatch' | 'result';
export interface SelfRewriteResult { state: 'completed' | 'refused' | 'unknown'; gate: SelfRewriteGate; code: string; }
export interface SelfRewriteWork {
  workId: string; scopeKey: string; failures: number; frozen: boolean; generation: number;
  activeCandidate: string | null; state: 'idle' | 'validating' | 'applying' | 'unknown';
}
/** Injected into the existing tool runner. It neither claims an action nor opens a new executor. */
export interface SelfRewriteRuntimePort {
  inspect(scopeKey: string, workId: string, paths: readonly string[]): Promise<{
    authority: SelfRewriteAuthority; baseRevision: string; files: readonly SelfRewriteFile[];
  } | null>;
  execute(scopeKey: string, candidate: SelfRewriteCandidate): Promise<SelfRewriteResult>;
  propose(scopeKey: string, candidate: SelfRewriteCandidate): Promise<{ proposalId: string } | null>;
}
