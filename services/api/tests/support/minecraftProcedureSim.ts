import { withMinecraftAgenda } from '../../src/surfaces/minecraft/minecraftAgenda.js';
import type { FcaExternalTools } from '../../src/mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../src/mind/tools/shannonTools.js';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';

/**
 * mb-arch: the executor's procedures run on a simulated body from nothing to the Nether. Each body tool changes the simulated world as
 * Minebot's does (by its catalog: `craft-one` sets its table down and picks it up, `mine-block` picks the drops up, `start-smelting`
 * fills the furnace named, `use-item-on-block water_bucket` on lava casts obsidian and takes the water back, `build-structure` lights
 * the frame when the flint and steel is carried) and costs about the time run 19 measured for it.
 */
export const AT = Date.parse('2026-10-20T10:00:00.000Z');
const RECIPES: Readonly<Record<string, { needs: Record<string, number>; makes: number; table?: boolean }>> = {
  oak_planks: { needs: { oak_log: 1 }, makes: 4 }, stick: { needs: { oak_planks: 2 }, makes: 4 },
  crafting_table: { needs: { oak_planks: 4 }, makes: 1 },
  wooden_pickaxe: { needs: { oak_planks: 3, stick: 2 }, makes: 1, table: true },
  stone_pickaxe: { needs: { cobblestone: 3, stick: 2 }, makes: 1, table: true }, stone_axe: { needs: { cobblestone: 3, stick: 2 }, makes: 1, table: true },
  furnace: { needs: { cobblestone: 8 }, makes: 1, table: true }, iron_pickaxe: { needs: { iron_ingot: 3, stick: 2 }, makes: 1, table: true },
  iron_sword: { needs: { iron_ingot: 2, stick: 1 }, makes: 1, table: true },
  bucket: { needs: { iron_ingot: 3 }, makes: 1, table: true }, iron_chestplate: { needs: { iron_ingot: 8 }, makes: 1, table: true },
  iron_leggings: { needs: { iron_ingot: 7 }, makes: 1, table: true }, iron_helmet: { needs: { iron_ingot: 5 }, makes: 1, table: true },
  iron_boots: { needs: { iron_ingot: 4 }, makes: 1, table: true }, diamond_pickaxe: { needs: { diamond: 3, stick: 2 }, makes: 1, table: true },
  flint_and_steel: { needs: { iron_ingot: 1, flint: 1 }, makes: 1 }, white_bed: { needs: { white_wool: 3, oak_planks: 3 }, makes: 1, table: true },
};
/** Seconds a call takes, about what run 19 measured (per block or per kill where it scales). */
const SECONDS = { log: 4, stone: 1.2, iron: 7, coal: 5, diamond: 20, gravel: 2, craft: 2, place: 1.5, smeltStart: 3, kill: 9, find: 0.5, walk: 15,
  stairStep: 2.6, pour: 3, obsidianDig: 9.4, build: 30, enter: 8, equip: 1, eat: 2, withdraw: 3 };

export type Input = Record<string, unknown>;
export class SimBody {
  clock = AT;
  pack = new Map<string, number>();
  worn: string[] = [];
  y = 64;
  dimension = 'overworld';
  food = 20;
  health = 20;
  /** Night (the margin says how long until light). */
  night = false;
  /** Hostiles near (`nearbyThreats`) and the uses left of tools that report their wear (`inventory[].durability`). */
  threats: Array<{ name: string; distance: number; canReachMe: boolean }> = [];
  durability = new Map<string, number>();
  furnaces = new Map<string, { input: string; count: number; doneAt: number; out: number }>();
  calls: string[] = [];
  private placed = 0;
  private gravelDigs = 0;
  portal: string | null = null;
  /** The body's map of the world (`mapSummary`). */
  map = '';
  /** Each look is a new frame (the body's 200 ms beat). */
  private frames = 0;

