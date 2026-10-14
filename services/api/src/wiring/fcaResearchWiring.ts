import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { conversationSecrets } from '../mind/inhibition/disclosurePorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import { toolSessionMemory, type ToolDocuments } from '../mind/tools/shannonToolTypes.js';
import { webReadUnknown } from '../mind/tools/shannonReadTools.js';
import { MEMORY_TOOLS } from '../mind/tools/memoryToolDefinitions.js';
import { toolFailure } from '../mind/tools/toolRegistryPorts.js';
import type { FcaExternalTools } from '../mind/action/fca/fcaPorts.js';
import type { TaskOrigin } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import { MemoryWithholding } from '../mind/memory/memoryVisibilityPorts.js';

/** Common tasks use the existing registry/executors. Only admitted owner requests inherit conversational authority. */
export function fcaResearchTools(parts: {
  tools: ShannonToolRunner; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  scopeKey: string; ownerAlone(): boolean; sourcesVisible?(): boolean;
  task?: { id: string; origin: TaskOrigin; leaseId: string };
  checkpoint?: unknown;
  placeSearch?: import('../integrations/places/placeDiscovery.js').PlaceSearchContext;
  observeMemory?(ids: readonly string[]): boolean;
  /** Pin the original executor receipt under this segment, before returning private text. */
  observeRead?(operationId: string, receipt: { name: string; documents?: ToolDocuments; ok: boolean }): boolean;
  /** A skill this task opened with `skill.read` (`fcaSkillOutcomes.ts`): noted as a use its later outcome settles. */
  skillRead?(name: string): void;
}): FcaExternalTools {
  const saved = parts.checkpoint && typeof parts.checkpoint === 'object' ? (parts.checkpoint as { fcaFolderReadDigests?: unknown }).fcaFolderReadDigests : undefined;
  if (saved !== undefined && (!Array.isArray(saved) || saved.length > 5000 || saved.some(entry => !Array.isArray(entry) || entry.length !== 2
    || entry.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))))) throw new Error('FCA_FOLDER_READS_INVALID');
  const memory = { ...toolSessionMemory(), retainedReadDigests: new Map<string, string>(saved as [string, string][] | undefined) };
  let effectUncommitted = false;
  const shared = Boolean(parts.task?.origin === 'owner_request' && parts.observeRead);
  const eligible = (tool: { name: string; domain: string }) => shared
    ? !['task_runtime', 'memory_read', 'minecraft_body', 'vm_workspace', 'owner_documents_read'].includes(tool.domain)
    : tool.name === 'web.search' || tool.name === 'web.read';
  const definitions = [...parts.tools.offered('text', 'owner_alone', parts.scopeKey).filter(eligible), ...(parts.observeMemory ? MEMORY_TOOLS : [])];
  // An own-time task (ADR-0009 stage 2, E4) reads public pages only and inherits nothing of a conversation: who is present does not hold it.
  const ownTime = parts.task?.origin === 'own_time';
  const live = () => {
    if ((!ownTime && !parts.ownerAlone()) || parts.sourcesVisible?.() === false) throw new Error('FCA_SOURCE_WITHHELD');
    if (parts.task) {
      const action = currentActionExecution();
      const authorized = parts.task.origin === 'owner_request' || ownTime;
      if (!authorized || !action || action.lease.id !== parts.task.leaseId) throw new Error('FCA_TOOL_AUTHORITY_INVALID');
      action.signal.throwIfAborted();
    }
  };
  return {
    definitions,
    checkpoint() { if (memory.retainedReadDigests.size > 5000) throw new Error('FCA_FOLDER_READS_LIMIT'); return { fcaFolderReadDigests: [...memory.retainedReadDigests] }; },
    safeToAcknowledgeStop: () => !effectUncommitted && !webReadUnknown(memory),
    skillIndex() {
      if (!definitions.some(tool => tool.name === 'skill.read')) return '';
      live();
      const text = parts.tools.skillIndex(parts.scopeKey);
      if (!text) return '';
      const ids = parts.tools.skillIndexSources(parts.scopeKey);
      // Older/custom ports without complete metadata receipts cannot safely retain an index in native history.
      if (!ids || !parts.observeRead?.('skill-index', { name: 'skill.read', ok: true, documents: { sourceIds: ids } })) return '';
      live();
      return text;
    },
    async execute(call) {
      if (!definitions.some(tool => tool.name === call.name)) throw new Error('FCA_TOOL_NOT_OFFERED');
      if (call.scopeKey !== parts.scopeKey || (parts.task && call.taskId !== parts.task.id)) throw new Error('FCA_SOURCE_WITHHELD');
      live(); call.signal.throwIfAborted();
      const secrets = conversationSecrets(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey);
      const beforeExecution = () => {
        call.signal.throwIfAborted(); live();
        if (!parts.tools.offered('text', 'owner_alone', parts.scopeKey).some(tool => tool.name === call.name)
          && !MEMORY_TOOLS.some(tool => tool.name === call.name)) throw new Error('FCA_TOOL_NOT_OFFERED');
        const currentSecrets = conversationSecrets(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey);
        const words = call.input && typeof call.input === 'object' ? Object.values(call.input).filter((value): value is string => typeof value === 'string') : [];
        if (words.some(word => currentSecrets.carries(word))) throw new Error('FCA_SOURCE_WITHHELD');
      };
      const definition = definitions.find(tool => tool.name === call.name)!;
      const priorEffect = effectUncommitted;
      let readStage = 0;
      /**
       * A read with no effect outside (`read`, cost `none`) whose result cannot be shown now is a known failure, its text withheld
       * from the model, and the task goes on (Minecraft run 11, 2026-10-15: one such hold closed the step unknown and the task was
       * retired). Anything with an effect outside still throws: its step stays unknown, as before.
       */
      const effectFree = effectFreeRead(definition);
      let readWithheld = false;
      const withheld = () => {
        if (!effectFree) throw new Error('FCA_SOURCE_WITHHELD');
        readWithheld = true;
      };
      const result = await parts.tools.call(call.name, call.input, { scopeKey: parts.scopeKey,
        surface: 'text', audience: 'owner_alone', placeSearch: parts.placeSearch, memory: Object.assign(memory, { turnKey: call.operationId }), secrets,
        beforeExecution() { beforeExecution(); if (definition.effect === 'write' || definition.cost === 'model') effectUncommitted = true; },
        observeRead(receipt) {
          call.signal.throwIfAborted(); live();
          if (receipt.ok && receipt.text && new MemoryWithholding(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey)
            .withholdsReply({ text: receipt.text, observedAt: new Date().toISOString(), recalledMemoryIds: [] })) return withheld();
          if (!parts.observeRead?.(`${call.operationId}:read:${readStage++}`, receipt)) return withheld();
          live();
        },
        afterExecution(receipt) {
          call.signal.throwIfAborted(); live();
          const tool = definitions.find(tool => tool.name === call.name)!;
          if (tool.effect === 'read' && receipt.ok && new MemoryWithholding(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey)
            .withholdsReply({ text: receipt.text, observedAt: new Date().toISOString(), recalledMemoryIds: [] })) return withheld();
          if (tool.effect === 'read' && tool.domain !== 'memory_read' && parts.observeRead && !parts.observeRead(call.operationId, receipt)) return withheld();
          live();
        },
        ...(parts.observeMemory ? { observeMemory: parts.observeMemory } : {}), timeMilliseconds: 45_000, acknowledgementOwner: 'fca' }, call.signal);
      call.signal.throwIfAborted();
      // A lost paid request holds the original segment; it is never converted to a fresh retryable result.
      if (webReadUnknown(memory) || (definition.cost === 'model' && !result.ok
        && ['failed', 'unavailable', 'timeout'].includes(result.failure ?? ''))) throw new Error('FCA_RESEARCH_RESULT_UNKNOWN');
      if (!result.ok || definition.effect !== 'write') effectUncommitted = priorEffect;
      live();
      // Nothing of a withheld read reaches the model: a fixed failure in its place.
      if (readWithheld) return WITHHELD_READ;
      if (parts.task) noteSkillRead(parts.skillRead, call, result.ok);
      return result;
    },
  };
}

/** A read with no effect outside: nothing is changed or paid for by running it again. */
function effectFreeRead(definition: { effect: string; cost: string }): boolean {
  return definition.effect === 'read' && definition.cost === 'none';
}
/** The result of a read withheld after it ran: fixed words, nothing of what it read. */
const WITHHELD_READ = toolFailure('unavailable', 'この結果は今は使えません。', { retryable: false });

/** A task's successful `skill.read`, handed to its outcome tracker (`fcaSkillOutcomes.ts`); learning never fails a read. */
function noteSkillRead(skillRead: ((name: string) => void) | undefined, call: { name: string; input: unknown }, ok: boolean): void {
  const name = call.input && typeof call.input === 'object' ? (call.input as { name?: unknown }).name : undefined;
  if (!skillRead || !ok || call.name !== 'skill.read' || typeof name !== 'string' || !name.trim()) return;
  try { skillRead(name.trim()); } catch { /* learning never fails a read */ }
}
