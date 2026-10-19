import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { SKILL_GIST, SKILL_INDEX_WIDTH, skillGist, skillLint } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { gistToolNames, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { minecraftStage } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { NIGHT_GATE_FAILURE, minecraftRetryHint, minecraftSkillResult, nightGateNeeds } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { createMinecraftTaskMetrics } from '../src/surfaces/minecraft/minecraftTaskMetrics.js';

/**
 * Minecraft run 16 (2026-10-19, task 20467761, Sonnet, 20 minutes): she reached diamonds with no armour, no cooked food and no bed,
 * went down at night and died to a zombie at y=-7. The head's side of the fixes: the chestplate before diamonds, the body's night
 * gate as the model reads it, legacy-minecraft draft-8 (six revisions), the gist follow measure and the death count.
 */
const at = '2026-10-19T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };
const REVISED = ['mc-first-day', 'mc-food-and-bed', 'mc-iron-and-bucket', 'mc-diamond-obsidian', 'mc-night-retreat', 'mc-food-and-pace'];
/** Where each revision's base is: the body production holds now (sha256 checked against the production DB on 2026-10-19). */
const BASE: Record<string, string> = { 'mc-first-day': 'draft-6', 'mc-food-and-bed': 'draft-6', 'mc-diamond-obsidian': 'draft-6',
  'mc-iron-and-bucket': 'draft-4', 'mc-night-retreat': 'draft-7', 'mc-food-and-pace': 'draft-2' };
const pack8 = () => standardSkillPack('legacy-minecraft', 'draft-8')!;
const body = (name: string) => pack8().skills.find(entry => entry.name === name)!.body;
const gistOf = (name: string) => skillGist(body(name), observeOnlyStep);
/** The body catalog's tool names these skills may name (Minebot instantSkills, as of body c05464e). */
const REAL_TOOLS = new Set(['mc.mine-block', 'mc.craft-one', 'mc.find-nearest-entity', 'mc.attack-continuously', 'mc.start-smelting', 'mc.sleep-in-bed',
  'mc.find-structure', 'mc.find-blocks', 'mc.check-container', 'mc.withdraw-from-container', 'mc.harvest-crop', 'mc.stair-mine', 'mc.use-item-on-block',
  'mc.build-structure', 'mc.enter-portal', 'mc.recall-places', 'mc.place-block-at', 'mc.equip-item', 'mc.use-item', 'mc.withdraw-from-furnace',
  'mc.list-nearby-entities', 'mc.dig-shelter', 'mc.leave-water', 'mc.build-around-self']);

describe('the chestplate before diamonds, counted when worn', () => {
  const counts = (inventory: string[], worn?: string) => carriedItemCounts({ inventory: inventory.map(item => {
    const [name, count] = item.split('×'); return { name: name!, count: Number(count ?? 1) };
  }), ...(worn ? { worn } : {}) }, {});
  it('reads what she wears from the body\'s one line (the pack lists no armour slot)', () => {
    const worn = '頭: iron_helmet(残り165/165)、胴: iron_chestplate(残り240/240)、脚: なし、足: なし、左手: shield(残り336/336)';
    expect([...counts([], worn)]).toEqual([['iron_helmet', 1], ['iron_chestplate', 1], ['shield', 1]]);
    expect([...counts([], '頭: なし、胴: なし')]).toEqual([]);
    // Run 16's eleven iron made the pickaxe and the bucket: stage 4 (iron), not diamonds.
    expect(minecraftStage(counts(['iron_pickaxe', 'bucket']))).toBe(4);
    expect(minecraftStage(counts(['iron_pickaxe', 'bucket'], '胴: iron_chestplate(残り240/240)'))).toBe(5);
  });
});

describe('the body\'s night gate, as the model reads its refusal', () => {
  const refused = (result: string) => minecraftSkillResult({ id: 'op', outcome: 'failed', failureType: NIGHT_GATE_FAILURE, result, inputsReleased: true } as never);
  it('names the next moves for what is missing, and is not retryable', () => {
    const text = '夜の深い所は備えがそろうまで断る。足りない: armor, cooked_food';
    expect(minecraftRetryHint(NIGHT_GATE_FAILURE)).toBe('prepare_first');
    expect(nightGateNeeds(text)).toEqual(['armor', 'cooked_food']);
    const result = refused(text);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ retryable: false });
    const said = (result as { text?: string; message?: string }).text ?? JSON.stringify(result);
    expect(said).toContain('［再試行の目安: prepare_first｜夜に深い所へは備えがそろうまで行けない。次の手: 胸当て（鉄8）を作って着る／かまどで肉を焼く。');
    expect(said).not.toContain('羊毛');
    // The body's own wording (Shannon `utils/nightGate.ts`, mb-body 2026-10-19), its next moves in the text before the list.
    const bodyText = '夜の深い所は備えがそろうまで断る（夜の門）。夜（明けるまで約300秒）で、y16より下（地下深く）へ降りるstair-mine（目標 y-54）を断りました。'
      + '備え: ベッドが無い。次の手: 地上（y16以上）でできることを進めるか、dig-shelter で夜を越す。用意: 同じ色の羊毛3個と板材3個で bed。'
      + '敵が近い時は build-around-self か dig-shelter（この断りは備えがそろうまで続く）。足りない: bed';
    expect(nightGateNeeds(bodyText)).toEqual(['bed']);
    expect(refused(bodyText).text).toMatch(/次の手: 同じ色の羊毛3個でベッド。拠点か浅い穴で精錬と料理を進める］$/u);
    // Without the list (another wording), all three; the hint keeps within what the stored result keeps (120 characters).
    expect(nightGateNeeds('断った')).toEqual(['armor', 'cooked_food', 'bed']);
    const all = JSON.stringify(refused('断った'));
    expect(all).toContain('同じ色の羊毛3個でベッド');
    const tail = /［再試行の目安: prepare_first｜([^］]*)］/u.exec(all)![1]!;
    expect([...tail].length).toBeLessThanOrEqual(120);
    expect(storedBodyResult('mc.stair-mine', `${'断った'}\n［再試行の目安: prepare_first｜${tail}］`)).toContain('prepare_first');
  });
});