  add(name: string, count: number) { this.pack.set(name, (this.pack.get(name) ?? 0) + count); }
  take(name: string, count: number): boolean {
    if ((this.pack.get(name) ?? 0) < count) return false;
    this.pack.set(name, this.pack.get(name)! - count);
    if (!this.pack.get(name)) this.pack.delete(name);
    return true;
  }
  spend(seconds: number) { this.clock += Math.round(seconds * 1000); this.food = Math.max(0, this.food - seconds / 80); this.cook(); }
  private cook() {
    for (const job of this.furnaces.values()) {
      const done = Math.min(job.count, Math.floor((this.clock - (job.doneAt - job.count * 10_000)) / 10_000));
      if (done > 0) { job.out += done; job.count -= done; job.doneAt = this.clock + job.count * 10_000; }
    }
  }
  ironNeeded(): number {
    const has = (pattern: RegExp) => [...this.pack.keys(), ...this.worn].some(name => pattern.test(name));
    const plan: Array<[RegExp, number]> = [[/iron_pickaxe/u, 3], [/iron_sword/u, 2], [/bucket/u, 3], [/chestplate/u, 8], [/leggings/u, 7], [/helmet/u, 5], [/boots/u, 4]];
    const pickaxes = (this.pack.get('iron_pickaxe') ?? 0) + (this.pack.get('diamond_pickaxe') ?? 0);
    const held = (this.pack.get('raw_iron') ?? 0) + (this.pack.get('iron_ingot') ?? 0) + [...this.furnaces.values()].reduce((s, j) => s + j.count + j.out, 0);
    return plan.filter(([pattern]) => !has(pattern)).reduce((s, [, n]) => s + n, 0) + (pickaxes >= 2 ? 0 : 3) + 1 - held;
  }
  observation(): BodyObservation {
    const inventory = [...this.pack].map(([name, count]) => this.durability.has(name) ? { name, count, durability: { left: this.durability.get(name)!, max: 131 } } : { name, count });
    const jobs = [...this.furnaces].filter(([, job]) => job.count > 0 || job.out > 0).map(([cell, job]) => {
      const [x, y, z] = cell.split(',').map(Number);
      return { position: { x, y, z }, remainingEstimateMs: Math.max(0, job.doneAt - this.clock), input: job.input, count: job.count };
    });
    const needs = [
      ...(this.dimension === 'overworld' && this.y > 0 && this.ironNeeded() > 0 && this.pack.has('stone_pickaxe') ? [{ id: 'iron:b:30,40,0', need: 'iron', name: 'iron_ore',
        position: { x: 30, y: 40, z: 0 }, distance: 30, canReach: true }] : []),
      ...((this.pack.get('coal') ?? 0) < 8 && this.y > 0 ? [{ id: 'fuel:b:10,60,0', need: 'fuel', name: 'coal_ore', position: { x: 10, y: 60, z: 0 }, distance: 10, canReach: true }] : []),
      { id: 'wood:b:5,64,0', need: 'wood', name: 'oak_log', position: { x: 5, y: 64, z: 0 }, distance: 5, canReach: true },
    ];
    this.frames += 1;
    return { schemaVersion: 1, bodyId: 'minecraft:world', sequence: this.frames, stateAt: new Date(this.clock).toISOString(), receivedAt: new Date(this.clock).toISOString(),
      connected: true, facts: { danger: false },
      state: { world: { position: { x: 0, y: this.y, z: 0 }, dimension: this.dimension, health: this.health, food: Math.round(this.food), inventory, jobs, nearbyNeeds: needs,
        worn: this.worn.length ? this.worn.map((name, i) => `${['頭', '胴', '脚', '足'][i] ?? '手'}: ${name}`).join('、') : '頭: なし',
        nearbyThreats: this.threats, margin: this.night ? { lightInSeconds: 200 } : { darkInSeconds: 300 }, mapSummary: this.map } } as never };
  }

