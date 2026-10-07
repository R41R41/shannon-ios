/** Canonical owner scope configuration, independent of any operator/read surface. */
export function configuredOwnerScope(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner';
}
