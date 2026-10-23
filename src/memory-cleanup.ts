import type { DataCleanup } from './data-cleanup.js';
import { Failure } from './errors.js';
import * as vec from 'sqlite-vec';
import { imageKey } from './image-identity.js';
import { imageSegments } from './messages.js';
export const cleanup: DataCleanup = {
  kind: 'memory', prepare(db, exists) { if (exists('memory_vec')) vec.load(db); },
  erase(db, context) {
    const { seqs, memoryIds, exists } = context;
    if (context.input.kind === 'memory') {
      if (!context.exists('memory_items')) throw new Failure('memory_not_found');
      const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(context.input.id);
      if (!row) throw new Failure('memory_not_found');
      if (Number(row.version) !== context.input.version) throw new Failure('memory_conflict');
      context.memoryIds.add(context.input.id);
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
      if (exists('memory_summary_retries')) db.exec('DELETE FROM memory_summary_retries');
      db.prepare("INSERT INTO memory_meta VALUES ('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
    }
    for (const seq of seqs) {
      const row = db.prepare('SELECT payload FROM messages WHERE seq=?').get(seq);
      const payload = row ? JSON.parse(String(row.payload)) : {};
      if (exists('memory_images')) for (const image of imageSegments(payload.segments ?? [])) {
        const hash = imageKey(image.url);
        db.prepare('DELETE FROM memory_images WHERE hash=?').run(hash);
        if (exists('memory_image_failures')) db.prepare('DELETE FROM memory_image_failures WHERE image_hash=?').run(hash);
      }
      if (exists('memory_suppressed')) db.prepare('DELETE FROM memory_suppressed WHERE seq=?').run(seq);
    }
  },
};
