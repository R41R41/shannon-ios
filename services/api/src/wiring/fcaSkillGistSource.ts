/**
 * The read source a skill gist pins (`fcaSkillGists.ts`). It names the same skill revision as `skill.read`'s receipt, in a distinct
 * form (`/gist-revision/` or `/gist`), so that a gist shown to a body task is told apart from a skill the task opened and read in
 * full: visibility, forgetting and withdrawal treat both alike (`fcaReadSources.ts`), but sleep consolidation does not count a
 * gist pin as a private read (`privateReadIds`): the gist is code over the skill's own stored text, shown only while the owner alone
 * is present, and an outcome that followed it is still an observation of the body.
 */
export function skillGistSource(skillId: string, revisionId?: string): string {
  return `shannon-skill://${encodeURIComponent(skillId)}${revisionId ? `/gist-revision/${encodeURIComponent(revisionId)}` : '/gist'}`;
}
export function isSkillGistPin(id: string): boolean {
  return /^shannon-skill:\/\/[^/]+\/gist(?:-revision\/[^/]+)?$/u.test(id);
}
/** The read sources of an evidence record that sleep consolidation must treat as private reads: every one but a skill gist pin. */
export function privateReadIds(ids: readonly string[] | undefined): readonly string[] {
  return (ids ?? []).filter(id => !isSkillGistPin(id));
}
