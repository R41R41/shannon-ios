/** The owner's primary-model preference. Auxiliary models and execution authority do not change with it. */
export type PrimaryModelMode = 'haiku' | 'sonnet';
export interface ModelModePreference { readonly mode: PrimaryModelMode; readonly revision: number }
export interface ModelModeSnapshot extends ModelModePreference {
  readonly available: { readonly haiku: boolean; readonly sonnet: boolean };
  readonly models: { readonly haiku: string; readonly sonnet: string };
  readonly appliesTo: readonly ('conversation' | 'autonomy-planning' | 'minecraft-planning')[];
}
export interface ModelModeStore {
  read(scopeKey: string): ModelModePreference;
  compareAndSet(scopeKey: string, expectedRevision: number, mode: PrimaryModelMode): ModelModePreference | null;
}
export interface ModelModePort {
  snapshot(scopeKey: string): ModelModeSnapshot;
  change(scopeKey: string, expectedRevision: number, mode: PrimaryModelMode): ModelModeSnapshot;
}
export class ModelModeError extends Error {
  constructor(readonly code: 'MODEL_MODE_CONFLICT' | 'MODEL_MODE_UNAVAILABLE') { super(code); }
}

export function modelModePort(store: ModelModeStore, capability: (scope: string, preference: ModelModePreference) => Pick<ModelModeSnapshot, 'available' | 'models' | 'appliesTo'>): ModelModePort {
  const snapshot = (scope: string): ModelModeSnapshot => {
    const preference = store.read(scope);
    return { ...preference, ...capability(scope, preference) };
  };
  return {
    snapshot,
    change(scope, revision, mode) {
      if (!capability(scope, { mode, revision }).available[mode]) throw new ModelModeError('MODEL_MODE_UNAVAILABLE');
      const saved = store.compareAndSet(scope, revision, mode);
      if (!saved) throw new ModelModeError('MODEL_MODE_CONFLICT');
      return { ...saved, ...capability(scope, saved) };
    },
  };
}
