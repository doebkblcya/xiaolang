import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Log, LogItem } from './contracts.js';
import { presentLog } from './log-format.js';
import { Failure } from './errors.js';

export interface LogQuery { after?: number; before?: number; limit?: number; q?: string }
/** Owns the bounded log archive; no application service depends on successful writes. */
export class LogJournal {
  private db?: DatabaseSync;
  private seq = 0;
  private recent: LogItem[] = [];
  private pruned = 0;
  private degraded = false;
  private persistent: boolean;
  generation = randomUUID();
  constructor(path: string, private retentionDays = 7, private maxRecords = 100000, private failure: () => void = () => {}) {
    this.persistent = path !== ':memory:';
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS process_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,recorded INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS process_logs_recorded ON process_logs(recorded);
        CREATE INDEX IF NOT EXISTS process_logs_message ON process_logs(json_extract(body,'$.messageId'));
        CREATE INDEX IF NOT EXISTS process_logs_turn ON process_logs(json_extract(body,'$.turn'));`);
      this.seq = Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='process_logs'").get()?.seq ?? 0);
      this.prune();
    } catch { this.db?.close(); this.db = undefined; this.failed(); }
  }
  private failed() { if (!this.degraded) { this.degraded = true; try { this.failure(); } catch { /* isolated output */ } } }
  append(entry: Log) {
    const item = { seq: ++this.seq, entry: structuredClone(entry) };
    this.recent.push(item); if (this.recent.length > 500) this.recent.shift();
    try {
      if (!this.db) return;
      this.db.prepare('INSERT INTO process_logs(id,recorded,body) VALUES (?,?,?)').run(item.seq, Date.now(), JSON.stringify(item.entry));
      this.degraded = false;
      if (Date.now() - this.pruned > 60000) this.prune();
    } catch { this.failed(); }
  }
  private prune() {
    if (!this.db) return;
    this.db.prepare('DELETE FROM process_logs WHERE recorded<?').run(Date.now() - this.retentionDays * 86400000);
    this.db.prepare('DELETE FROM process_logs WHERE id <= (SELECT id FROM process_logs ORDER BY id DESC LIMIT 1 OFFSET ?)').run(this.maxRecords);
    this.pruned = Date.now();
  }
  invalidate() { this.recent = []; if (!this.persistent) this.db?.exec('DELETE FROM process_logs'); this.generation = randomUUID(); }
  close() { this.db?.close(); this.db = undefined; }
  query(query: LogQuery = {}) {
    const { after, before } = query, limit = query.limit ?? 200, q = query.q?.trim() ?? '';
    if ((after !== undefined && (!Number.isSafeInteger(after) || after < 0))
      || (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || (after !== undefined && before !== undefined)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || typeof q !== 'string' || q.length > 200) throw new Failure('invalid_log_query');
    const first = this.db ? Number(this.db.prepare('SELECT MIN(id) n FROM process_logs').get()?.n ?? 0) : this.recent[0]?.seq ?? 0;
    const reset = after !== undefined && (after > this.seq || (first > 0 && after > 0 && after < first - 1));
    const incremental = after !== undefined && after > 0 && !reset;
    let items: LogItem[];
    if (this.db) {
      const rows = this.db.prepare(`SELECT id,body FROM process_logs WHERE instr(lower(body),lower(?))>0 AND id${incremental ? '>' : '<'}? ORDER BY id ${incremental ? 'ASC' : 'DESC'} LIMIT ?`)
        .all(q, incremental ? after! : before ?? Number.MAX_SAFE_INTEGER, limit + 1);
      items = rows.map(row => ({ seq: Number(row.id), entry: JSON.parse(String(row.body)) as Log }));
    } else {
      items = this.recent.filter(item => JSON.stringify(item.entry).toLowerCase().includes(q.toLowerCase()) && (incremental ? item.seq > after! : item.seq < (before ?? Infinity)));
      if (!incremental) items.reverse();
    }
    const more = items.length > limit;
    items = items.slice(0, limit); if (!incremental) items.reverse();
    const cursor = incremental && more ? items.at(-1)?.seq ?? after! : this.seq;
    const oldest = items[0]?.seq;
    const older = oldest !== undefined && (this.db
      ? !!this.db.prepare('SELECT 1 FROM process_logs WHERE id<? AND instr(lower(body),lower(?))>0 LIMIT 1').get(oldest, q)
      : this.recent.some(item => item.seq < oldest && JSON.stringify(item.entry).toLowerCase().includes(q.toLowerCase())));
    return { items: items.map(item => ({ ...structuredClone(item), display: presentLog(item.entry) })), cursor, reset, generation: this.generation,
      before: older ? oldest : null, hasMore: incremental && more, persistent: !!this.db && this.persistent, degraded: this.degraded };
  }
}
