import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, SHORT_ACT_MANUAL_FRAGMENTS, expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { createMinecraftContractBook, minecraftContractHash } from '../src/contracts/minecraftContractBook.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { SELF_DEFENCE_SHORT } from '../src/contracts/minecraftSelfDefenceWords.js';
import { SLEEP_EXCEPT, SLEEP_MODES } from '../src/contracts/minecraftSleepWords.js';

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
// The hunt hand (2026-11-11) added a page (last, so the earlier fragments keep their ids), a pointer on the attack line and a clause in the json fields line:
// the historical contract is made without them.
const CURRENT_ATTACK_POINTER = '。食料の動物を何体も狩るのは hunt';
const CURRENT_HUNT_FIELDS = ' / hunt: target（種類。id は不可）・count・range・seconds';

// 11/11 trim: the owner's self-defence numbers are said once (the instructions' 「敵と体力」); mc_act's accept line points to them. The historical contract is made with the earlier words.
// (The wait hand's 「待つ手の act には hostileWithin」 stays in mc_act's stopIf line: the instructions' 待ち打ち is another rule.)
const CURRENT_SELF_DEFENCE = '体の自衛（数は system の「敵と体力」）は accept の有無に関係なく働く。';
const LEGACY_SELF_DEFENCE = `${SELF_DEFENCE_SHORT}。`;
/** 11/27 (1127m): go's maxDrop line says what 11 and over mean (the End only, up to 70); the historical book had "既定 3）。" only. */
const CURRENT_GO_DROP = 'maxDrop は一度に落ちてよい段（既定 3。10 まで通常、11 以上はエンドだけで 70 まで: 水バケツが手か hotbar に有り・体力 18 以上・竜の火の玉や息の雲が届いていない時。体が条件を判定し、欠けると降りずに欠けた条件を返す）。';
const LEGACY_GO_DROP = 'maxDrop は一度に落ちてよい段（既定 3）。';

// The tidy hand (2026-11-13) added one line after the drop line: the historical contract is made without it.
const isTidyLine = (text: string) => text.startsWith('tidy [物[:数]');
// 11/13 (h-knowledge): exposeOk on mine and vertical, the seal example and the stairs line on the vertical page, and one queue line (the inline ids again shift
// by it): the historical contract is made without them, and its hash proves the removal is exact.
const isQueuePackingLine = (text: string) => text.startsWith('- 列の積み方（体が止まる時間を減らす）');
// 11/26 (the end-dragon run on Haiku: one hand per decision): a section of nine lines after the tidy-through-hunt lines says to stack the known follow-up hands in one act; the
// historical contract is made without it (the heading line starts with a blank line, so the joined text is the same as before without it).
const STACK_1126 = ['\n## 続きの手は同じ act に積む', '- 次に何をするかが今の時点', '- 続きが分かっている並びの例', '  作って着る', '  掘って作る', '  倒して拾う', '  行って働く', '- 失敗した時（体のきまり）', '- 積まない時'];
// 11/26 (the limits of each hand's seconds and range, one line after the fight lines): the historical contract is made without it.
const isLimitsLine = (text: string) => text.startsWith('- 手の秒と範囲の上限');
const isStackLine = (text: string) => STACK_1126.some(head => text.startsWith(head));
const REVISIONS_1113: ReadonlyArray<readonly [string | RegExp, string]> = [
  ['[collect=false] [exposeOk] [seconds=N]', '[collect=false] [seconds=N]'],
  ["exposeOk は dig と同じ（敵に見られても掘る。「見られる」の止まりのあと、離れて掘れない時に付ける）。", ''],
  ['[range=1|2] [exposeOk] [seconds=N]', '[range=1|2] [seconds=N]'],
  ['vertical down stairs south y=10 dig=stone,dirt,gravel liquid=seal place=cobblestone', 'vertical down stairs south y=10 dig=stone,dirt liquid=stop'],
  [/\n  荷に丸石があるのが普通の場面は liquid=seal[^\n]*/u, ''],
  [/\n  stairs は 1 段で向きへ 1 マス進む[^\n]*/u, ''],
  ['collect・exposeOk・seconds・canDig', 'collect・seconds・canDig'],
  ['range・exposeOk・seconds / walk', 'range・seconds / walk'],
];
// The sleep hand's `on` (not tonight / back on) and the exception to "sleep at night" with its reason: the historical contract is made without them.
const REVISIONS_1125: ReadonlyArray<readonly [string | RegExp, string]> = [
  ['sleep [ベッド] [seconds=N] [on=false]', 'sleep [ベッド] [seconds=N]'],
  [`${SLEEP_MODES}。理由:`, '理由:'],
  [`${SLEEP_EXCEPT}。`, ''],
];
const undo1113 = (text: string) => [...REVISIONS_1113, ...REVISIONS_1125].reduce((out, [now, before]) => out.replace(now, before), text);

