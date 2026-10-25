const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function words(text: string): string[] {
  const clean = text.normalize('NFKC').toLowerCase();
  const tokens = [...segmenter.segment(clean)].filter(p => p.isWordLike).map(p => p.segment);
  // Bigrams let short Chinese names and phrases match even when the dictionary segments differently.
  for (const part of clean.match(/[\p{Script=Han}]+/gu) ?? []) for (let i = 0; i + 1 < part.length; i++) tokens.push(part.slice(i, i + 2));
  return [...new Set(tokens)].slice(0, 300);
}
const retrievalStopWords = new Set('的 了 在 是 有 就 不 也 都 还 又 很 吧 啊 吗 呢 喵 嗯 哦 嘛 和 与 及 被 把 为 到 从 让 给 看 说 喜欢 使用 表示 提到 需要 想要 认为 但是 因为 所以 还有 我 你 他 她 它 我们 你们 他们 这个 那个 这些 那些 什么 怎么 为什么 多少 哪里 哪个 一下 一个 一点 有点 已经 还是 就是 不是 没有 可以 可能 觉得 知道 记得 今天 昨天 现在 之前 后来 时候 这样 那样 小狼 用户 消息 图片 群聊 the a an is are am i you he she it we they this that what how why do does did of to in on at and or for with'.split(' '));
/** Search content, not protocol IDs, dates, or high-frequency conversational glue. */
export function retrievalWords(text: string): string[] {
  const clean = text.replace(/https?:\/\/\S+|\b[a-f0-9]{16,}\b|\b\d{4}-\d{2}-\d{2}\S*/gi, ' ');
  return words(clean).filter(term => !retrievalStopWords.has(term) && !/^\d+$/.test(term));
}