describe('legacy-minecraft draft-8: six revisions, no new skill', () => {
  it('revises exactly the bodies production holds, with exact hashes', () => {
    expect(pack8().skills.map(entry => entry.name)).toEqual(REVISED);
    for (const entry of pack8().skills) {
      const base = standardSkillPack('legacy-minecraft', BASE[entry.name]!)!.skills.find(skill => skill.name === entry.name)!;
      expect(entry.revises).toEqual({ bodySha256: base.sha256 });
      expect(skillArtifactSha256(entry.body)).toBe(entry.sha256);
      expect(entry.milestone).toBeUndefined();
    }
  });

  it.each(REVISED)('%s: the gist is how to go on (no tool), its first move concrete; the tools apart below', name => {
    const gist = gistOf(name), text = body(name);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length >= 40 && [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
    expect(gistToolNames(gist).size).toBe(0);
    const steps = text.split('## 手順')[1]!.split('## 補助')[0]!;
    expect(steps.split('\n').filter(line => /^\d+\./u.test(line) && !line.includes('minecraft.observe')).filter(line => /mc\.[a-z]/u.test(line))).toEqual([]);
    expect(steps.indexOf('\n使う道具')).toBeGreaterThan(0);
    expect([...text.matchAll(/mc\.[a-z][a-z-]*/gu)].map(match => match[0]).filter(tool => !REAL_TOOLS.has(tool))).toEqual([]);
    expect(text).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
    expect(text).toContain('旧Minebot実験');
    expect(text).toContain('実走16');
    expect(text).not.toMatch(/朝まで待つ|回復を待つ/u);
    expect(skillLint(text)).toEqual([]);
    expect(`- ${name}（試し）（運用作成）: ${/description: (.*)/u.exec(text)![1]}`.length).toBeLessThanOrEqual(SKILL_INDEX_WIDTH);
  });

  it('says what run 16 got wrong, first', () => {
    expect(gistOf('mc-first-day')[0]).toMatch(/原木を12〜16本/u);
    expect(body('mc-first-day')).toMatch(/「,」で並べない/u);
    expect(gistOf('mc-food-and-bed').join('')).toMatch(/同じ色の羊を3頭.*色違いではベッドにならない.*生肉は食べる前にかまどで焼く.*待たず/u);
    expect(gistOf('mc-iron-and-bucket').join('')).toMatch(/14個.*ツルハシ3・バケツ3・胸当て8.*炉の前で待たない.*胸当てを着てから深い層やダイヤへ/u);
    expect(gistOf('mc-diamond-obsidian')[0]).toMatch(/^2\. 胸当てを着て、焼いた食料とベッドを持ってから、昼のうちに/u);
    // The old night retreat sent her down to mine at night ("余裕があれば地下へ下り"): no more.
    expect(gistOf('mc-night-retreat').join('')).toMatch(/夜は高さ16より下へ降りない.*防具・焼いた食料・ベッド/u);
    expect(body('mc-night-retreat')).not.toMatch(/余裕があれば、穴から階段を掘って地下へ下り/u);
    expect(body('mc-night-retreat')).toMatch(/mc\.build-around-self（structureName=slit_shelter）.*cobblestone_slab/su);
    expect(gistOf('mc-food-and-pace')[0]).toMatch(/^2\. 生肉はかまどで焼いてから食べる/u);
  });

  it('applies as six revisions on top of production (capacity unchanged), only while each is unused', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (pack: SkillPack, when: string) => importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'owner-20261019' }, when);
    (['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-6', 'draft-7'] as const).forEach((revision, index) =>
      expect(apply(standardSkillPack('legacy-minecraft', revision)!, later(index))).toHaveProperty('receipt'));
    const used = memory.store.all('owner').length;
    const before = Object.fromEntries(REVISED.map(name => [name, memory.store.byName('owner', name)!.version]));
    const plan = importer.dryRun('owner', pack8());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toMatchObject({ used, added: 0 });
    expect(apply(pack8(), later(9))).toHaveProperty('receipt');
    for (const name of REVISED) expect(memory.store.byName('owner', name)).toMatchObject({ version: before[name]! + 1, status: 'trial' });
    expect(memory.store.all('owner')).toHaveLength(used);
    // A skill used at its version stops alone (`on_trial`); production had no use of any of the six on 2026-10-19.
    const again = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer2 = new SkillImporter({ memory: again, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    (['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-6', 'draft-7'] as const).forEach((revision, index) =>
      importer2.apply('owner', standardSkillPack('legacy-minecraft', revision)!, { planHash: importer2.dryRun('owner', standardSkillPack('legacy-minecraft', revision)!).planHash, approvalReference: 'x' }, later(index)));
    again.usedInTask('owner', fcaSkillTaskKey('run-17'), 'mc-first-day', later(8), 'gist');
    expect(importer2.dryRun('owner', pack8()).problems).toEqual([{ name: 'mc-first-day', code: 'on_trial' }]);
  });
});

