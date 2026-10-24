import type { ChatRecord, Message } from './contracts.js';
import { textTokens } from './context-budget.js';

export const proactiveHistoryBudget = 1800;
export interface ProactiveReference { seq: number; speaker: 'human' | 'bot'; text: string; truncated?: true }

/** Select explicit conversational anchors locally; candidates never pass through this reducer. */
export function selectProactiveHistory(rows: ChatRecord[], batch: Message[], options: {
  limit: number;
  record?(seq: number): ChatRecord | undefined;
  imageContext(message: Message): string;
  fits(items: ProactiveReference[]): boolean;
}) {
  const last = batch.at(-1)!, pending = new Set(batch.map(message => message.seq));
  const pool = new Map<number, ChatRecord>(), quotes = new Set<number>(), inline = new Set<number>();
  const add = (row: ChatRecord | undefined) => {
    if (row && row.session === last.session && Number.isSafeInteger(row.seq) && row.seq > 0 && row.seq <= last.seq && !pending.has(row.seq)) pool.set(row.seq, row);
  };
  rows.forEach(add);
  for (const message of batch) for (const part of message.segments) {
    if (part.type !== 'reply' || part.unavailable || part.seq === undefined || !Number.isSafeInteger(part.seq) || part.seq <= 0 || part.seq > last.seq || pending.has(part.seq) || quotes.size >= 50) continue;
    quotes.add(part.seq);
    // The complete new message already contains this quote; do not send its text twice.
    if (part.segments?.length) inline.add(part.seq);
    if (!pool.has(part.seq)) add(options.record?.(part.seq));
  }
  const ordered = [...pool.values()].sort((a, b) => a.seq - b.seq), priorities = new Map<number, number>();
  const prioritize = (row: ChatRecord | undefined, rank: number) => {
    if (row) priorities.set(row.seq, Math.min(priorities.get(row.seq) ?? Infinity, rank));
  };
  for (let i = 0; i < ordered.length; i++) if (quotes.has(ordered[i]!.seq)) {
    prioritize(ordered[i], 0); prioritize(ordered[i - 1], 3); prioritize(ordered[i + 1], 3);
  }
  const bot = ordered.findLastIndex(row => row.direction === 'out');
  if (bot >= 0) { prioritize(ordered[bot], 1); prioritize(ordered[bot - 1], 3); prioritize(ordered[bot + 1], 3); }
  ordered.filter(row => row.seq < batch[0]!.seq).slice(-3).forEach(row => prioritize(row, 2));
  ordered.slice(-2).forEach(row => prioritize(row, 2));
  const ranked = ordered.filter(row => !inline.has(row.seq)).sort((a, b) => (priorities.get(a.seq) ?? 4) - (priorities.get(b.seq) ?? 4) || b.seq - a.seq);
  let selected: ProactiveReference[] = [];
  const fits = (items: ProactiveReference[]) => textTokens(JSON.stringify(items)) <= proactiveHistoryBudget && options.fits(items);
  for (const row of ranked) {
    if (selected.length >= options.limit) break;
    const raw = row.text + (row.direction === 'in' ? options.imageContext(row.message) : '');
    const rank = priorities.get(row.seq) ?? 4, rowBudget = rank === 0 ? 900 : rank <= 2 ? 500 : 300;
    const item = (length: number): ProactiveReference => ({ seq: row.seq, speaker: row.direction === 'out' ? 'bot' : 'human',
      text: raw.slice(0, length), ...(length < raw.length ? { truncated: true as const } : {}) });
    const insert = (value: ProactiveReference) => [...selected, value].sort((a, b) => a.seq - b.seq);
    const prefix = Math.min(raw.length, 4000);
    if (prefix === raw.length && textTokens(JSON.stringify(item(raw.length))) <= rowBudget && fits(insert(item(raw.length)))) { selected = insert(item(raw.length)); continue; }
    // Incidental long history is omitted; preserve a marked fragment for an important anchor.
    if (rank >= 4) continue;
    let low = 0, high = prefix;
    while (low < high) {
      const length = Math.ceil((low + high) / 2), value = item(length);
      if (textTokens(JSON.stringify(value)) <= rowBudget && fits(insert(value))) low = length;
      else high = length - 1;
    }
    if (low > 0) selected = insert(item(low));
  }
  return { items: selected, scanned: pool.size, inlined: inline.size, tokens: textTokens(JSON.stringify(selected)) };
}
