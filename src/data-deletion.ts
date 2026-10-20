import type { DatabaseSync } from 'node:sqlite';
import * as vec from 'sqlite-vec';
import { object } from './contracts.js';
import { Failure } from './errors.js';
import { imageKey } from './image-identity.js';

/** Delete stored content and its derived records in one transaction; never retain content as a tombstone. */
export function deleteData(db: DatabaseSync, raw: unknown) {
  const input = object(raw), kind = input?.kind;
  if (!input || !['conversation', 'message', 'memory', 'persona'].includes(String(kind))
    || Object.keys(input).some(k => !['kind', 'id', 'seq', 'version'].includes(k))
    || typeof input.id !== 'string' || !(kind === 'conversation' || kind === 'message' ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/).test(input.id)
    || (kind === 'message' && (!Number.isSafeInteger(input.seq) || Number(input.seq) < 1))
    || ((kind === 'memory' || kind === 'persona') && (!Number.isSafeInteger(input.version) || Number(input.version) < 1))) throw new Failure('invalid_delete_request');
  const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);
  // No reply or side-effecting task may still be using data about to be erased.
  if (db.prepare("SELECT 1 FROM turns WHERE state IN ('queued','running','sending') LIMIT 1").get()
    || (exists('reminders') && db.prepare("SELECT 1 FROM reminders WHERE state IN ('queued','sending') LIMIT 1").get())) throw new Failure('data_busy');
  if (exists('memory_vec')) vec.load(db);
  db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  const seqs = new Set<number>(), memoryIds = new Set<string>(), styleIds = new Set<string>();
  let messages = 0;
  try {
    if (kind === 'message' || kind === 'conversation') {
      const session = db.prepare('SELECT session FROM chat_sessions WHERE id=?').get(input.id);
      if (!session) throw new Failure('conversation_not_found');
      const rows = db.prepare('SELECT seq,key,source_seq,payload FROM messages WHERE session=?' + (kind === 'message' ? ' AND seq=?' : '')).all(...(kind === 'message' ? [String(session.session), Number(input.seq)] : [String(session.session)]));
      if (!rows.length) throw new Failure('message_not_found');
      for (const row of rows) seqs.add(Number(row.seq));
      // Erasing an incoming message also erases the bot reply derived from that message.
      for (const row of db.prepare('SELECT seq,source_seq FROM messages WHERE session=?').all(String(session.session))) if (seqs.has(Number(row.source_seq))) seqs.add(Number(row.seq));
    } else {
      const table = kind === 'memory' ? 'memory_items' : 'persona_styles';
      if (!exists(table)) throw new Failure(kind + '_not_found');
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(input.id);
      if (!row) throw new Failure(kind + '_not_found');
      const version = kind === 'memory' ? Number(row.version) : Number(JSON.parse(String(row.payload)).version);
      if (version !== input.version) throw new Failure(kind + '_conflict');
      (kind === 'memory' ? memoryIds : styleIds).add(input.id);
    }
    if (exists('memory_items')) {
      db.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1); INSERT INTO memory_version_fts(memory_version_fts,rank) VALUES('secure-delete',1)");
      for (const row of db.prepare('SELECT id,sources FROM memory_items').all()) {
        if ((JSON.parse(String(row.sources)) as number[]).some(seq => seqs.has(seq))) memoryIds.add(String(row.id));
      }
      for (const row of db.prepare('SELECT memory_id,payload FROM memory_versions').all()) {
        if ((JSON.parse(String(row.payload)).sources as number[]).some(seq => seqs.has(seq))) memoryIds.add(String(row.memory_id));
      }
      for (const id of memoryIds) {
        const item = db.prepare('SELECT content,sources FROM memory_items WHERE id=?').get(id);
        const versions = db.prepare('SELECT payload FROM memory_versions WHERE memory_id=?').all(id).map(row => JSON.parse(String(row.payload)));
        const origins = [...(item ? JSON.parse(String(item.sources)) as number[] : []), ...versions.flatMap(v => v.sources as number[])];
        // Keep only source sequence numbers, preventing extraction from recreating a manually erased memory.
        for (const seq of origins) if (!seqs.has(seq)) db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES (?)').run(seq);
        for (const content of [item?.content, ...versions.map(v => v.content)]) if (typeof content === 'string') db.prepare('DELETE FROM memory_forgotten WHERE content=?').run(content);
        db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
        db.prepare('DELETE FROM memory_version_fts WHERE id=?').run(id);
        db.prepare('DELETE FROM memory_versions WHERE memory_id=?').run(id);
        if (exists('memory_vec')) db.prepare('DELETE FROM memory_vec WHERE id=?').run(id);
        db.prepare('DELETE FROM memory_items WHERE id=?').run(id);
      }
      db.exec('DELETE FROM memory_summaries; DELETE FROM memory_recalls');
      db.prepare("INSERT INTO memory_meta VALUES ('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
    }
    if (exists('persona_styles')) {
      db.exec('CREATE TABLE IF NOT EXISTS persona_suppressed(seq INTEGER PRIMARY KEY)');
      const related = (value: { examples: { prompt: number; reply: number }[] }) => value.examples.some(pair => seqs.has(pair.prompt) || seqs.has(pair.reply));
      for (const row of db.prepare('SELECT id,payload FROM persona_styles').all()) if (related(JSON.parse(String(row.payload)))) styleIds.add(String(row.id));
      for (const row of db.prepare('SELECT id,payload FROM persona_versions').all()) if (related(JSON.parse(String(row.payload)))) styleIds.add(String(row.id));
      for (const id of styleIds) {
        for (const row of db.prepare('SELECT payload FROM persona_versions WHERE id=? UNION SELECT payload FROM persona_styles WHERE id=?').all(id,id)) {
          for (const pair of JSON.parse(String(row.payload)).examples as { prompt: number; reply: number }[]) for (const seq of [pair.prompt,pair.reply]) {
            if (!seqs.has(seq)) db.prepare('INSERT OR IGNORE INTO persona_suppressed VALUES (?)').run(seq);
          }
        }
        db.prepare('DELETE FROM persona_versions WHERE id=?').run(id); db.prepare('DELETE FROM persona_styles WHERE id=?').run(id);
      }
      const row = db.prepare("SELECT payload FROM persona_state WHERE key='learning'").get();
      if (row) { const state = JSON.parse(String(row.payload)); state.revision++; db.prepare("UPDATE persona_state SET payload=? WHERE key='learning'").run(JSON.stringify(state)); }
    }
    const turns = new Set<string>();
    for (const seq of seqs) {
      const row = db.prepare('SELECT key,payload,direction FROM messages WHERE seq=?').get(seq);
      if (!row) continue;
      if (row.direction === 'in') db.prepare('INSERT OR IGNORE INTO message_tombstones VALUES (?)').run(String(row.key));
      const turn = db.prepare("SELECT id FROM turns WHERE message_key=? OR 'reply:'||id=?").get(String(row.key),String(row.key));
      if (turn) turns.add(String(turn.id));
      const payload = JSON.parse(String(row.payload));
      if (exists('memory_images')) for (const image of payload.segments ?? []) if (image.type === 'image') {
        const hash = imageKey(image.url);
        db.prepare('DELETE FROM memory_images WHERE hash=?').run(hash);
        if (exists('memory_image_failures')) db.prepare('DELETE FROM memory_image_failures WHERE image_hash=?').run(hash);
      }
      db.prepare('DELETE FROM messages WHERE seq=?').run(seq); messages++;
      if (exists('memory_suppressed')) db.prepare('DELETE FROM memory_suppressed WHERE seq=?').run(seq);
      if (exists('persona_suppressed')) db.prepare('DELETE FROM persona_suppressed WHERE seq=?').run(seq);
    }
    for (const turn of turns) {
      db.prepare('DELETE FROM tools WHERE turn_id=?').run(turn); db.prepare('DELETE FROM sends WHERE turn_id=?').run(turn); db.prepare('DELETE FROM turns WHERE id=?').run(turn);
    }
    if (exists('reminders')) for (const row of db.prepare('SELECT id,payload FROM reminders').all()) if (seqs.has(Number(JSON.parse(String(row.payload)).source))) {
      db.prepare('DELETE FROM reminder_runs WHERE reminder_id=?').run(String(row.id)); db.prepare('DELETE FROM reminders WHERE id=?').run(String(row.id));
    }
    db.exec('DELETE FROM chat_sessions WHERE session NOT IN (SELECT DISTINCT session FROM messages); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Secure-delete overwrites freed table pages; truncate the WAL after committing the removal.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { ok: true, messages, memories: memoryIds.size, styles: styleIds.size };
}
