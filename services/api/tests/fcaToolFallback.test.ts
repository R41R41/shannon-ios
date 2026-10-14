import { describe, expect, it } from 'vitest';
import { FCA_FALLBACK_DEFINITION_CHARACTERS, selectFcaTools } from '../src/mind/action/fca/fcaToolState.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { ShannonToolDefinition } from '../src/mind/tools/toolRegistryPorts.js';

/** Minecraft run 10 (2026-10-14, task 74a32315): four selections fell back to all 139 tools and passed the 100k-token price step. */
const tool = (name: string, domain: string, description = `${name} の説明`): ShannonToolDefinition => ({ name, description, domain, effect: 'read',
  cost: 'none', audiences: ['owner_alone'], surfaces: ['text'], input: { type: 'object', properties: {}, required: [], additionalProperties: false } } as unknown as ShannonToolDefinition);
const long = 'x'.repeat(600);
const catalog = [tool('task.list', 'task_runtime'), tool('task.send', 'task_runtime'), tool('skill.read', 'skills'), tool('web.search', 'web'),
  tool('minecraft.observe', 'minecraft_body'), tool('mc.move-to', 'minecraft_body'),
  ...Array.from({ length: 130 }, (_, index) => tool(index % 2 ? `mc.extra-${index}` : `other.tool-${index}`, index % 2 ? 'minecraft_body' : 'other', long))];
const input = { task: { id: 't', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: '確認' }, messages: [], tools: catalog, history: [] } as unknown as FcaModelInput;
const signal = new AbortController().signal;
const timedOut = { async select() { return { names: catalog.map(item => item.name), source: 'fallback' as const }; } };
const failing = { async select(): Promise<never> { throw new Error('JEV_TIMEOUT'); } };
const choosing = (names: string[]) => ({ async select() { return { names, source: 'jev' as const }; } });
const definitionCharacters = (names: readonly string[]) => names.reduce((sum, name) => {
  const item = catalog.find(entry => entry.name === name)!;
  return sum + JSON.stringify({ name: item.name, description: item.description, input: item.input }).length;
}, 0);

describe('a fallback tool selection is bounded (Minecraft run 10)', () => {
  it('keeps a body task to the previous selection plus its body tools, under the definition bound, and asks again next time', async () => {
    const previous = await selectFcaTools(input, catalog, undefined, choosing(['task.list', 'skill.read', 'mc.move-to']), 'owner', signal, { keepBodyTools: true });
    const fallback = await selectFcaTools({ ...input, messages: [{ id: 'm', text: 'new' }] } as unknown as FcaModelInput, catalog,
      { ...previous, refresh: true }, timedOut, 'owner', signal, { keepBodyTools: true });
    expect(fallback.names).toEqual(expect.arrayContaining(['task.list', 'task.send', 'skill.read', 'mc.move-to', 'minecraft.observe']));
    expect(fallback.names).not.toContain('web.search');
    expect(fallback.names.some(name => name.startsWith('other.'))).toBe(false);
    expect(fallback.names.length).toBeLessThan(catalog.length);
    expect(definitionCharacters(fallback.names)).toBeLessThanOrEqual(FCA_FALLBACK_DEFINITION_CHARACTERS);
    expect(fallback.refresh).toBe(true);
  });

  it('gives any other task its previous selection, or the task tools alone, when the selector throws', async () => {
    const previous = await selectFcaTools(input, catalog, undefined, choosing(['task.list', 'web.search']), 'owner', signal);
    const again = await selectFcaTools({ ...input, messages: [{ id: 'm', text: 'new' }] } as unknown as FcaModelInput, catalog,
      { ...previous, refresh: true }, failing, 'owner', signal);
    expect(again.names).toEqual(['task.list', 'task.send', 'web.search']);
    expect((await selectFcaTools(input, catalog, undefined, timedOut, 'owner', signal)).names).toEqual(['task.list', 'task.send']);
  });

  it('keeps a Jev answer as it is', async () => {
    const chosen = await selectFcaTools(input, catalog, undefined, choosing(['task.list', 'web.search']), 'owner', signal);
    expect(chosen.names).toEqual(['task.list', 'web.search']);
    expect(chosen.refresh).toBe(false);
  });

  it('keeps the whole catalog when no selector is configured (a deliberate catalog, not a failure)', async () => {
    const whole = { async select() { return { names: catalog.map(item => item.name), source: 'catalog' as const }; } };
    expect((await selectFcaTools(input, catalog, undefined, whole, 'owner', signal)).names).toHaveLength(catalog.length);
  });
});
