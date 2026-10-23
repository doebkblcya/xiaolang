import type { DatabaseSync } from 'node:sqlite';
import { object } from './contracts.js';
import { Failure } from './errors.js';
import { messageKey } from './messages.js';
import type { Message, Segment } from './contracts.js';
import type { DataCleanup } from './data-cleanup.js';

/** Delete stored content and its derived records in one transaction; never retain content as a tombstone. */
export function deleteData(db: DatabaseSync, raw: unknown, cleanups: Iterable<DataCleanup> = []) {
  const input = object(raw), kind = input?.kind;
  if (!input || !['conversation', 'message', 'memory', 'persona'].includes(String(kind))
    || Object.keys(input).some(k => !['kind', 'id', 'seq', 'version'].includes(k))
    || typeof input.id !== 'string' || !(kind === 'conversation' || kind === 'message' ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/).test(input.id)
    || (kind === 'message' && (!Number.isSafeInteger(input.seq) || Number(input.seq) < 1))
    || ((kind === 'memory' || kind === 'persona') && (!Number.isSafeInteger(input.version) || Number(input.version) < 1))) throw new Failure('invalid_delete_request');
  const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);
  // No reply or side-effecting task may still be using data about to be erased.
  if (db.prepare("SELECT 1 FROM turns WHERE state IN ('queued','running','sending') LIMIT 1").get()) throw new Failure('data_busy');
  const hooks = [...cleanups];
  for (const hook of hooks) hook.prepare?.(db, exists);
  if ((kind === 'memory' || kind === 'persona') && !hooks.some(hook => hook.kind === kind)) throw new Failure(kind + '_not_found');
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
    }
    for (const hook of hooks) hook.erase(db, { input: input as { kind: string; id: string; version?: number }, seqs, memoryIds, styleIds, exists });
    // Remove copied quote content too; retain only hashes to prevent a later push restoring it.
    const refs = new Map<string, Set<string>>();
    for (const seq of seqs) {
      const row = db.prepare('SELECT session,direction,payload,key FROM messages WHERE seq=?').get(seq); if (!row) continue;
      const payload = JSON.parse(String(row.payload)), session = String(row.session), keys = refs.get(session) ?? new Set<string>();
      if (row.direction === 'in') { if (payload.id) keys.add(payload.id); if (payload.metadata?.index) keys.add(payload.metadata.index); }
      else {
        if (payload.reference) keys.add(payload.reference);
        for (const receipt of payload.platformIds ?? []) keys.add(receipt);
        if (exists('sends') && db.prepare('PRAGMA table_info(sends)').all().some(column => column.name === 'reference')) {
          for (const send of db.prepare("SELECT s.reference FROM sends s WHERE 'reply:'||s.turn_id=?").all(String(row.key))) if (send.reference) keys.add(String(send.reference));
        }
      }
      refs.set(session, keys);
    }
    for (const [session, keys] of refs) {
      for (const key of keys) db.prepare('INSERT OR IGNORE INTO message_tombstones VALUES (?)').run(messageKey(session, key));
      const strip = (parts: Segment[]): Segment[] => parts.map(part => part.type === 'reply'
        ? keys.has(part.messageId) || part.seq && seqs.has(part.seq) ? { type: 'reply', messageId: part.messageId, unavailable: true }
          : { ...part, segments: part.segments ? strip(part.segments) : undefined }
        : part.type === 'bundle' ? { ...part, items: part.items.map(item => ({ ...item, segments: strip(item.segments) })) } : part);
      for (const row of db.prepare("SELECT seq,payload FROM messages WHERE session=? AND direction='in'").all(session)) if (!seqs.has(Number(row.seq))) {
        const payload = JSON.parse(String(row.payload)) as Message; payload.segments = strip(payload.segments);
        db.prepare('UPDATE messages SET payload=? WHERE seq=?').run(JSON.stringify(payload), Number(row.seq));
      }
    }
    const turns = new Set<string>();
    for (const seq of seqs) {
      const row = db.prepare('SELECT key,payload,direction FROM messages WHERE seq=?').get(seq);
      if (!row) continue;
      if (row.direction === 'in') db.prepare('INSERT OR IGNORE INTO message_tombstones VALUES (?)').run(String(row.key));
      const turn = db.prepare("SELECT id FROM turns WHERE message_key=? OR 'reply:'||id=?").get(String(row.key),String(row.key));
      if (turn) turns.add(String(turn.id));
      db.prepare('DELETE FROM messages WHERE seq=?').run(seq); messages++;
    }
    for (const turn of turns) {
      db.prepare('DELETE FROM tools WHERE turn_id=?').run(turn); db.prepare('DELETE FROM sends WHERE turn_id=?').run(turn); db.prepare('DELETE FROM turns WHERE id=?').run(turn);
    }
    db.exec('DELETE FROM chat_sessions WHERE session NOT IN (SELECT DISTINCT session FROM messages); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Secure-delete overwrites freed table pages; truncate the WAL after committing the removal.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { ok: true, messages, memories: memoryIds.size, styles: styleIds.size };
}
