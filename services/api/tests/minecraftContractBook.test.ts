import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, SHORT_ACT_MANUAL_FRAGMENTS, expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { createMinecraftContractBook, minecraftContractHash } from '../src/contracts/minecraftContractBook.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';

// Exact special-page text from parent8c, for the historical shoot-only parent comparison.
const LEGACY_SPECIAL_8C = [
  "bed_burst はエンドで指定したベッド配置を1進入だけ短く起爆する手。先に probe kind=bedsite,target=#id で現在の候補を読み、その配置を頭が選んで施工する。未観測の配置では起爆しない。at:[足側,枕側] は同じ高さで水平に隣接する絶対整数座標2つ、target は竜の #id、count はベッド使用上限1〜5、seconds は上限1〜20秒を全部書く。現在のphase 2→3、または現在のphase 3だけを扱い、次の着地は待たない。配置選び・足場と支持の施工・材料集めはしない。安全な機会なし・着地終了・上限で短く終了し、確認済み爆発数を返す。所有権取消・死亡・世界切替は中断する。準備拒否でも頭が選んだ退避goへ進める時はbed_burstにonFail:continueを付け、同じactの後続へ退避goを置く。外部abort・生命/世界切替・安全反射はonFailで迂回しない。rel:trueとactのrepeatは使えない。",
  "bed_burst は json {\"do\":\"bed_burst\",\"at\":[{\"x\":0,\"y\":67,\"z\":2},{\"x\":0,\"y\":67,\"z\":3}],\"target\":\"#12\",\"count\":5,\"seconds\":20} の行で書く。",
  "fill: groups(1〜12組、各{stand:{x,y,z},at:[{x,y,z},…1〜8マス]})・block・retreatHp(1〜19の整数、以下で置くのを中止)・retreatTo({x,y,z}、遮蔽の足)・seconds(5〜60、帰還込み)は全て必須。座標は絶対座標（rel不可）。指定順に置き、帰還を試みる。結果は行の fill。reached は退避先に着いたか、seen は見ている射手の数。safe は着き、かつ射手に見られていない時だけ true。safe:false だけでは未到着とは限らない。",
  "attack style=shield_rush: 見たブレイズ1体の target(#id)・seconds(5〜60、帰還込み)・retreatHp(1〜19の整数)・retreatTo({x,y,z})・area({center:{x,y,z},radius:1〜16,maxDrop:0〜3の整数})・shieldReserve(0〜335)・onCrossfire(retreat/continue)・pickup(target_drops/none)は全て必須。座標は絶対座標（rel不可）。盾を構えて詰めて打ち、指定した落とし物を拾って退避先へ戻る。掘る・置く・作る・食べるはしない。結果の shieldRush は status(killed/retreated/failed/cut)・targetDead(true/false/null)・code(TARGET_LOST/HEIGHT_UNREACHABLE/NO_ATTACK_WINDOW/CROSSFIRE/SHIELD_LOW/RETREAT_BLOCKED/PICKUP_UNSAFE/TIME_LIMIT/REFLEX/DEAD/null)と実測値。retreatHpで帰れた時はretreated/code:null。",
].join('\n');

// Restore the exact parent pre text only when constructing the historical contract.
const LEGACY_FURNACE_PRE = 'furnace:x,y,z（体が入れた焼きが終わった）';
const CURRENT_FURNACE_PRE = 'furnace:x,y,z（焼きの見込み時間に達した。現物はtakeで確認）';

const pin = { catalogHash: 'a'.repeat(64) };
const book = () => createMinecraftContractBook(pin);

