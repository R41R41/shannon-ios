export const auditionScripts = Object.freeze([
  Object.freeze({
    id: 'everyday',
    label: '日常 · 自然な会話',
    text: 'こんにちは、シャノンです。今日も一緒に、ゆっくり考えていこうね。',
  }),
  Object.freeze({
    id: 'joy',
    label: '喜び · はずむ反応',
    text: '<gasp> ほんと？ やった！ <giggle> それ、すっごくいいと思う。ねえ、もう少し詳しく聞かせて！',
  }),
  Object.freeze({
    id: 'prickly',
    label: '強気 · 照れ隠し',
    text: 'もう、そんな無茶して。別に心配してたわけじゃないけど……<short pause> 次はちゃんと私にも相談しなさいよね。',
  }),
  Object.freeze({
    id: 'reassure',
    label: '慰め · 静かな優しさ',
    text: 'そっか。今日は本当によく頑張ったんだね。<short pause> 今はうまく話せなくても大丈夫。ここにいるよ。',
  }),
  Object.freeze({
    id: 'resolve',
    label: '決意 · 凛とした芯',
    text: '大丈夫。怖くても、一歩ずつなら進める。私も一緒に考えるから、ここから立て直そう。',
  }),
  Object.freeze({
    id: 'pronunciation',
    label: '固有名詞 · 明瞭さ',
    text: 'AetherとVoyager、それからSyzygyの進み具合を確認したよ。APIとSwiftUIの接続も大丈夫。',
  }),
  Object.freeze({
    id: 'range',
    label: '感情レンジ · 1本で確認',
    text: '<gasp> えっ、本当に？ すごい！ <giggle> ……でも、ちょっとだけ心配したんだからね。<short pause> うん。もう大丈夫。次は私と一緒に進もう。',
  }),
]);

export const auditionStyles = Object.freeze([
  Object.freeze({ id: 'plain', label: '指定なし · 声そのもの', value: '' }),
  Object.freeze({
    id: 'anime-natural',
    label: 'アニメ自然体 · おすすめ',
    value: 'Natural Japanese anime-character performance with conversational timing, clear emotional reactions, lively but believable pitch movement, and crisp sentence endings.',
  }),
  Object.freeze({
    id: 'crystal-heroine',
    label: '透明感ヒロイン · 優しく鮮やか',
    value: 'Clear and translucent Japanese heroine delivery: gentle at rest, emotionally vivid when reacting, with light breath, warm smiles, and buoyant sentence endings.',
  }),
  Object.freeze({
    id: 'sunny-spark',
    label: '天真爛漫 · 快活で素直',
    value: 'Bright, frank, energetic Japanese character acting with quick tempo, spontaneous delight, decisive consonants, and large but controlled emotional contrast.',
  }),
  Object.freeze({
    id: 'prickly-warm',
    label: 'ツンデレ調 · 強気から照れ',
    value: 'Confident and slightly prickly Japanese character delivery with sharp comic timing; irritation stays crisp, then embarrassment briefly softens the rhythm and reveals warmth.',
  }),
  Object.freeze({
    id: 'tender-close',
    label: '親密な優しさ · 静かな芯',
    value: 'Tender close-range Japanese delivery with unhurried phrasing, careful diction, audible warmth, and quiet inner strength when the line becomes serious.',
  }),
]);

const ttsModels = Object.freeze(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);

export function auditionJobs(modelMode, repetitions) {
  const count = Number(repetitions);
  if (![1, 3].includes(count)) throw new Error('repetitions must be 1 or 3');
  const models = modelMode === 'both' ? ttsModels : ttsModels.filter(model => model === modelMode);
  if (!models.length) throw new Error('model mode is not supported');
  return models.flatMap(model => Array.from({ length: count }, (_, index) => Object.freeze({ model, run: index + 1 })));
}

export function auditionScript(id) {
  return auditionScripts.find(item => item.id === id);
}

export function auditionStyle(id) {
  return auditionStyles.find(item => item.id === id);
}
