/**
 * The owner's rule of the body's self-defence (11/10, run 4's death): the words every head text that speaks of fighting, `accept` or fleeing
 * shares, so that none of them says the old thing (accept silences the reflexes; no fight at 8 health; no creeper fight).
 * The body keeps the rule (its floor reflexes); the head only tells it to the model.
 */
export const SELF_DEFENCE_SHORT =
  '体の自衛（4m 内で自分を倒しに来ている敵が 2 体まで・8m 内の敵が 4 体までなら、殴られる前から体が倒す。クリーパーは打って離れる・盾で受ける。'
  + 'エンダーマン・ピグリンなど中立は敵意を向けるまで迎撃しない）は accept の有無に関係なく働く';
