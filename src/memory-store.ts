import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import * as vec from 'sqlite-vec';
import type { MemoryConfig } from './memory-config.js';
import type { CompactionRecord } from './contracts.js';
import { Failure } from './errors.js';

export interface MemoryItem {
  id: string; content: string; kind: 'profile' | 'event'; people: string[]; sources: number[];
  importance: number; pinned: boolean; created: number; updated: number; version: number; validUntil: string | null;
}
export interface MemoryWrite {
  id?: string; content: string; kind: 'profile' | 'event'; people: string[]; sources: number[];
  importance: number; validUntil?: string | null; version?: number; pinned?: boolean;
  operation?: 'add' | 'update' | 'supersede';
}
export interface MemoryVersion { item: MemoryItem; change: 'baseline' | 'add' | 'update' | 'supersede' | 'correct'; usable: boolean }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function words(text: string): string[] {
  const clean = text.normalize('NFKC').toLowerCase();
  const tokens = [...segmenter.segment(clean)].filter(p => p.isWordLike).map(p => p.segment);
  // Bigrams let short Chinese names and phrases match even when the dictionary segments differently.
  for (const part of clean.match(/[\p{Script=Han}]+/gu) ?? []) for (let i = 0; i + 1 < part.length; i++) tokens.push(part.slice(i, i + 2));
  return [...new Set(tokens)].slice(0, 300);
}
function tokens(text: string): string { return words(text).join(' '); }
function unpack(row: Record<string, unknown>): MemoryItem {
  return { id: String(row.id), content: String(row.content), kind: row.kind as MemoryItem['kind'],
    people: JSON.parse(String(row.people)), sources: JSON.parse(String(row.sources)), importance: Number(row.importance),
    pinned: !!row.pinned, created: Number(row.created), updated: Number(row.updated), version: Number(row.version), validUntil: row.valid_until as string | null };
}
function similar(a: string, b: string): boolean {
  const x = new Set(words(a)), y = new Set(words(b));
  return a === b || (x.size > 2 && y.size > 2 && [...x].filter(w => y.has(w)).length / Math.min(x.size, y.size) > 0.8);
}
export class MemoryRepository {
  private db: DatabaseSync;
  vectorError?: string;
  constructor(path: string, private config: MemoryConfig) {
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_items(id TEXT PRIMARY KEY,content TEXT NOT NULL,kind TEXT NOT NULL,people TEXT NOT NULL,sources TEXT NOT NULL,
        importance INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,valid_until TEXT,deleted INTEGER NOT NULL DEFAULT 0,indexed INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,body);
      CREATE TABLE IF NOT EXISTS memory_suppressed(seq INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_forgotten(content TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_summaries(session TEXT PRIMARY KEY,through INTEGER NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_summary_retries(session TEXT PRIMARY KEY,stamp TEXT NOT NULL,attempts INTEGER NOT NULL,retry_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_compactions(id TEXT PRIMARY KEY,session TEXT NOT NULL,turn TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_compactions_session ON memory_compactions(session,created);
      CREATE TABLE IF NOT EXISTS memory_recalls(turn TEXT PRIMARY KEY,payload TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_images(hash TEXT PRIMARY KEY,caption TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_image_failures(url_hash TEXT PRIMARY KEY,image_hash TEXT NOT NULL,attempts INTEGER NOT NULL,error TEXT NOT NULL,retry_at INTEGER);
      CREATE TABLE IF NOT EXISTS memory_versions(memory_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,change TEXT NOT NULL,usable INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(memory_id,version));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_version_fts USING fts5(id UNINDEXED,version UNINDEXED,body);
    `);
    this.db.prepare("UPDATE memory_compactions SET state='interrupted',updated=? WHERE state='running'").run(Date.now());
    if (this.meta('image_cache_version') !== '2') this.transaction(() => {
      // Legacy keys discarded the fileid query parameter, so even apparently valid captions cannot be reused.
      this.db.exec('DELETE FROM memory_images; DELETE FROM memory_summaries; DELETE FROM memory_recalls;');
      this.meta('image_cache_version', '2');
    });
    if (this.meta('history_initialized') !== '1') this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM memory_items WHERE deleted=0').all()) this.saveVersion(unpack(row), 'baseline');
      this.meta('history_initialized', '1');
    });
    try {
      vec.load(this.db);
      const fingerprint = createHash('sha256').update(JSON.stringify([config.embeddingBaseUrl, config.embeddingModel, config.embeddingDimensions])).digest('hex');
      if (this.meta('embedding_fingerprint') !== fingerprint) {
        this.db.exec('DROP TABLE IF EXISTS memory_vec; UPDATE memory_items SET indexed=0');
        this.meta('embedding_fingerprint', fingerprint);
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(id TEXT PRIMARY KEY,embedding float[${config.embeddingDimensions}] distance_metric=cosine)`);
    } catch { this.vectorError = 'vector_extension_unavailable'; }
  }
  close(): void { this.db.close(); }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key: string, value?: string): string {
    if (value !== undefined) this.db.prepare('INSERT INTO memory_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    return String(this.db.prepare('SELECT value FROM memory_meta WHERE key=?').get(key)?.value ?? '');
  }
  suppressed(seq: number): boolean { return !!this.db.prepare('SELECT 1 FROM memory_suppressed WHERE seq=?').get(seq); }
  get(id: string): MemoryItem | undefined {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id=? AND deleted=0').get(id);
    return row ? unpack(row) : undefined;
  }
  private saveVersion(item: MemoryItem, change: MemoryVersion['change']): void {
    const added = this.db.prepare('INSERT OR IGNORE INTO memory_versions(memory_id,version,payload,change) VALUES (?,?,?,?)')
      .run(item.id, item.version, JSON.stringify(item), change);
    if (added.changes) this.db.prepare('INSERT INTO memory_version_fts(id,version,body) VALUES (?,?,?)')
      .run(item.id, item.version, tokens(item.content + ' ' + item.people.join(' ')));
  }
  versions(id: string, before = Number.MAX_SAFE_INTEGER, limit = 10, includeInvalid = false): MemoryVersion[] {
    if (!this.get(id)) return [];
    return this.db.prepare(`SELECT payload,change,usable FROM memory_versions WHERE memory_id=? AND version<? ${includeInvalid ? '' : 'AND usable=1'} ORDER BY version DESC LIMIT ?`)
      .all(id, before, limit).map(row => ({ item: JSON.parse(String(row.payload)) as MemoryItem, change: row.change as MemoryVersion['change'], usable: !!row.usable }));
  }
  searchHistory(query: string, limit = 5): MemoryVersion[] {
    const search = words(query).slice(0, 40).map(w => `"${w.replaceAll('"', '""')}"`).join(' OR ');
    if (!search) return [];
    return this.db.prepare(`SELECT v.payload,v.change,v.usable FROM memory_version_fts f
      JOIN memory_versions v ON v.memory_id=f.id AND v.version=f.version JOIN memory_items m ON m.id=v.memory_id
      WHERE memory_version_fts MATCH ? AND v.usable=1 AND m.deleted=0 AND v.version<m.version ORDER BY bm25(memory_version_fts) LIMIT ?`)
      .all(search, limit).map(row => ({ item: JSON.parse(String(row.payload)) as MemoryItem, change: row.change as MemoryVersion['change'], usable: true }));
  }
  list(query = '', kind = '', before = Number.MAX_SAFE_INTEGER, limit = 40): MemoryItem[] {
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE deleted=0 AND updated<? AND (?='' OR kind=?)
      AND (?='' OR instr(lower(content),lower(?))>0 OR instr(people,?)>0) ORDER BY updated DESC,id LIMIT ?`)
      .all(before, kind, kind, query, query, query, limit);
    return rows.map(unpack);
  }
  lexical(query: string, limit = 30): MemoryItem[] {
    const search = words(query).slice(0, 40).map(w => `"${w.replaceAll('"', '""')}"`).join(' OR ');
    if (!search) return [];
    return this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id=f.id WHERE memory_fts MATCH ? AND m.deleted=0 ORDER BY bm25(memory_fts) LIMIT ?`).all(search, limit).map(unpack);
  }
  semantic(vector: number[], limit = 30): MemoryItem[] {
    if (this.vectorError) return [];
    const rows = this.db.prepare('SELECT id,distance FROM memory_vec WHERE embedding MATCH ? AND k=? ORDER BY distance').all(new Uint8Array(new Float32Array(vector).buffer), limit);
    return rows.filter(row => Number(row.distance) < 0.85).flatMap(row => this.get(String(row.id)) ?? []);
  }
  candidates(query: string, people: string[], vector?: number[]): MemoryItem[] {
    const lexical = this.lexical(query), semantic = vector ? this.semantic(vector) : [];
    const profiles = this.db.prepare(`SELECT * FROM memory_items WHERE deleted=0 AND kind='profile' AND
      (pinned=1 OR EXISTS(SELECT 1 FROM json_each(memory_items.people) p JOIN json_each(?) wanted ON p.value=wanted.value))
      ORDER BY pinned DESC,importance DESC LIMIT 15`).all(JSON.stringify([...new Set(people)])).map(unpack);
    const pinned = this.db.prepare('SELECT * FROM memory_items WHERE deleted=0 AND pinned=1 ORDER BY importance DESC LIMIT 10').all().map(unpack);
    const scores = new Map<string, { item: MemoryItem; score: number }>();
    for (const [weight, items] of [[1, lexical], [1, semantic], [0.45, profiles], [0.6, pinned]] as const) items.forEach((item, i) => {
      if (item.validUntil && Date.parse(item.validUntil) < Date.now()) return;
      const age = Math.max(0, (Date.now() - item.updated) / 86400000);
      const decay = item.pinned || item.importance >= 4 ? 1 : 1 / (1 + age / 90);
      const bonus = 1 + item.importance * 0.06 + (item.people.some(p => people.includes(p)) ? 0.15 : 0);
      const old = scores.get(item.id);
      scores.set(item.id, { item, score: (old?.score ?? 0) + weight / (60 + i + 1) * bonus * decay });
    });
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, this.config.recallLimit).map(x => x.item);
  }
  write(input: MemoryWrite, manual = false): MemoryItem | undefined {
    if (!manual && (input.sources.some(seq => this.suppressed(seq)) || this.db.prepare('SELECT content FROM memory_forgotten').all().some(row => similar(input.content, String(row.content))))) return;
    const old = input.id ? this.get(input.id) : undefined;
    if (input.id && !old) throw new Failure('memory_not_found');
    if (old && input.version !== old.version) throw new Failure('memory_conflict');
    if (!manual && input.operation && (input.operation === 'add' ? !!old : !old)) throw new Failure('memory_invalid_operation');
    if (!manual && old && (old.kind !== input.kind || JSON.stringify([...old.people].sort()) !== JSON.stringify([...input.people].sort()))) throw new Failure('memory_subject_mismatch');
    const duplicate = !old ? this.db.prepare('SELECT * FROM memory_items WHERE deleted=0 AND content=? AND people=?').get(input.content, JSON.stringify([...input.people].sort())) : undefined;
    if (duplicate) return unpack(duplicate);
    const id = old?.id ?? randomUUID(), now = Date.now();
    const change = old ? manual ? 'correct' : input.operation ?? 'update' : 'add';
    if (old) this.saveVersion(old, 'baseline');
    this.db.prepare(`INSERT INTO memory_items(id,content,kind,people,sources,importance,pinned,created,updated,valid_until) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content,kind=excluded.kind,people=excluded.people,sources=excluded.sources,
      importance=excluded.importance,pinned=excluded.pinned,updated=excluded.updated,valid_until=excluded.valid_until,version=memory_items.version+1,indexed=0`)
      .run(id, input.content, input.kind, JSON.stringify([...input.people].sort()), JSON.stringify([...new Set([...(change === 'supersede' ? [] : old?.sources ?? []), ...input.sources])]), input.importance,
        input.pinned === undefined ? (old?.pinned ? 1 : 0) : input.pinned ? 1 : 0, old?.created ?? now, now, input.validUntil ?? null);
    this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    this.db.prepare('INSERT INTO memory_fts(id,body) VALUES (?,?)').run(id, tokens(input.content + ' ' + input.people.join(' ')));
    if (!this.vectorError) this.db.prepare('DELETE FROM memory_vec WHERE id=?').run(id);
    const result = this.get(id)!;
    this.saveVersion(result, change);
    return result;
  }
  protect(item: MemoryItem): void {
    for (const previous of [item, ...this.versions(item.id, undefined, Number.MAX_SAFE_INTEGER, true).map(entry => entry.item)]) {
      this.db.prepare('INSERT OR IGNORE INTO memory_forgotten VALUES (?)').run(previous.content);
      previous.sources.forEach(seq => this.db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES (?)').run(seq));
    }
    this.db.prepare('UPDATE memory_versions SET usable=0 WHERE memory_id=?').run(item.id);
    this.db.prepare('DELETE FROM memory_version_fts WHERE id=?').run(item.id);
    // Summaries can contain the old fact without naming its memory ID. Invalidate them together.
    this.db.exec('DELETE FROM memory_summaries; DELETE FROM memory_recalls');
  }
  remove(id: string, version: number): void {
    const item = this.get(id);
    if (!item) throw new Failure('memory_not_found');
    if (item.version !== version) throw new Failure('memory_conflict');
    const previous = [item, ...this.versions(id, undefined, Number.MAX_SAFE_INTEGER, true).map(entry => entry.item)];
    for (const version of previous) {
      for (const seq of version.sources) this.db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES (?)').run(seq);
      this.db.prepare('DELETE FROM memory_forgotten WHERE content=?').run(version.content);
    }
    this.db.exec("PRAGMA secure_delete=ON; INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1); INSERT INTO memory_version_fts(memory_version_fts,rank) VALUES('secure-delete',1); DELETE FROM memory_summaries; DELETE FROM memory_recalls");
    this.db.prepare('DELETE FROM memory_items WHERE id=?').run(id);
    this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    this.db.prepare('DELETE FROM memory_versions WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM memory_version_fts WHERE id=?').run(id);
    if (!this.vectorError) this.db.prepare('DELETE FROM memory_vec WHERE id=?').run(id);
  }
  pending(limit = 10): MemoryItem[] { return this.db.prepare('SELECT * FROM memory_items WHERE deleted=0 AND indexed=0 ORDER BY updated LIMIT ?').all(limit).map(unpack); }
  index(item: MemoryItem, vector: number[]): void {
    if (this.vectorError || this.get(item.id)?.version !== item.version) return;
    this.transaction(() => {
      this.db.prepare('DELETE FROM memory_vec WHERE id=?').run(item.id);
      this.db.prepare('INSERT INTO memory_vec(id,embedding) VALUES (?,?)').run(item.id, new Uint8Array(new Float32Array(vector).buffer));
      this.db.prepare('UPDATE memory_items SET indexed=1 WHERE id=?').run(item.id);
    });
  }
  reindex(): void { this.db.exec('UPDATE memory_items SET indexed=0'); }
  summary(session: string): { through: number; body: string; updated: number } | undefined {
    const row = this.db.prepare('SELECT through,body,updated FROM memory_summaries WHERE session=?').get(session);
    return row ? { through: Number(row.through), body: String(row.body), updated: Number(row.updated) } : undefined;
  }
  setSummary(session: string, through: number, body: string): void {
    this.db.prepare('INSERT INTO memory_summaries VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET through=excluded.through,body=excluded.body,updated=excluded.updated').run(session, through, body, Date.now());
    this.db.prepare('DELETE FROM memory_summary_retries WHERE session=?').run(session);
  }
  startCompaction(session: string, record: CompactionRecord): void {
    this.db.prepare('INSERT INTO memory_compactions VALUES (?,?,?,?,?,?,?)').run(record.id, session, record.turn, record.state, record.created, record.updated, JSON.stringify(record));
    this.db.exec('DELETE FROM memory_compactions WHERE id IN (SELECT id FROM memory_compactions ORDER BY created DESC LIMIT -1 OFFSET 1000)');
  }
  finishCompaction(id: string, update: Partial<CompactionRecord>): void {
    const old = this.compaction(id); if (!old) return;
    const record = { ...old, ...update, updated: Date.now() };
    this.db.prepare('UPDATE memory_compactions SET state=?,updated=?,payload=? WHERE id=?').run(record.state, record.updated, JSON.stringify(record), id);
  }
  compaction(id: string): CompactionRecord | undefined {
    const row = this.db.prepare('SELECT payload,state,updated FROM memory_compactions WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.payload)), state: String(row.state), updated: Number(row.updated) } : undefined;
  }
  compactions(session: string): CompactionRecord[] {
    return this.db.prepare('SELECT id FROM memory_compactions WHERE session=? ORDER BY created DESC,id DESC LIMIT 10').all(session).map(row => this.compaction(String(row.id))!);
  }
  summaryRetry(session: string, stamp: string): { attempts: number; retryAt: number } | undefined {
    const row = this.db.prepare('SELECT attempts,retry_at FROM memory_summary_retries WHERE session=? AND stamp=?').get(session, stamp);
    return row ? { attempts: Number(row.attempts), retryAt: Number(row.retry_at) } : undefined;
  }
  deferSummary(session: string, stamp: string, attempts: number, retryAt: number): void {
    this.db.prepare('INSERT INTO memory_summary_retries VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET stamp=excluded.stamp,attempts=excluded.attempts,retry_at=excluded.retry_at')
      .run(session, stamp, attempts, retryAt);
  }
  image(hash: string, caption?: string): string | undefined {
    if (caption !== undefined) this.db.prepare('INSERT INTO memory_images VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET caption=excluded.caption,updated=excluded.updated').run(hash, caption, Date.now());
    return this.db.prepare('SELECT caption FROM memory_images WHERE hash=?').get(hash)?.caption as string | undefined;
  }
  imageFailure(urlHash: string): { attempts: number; error: string; retryAt: number | null } | undefined {
    const row = this.db.prepare('SELECT attempts,error,retry_at FROM memory_image_failures WHERE url_hash=?').get(urlHash);
    return row ? { attempts: Number(row.attempts), error: String(row.error), retryAt: row.retry_at === null ? null : Number(row.retry_at) } : undefined;
  }
  failImage(urlHash: string, imageHash: string, attempts: number, error: string, retryAt: number | null): void {
    this.db.prepare('INSERT INTO memory_image_failures VALUES (?,?,?,?,?) ON CONFLICT(url_hash) DO UPDATE SET attempts=excluded.attempts,error=excluded.error,retry_at=excluded.retry_at')
      .run(urlHash, imageHash, attempts, error, retryAt);
  }
  clearImageFailure(urlHash: string): void { this.db.prepare('DELETE FROM memory_image_failures WHERE url_hash=?').run(urlHash); }
  recall(turn: string, payload?: unknown): unknown {
    if (payload !== undefined) {
      this.db.prepare('INSERT OR REPLACE INTO memory_recalls VALUES (?,?,?)').run(turn, JSON.stringify(payload), Date.now());
      this.db.exec('DELETE FROM memory_recalls WHERE turn IN (SELECT turn FROM memory_recalls ORDER BY created DESC LIMIT -1 OFFSET 500)');
    }
    const row = this.db.prepare('SELECT payload FROM memory_recalls WHERE turn=?').get(turn);
    return row ? JSON.parse(String(row.payload)) as unknown : undefined;
  }
  counts(): Record<string, number> {
    return { total: Number(this.db.prepare('SELECT count(*) AS n FROM memory_items WHERE deleted=0').get()!.n),
      indexed: Number(this.db.prepare('SELECT count(*) AS n FROM memory_items WHERE deleted=0 AND indexed=1').get()!.n),
      summaries: Number(this.db.prepare('SELECT count(*) AS n FROM memory_summaries').get()!.n) };
  }
}
