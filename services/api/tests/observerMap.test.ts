import { describe, expect, it } from 'vitest';
import { OBSERVER_NODES } from '../src/contracts/observerContract.js';
import {
  BLOCKS, CURRENT_LAYOUT, TARGET_BLOCKS, TARGET_LAYOUT, TARGET_LINKS, TARGET_NODES, TARGET_RUNS, VIEW_LINKS, VIEW_NODES,
  blockRoutes, dummyFields, routePath, routePoint, mergeFields, routeTable, viewHandoff, viewNodeOf, type GridLayout,
} from '../src/infra/observer/web/observerMap.js';

function noOverlap(layout: GridLayout) {
  const boxes = [...layout.boxes.values()], blocks = [...layout.blocks.values()];
  for (const list of [boxes, blocks]) for (const [index, a] of list.entries()) for (const b of list.slice(index + 1))
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  for (const box of boxes) { expect(box.x + box.w).toBeLessThanOrEqual(layout.width); expect(box.y + box.h).toBeLessThanOrEqual(layout.height); }
}

describe('current-architecture view of observed events', () => {
  it('projects every contract node somewhere, with unique view ids and links between known boxes', () => {
    const ids = VIEW_NODES.map(spec => spec[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const sources = new Set(VIEW_NODES.flatMap(spec => spec[6]));
    for (const node of OBSERVER_NODES) expect(sources.has(node), node).toBe(true);
    for (const [from, to] of [...VIEW_LINKS]) { expect(ids).toContain(from); expect(ids).toContain(to); }
    for (const spec of VIEW_NODES) expect(BLOCKS.map(block => block[0])).toContain(spec[1]);
    // The processes the owner asked to see are blocks; display-only boxes carry no contract node.
    expect(BLOCKS.map(block => block[2]).join(' ')).toMatch(/api.*worker.*autonomy worker.*world・agent-host/su);
    for (const id of ['identity', 'executive', 'sqlite']) expect(VIEW_NODES.find(spec => spec[0] === id)![6]).toEqual([]);
  });

  it('splits Jev and LLM nodes, and base from semantic recall, only from explicit payload fields', () => {
    expect(viewNodeOf('turn')).toBe('admit');
    expect(viewNodeOf('jevt', { surface: 'text', offeredTools: [], difficulty: 'normal' })).toBe('router');
    expect(viewNodeOf('jevv', {})).toBe('router');
    expect(viewNodeOf('jevt', { selector: 'fca', offeredCount: 3 })).toBe('fcaTool');
    expect(viewNodeOf('jevt', { selector: 'reflex_entry' })).toBe('reflexJev');
    expect(viewNodeOf('llm', { model: 'claude-haiku-5-5', round: 1 })).toBe('haiku');
    expect(viewNodeOf('llm', { provider: 'jev', questionCount: 2 })).toBe('jevModel');
    expect(viewNodeOf('llm', { provider: 'openai_decisions' })).toBe('jevModel');
    expect(viewNodeOf('recall', { message: 'x', threadId: 't' })).toBe('base');
    expect(viewNodeOf('recall', { message: 'x', semantic: true })).toBe('recall');
    expect(viewNodeOf('recall', { strategy: 'deterministic', surface: 'voice' })).toBe('base');
    expect(viewNodeOf('recall', { strategy: 'semantic', surface: 'voice' })).toBe('recall');
    expect(viewNodeOf('recall', { phase: 'decision_packet', maximumWaitMs: 900 })).toBe('recall');
    expect(viewNodeOf('recall', { phase: 'task_deterministic' })).toBe('base');
    expect(viewNodeOf('pcm')).toBe('pcm'); expect(viewNodeOf('unknown-node')).toBeNull();
    expect(viewHandoff({ fromNode: 'context', toNode: 'jevt', output: { phase: 'fca_selection', offeredCount: 4 } })).toEqual(['context', 'fcaTool']);
    expect(viewHandoff({ fromNode: 'jevt', toNode: 'context', output: { tools: [] } })).toEqual(['router', 'context']);
    expect(viewHandoff({ fromNode: 'native', toNode: 'llm', output: { model: 'claude-haiku-5-5', round: 1 } })).toEqual(['native', 'haiku']);
    expect(viewHandoff({ fromNode: 'native', toNode: 'llm', output: { provider: 'openai_decisions' } })).toEqual(['native', 'jevModel']);
  });

  it('lays out blocks and boxes without overlap and routes every structural link', () => {
    for (const layout of [CURRENT_LAYOUT, TARGET_LAYOUT]) noOverlap(layout);
    for (const [layout, links] of [[CURRENT_LAYOUT, VIEW_LINKS], [TARGET_LAYOUT, TARGET_LINKS]] as const) {
      const routes = routeTable(layout, links);
      expect(routes.size).toBe(links.length);
      for (const route of routes.values()) expect(routePath(route)).not.toMatch(/NaN|undefined|Infinity/);
      for (const route of blockRoutes(layout, links).values()) expect(route.from).not.toBe(route.to);
    }
    // Links between boxes that are not neighbours travel in the gutters, never through another box.
    for (const route of routeTable(CURRENT_LAYOUT, VIEW_LINKS).values()) {
      if (route.kind !== 'poly') continue;
      for (let index = 1; index < route.points.length; index += 1) {
        const [a, b] = [route.points[index - 1], route.points[index]];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
        for (const [id, box] of CURRENT_LAYOUT.boxes) {
          if (id === route.from || id === route.to) continue;
          const crosses = Math.max(a[0], b[0]) > box.x && Math.min(a[0], b[0]) < box.x + box.w && Math.max(a[1], b[1]) > box.y && Math.min(a[1], b[1]) < box.y + box.h;
          expect(crosses, `${route.from}>${route.to} crosses ${id}`).toBe(false);
        }
      }
      expect(routePoint(route, 0)).toEqual(route.points[0]); expect(routePoint(route, 1)).toEqual(route.points.at(-1));
    }
    // A return route never hides under its outbound route.
    const routes = routeTable(CURRENT_LAYOUT, VIEW_LINKS);
    expect(routes.get('haiku>gate')!.points).not.toEqual(routes.get('tools>haiku')!.points);
  });
});

describe('target architecture (ADR-0009) dummy model', () => {
  it('uses only its own boxes, closed dummy fields and overrides', () => {
    const ids = new Set(TARGET_NODES.map(spec => spec[0]));
    for (const [from, to] of TARGET_LINKS) { expect(ids.has(from)).toBe(true); expect(ids.has(to)).toBe(true); }
    for (const run of TARGET_RUNS) for (const [id] of run.spans) expect(ids.has(id), id).toBe(true);
    for (const spec of TARGET_NODES) expect(TARGET_BLOCKS.map(block => block[0])).toContain(spec[1]);
    expect(dummyFields('完了 completion=1.0; 反応 owner=0.8')).toEqual([{ gloss: '完了', key: 'completion', value: '1.0' }, { gloss: '反応', key: 'owner', value: '0.8' }]);
    expect(mergeFields(dummyFields('候補 candidates=7'), '候補 candidates=6; 理由 reason=1行').map(field => field.value)).toEqual(['6', '1行']);
    expect(TARGET_NODES.find(spec => spec[0] === 'reward')![5]).toBe('完了35・反応35・予測20・自己10');
  });
});
