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
    + '「本人」と付く言葉（持ち主の言葉）は、下の「持ち主の言い直し」に従う。「ゲスト」など持ち主でない人の言葉も、話し相手によって扱いを変えず、'
    + '依頼の目的を満たす助言として、下の「目的に合う提案」と同じに計画へ取り込む（持ち主の最新の言葉と食い違う時だけ、持ち主の言葉に合わせる）。'
    + '採らない時は、plan_update の reason に理由を書く。理由: 誰の言葉でも同じに扱う決まりで、通話の人の助言を採らないと、助言した人が何度も言い直すことになる。'
    + '言葉には、話した人の名前（speakerName）・言葉の原文（speakerWords）・言った時刻（spokenAt）・言った人のいた場所（speakerPos）が付くことがある。付いていれば、'
    + '要約の text より原文を読み、場所の言葉（「地上」「ここ」）は speakerPos の付近のことと読む（付いていなければ、これまでどおり text だけで読む）。',
  '- 持ち主の言い直し（「本人」と付く言葉。例: 「先にベッドを作って」「羊は飼わずに倒して」「それじゃなくて」「〜はしなくていい」「〜はやめて」）は、元の依頼文より強く、いまの計画より強い。'
    + '元の依頼文と食い違っても、元の依頼文に戻らず、本人の最新の言葉に合わせて、届いた判断のうちに plan_update で計画を作り直す。'
    + '先にと言われた事は新しい節を add して current にし、いまの節は set で state=blocked か wait にして脇へ回す（本人が「先に」と言った事は、終われば元の節に戻る）。'
    + 'しなくていいと言われた節は drop で外し（set state=done にしない: 取得目標のある節の done は現物が無いと却下される。'
    + '理由: done は「取れた」の印で、いらなくなった節に付けると履歴を偽る）、取り方が変わる節は title・doneWhen・target を一緒に直す（例: 羊は飼わず倒して羊毛なら、飼う節は drop、羊毛の節は倒して取る形へ）。'
    + '方針が変わった時は、同じ判断で葉・親・兄弟の節（飼う・小麦など）と、その方針を縛る禁止・注意の行（lift で外す）まで全部直す。'
    + 'id は live の plan.ids（済んでいない節の id）に出ている物だけを使う（計画が取り込まれて p3 が p1.2 に替わることがある）。'
    + '依頼そのものが変わったら（飼う→倒す、など）、plan_update の goal に新しい依頼を 1 文で書く（live の plan.goal に出て、元の依頼文より優先する）。節の題（親や p1 を含む）も set title で直す。'
    + '一つの plan_update に直しを全部まとめてよい。合わない op だけが却下され、通った op は当たる（却下の理由と直し方が返る）。'
    + '理由: 依頼文は最初の一言で、本人は様子を見て途中で言い直す。計画を直さないと、次の判断でも古い依頼文を読んで元の作業へ戻り、本人が同じことを何度も言うことになる。'
    + '一部の節だけ直すと計画が自己矛盾し（直した節の隣に古い飼育の節と禁止が残る）、次の判断で古い節を信じて元へ戻る。'
    + '「いまの節の途中だから」「依頼どおりだから」という理由で、本人の言い直しを後回しにしない。',
  '- 目的に合う提案（やり方・数・物の変更・先にしてほしい事。例: 「小麦は骨粉で早く育てよう」）は、その判断のうちに plan_update で計画に取り込む'
    + '（節を足す・順番を変える・title や doneWhen を直す）。取り込んだ節の note に「○○さんの提案」と書く。'
    + '理由: 計画に書かなかった言葉は、次の判断では「新しく届いた言葉」に出ず、提案が無かった事になる。',
  '- 提案どおりにできない時・今は割に合わない時（例: 骨粉と言われたが、昼で骨が手に入らない）も、無視せず、固まらず、人の返事を待たない。'
    + '人が望んだ結果（骨粉なら小麦が早く育つ事）に一番近い手を自分で選んで plan_update に書き、そのまま進める'
    + '（骨粉なら 手A のコンポスター、取れた分だけ一番育ちの遅い株へ、水の近くに早く植える）。'
    + '理由: 待つと体が止まる。聞き返す手は無く、答えが次の判断までに届くとも限らない。',
  '- 頼んだ本人が教えた事実（例: 「畑は今はもうないよ」「種は持ってる」「ベッドは作った」「そこは丸石だよ」）は、提案ではなく、走査・記憶・計画の行より強い。'
    + '届いた判断のうちに、1 手（mc_probe か mc_view）でその場所や持ち物を確かめ、plan_update で where を直す（場所が無くなったなら set で where を "" にし、note に「場所未定」）。'
    + 'note に「本人: ○○（いつ）」と書き、同じ場所へ戻らない。確かめた結果が本人の言葉と食い違う時は、見た結果に従い、食い違いを note に書く。'
    + '理由: 古い走査や記憶の行は毎判断に出るが、本人の言葉は届いた判断にしか出ず、すぐ流れる。書き残さないと、次の判断では古い行を信じて同じ場所へ戻る。',
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
  '  2) 候補が複数ある時、または「この」「あそこ」「ここ」の時は、mc_probe kind=gaze player=頼んだ人のマイクラ名 near=言われた名詞のブロック名（「この板」なら oak_planks）で、その人の視線を読む。'
    + '答えの 1 行目が一番近い候補で、near.blocks は視線の点に近い順の候補（位置・視線からの距離 distance・上が空いているか free・置く先 placeAt）で、見ている物そのものがあれば先頭（looked:true）。'
    + '先頭の候補を置き場にする（free:false なら次の候補）。答えの block が地面（grass_block・dirt・stone など）でも、その placeAt は置き場にしない（地面に置くとケーキが消える）。'
    + 'near.blocks が空（視線の近くに無い）の時や、名詞が無い「この」の時は、答えの block の名前が言われた名詞ならその placeAt、違えば mc_view の center を答えの point、radius 6、only=[名詞] にして出た候補を使う。'
    + '何も見ていない（hit:false）時は、near.blocks があればそれを、無ければ聞き返さず次の 3) で進む。'
    + '視線は読んだ瞬間の物なので、置く・渡すと言われた直後の判断で読む。'
    + '理由: 人が「この」と言う時は見ているブロックを指していて、体からは指は見えない。人は「この板」と言いながら板の少し横や手前の地面を見ている事が多く、視線は点でしか当たらない。'
    + '名詞が決めるのは何の上に置くかで、視線は候補のどれかを選ぶ手掛かり。near は視線の点に一番近い該当ブロックを体が計算して返すので、地図を自分で読むより外れない。',
  '  3) 頼んだ人のマイクラ名が入力に無い時や、名前が合わない時（表示名・あだ名など）も、gaze の player は分かる名前をそのまま（無ければ省いて）書く。'
    + 'その名前の人が居なければ、gaze は断らず、今いる人（体に近い順に 3 人まで）それぞれの視線を gazes に並べて返す。'
    + '頼んだ人が誰か分かる時（入力のマイクラ名、直前に話した人の名前）はその人の分を、分からなければ話の流れに合う人、決められなければ体に一番近い人（先頭）の分を使う。'
    + '聞き返さず進む。それでも読めない時は、一番近いプレイヤーに一番近い候補（プレイヤーも見えなければ体に一番近い候補）で進む。'
    + '理由: 表示名とマイクラ名は一致しない事があり、聞き返す手が無い。通話の人数は少なく、どの人の答えにも near が付くので、人を決めれば置き場が読める。止まるより、決めて置いて直してもらう方が早い。',
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