const frame = (world: Record<string, unknown>, facts: Record<string, unknown> = { alive: true }) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 'x', receivedAt: 'x', connected: true, state: { world }, facts }) as unknown as BodyObservation;

describe('the death count of the measurement', () => {
  const metricsAt = (clock: { now: number }, kept?: unknown) => {
    const lines: string[] = [];
    const metrics = createMinecraftTaskMetrics({ taskId: 't16', createdAt: '2026-10-19T13:42:18.000Z', kept, now: () => clock.now, log: line => lines.push(line) });
    return { metrics, lines, deaths: () => (metrics.checkpoint() as { minecraftMetrics?: { deaths: number } }).minecraftMetrics?.deaths };
  };
  const dead = (iso: string) => ({ at: iso, position: { x: 7, y: -7, z: -42 }, dimension: 'overworld', cause: 'zombie', lostItems: [] });
  it('counts a death the frames never showed, from the body\'s own list (run 16: the count stayed 0)', () => {
    const clock = { now: Date.parse('2026-10-19T14:01:06.000Z') };
    const { metrics, deaths } = metricsAt(clock);
    metrics.context(frame({ inventory: [] }), null, {});
    // Before the task: none. Run 16's death at 14:00:59Z: one, however many frames repeat it.
    metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T12:00:00.000Z')] }));
    expect(deaths()).toBe(0);
    for (let i = 0; i < 3; i++) metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T12:00:00.000Z'), dead('2026-10-19T14:00:59.000Z')] }));
    expect(deaths()).toBe(1);
    // A second death later: two.
    metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T14:00:59.000Z'), dead('2026-10-19T14:05:00.000Z')] }));
    expect(deaths()).toBe(2);
  });
  it('counts once a frame that shows her dead with the list\'s entry already in it, in either order', () => {
    const clock = { now: Date.parse('2026-10-19T14:01:00.000Z') };
    const same = metricsAt(clock);
    same.metrics.context(frame({ inventory: [] }), null, {});
    same.metrics.sample(frame({ health: 0, deaths: [dead('2026-10-19T14:00:59.000Z')] }, { alive: false }));
    same.metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T14:00:59.000Z')] }));
    expect(same.deaths()).toBe(1);
    const listFirst = metricsAt(clock);
    listFirst.metrics.context(frame({ inventory: [] }), null, {});
    listFirst.metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T14:00:59.000Z')] }));
    listFirst.metrics.sample(frame({ health: 0 }, { alive: false }));
    expect(listFirst.deaths()).toBe(1);
  });
  it('counts a frame\'s death and the list\'s entry for it once, even across steps and clocks 20 s apart', () => {
    const clock = { now: Date.parse('2026-10-19T14:01:00.000Z') };
    const first = metricsAt(clock);
    first.metrics.context(frame({ inventory: [] }), null, {});
    first.metrics.sample(frame({ health: 0 }, { alive: false }));
    expect(first.deaths()).toBe(1);
    first.metrics.flush();
    const kept = (first.metrics.checkpoint() as { minecraftMetrics: unknown }).minecraftMetrics;
    clock.now += 5_000;
    const second = metricsAt(clock, kept);
    second.metrics.context(frame({ inventory: [] }), null, {});
    // The body's clock runs 20 s ahead of the API's.
    second.metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T14:01:20.000Z')] }));
    expect(second.deaths()).toBe(1);
    second.metrics.sample(frame({ health: 20, deaths: [dead('2026-10-19T14:01:20.000Z'), dead('2026-10-19T14:03:00.000Z')] }));
    expect(second.deaths()).toBe(2);
  });
});

