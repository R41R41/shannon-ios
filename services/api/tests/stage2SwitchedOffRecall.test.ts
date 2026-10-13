import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capturedRecallDigests, type CapturedRecall } from './support/stage2RecallScenarios.js';
import { configuredTreeRecall } from '../src/wiring/treeRecallWiring.js';

/**
 * Syzygy ADR-0008 stage 2, the switched-off proof for recall (`docs/skill-and-routing-contract.md`): turns that recall a long
 * knowledge note, where ca7cf519 asked luna to navigate its headings, send the same provider and Jev requests with the stage-2
 * wiring built from `SHANNON_ADR8_STAGE2=off` (or `SHANNON_TREE_RECALL=off`). The digests (`fixtures/stage2-switched-off-recall-v1.json`)
 * were recorded on ca7cf519 itself, with the scenarios of `support/stage2RecallScenarios.ts` (which use only APIs of that commit),
 * and are never regenerated for a stage-2 change: `SHANNON_WRITE_STAGE2_OFF=1` writes the file only where it does not exist.
 */
const fixture = new URL('./fixtures/stage2-switched-off-recall-v1.json', import.meta.url);

export function recordedRecall(): Record<string, CapturedRecall> {
  return JSON.parse(readFileSync(fixture, 'utf8')).scenarios as Record<string, CapturedRecall>;
}

describe('stage 2 switched off: the recall requests of ca7cf519', () => {
  it('sends the recorded provider and Jev requests in every recall scenario', async () => {
    const current = await capturedRecallDigests({ expectStatus: (status, name) => expect(status, name).toBe(200) });
    if (process.env.SHANNON_WRITE_STAGE2_OFF === '1' && !existsSync(fixture)) {
      writeFileSync(fixture, `${JSON.stringify({ about: 'Digests of the recall turns of ca7cf519 (stage2SwitchedOffRecall.test.ts). Never regenerated for a stage-2 change.', scenarios: current }, null, 1)}\n`);
    }
    const recorded = recordedRecall();
    expect(Object.keys(current)).toEqual(Object.keys(recorded));
    for (const name of Object.keys(recorded)) expect(current[name], name).toEqual(recorded[name]);
    // Not vacuous: the turns made the calls they are about (luna's navigation among them), and they differ.
    expect(recorded['text-recall-note']!.openai.length).toBeGreaterThan(1);
    expect(new Set(Object.values(recorded).flatMap(item => item.openai)).size).toBeGreaterThan(4);
  });
});

describe('stage 2 switched off with tree recall wired', () => {
  const tree = (environment: Record<string, string>, traces: unknown[]) => ({ jev }: { jev: typeof fetch }) =>
    configuredTreeRecall({ TYPESAFE_API_KEY: 'jev-test', ...environment }, { trace: (_scope, draft) => { traces.push(draft); }, jevFetch: jev, defer: task => task() });

  it('sends the requests of ca7cf519 with SHANNON_ADR8_STAGE2=off and with SHANNON_TREE_RECALL=off', async () => {
    const recorded = recordedRecall();
    for (const environment of [{ SHANNON_ADR8_STAGE2: 'off' }, { SHANNON_TREE_RECALL: 'off' }] as Array<Record<string, string>>) {
      const traces: unknown[] = [];
      const current = await capturedRecallDigests({ tree: tree(environment, traces) });
      for (const name of Object.keys(recorded)) expect(current[name], `${JSON.stringify(environment)} ${name}`).toEqual(recorded[name]);
      expect(traces).toEqual([]);
    }
    expect(configuredTreeRecall({ SHANNON_ADR8_STAGE2: 'off', TYPESAFE_API_KEY: 'jev-test' }, { trace: null })).toBeNull();
    expect(configuredTreeRecall({}, { trace: null })).toBeNull();
  });

  it('is not vacuous: with tree recall on, luna never navigates a note, Jev walks it, and each call is traced as recall_beam', async () => {
    const recorded = recordedRecall();
    const traces: Array<{ decision: string; surface: string }> = [];
    const current = await capturedRecallDigests({ tree: tree({}, traces) });
    expect(current['text-recall-note']!.openai).not.toEqual(recorded['text-recall-note']!.openai);
    // One call fewer for the note luna no longer navigates, and one for the query rewrite a text turn no longer makes (2026-10-13).
    expect(current['text-recall-note']!.openai.length).toBe(recorded['text-recall-note']!.openai.length - 2);
    expect(current['text-recall-note']!.jev.length).toBeGreaterThan(0);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every(trace => trace.decision === 'recall_beam')).toBe(true);
    // Voice walks the tree only in a skill_* turn, one level: one Jev call beside the router's.
    expect(current['voice-recall-plain']!.jev).toHaveLength(2);
    expect(traces.filter(trace => trace.surface === 'voice')).toHaveLength(2);
  });
});
