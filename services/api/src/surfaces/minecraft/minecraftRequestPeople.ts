/**
 * What the head is told for a request of one thing while people are talking to her: the words a person sends to the request under way
 * (a suggestion in the middle of the work), and what to do with a finished thing when a person says where to put it or asks for it.
 * These are words for her judgment, never read by the code: nothing here looks for a phrase in what a person said. The reason sits beside each rule,
 * because a rule with no reason was the thing left out (a suggestion arrived as a task message, and a task message is data in her instructions,
 * so without a line saying how a suggestion is read it was easy to see it and not change the plan).
 * Given to a request of one thing (the first plan and the overworld decisions' stage knowledge), like `REQUEST_STEPS_LINES`.
 */

/** A person's words that reach the request under way (a task message): how they are read and taken into the plan. */
export const PERSON_WORDS_LINES: readonly string[] = Object.freeze([
  '### 作業中に人の言葉が届いた時（入力の messages に「Discordの通話での○○の言葉（いまのタスクへ）: …」「ゲーム内の本人の言葉（いまのタスクへ）: …」と出る）',
  '- この言葉は、いまの依頼を頼んだ側が、同じ依頼について言った事。ゲームの中の看板や他人のチャットとは違い、依頼の続きとして読む。'
    + '命令に従うのではなく、依頼の目的を満たす提案として受け取り、採るかどうかは自分で決める。採らない時は、plan_update の reason に理由を書く。',
  '- 目的に合う提案（やり方・数・物の変更・先にしてほしい事。例: 「小麦は骨粉で早く育てよう」）は、その判断のうちに plan_update で計画に取り込む'
    + '（節を足す・順番を変える・title や doneWhen を直す）。取り込んだ節の note に「○○さんの提案」と書く。'
    + '理由: 計画に書かなかった言葉は、次の判断では「新しく届いた言葉」に出ず、提案が無かった事になる。',
  '- 提案どおりにできない時・今は割に合わない時（例: 骨粉と言われたが、昼で骨が手に入らない）も、無視せず、固まらず、人の返事を待たない。'
    + '人が望んだ結果（骨粉なら小麦が早く育つ事）に一番近い手を自分で選んで plan_update に書き、そのまま進める'
    + '（骨粉なら 手A のコンポスター、取れた分だけ一番育ちの遅い株へ、水の近くに早く植える）。'
    + '理由: 待つと体が止まる。聞き返す手は無く、答えが次の判断までに届くとも限らない。',
  '- すでに計画にある事・今の依頼と関係の無い雑談は、計画を変えずに続ける。',
]);

