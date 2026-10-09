import { SkillImporter, type SkillMemory } from '../mind/memory/memoryPorts.js';
import { skillBodyCheck } from './skillMemoryWiring.js';
import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/store/conversationStore.js';
import { SHANNON_TOOLS } from '../mind/tools/shannonTools.js';

/** Owner control only. Importing an artifact adds instructions, never tool authority or observed success. */
export function configuredSkillImporter(memory: SkillMemory | null, parts: {
  ownerScopeKey: string; state: Pick<CompanionStateStore, 'snapshot'>; conversations: Pick<ConversationStore, 'experienceCandidates'>;
}): SkillImporter | null {
  if (!memory) return null;
  const known = new Set(SHANNON_TOOLS.map(tool => tool.name));
  return new SkillImporter({ memory, ownerScopeKey: parts.ownerScopeKey,
    check: scope => scope === parts.ownerScopeKey ? skillBodyCheck(parts.state.snapshot(scope), parts.conversations, scope) : null,
    tools: (scope, declared, body, conditional = []) => {
      if (scope !== parts.ownerScopeKey) return null;
      const allowedConditional = new Set(['minecraft.observe', 'fca_wait', 'fca_complete']);
      const problems = conditional.filter(name => !allowedConditional.has(name)).map(name => `unknown_conditional_tool:${name}`);
      problems.push(...declared.filter(name => !known.has(name)).map(name => `unknown_tool:${name}`));
      for (const name of body.match(/\b(?:study|folder|aether|aetherFolder|ownerDocs|notion|voyager|schedule|places|web|task|memory|skill|minecraft)\.[a-z][a-zA-Z0-9_]*/gu) ?? []) {
        if ((!known.has(name) || !declared.includes(name)) && !conditional.includes(name)) problems.push(`undeclared_tool:${name}`);
      }
      return [...new Set(problems)];
    },
  });
}