  /** When each of the owner's milestones was first reached, in seconds from the start. */
  marks = new Map<string, number>();
  private mark() {
    const has = (name: string, count = 1) => (this.pack.get(name) ?? 0) + this.worn.filter(item => item === name).length >= count;
    const checks: Array<[string, boolean]> = [['木のツルハシ', has('wooden_pickaxe')], ['石のツルハシ・石の斧', has('stone_pickaxe') && has('stone_axe')],
      ['鉄のツルハシとバケツ', has('iron_pickaxe') && (has('bucket') || has('water_bucket'))], ['ベッド', has('white_bed')],
      ['鉄の全身と予備のツルハシ', this.worn.length === 4 && has('iron_pickaxe', 2)], ['ダイヤのツルハシ', has('diamond_pickaxe')],
      ['黒曜石10', has('obsidian', 10) || this.portal !== null], ['火打石と打ち金・ゲート', this.portal !== null], ['ネザー', this.dimension === 'the_nether']];
    for (const [name, reached] of checks) if (reached && !this.marks.has(name)) this.marks.set(name, Math.round((this.clock - AT) / 1000));
  }

  run(name: string, input: Input): ToolResult {
    this.calls.push(name);
    this.inputs.set(name, [...(this.inputs.get(name) ?? []), input]);
    const handler = (this as unknown as Record<string, ((input: Input) => ToolResult) | undefined>)[name.replace('mc.', 'tool_').replaceAll('-', '_')];
    const result = handler ? handler.call(this, input) : { ok: false, text: `no ${name}`, failure: 'failed' as const, retryable: false };
    this.mark();
    return result;
  }
  private ok(text: string): ToolResult { return { ok: true, text, retryable: false }; }
  private fail(kind: string, text = kind): ToolResult { return { ok: false, text, failure: 'failed', bodyFailure: kind, retryable: true } as ToolResult; }