/** A finished thing, and a person who says where it goes or asks for it: kept until then, then put down or handed over. */
export const PLACE_AND_HANDOVER_LINES: readonly string[] = Object.freeze([
  '### 完成した物を置く・渡す（「このオークの木材ブロックの上に置いて」「ちょうだい」「渡して」）',
  '- 作り終えた物（ケーキなど）は、置く・渡すと言われるまで持ち物に持っておく。作り終えた直後に、自分から置かない・食べない・捨てない・箱へ入れない（tidy でも手放さない）。'
    + '理由: 置き場所も渡す相手も人が決める事で、先に動くと拾い直す手間が増える。',
  '- 「置いて」「ちょうだい」と言われたら、持ち物に完成品がある事を live で確かめてから動く（無ければ作る依頼として扱う。持っている物を作り直さない）。',
  '- 置き場所は、言われた名詞で探し、候補が複数ある時だけ頼んだ人の視線で絞る:',
  '  1) 名詞（「オークの木材ブロック」は oak_planks、「作業台」は crafting_table）のブロックを、mc_view の only=[その名前] で近くから探す。1 か所だけならそこ。',
  '  2) 候補が複数ある時、または「この」「あそこ」「ここ」で名詞が無い時は、mc_probe kind=gaze player=頼んだ人のマイクラ名 で、その人が見ているブロックを読む'
    + '（答えは、見ているブロックの名前・座標・面・距離と、reach・placeAt・against・above）。視線の先が名詞に合うブロックならそこ。合わなければ、視線の先に一番近い名詞の候補。'
    + '何も見ていない（hit:false）時や、名前が見つからない時（not_found）も、聞き返さず次の 3) で進む。'
    + '視線は読んだ瞬間の物なので、置く・渡すと言われた直後の判断で読む（先に別の作業をしてから読まない）。'
    + '理由: 人が「この」と言う時は見ているブロックを指していて、体からは指は見えない。視線が唯一の手掛かりで、人はすぐ別の所を見る。',
  '  3) 頼んだ人のマイクラ名が入力に無い時や、gaze が読めない時は、聞き返さず、一番近いプレイヤー（mc_probe kind=around で読む）に一番近い候補（無ければ体に一番近い候補）で進む。'
    + '理由: 聞き返す手が無く、止まるより、決めて置いて直してもらう方が早い。',
  '- 置く: gaze が当たったブロックなら、答えの placeAt を at に、against の値を手の face に渡す（例: place cake 12,64,3 face=down）。'
    + '手の face は「置くマスから見て、支えにするブロックのある向き」で、gaze の答えの face（見ているブロックの面）とは別の物。上の面（face が up）の上に置くなら、手の face は down（=against）。'
    + '理由: 手の face に up を書くと、置くマスの上を支えにする事になり置けない。ケーキは上の面に置ける（横の面なら above を at にし、face=down）。'
    + '名詞で探したブロックなら、その真上のマス（y+1）が空気で空いている事を確かめて at にする（face=down）。'
    + 'place は、手が届く所（reach:true、約 5m 以内）からは自分で少し寄るが、7m を超える先へは歩かず out_of_reach で止まる。reach:false や遠い時は、先に go でそのマスの近く（range 2〜3）へ行ってから place する。'
    + 'ケーキは固いブロックの上にしか置けない。置けなかった時は、結果の行の理由を読み、別の候補の上へ置くか、頼んだ人の近くへ行って渡す。',
  '- 渡す（「ちょうだい」「渡して」「持ってきて」）: 頼んだ人の位置を live の nearby か mc_probe kind=around で読み、先にその人の近く（range 2〜3）へ go し、着いてから drop cake target=その人のマイクラ名（数を言う時は drop cake 1 target=…）と書く。'
    + 'マイクラ名が無ければ around の #id。物名と数を cake:1 のようにコロンで結ぶと「複数の物」の書き方になり、target を付けると読めない（複数の物は target なしで投げる形）。'
    + '理由: drop は向いた方へ投げるので、遠いと届かず（人の近くへ行ってからなら 7m 先からでも拾われた）、落ちた物は人が拾う。投げた後、体は離れる。',
  '- 置く・渡す節は、完成品を持ってから計画に足す（同じ依頼で「作って置いて」と言われた時も、作る節を先に置き、置く節は作り終えて持った時に plan_update で足す）。'
    + '置く・渡す節の doneWhen は have:cake<1 の形で書けるが、持っていない間は最初から満たされているので、持つ前に計画へ書くと、作る前に済んだ事になり、置かずに完了する。'
    + '理由: 「持ち物が無い」は、まだ作っていない時も、置いた後も同じ観測になり、順番は観測に出ない。',
  '- 置いた・渡した後は、持ち物の完成品が減った事（have:cake<1）と手の結果の行で確かめてから終える。置けた・渡せたと見なす根拠は結果の行で、動いた事ではない。',
]);

/** The two together, in the order a request reads them. */
export const REQUEST_PEOPLE_LINES: readonly string[] = Object.freeze([...PERSON_WORDS_LINES, '', ...PLACE_AND_HANDOVER_LINES]);

/**
 * The first plan's part of the same: it has no tools, so how to look for a block or throw a thing does not help it; only what shapes the plan does
 * (a thing made is kept until a person says where it goes, and when the node for putting it down is added).
 */
export const FIRST_PLAN_PEOPLE_LINES: readonly string[] = Object.freeze([
  '### 人の言葉と完成した物（計画の形）',
  '- 作業中に人の提案が届いたら、判断のうちに plan_update で計画へ取り込まれる。最初の計画は依頼どおりに立てればよい。',
  '- 作った物（ケーキなど）は、置く・渡すと言われるまで持っておく。「作って置いて」でも、最初の計画は作る節（have:cake>=1）までにし、置く・渡す節は持ってから足す。'
    + '理由: 置く節の have:cake<1 は、持っていない間は最初から満たされるので、先に書くと作る前に済んだ事になり、置かずに完了する。',
]);