describe('the canonical Minecraft input-contract book', () => {
  it('pins the revised shoot manual and unchanged schema while deriving all nine pages', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(sha(SHORT_ACT_DESCRIPTION)).toBe('ddb25f9de34179e4d653f7fdaf4686e5765fc5483bd19d35e372e4a3b69264ca');
    expect(sha(JSON.stringify(SHORT_ACT_INPUT_SCHEMA))).toBe('acdac6edc8341fbd5689593064fbaa2a8387c869af06a1e9fcb2fbc1179cedc5');
    const current = book();
    expect(current.pages).toHaveLength(9);
    expect(current.reconstruct()).toBe(SHORT_ACT_DESCRIPTION);
    expect(current.manualHash).toBe(sha(SHORT_ACT_DESCRIPTION));
    for (const fragment of SHORT_ACT_MANUAL_FRAGMENTS) {
      if (fragment.inline) expect(current.inline).toContain(fragment.text);
      else expect(current.pages.find(page => page.title === fragment.title)?.text).toBe(fragment.text);
    }
  });

  it('retains untouched parent fragments and refuses its historical book after current manual revisions', () => {
    const legacyShoot = 'shoot 相手(#id か名前) か X,Y,Z [item=bow] [charge=秒] [n=本数]  弓で撃つ。長い欄名（canDig=・canPlace=）も dig=・place= と同じに読む。';
    const fragments = SHORT_ACT_MANUAL_FRAGMENTS;
    const historical = fragments.map(part => ({ ...part, text: part.id === 'special'
      ? LEGACY_SPECIAL_8C : part.text.replace(CURRENT_FURNACE_PRE, LEGACY_FURNACE_PRE) }));
    expect(minecraftContractHash(historical.filter(part => part.id !== 'shoot')))
      .toBe('24065a68017c1cf82467357e4846ffa96682dbb4bf56f8c6976c6c27d9c6abca');
    expect(fragments.find(part => part.id === 'shoot')!.text.split('\n')[0]).toBe(legacyShoot);
    const parent = createMinecraftContractBook(pin, { schema: SHORT_ACT_INPUT_SCHEMA,
      fragments: historical.map(part => part.id === 'shoot' ? { ...part, text: legacyShoot } : part) });
    expect(parent.manualHash).toBe('790714252ac6530c1710f7f266dd6d3a3ea165e9a836f38e8f94a45bc211487e');
    const current = book();
    expect(current.schemaHash).toBe(parent.schemaHash);
    expect(current.catalogHash).toBe(parent.catalogHash);
    expect(current.manualHash).not.toBe(parent.manualHash);
    expect(current.revision).not.toBe(parent.revision);
    for (const page of parent.pages) expect(current.read(page.name)).toBeNull();
    for (const page of current.pages.filter(page => !page.name.startsWith('mc/act/shoot@') && !page.name.startsWith('mc/act/special@'))) {
      expect(page.text).toBe(parent.pages.find(old => old.title === page.title)!.text);
    }
  });

  it('lets a previously unused current hand be found without knowing a hidden page name', () => {
    const current = book();
    for (const kind of ACT_INPUT_SCHEMA.properties.hands.items.properties.do.enum) expect(current.inline).toContain(kind);
    expect(current.inline).toContain('shield_rush');
    expect(current.inline).toContain('sleep [ベッド]');
    expect(current.inline).toContain('enemy_near・not_night・no_bed');
    for (const page of current.pages) {
      const row = current.index.split('\n').find(line => line.includes(page.name))!;
      expect(row).toContain(page.title);
      expect(page.name.length).toBeLessThanOrEqual(40);
      expect(current.read(row.slice(row.lastIndexOf(': ') + 2))).toEqual(page);
      expect(page.sha256).toBe(minecraftContractHash(page.text));
    }
  });

  it('keeps emergency movement/combat, all input fields, stop and queue semantics inline', () => {
    const current = book();
    for (const text of ['go X,Y,Z', 'fight 相手', 'walk X,Y,Z', 'dig X,Y,Z', 'place ブロック名', 'use 物',
      '## 書き方', '## json の欄', '## 止める・守る', '## 列', '## 返る行', 'stopIf', 'accept', 'onFail', 'dependsOn', 'repeat', 'replace']) {
      expect(current.inline).toContain(text);
    }
  });

  it('refuses old pointers after a manual, schema or catalog revision without fuzzy resolution', () => {
    const first = book(), source = { fragments: SHORT_ACT_MANUAL_FRAGMENTS, schema: SHORT_ACT_INPUT_SCHEMA };
    const variants = [
      createMinecraftContractBook(pin, { ...source, fragments: source.fragments.map(part => part.id === 'vertical' ? { ...part, text: part.text + '\n別の契約' } : part) }),
      createMinecraftContractBook(pin, { ...source, schema: { ...source.schema, description: 'new schema' } }),
      createMinecraftContractBook({ ...pin, catalogHash: 'b'.repeat(64) }),
    ];
    for (const changed of variants) {
      expect(changed.revision).not.toBe(first.revision);
      for (const page of first.pages) expect(changed.read(page.name)).toBeNull();
    }
    for (const name of ['vertical', '../api.env', 'mc/act/vertical@latest', first.pages[0]!.name + ' ']) expect(first.read(name)).toBeNull();
  });

  it('survives a fresh epoch and does not require an old tool result to remain in history', () => {
    const first = book(), next = book();
    expect(next.revision).toBe(first.revision);
    for (const page of first.pages) expect(next.read(page.name)).toEqual(page);
    expect(minecraftContractHash({ b: 1, a: { d: 2, c: 3 } })).toBe(minecraftContractHash({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('still sends specialist and sleep examples through the real short parser and unchanged native head schema', () => {
    for (const line of ['obsidian 1,63,2 count=1 seconds=90', 'mine iron_ore 1,63,2 count=2', 'portal 1,63,2 x noEnter',
      'smelt raw_iron 1 fuel=coal fuelCount=1 furnaces=1', 'vertical down stairs south y=12 dig=stone liquid=stop',
      'shoot #12 item=bow charge=1 n=1', 'sleep white_bed seconds=45']) {
      const expanded = expandShortAct({ hands: [line] });
      expect(validSkillInput(expanded.input, ACT_INPUT_SCHEMA)).toBe(true);
    }
  });
});