  tool_mine_block(input: Input): ToolResult {
    const count = Number(input.count ?? 1), block = String(input.blockName);
    const drop: Array<[RegExp, string, number]> = [[/log/u, 'oak_log', SECONDS.log], [/^stone$/u, 'cobblestone', SECONDS.stone], [/iron_ore/u, 'raw_iron', SECONDS.iron],
      [/coal_ore/u, 'coal', SECONDS.coal], [/gravel/u, 'gravel', SECONDS.gravel], [/diamond_ore/u, 'diamond', SECONDS.diamond],
      [/^obsidian$/u, 'obsidian', SECONDS.obsidianDig]];
    const found = drop.find(([pattern]) => pattern.test(block));
    if (!found) return this.fail('invalid_block');
    if (found[1] === 'diamond' && this.y > -50) return this.fail('target_not_found');
    if (found[1] !== 'oak_log' && !/pickaxe/u.test([...this.pack.keys()].join())) return this.fail('missing_tool');
    this.spend(count * found[2] + 4);
    this.add(found[1], count);
    return this.ok(`${block}を${count}個採掘しました`);
  }
  tool_craft_one(input: Input): ToolResult {
    const item = String(input.itemName), recipe = RECIPES[item];
    if (!recipe) return this.fail('unknown');
    const times = Math.ceil(Number(input.count ?? 1) / recipe.makes);
    if (recipe.table && !this.pack.has('crafting_table') && !this.take('oak_planks', 4)) return this.fail('crafting_table_missing');
    if (recipe.table) this.pack.set('crafting_table', 1);
    for (const [need, n] of Object.entries(recipe.needs)) if ((this.pack.get(need) ?? 0) < n * times) return { ok: false, text: `足りない ${need}`, failure: 'failed', retryable: false };
    for (const [need, n] of Object.entries(recipe.needs)) this.take(need, n * times);
    this.add(item, recipe.makes * times);
    this.spend(SECONDS.craft);
    return this.ok(`${item}を${recipe.makes * times}個クラフトしました`);
  }
  tool_place_block_at(input: Input): ToolResult {
    const block = String(input.blockName);
    if (!this.take(block, 1)) return this.fail('missing_item');
    this.placed += 1;
    const cell = `${10 + this.placed}, ${this.y}, 2`;
    if (block === 'furnace') this.furnaces.set(cell.replaceAll(' ', ''), { input: '', count: 0, doneAt: this.clock, out: 0 });
    this.spend(SECONDS.place);
    return this.ok(`${block}を(${cell})に設置しました`);
  }
  tool_start_smelting(input: Input): ToolResult {
    const cell = `${input.x},${input.y},${input.z}`, job = this.furnaces.get(cell), count = Number(input.count ?? 1);
    if (!job) return this.fail('target_not_found');
    if (!this.take(String(input.inputItem), count)) return this.fail('material_missing');
    const fuel = this.take('coal', Math.ceil(count / 8)) || this.take('oak_planks', Math.ceil(count / 1.5)) || this.take('oak_log', Math.ceil(count / 1.5));
    if (!fuel) { this.add(String(input.inputItem), count); return this.fail('material_missing'); }
    Object.assign(job, { input: String(input.inputItem), count, doneAt: this.clock + count * 10_000, out: job.out });
    this.spend(SECONDS.smeltStart);
    return this.ok(`${input.inputItem} x${count}の精錬を開始しました。約${count * 10}秒で完了予定`);
  }
  tool_withdraw_from_furnace(input: Input): ToolResult {
    const job = this.furnaces.get(`${input.x},${input.y},${input.z}`);
    if (!job) return this.fail('target_not_found');
    if (input.waitForCompletion === true && job.count > 0) this.spend((job.doneAt - this.clock) / 1000);
    this.spend(SECONDS.withdraw);
    const out = job.out;
    if (!out) return this.fail('waiting_external');
    job.out = 0;
    this.add('iron_ingot', out);
    return this.ok(`取り出しました: iron_ingot x${out}（完成品）`);
  }
  tool_wait_time(input: Input): ToolResult { this.spend(Number(input.milliseconds) / 1000); return this.ok('待機しました'); }
  tool_equip_item(input: Input): ToolResult {
    if (!this.take(String(input.itemName), 1)) return this.fail('not_found');
    this.worn.push(String(input.itemName));
    this.spend(SECONDS.equip);
    return this.ok(`${input.itemName}を装備しました`);
  }
  tool_use_item(input: Input): ToolResult { if (!this.take(String(input.itemName), 1)) return this.fail('missing_item'); this.food = 20; this.spend(SECONDS.eat); return this.ok('食べました'); }
  tool_attack_continuously(input: Input): ToolResult {
    const kills = Number(input.maxKills ?? 1);
    this.spend(kills * SECONDS.kill);
    this.add(input.entityName === 'sheep' ? 'white_wool' : 'porkchop', kills);
    return this.ok(`${kills}体撃破`);
  }
  tool_find_nearest_entity(): ToolResult { this.spend(SECONDS.find); return this.ok('sheepを発見: 座標(20.5, 64, 3.2), 距離20m'); }
  tool_move_to(): ToolResult { this.spend(SECONDS.walk); return this.ok('移動しました'); }
  tool_stair_mine(input: Input): ToolResult { this.spend(Math.abs(this.y - Number(input.targetY)) * SECONDS.stairStep); this.y = Number(input.targetY); return this.ok('到達しました'); }
  tool_find_blocks(input: Input): ToolResult {
    this.spend(SECONDS.find);
    if (input.blockName === 'nether_portal') return this.portal ? this.ok(`(${this.portal}) 距離3m`) : this.ok('見つかりませんでした');
    const base = input.blockName === 'lava' ? 40 : 60;
    return this.ok(Array.from({ length: 10 }, (_, i) => `(${base + i * 3}, ${this.y}, 5) 距離${5 + i}m`).join('\n'));
  }
  tool_use_item_on_block(input: Input): ToolResult {
    this.spend(SECONDS.pour);
    if (input.itemName === 'bucket') { this.take('bucket', 1); this.add('water_bucket', 1); return this.ok('water_bucketを入手しました'); }
    if (input.itemName === 'water_bucket' && Number(input.count ?? 1) > 1) {
      this.spend(Number(input.count) * 18);
      this.add('obsidian', Number(input.count));
      return this.ok(`黒曜石を${input.count}個作って掘りました。水はwater_bucketへ回収済み。`);
    }
    if (input.itemName === 'water_bucket') return this.ok('✅ マグマが黒曜石に変換されました。水はwater_bucketへ回収済み');
    return this.ok('使用しました');
  }
  tool_dig_block_at(input: Input): ToolResult {
    if (Number(input.x) >= 40 && Number(input.x) < 70) { this.spend(SECONDS.obsidianDig); this.add('obsidian', 1); return this.ok('obsidianを掘りました'); }
    this.spend(SECONDS.gravel);
    this.gravelDigs += 1;
    this.add(this.gravelDigs % 10 === 0 ? 'flint' : 'gravel', 1);
    return this.ok('gravelを掘りました');
  }
  tool_build_structure(input: Input): ToolResult {
    if (!this.take('obsidian', 10)) return this.fail('missing_item');
    this.spend(SECONDS.build);
    this.portal = `${Number(input.x) + 1}, ${input.y}, ${input.z}`;
    return this.ok(`nether_portal を (${input.x}, ${input.y}, ${input.z}) に建築完了`);
  }
  /** A chest's contents (`chest`), looked into and taken from. */
  chest = new Map<string, number>();
  tool_check_container(): ToolResult { this.spend(1); return this.ok(`chest(1, 2, 3)の中身: ${[...this.chest].map(([name, count]) => `${name} x${count}`).join(', ')}`); }
  tool_withdraw_from_container(input: Input): ToolResult {
    const count = this.chest.get(String(input.itemName)) ?? 0;
    if (!count) return this.fail('not_found');
    this.chest.delete(String(input.itemName));
    this.add(String(input.itemName), count);
    this.spend(1);
    return this.ok(`${input.itemName}を${count}個取り出しました`);
  }
  /** The inputs the tools were called with, by tool (what a test reads to see how a call was made). */
  inputs = new Map<string, Input[]>();
  tool_sleep_in_bed(): ToolResult {
    const bed = [...this.pack.keys()].find(name => /_bed$/u.test(name));
    if (!bed) return this.fail('missing_item');
    this.take(bed, 1);
    this.night = false;
    this.spend(7);
    return this.ok('ベッドで寝て朝になりました');
  }
  tool_drop_item(input: Input): ToolResult {
    const name = String(input.itemName), count = Math.min(Number(input.count ?? 1), this.pack.get(name) ?? 0);
    this.take(name, count);
    this.spend(2);
    return this.ok(`${name}を${count}個捨てました`);
  }
  tool_enter_portal(): ToolResult { this.spend(SECONDS.enter); this.dimension = 'the_nether'; return this.ok('ネザーに移動しました'); }
}

