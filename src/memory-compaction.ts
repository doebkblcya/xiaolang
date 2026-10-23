import type { ChatRecord, ModelMessage } from './contracts.js';

/** Prefix boundaries never separate a stored reply from its source message. */
export function compactionBoundaries(rows: ChatRecord[]): number[] {
  const suffix = new Array<number>(rows.length + 1); suffix[rows.length] = Infinity;
  for (let i = rows.length - 1; i >= 0; i--) suffix[i] = Math.min(suffix[i + 1]!, rows[i]!.direction === 'out' ? rows[i]!.message.seq : rows[i]!.seq);
  return rows.flatMap((row, i) => suffix[i + 1]! > row.seq ? [i + 1] : []);
}
export function compactionCut(rows: ChatRecord[], history: ModelMessage[], keep: number, target: number, measure: (value: unknown) => number, fence = Infinity): number {
  const boundaries = compactionBoundaries(rows).filter(cut => rows[cut - 1]!.seq < fence), minimum = Math.max(1, rows.length - keep);
  let lo = 0, hi = boundaries.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2), cut = boundaries[mid]!;
    if (cut < minimum || measure(history.slice(cut)) > target) lo = mid + 1; else hi = mid;
  }
  return boundaries[lo] ?? 0;
}
