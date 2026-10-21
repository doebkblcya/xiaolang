import type { DataCleanup } from './data-cleanup.js';
import { Failure } from './errors.js';
export const cleanup: DataCleanup = {
  kind: 'persona', erase(db, context) {
    const { seqs, styleIds, exists } = context;
    if (context.input.kind === 'persona') {
      if (!context.exists('persona_styles')) throw new Failure('persona_not_found');
      const row = db.prepare('SELECT * FROM persona_styles WHERE id=?').get(context.input.id);
      if (!row) throw new Failure('persona_not_found');
      if (Number(JSON.parse(String(row.payload)).version) !== context.input.version) throw new Failure('persona_conflict');
      context.styleIds.add(context.input.id);
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
    if (exists('persona_suppressed')) for (const seq of seqs) db.prepare('DELETE FROM persona_suppressed WHERE seq=?').run(seq);
  },
};