const TOOLS = ['mine-block', 'craft-one', 'place-block-at', 'start-smelting', 'withdraw-from-furnace', 'wait-time', 'equip-item', 'use-item',
  'attack-continuously', 'find-nearest-entity', 'move-to', 'stair-mine', 'find-blocks', 'use-item-on-block', 'dig-block-at', 'build-structure',
  'enter-portal', 'sleep-in-bed', 'check-container', 'withdraw-from-container', 'drop-item'];
const READS = new Set(['find-nearest-entity', 'find-blocks', 'check-container']);
let tasks = 0;

export function setup(body: SimBody, options: { batch?: boolean } = {}) {
  const taskId = `procedure-${++tasks}`;
  const inner: FcaExternalTools = {
    definitions: TOOLS.map(name => ({ name: `mc.${name}`, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'minecraft_body', effect: READS.has(name) ? 'read' : 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
      ...(options.batch && name === 'use-item-on-block' ? { nativeInputSchema: { type: 'object', properties: { x: {}, y: {}, z: {}, itemName: {}, count: {} } } } : {}) })) as never,
    async execute(request) { return body.run(request.name, request.input as Input); },
  };
  const tools = withMinecraftAgenda(inner, { on: true, taskId, observe: () => body.observation(), now: () => body.clock, taskStartedAt: AT });
  const call = (input: Input) => tools.execute({ scopeKey: 'owner', taskId, operationId: `step${body.calls.length}`, name: 'mc.run-procedure', input,
    signal: new AbortController().signal, last: true });
  return { taskId, tools, call };
}
