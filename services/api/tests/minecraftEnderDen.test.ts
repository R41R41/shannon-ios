import { describe, expect, it } from 'vitest';
import { actProblem, type ActInput } from '../src/contracts/minecraftActContract.js';
import { denActProblem, denProblem } from '../src/contracts/minecraftEnderDenContract.js';
import { structuredActProblem } from '../src/contracts/minecraftActHandRules.js';
import { PROBE_KINDS } from '../src/contracts/minecraftProbeContract.js';
import { prepareProbeInput } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';

/** The enderman den on the fight hand (the body's refusals said before the call), and the probe kind that names the candidates. */
const den = { entrance: { x: 10, y: 64, z: -3 }, direction: 'north' };
const hand = (extra: Record<string, unknown> = {}) => ({ do: 'fight', target: '#41', den, retreatHp: 10, seconds: 40, ...extra });

describe('denProblem', () => {
  it('takes a candidate as it is with an observed #id (a number too)', () => {
    expect(denProblem(hand())).toBeNull();
    expect(denProblem(hand({ target: 41 }))).toBeNull();
    expect(denProblem({ do: 'fight', target: 'enderman' })).toBeNull();
  });
  it('refuses a kind name, a fractional cell, a wrong direction, an extra field, flee and rel, each with the form', () => {
    expect(denProblem(hand({ target: 'enderman' }))).toContain('target:"#id"');
    expect(denProblem(hand({ den: { entrance: { x: 10.5, y: 64, z: -3 }, direction: 'north' } }))).toContain('整数の絶対マス');
    expect(denProblem(hand({ den: { entrance: den.entrance, direction: 'up' } }))).toContain('north|east|south|west');
    expect(denProblem(hand({ den: { ...den, depth: 3 } }))).toContain('north|east|south|west');
    expect(denProblem(hand({ stance: 'flee' }))).toContain('stance=fight');
    expect(denProblem(hand({ rel: true }))).toContain('rel');
  });
});

describe('a den in an act', () => {
  it('stands alone: a second hand is refused, one hand passes the act and the broad checks', () => {
    expect(denActProblem({ hands: [hand(), { do: 'wait', seconds: 2 }] })).toContain('手1（fight）');
    expect(structuredActProblem({ hands: [hand(), { do: 'wait', seconds: 2 }] })).toContain('den の手は act に 1 つだけ');
    expect(actProblem({ hands: [hand()] } as unknown as ActInput)).toBeNull();
    expect(actProblem({ hands: [{ do: 'go', to: { x: 1, y: 2, z: 3 }, den }] } as unknown as ActInput)).toContain('den は使えない');
  });
});

describe('probe kind den', () => {
  it('is a kind of the probe, takes no field and says so', () => {
    expect(PROBE_KINDS).toContain('den');
    const context = { feet: null } as never;
    expect(prepareProbeInput({ kind: 'den' }, context)).toMatchObject({ input: { kind: 'den' } });
    expect(prepareProbeInput({ kind: 'enderman_den', radius: 8 }, context)).toMatchObject({ input: { kind: 'den' } });
    expect(prepareProbeInput({ kind: 'enderman_den', radius: 8 }, context)?.fixes).toContain('den に使わない欄 radius を外した');
  });
});

describe('the stop words of a den fight', () => {
  it('says the reason of a den code as a fact on the fight line, and nothing for another code or hand', async () => {
    const { handFacts } = await import('../src/surfaces/minecraft/minecraftLlmcResultWords.js');
    const line = (extra: Record<string, unknown>) => ({ i: 1, do: 'fight', status: 'stopped', line: 'fight 止まった', goal: 'failed', end: 'finished', ...extra }) as never;
    expect(handFacts(line({ code: 'enderman_did_not_arrive' })).join('\n'))
      .toContain('穴の手が止まった理由 enderman_did_not_arrive: 敵対した相手が 15 秒近づかなかった');
    expect(handFacts(line({ code: 'enderman_not_visible' })).join('\n')).toContain('相手の目が見えない');
    expect(handFacts(line({ code: 'reflex' })).join('\n')).not.toContain('穴の手');
    expect(handFacts(line({ do: 'go', code: 'den_hurt' })).join('\n')).not.toContain('穴の手');
  });
});