const pin = { catalogHash: 'a'.repeat(64) };
const book = () => createMinecraftContractBook(pin);

describe('the canonical Minecraft input-contract book', () => {
  it('pins the revised shoot manual and the schema while deriving all ten pages (the hunt page added 11/11)', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(sha(SHORT_ACT_DESCRIPTION)).toBe('56c8b4f3fdc706882b39b6e08791aeb220b1afa196bcf85f710587cda2a1da56');
    expect(sha(JSON.stringify(SHORT_ACT_INPUT_SCHEMA))).toBe('848d8b9cc2cca9535e006ece66c959568186d367e48dca2dedebdcb82f4a96b2');
    const current = book();
    expect(current.pages).toHaveLength(10);
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
    // The inline ids are the lines' positions: without the tidy lines the later ones are numbered as before.
    const historical = fragments.filter(part => part.id !== 'hunt' && !isTidyLine(part.text) && !isQueuePackingLine(part.text) && !isStackLine(part.text) && !isLimitsLine(part.text)).map((part, index) => ({ ...part, ...(part.inline ? { id: `inline-${index}` } : {}), text: part.id === 'special'
      ? LEGACY_SPECIAL_8C : undo1113(part.text).replace(CURRENT_FURNACE_PRE, LEGACY_FURNACE_PRE).replace(CURRENT_ATTACK_POINTER, '').replace(CURRENT_HUNT_FIELDS, '')
        .replace(CURRENT_SELF_DEFENCE, LEGACY_SELF_DEFENCE).replace(CURRENT_GO_DROP, LEGACY_GO_DROP) }));
    expect(minecraftContractHash(historical.filter(part => part.id !== 'shoot')))
      .toBe('fb90c61aae8f5be0499ca348c3f5fec20f1aa346a6cca29d1ab1080e2188dd1d');
    expect(fragments.find(part => part.id === 'shoot')!.text.split('\n')[0]).toBe(legacyShoot);
    const parent = createMinecraftContractBook(pin, { schema: SHORT_ACT_INPUT_SCHEMA,
      fragments: historical.map(part => part.id === 'shoot' ? { ...part, text: legacyShoot } : part) });
    expect(parent.manualHash).toBe('d6be3d45ff0dfd3ad67682283647cbab25fdf17e25bb46038cdeace05e8f4856');
    const current = book();
    expect(current.schemaHash).toBe(parent.schemaHash);
    expect(current.catalogHash).toBe(parent.catalogHash);
    expect(current.manualHash).not.toBe(parent.manualHash);
    expect(current.revision).not.toBe(parent.revision);
    for (const page of parent.pages) expect(current.read(page.name)).toBeNull();
    for (const page of current.pages.filter(page => !page.name.startsWith('mc/act/shoot@') && !page.name.startsWith('mc/act/special@') && !page.name.startsWith('mc/act/hunt@')
      && !page.name.startsWith('mc/act/mine@') && !page.name.startsWith('mc/act/vertical@'))) {   // mine and vertical: revised 11/13 (exposeOk, the seal, the stairs line)
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