describe('the gist follow measure counts what a shown skill is about (tool and argument)', () => {
  it('counts mine-block diamond_ore as following the diamond gist (run 16: counted no, 6 times)', () => {
    const lines: string[] = [];
    const metrics = createMinecraftTaskMetrics({ taskId: 't16', createdAt: at, kept: undefined, now: () => Date.parse(at), log: line => lines.push(line) });
    metrics.context(frame({ inventory: [] }), null, { skillPointers: ['mc-diamond-obsidian（…）'], skillGists: [{ skill: 'mc-diamond-obsidian' }] });
    metrics.noteCall('mc.mine-block', { blockName: 'deepslate_diamond_ore', count: 3 }, new Map([['mc-diamond-obsidian', new Set(['mc.stair-mine'])]]));
    metrics.flush();
    expect(lines).toContain('Shannon Minecraft gist adoption task=t16 d=1 skill=mc-diamond-obsidian shownAt=1 followedWithinN=yes outcome=- ignoredStreak=0');
    // A call that is not what the skill is about still counts for nothing.
    const other: string[] = [];
    const quiet = createMinecraftTaskMetrics({ taskId: 't16', createdAt: at, kept: undefined, now: () => Date.parse(at), log: line => other.push(line) });
    quiet.context(frame({ inventory: [] }), null, { skillPointers: ['mc-diamond-obsidian（…）'], skillGists: [{ skill: 'mc-diamond-obsidian' }] });
    quiet.noteCall('mc.mine-block', { blockName: 'stone', count: 3 }, new Map([['mc-diamond-obsidian', new Set(['mc.stair-mine'])]]));
    quiet.flush();
    expect(other.some(line => line.includes('followedWithinN=yes'))).toBe(false);
  });
});
