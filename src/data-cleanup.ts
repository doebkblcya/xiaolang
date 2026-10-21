import type { DatabaseSync } from 'node:sqlite';
/** Hooks run in the host deletion transaction, including those of disabled plugins. */
export interface DataCleanup {
  kind?: string;
  prepare?(db: DatabaseSync, exists: (table: string) => boolean): void;
  erase(db: DatabaseSync, context: {
    input: { kind: string; id: string; version?: number };
    seqs: Set<number>; memoryIds: Set<string>; styleIds: Set<string>;
    exists: (table: string) => boolean;
  }): void;
}
