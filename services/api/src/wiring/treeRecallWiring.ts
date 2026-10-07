import type { CompanionStateSnapshot } from '@shannon/cognition';
import { skillRoutingSwitches } from '@shannon/learning';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import type { AetherAccess } from '../integrations/aether/aetherAccess.js';
import type { SkillMemory } from '../mind/memory/memoryPorts.js';
import { isExperienceSourceVisible } from '../mind/recall/turnKnowledgeRecall.js';
import { TreeKnowledgeRecall } from '../mind/recall/treeRecall.js';
import { configuredJevChooser } from './skillRoutingWiring.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2, step 8 (`docs/skill-and-routing-contract.md`, 「木をたどる想起」): tree recall over her notes,
 * and with the owner alone her skills (with `SHANNON_SKILLS`) and her Aether folder and study (while Aether is configured). Null
 * with `SHANNON_TREE_RECALL=off` (or stage 2 off) or without Jev: then recall is what it was (luna's `selectSections`).
 */
export function configuredTreeRecall(
  environment: Readonly<Record<string, string | undefined>>,
  parts: {
    trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string;
    skills?: SkillMemory | null; snapshot?: (scopeKey: string) => CompanionStateSnapshot;
    aether?: { access: AetherAccess | null; covers(scopeKey: string): boolean } | null;
    defer?: (task: () => void) => void; clock?: () => number;
  },
): TreeKnowledgeRecall | null {
  const switches = skillRoutingSwitches(environment);
  if (!switches.treeRecall) return null;
  const jev = configuredJevChooser(environment, { trace: parts.trace, ...(parts.jevFetch ? { jevFetch: parts.jevFetch } : {}), ...(parts.now ? { now: parts.now } : {}) });
  if (!jev) return null;
  const skills = switches.skills ? parts.skills ?? null : null;
  const access = parts.aether?.access ?? null;
  return new TreeKnowledgeRecall({
    jev,
    skills: scopeKey => {
      if (!skills) return [];
      const state = parts.snapshot?.(scopeKey);
      return skills.usable(scopeKey, state ? id => isExperienceSourceVisible(state, id) : undefined)
        .map(skill => ({ skillId: skill.skillId, name: skill.name, description: skill.description, body: skill.body, aetherDocumentId: skill.aetherDocumentId }));
    },
    // Her folder and study as listed by Aether, for the owner's scope only (the one folder); never read inside a turn.
    ...(access ? { folder: async (scopeKey: string) => parts.aether!.covers(scopeKey)
      ? (await access.list()).map(entry => ({ documentId: entry.documentId, title: entry.title, inStudy: entry.inStudy })) : [] } : {}),
    ...(parts.defer ? { defer: parts.defer } : {}), ...(parts.clock ? { clock: parts.clock } : {}),
  });
}
