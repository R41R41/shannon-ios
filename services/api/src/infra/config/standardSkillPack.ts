import { readFileSync } from 'node:fs';
import type { SkillPack } from '../../mind/memory/memoryPorts.js';

/** App-owned, fixed artifact path. Caller strings never become filesystem paths. Loading does not import. */
export function standardSkillPack(packId: string, revision: string): SkillPack | null {
  const paths: Readonly<Record<string, string>> = {
    'standard10/draft-2': '../../../artifacts/skill-packs/standard10/draft-2/',
    'minecraft-lifecycle/draft-1': '../../../artifacts/skill-packs/minecraft-lifecycle/draft-1/',
  };
  const path = paths[`${packId}/${revision}`];
  if (!path) return null;
  const base = new URL(path, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8')) as Omit<SkillPack, 'skills'> & {
    skills: { name: string; path: string; sha256: string; tools: string[]; conditionalTools?: string[] }[];
  };
  return { ...manifest, skills: manifest.skills.map(entry => {
    if (entry.path !== `${entry.name}/SKILL.md` || !/^[a-z][a-z0-9-]{0,39}$/u.test(entry.name)) throw new Error('SKILL_PACK_ARTIFACT_PATH');
    return { name: entry.name, sha256: entry.sha256, tools: entry.tools, ...(entry.conditionalTools ? { conditionalTools: entry.conditionalTools } : {}), body: readFileSync(new URL(entry.path, base), 'utf8') };
  }) };
}
