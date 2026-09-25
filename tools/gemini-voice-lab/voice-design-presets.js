export const voiceDesignPresetsVerifiedAt = '2026-09-25';

const allVariants = Object.freeze(['en:short', 'en:detailed', 'ja:short', 'ja:detailed']);

function prompts({ enShort, enDetailed, jaShort, jaDetailed }) {
  return Object.freeze({
    en: Object.freeze({ short: enShort, detailed: enDetailed }),
    ja: Object.freeze({ short: jaShort, detailed: jaDetailed }),
  });
}

export const voiceDesignPresets = Object.freeze([
  Object.freeze({
    id: 'shannon-crystal',
    label: 'シャノン本命 · 透明感ヒロイン',
    name: 'Shannon crystal heart',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese anime heroine voice: clear and translucent, kind and approachable, with a light feminine register, natural pitch accent, and vivid emotional contrast.',
      enDetailed: 'An original young-adult Japanese woman character voice with the fresh energy of an anime heroine. Clear, translucent, and softly luminous, with a kind and approachable core. A light feminine register, natural Japanese pitch accent, clean consonants, and smooth vowels. Emotionally vivid: joy becomes bright and buoyant, anger gains crisp strength without shouting, sadness turns delicate and breath-touched, and affection feels warm and close. Conversational, intelligent, and sincere; avoid sugary, babyish, nasal, or overly theatrical delivery.',
      jaShort: '若々しい日本人女性のオリジナルアニメヒロイン声。澄んだ透明感と親しみやすい優しさがあり、軽やかな女性音域、自然な日本語アクセント、喜怒哀楽の鮮やかな切り替えを持つ。',
      jaDetailed: '若々しい日本人女性のオリジナルアニメヒロイン声。澄んで柔らかく光るような声質で、芯には親しみやすい優しさがある。軽やかな女性音域、自然な日本語のアクセント、明瞭な子音となめらかな母音。喜びは明るく弾み、怒りは叫ばず歯切れよく、悲しみは繊細に息を含み、好意は近く温かく表れる。普段の会話は知的で誠実。甘すぎる声、幼すぎる声、鼻にかかった声、過剰な芝居は避ける。',
    }),
  }),
  Object.freeze({
    id: 'sunny-fourteen',
    label: '天真爛漫 · 竹を割った快活さ',
    name: 'Sunny straight arrow',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original bright Japanese anime character voice: sunny, frank, and energetic, with a clear upper-mid register, quick intelligible tempo, lively pitch movement, and strong emotional contrast.',
      enDetailed: 'An original bright Japanese female anime character voice. Sunny, openhearted, frank, and energetic, with the clean decisiveness of someone who says exactly what she thinks. A clear upper-mid register, quick but intelligible tempo, lively pitch movement, spontaneous little laughs, and strong emotional contrast. Excitement should sparkle, annoyance should snap briefly and honestly, sadness should remain brave, and recovery should feel immediate. Keep it clear and lively without shrillness, breathlessness, or caricature. Natural Japanese rhythm and articulation.',
      jaShort: '明るい日本人女性のオリジナルアニメキャラクター声。天真爛漫で率直、元気がよく、中高域の澄んだ声、速くても明瞭なテンポ、活発な音程変化、はっきりした感情差を持つ。',
      jaDetailed: '明るい日本人女性のオリジナルアニメキャラクター声。天真爛漫で裏表がなく、思ったことを気持ちよく言い切る率直さと元気がある。中高域の澄んだ声、速くても聞き取りやすいテンポ、活発な音程変化、自然にこぼれる小さな笑い、強い感情のコントラスト。興奮はきらきらと弾み、不満は短く正直に弾け、悲しみの中にも健気さが残り、すぐ前を向ける。甲高さ、息切れ、誇張した記号的な演技は避け、自然な日本語のリズムと発音を保つ。',
    }),
  }),
  Object.freeze({
    id: 'tsundere-leader',
    label: 'ツンデレ快活 · 強気なリーダー',
    name: 'Spark leader',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese anime voice: confident, quick-thinking, and slightly impatient on the surface, with clear forward placement, sharp endings, comic timing, and hidden warmth.',
      enDetailed: 'An original young-adult Japanese female anime voice: confident, fast-thinking, commanding, and slightly impatient on the surface, with unmistakable warmth underneath. Clear forward placement, brisk tempo, sharp sentence endings, playful challenges, and dramatic emotional pivots. Irritation is crisp rather than harsh; pride is energetic rather than arrogant; embarrassment briefly softens the voice and breaks its rhythm; genuine care appears in a quieter, more tender register. Strong comedic timing and expressive reactions, while remaining natural in ordinary conversation. Avoid shrillness and shouting.',
      jaShort: '若々しい日本人女性のオリジナルアニメ声。自信があり頭の回転が速く、表面は少しせっかち。前に飛ぶ明瞭な声、鋭い語尾、軽快な間、隠しきれない温かさを持つ。',
      jaDetailed: '若々しい日本人女性のオリジナルアニメ声。自信があり頭の回転が速く、主導的で、表面には少しせっかちな強気さがあるが、内側の温かさが隠しきれない。前に飛ぶ明瞭な声、きびきびしたテンポ、鋭い語尾、挑むような遊び心、劇的な感情の切り替え。不満は乱暴ではなく歯切れよく、誇りは傲慢ではなく活発に、照れると一瞬声が柔らかくなりリズムが崩れ、本気の気遣いは静かで優しい音域に現れる。コメディの間と豊かな反応を持ちながら、日常会話では自然。甲高さと叫びは避ける。',
    }),
  }),
  Object.freeze({
    id: 'refined-translucent',
    label: '上品な透明感 · 柔らかな知性',
    name: 'Refined translucent',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese woman voice with refined clarity, graceful diction, a soft velvet undertone, controlled breath, calm intelligence, and subtle but deep emotion.',
      enDetailed: 'An original young-adult Japanese woman character voice with refined clarity, graceful diction, and a soft velvet undertone. The register is light and feminine but grounded, with controlled breath, elegant phrasing, precise Japanese articulation, and calm intelligence. Usually gentle and composed, yet capable of revealing deep feeling through subtle changes in resonance, pauses, and warmth rather than volume. Smiles should be audible, concern should feel intimate, and firm moments should gain quiet authority. Avoid affectation, excessive whispering, and a generic announcer tone.',
      jaShort: '若々しい日本人女性のオリジナルキャラクター声。上品な透明感、優雅な発音、柔らかなベルベットの響き、整った息づかい、穏やかな知性、繊細だが深い感情表現を持つ。',
      jaDetailed: '若々しい日本人女性のオリジナルキャラクター声。洗練された透明感、優雅な言葉運び、柔らかなベルベットの響きを持つ。軽やかで女性的だが地に足のついた音域、整った息づかい、美しいフレージング、正確な日本語の発音、穏やかな知性。普段は優しく落ち着いているが、声量ではなく響き、間、温度の小さな変化で深い感情を見せる。笑顔が声ににじみ、心配は親密に、譲れない場面では静かな威厳が宿る。気取った芝居、過度なささやき、一般的なアナウンサー調は避ける。',
    }),
  }),
  Object.freeze({
    id: 'devoted-tender',
    label: '献身的で優しい · 静かな芯',
    name: 'Tender steadfast',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese woman voice that is gentle, devoted, and attentive, with a soft clear mid-to-high register, careful diction, tender breath, and a quietly firm inner core.',
      enDetailed: 'An original young-adult Japanese female character voice that is gentle, devoted, and emotionally attentive. Soft and clear in a comfortable mid-to-high register, with careful Japanese diction, modest pacing, and a tender breath texture that never becomes whispery. Everyday speech feels humble and reassuring; happiness blooms into a warm smile; urgency gains focused strength; sadness carries quiet ache; determination reveals a surprisingly firm inner core. Affection should feel sincere and personal, not submissive or artificial. Avoid childishness, melodrama, and exaggerated cuteness.',
      jaShort: '若々しい日本人女性のオリジナルキャラクター声。優しく献身的で感情に敏感。柔らかく澄んだ中高域、丁寧な発音、穏やかなテンポ、優しい息の質感、静かで強い芯を持つ。',
      jaDetailed: '若々しい日本人女性のオリジナルキャラクター声。優しく献身的で、相手の感情に細やかに気づく。心地よい中高域の柔らかく澄んだ声、丁寧な日本語の発音、控えめなテンポ、ささやきにならない優しい息の質感。普段の会話は謙虚で安心感があり、喜びは温かな笑顔として花開き、緊急時は集中した強さが増し、悲しみには静かな痛みが宿り、決意では意外なほど強い内面が現れる。好意は従属的でも作り物でもなく、誠実で個人的。幼さ、メロドラマ、誇張した可愛さは避ける。',
    }),
  }),
  Object.freeze({
    id: 'digital-idol',
    label: 'デジタルアイドル · 高く澄んだ輝き',
    name: 'Digital crystal idol',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original Japanese virtual-idol voice with a high crystal-clear register, polished digital sheen, precise rhythm, pure vowels, buoyant melody, quick emotion, and human warmth.',
      enDetailed: 'An original Japanese virtual-idol character voice with a high, crystal-clear register and a polished digital sheen. Bright, optimistic, rhythmically precise, and highly intelligible, with pure vowels, neat consonants, buoyant melodic contours, and quick expressive transitions. The sound may feel slightly synthetic and futuristic while still carrying human warmth and believable emotion. Joy sparkles, curiosity lifts lightly, sadness becomes glassy and fragile, and determination turns clean and radiant. Avoid metallic harshness, piercing highs, and robotic monotony.',
      jaShort: '日本語のオリジナル・バーチャルアイドル声。高く水晶のように澄んだ音域、磨かれたデジタルの艶、正確なリズム、純粋な母音、弾む旋律、素早い感情変化、人間らしい温かさを持つ。',
      jaDetailed: '日本語のオリジナル・バーチャルアイドル声。高く水晶のように澄んだ音域と、磨かれたデジタルの艶を持つ。明るく前向きで、リズムが正確、聞き取りやすく、純粋な母音、整った子音、弾む旋律線、素早い感情の切り替えがある。少し合成的で未来的に感じられても、人間らしい温かさと本物らしい感情を保つ。喜びはきらめき、好奇心は軽く持ち上がり、悲しみはガラスのように儚く、決意は清らかに輝く。金属的な硬さ、刺さる高音、機械的な単調さは避ける。',
    }),
  }),
  Object.freeze({
    id: 'reserved-low-soft',
    label: '控えめ低音 · 静かな照れと本音',
    name: 'Quiet hidden warmth',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese woman voice in a soft lower-mid register: reserved, thoughtful, slightly shy, with gentle breath, unhurried timing, subtle emotion, and hidden warmth.',
      enDetailed: 'An original young-adult Japanese female character voice in a soft lower-mid register. Reserved, thoughtful, and slightly shy, with an understated delivery, gentle breath, unhurried tempo, and natural Japanese pitch accent. Emotion appears through small but meaningful shifts: a faint lift when interested, a tiny hesitation when embarrassed, a warmer resonance when trust grows, and quiet firmness when protecting something important. Intimate and believable at close conversational distance. Avoid flatness, gloom, heavy vocal fry, excessive whispering, and overt cuteness.',
      jaShort: '若々しい日本人女性のオリジナルキャラクター声。柔らかな中低域で、控えめ、思慮深く、少し恥ずかしがり。穏やかな息、ゆっくりした間、繊細な感情、隠れた温かさを持つ。',
      jaDetailed: '若々しい日本人女性のオリジナルキャラクター声。柔らかな中低域で、控えめで思慮深く、少し恥ずかしがり。抑えた話し方、穏やかな息、急がないテンポ、自然な日本語のアクセント。感情は小さいが意味のある変化として現れる。興味を持つと少し音程が上がり、照れるとわずかにためらい、信頼が育つと響きが温かくなり、大切なものを守る時は静かな強さが出る。近い会話距離で親密かつ自然。平板さ、暗さ、強いボーカルフライ、過度なささやき、露骨な可愛さは避ける。',
    }),
  }),
  Object.freeze({
    id: 'formal-awakening',
    label: '凛とした清廉さ · 感情が花開く',
    name: 'Clear earnest bloom',
    verifiedVariants: allVariants,
    prompts: prompts({
      enShort: 'An original young-adult Japanese woman voice with pristine clarity, formal diction, quiet discipline, and restrained emotion that gradually opens into warmth, vulnerability, and sincere feeling.',
      enDetailed: 'An original young-adult Japanese woman character voice with pristine clarity, formal diction, quiet discipline, and a restrained emotional surface. Begin with measured pacing, precise articulation, and a cool, composed resonance. As feeling emerges, let the voice gradually become warmer, softer, and more vulnerable: gratitude glows gently, grief trembles without collapsing, wonder opens the vowels, and love is expressed with profound sincerity rather than sweetness. Elegant and cinematic but still natural in conversation. Avoid stiffness, aristocratic affectation, and melodrama.',
      jaShort: '若々しい日本人女性のオリジナルキャラクター声。清廉な透明感、端正な言葉遣い、静かな規律、抑えた感情が、徐々に温かさ、無防備さ、誠実な思いへ花開く。',
      jaDetailed: '若々しい日本人女性のオリジナルキャラクター声。曇りのない透明感、端正な言葉遣い、静かな規律、抑制された感情の表面を持つ。最初は落ち着いたテンポ、正確な発音、涼しく整った響き。感情が生まれるにつれて徐々に温かく、柔らかく、無防備になる。感謝は優しく光り、悲しみは崩れずに震え、驚きは母音を開き、愛情は甘さではなく深い誠実さで表す。上品で映画的だが日常会話では自然。硬さ、貴族的な気取り、メロドラマは避ける。',
    }),
  }),
]);

export function voiceDesignPrompt(preset, language = 'en', detail = 'detailed') {
  return preset?.prompts?.[language]?.[detail] ?? '';
}

export function voiceDesignVariantIsVerified(preset, language, detail) {
  return preset?.verifiedVariants?.includes(`${language}:${detail}`) === true;
}
