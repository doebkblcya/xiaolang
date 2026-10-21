import type { DataCleanup } from './data-cleanup.js';
import { Failure } from './errors.js';
export const cleanup: DataCleanup = {
  prepare(db, exists) { if (exists('reminders') && db.prepare("SELECT 1 FROM reminders WHERE state IN ('queued','sending') LIMIT 1").get()) throw new Failure('data_busy'); },
  erase(db, {seqs, exists}) {
    if (exists('reminders')) for (const row of db.prepare('SELECT id,payload FROM reminders').all()) if (seqs.has(Number(JSON.parse(String(row.payload)).source))) {
      db.prepare('DELETE FROM reminder_runs WHERE reminder_id=?').run(String(row.id)); db.prepare('DELETE FROM reminders WHERE id=?').run(String(row.id));
    }
  },
};
