import { describe, expect, it } from 'vitest';
import { repeatedFailures, REPEAT_LINES } from '../src/surfaces/minecraft/minecraftLlmcRepeat.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { standAfterHands } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2 `body.repeat` (ADR-0014 D7): what stopped again, from the live state alone (the body's stops with their counts, the
 * last act's stopped lines and the investigation line), in one line each, facts only; nothing for a stop that came once.
 */
const result = (...lines: string[]) => ['act 2/4 済みで止まった（failure）', ...lines, '今 (309,65,73) 体力20 満腹19'].join('\n');
const DIG_SEEN = '3 dig 止 見られる: (308,66,73)（自分から西1・上1） を開けると、今は届かない blaze（id 7、(303,67,72) 自分から西6・北1・上2、6.0m） から見える';
const ATTACK = '1 attack 止 届かない: enderman（id 113） に届かない（10.6m、5秒近づけない）。当てた 2回。そのマスは air';

describe('body.repeat: the stops that came again', () => {
  it('says nothing for a stop that happened once', () => {
    expect(repeatedFailures({ stops: ['(308,66,73) 見られる 1秒前'], lastResults: [result(DIG_SEEN)] })).toEqual([]);
    expect(repeatedFailures({})).toEqual([]);
  });
  it('joins the body\'s count of a cell to the hand of the last act: the kind of hand, the cell, the word and how many times', () => {
    const lines = repeatedFailures({ stops: ['(308,66,73) 見られる ×2 1秒前', '(300,60,73)→(299,61,73) 一歩ではない 30秒前'], lastResults: [result(DIG_SEEN)] });
    expect(lines).toEqual(['同じやり直しはしない: (308,66,73) の dig は「見られる」で 2 回止まった']);
  });
  it('says a stop of the body\'s that the last act did not repeat, with the cell and without a hand', () => {
    expect(repeatedFailures({ stops: ['(181,49,200) 掘れない ×4 3秒前'] })).toEqual(['同じやり直しはしない: (181,49,200) の手は「掘れない」で 4 回止まった']);
  });
  it('takes the count of the head\'s investigation line (「同じ止まりの 4 回目」) and names the creature the hand went for', () => {
    const lines = repeatedFailures({ stops: ['(190,63,101) 届かない 2秒前'], lastResults: [result(ATTACK)],
      investigation: ['驚き: 同じ止まりの 4 回目: attack「届かない」'] });
    expect(lines).toEqual(['同じやり直しはしない: attack（enderman #113）は「届かない」で 4 回止まった']);
  });
  it('is at most three lines, the most often first', () => {
    const stops = [2, 5, 3, 4].map((n, i) => `(${i},60,70) 掘れない ×${n} 1秒前`);
    const lines = repeatedFailures({ stops });
    expect(lines).toHaveLength(REPEAT_LINES);
    expect(lines[0]).toContain('5 回');
    expect(lines[2]).toContain('3 回');
  });
  it('comes after the stops in the rewritten live state, and only when something came again', () => {
    const body = { state: { at: '(309,65,73)' }, stops: ['(308,66,73) 見られる ×2 1秒前'], lastResults: [result(DIG_SEEN)], inventory: [] };
    const keys = Object.keys(rewriteLlmcLive({ body }).live.body as object);
    expect(keys.indexOf('repeat')).toBe(keys.indexOf('stops') + 1);
    expect(Object.keys(rewriteLlmcLive({ body: { ...body, stops: ['(308,66,73) 見られる 1秒前'] } }).live.body as object)).not.toContain('repeat');
  });
});

describe('standAfterHands: where the sent hands leave her', () => {
  // Feet (220,56,62); a corridor along +x, rock elsewhere (the guard tests' map).
  const map = (): string => {
    const lines = ['地図 v1 足=(220,56,62) x=213..227 z=55..69 方式=layers 上=北'];
    for (const dy of [1, 0, -1]) {
      lines.push(`y=${56 + dy}`);
      for (let z = 55; z <= 69; z += 1) {
        lines.push(` ${z} ${Array.from({ length: 15 }, (_, i) => {
          const x = 213 + i;
          return z === 62 && x >= 220 && x <= 223 && dy >= 0 ? (x === 220 && dy === 0 ? '@' : '.') : '#';
        }).join(' ')}`);
      }
    }
    return lines.join('\n');
  };
  const frame = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '', receivedAt: '', connected: true,
    state: { world: { position: { x: 220.5, y: 56, z: 62.5 }, localMap: map() } as never }, facts: {} } as unknown as BodyObservation;
  const walk = (x: number) => ({ do: 'walk', to: { x, y: 56, z: 62 } });
  it('the end of the last walk of the hands sent; the start when none has gone', () => {
    expect(standAfterHands({ hands: [walk(221), walk(222), walk(223)] }, frame, 't', 2)).toEqual({ at: { x: 222, y: 56, z: 62 }, via: { x: 222, y: 56, z: 62 } });
    expect(standAfterHands({ hands: [walk(221)] }, frame, 't', 0)).toEqual({ at: { x: 220, y: 56, z: 62 }, via: { x: 220, y: 56, z: 62 } });
  });
  it('not certain after a dig that goes to pick up what dropped: near the last walk, not at it', () => {
    const dug = standAfterHands({ hands: [walk(222), { do: 'dig', at: [{ x: 223, y: 56, z: 62 }] }] }, frame, 't', 2)!;
    expect(dug.at).toBeNull();
    expect(dug.via).toEqual({ x: 222, y: 56, z: 62 });
  });
  it('null when the frame or the map is missing', () => {
    expect(standAfterHands({ hands: [walk(221)] }, null, 't', 1)).toBeNull();
  });
});

describe('candidateStageState: the state text the replay puts in the history', () => {
  it('is the text the model\'s request stores for a changed stage part', async () => {
    const { candidateStageState, candidateStage } = await import('../src/surfaces/minecraft/minecraftLlmcV2.js');
    const { stateText } = await import('../src/infra/models/anthropic/anthropicFcaStoredState.js');
    const stage = candidateStage({ body: { state: { dimension: 'the_end' } } })!;
    expect(candidateStageState(stage)).toBe(stateText({ stageKnowledge: stage }, false));
    expect(candidateStageState(stage, true)).toBe(stateText({ stageKnowledge: stage }, true));
  });
});
