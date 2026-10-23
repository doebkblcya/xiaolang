import { DatabaseSync } from 'node:sqlite';
import type { PushTarget } from '../contracts.js';
export interface Relationship { present?: boolean; push?: boolean; receive?: string; role?: string; selfId?: string; updated: number; times?: Record<string, number> }
/** Platform relationship facts only. Unknown is distinct from permission being granted. */
export class QQRelationships {
  private db?: DatabaseSync;
  private cache = new Map<string, Relationship>();
  constructor(private account: string, path?: string) {
    if (!path) return;
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS qq_relationships(account TEXT,scope TEXT,recipient TEXT,body TEXT NOT NULL,PRIMARY KEY(account,scope,recipient));');
    } catch { this.db?.close(); this.db = undefined; }
  }
  get(scope: PushTarget['scope'], recipient: string): Relationship | undefined {
    const key = JSON.stringify([scope, recipient]), cached = this.cache.get(key);
    if (cached) return cached;
    try { const row = this.db?.prepare('SELECT body FROM qq_relationships WHERE account=? AND scope=? AND recipient=?').get(this.account, scope, recipient); return row ? JSON.parse(String(row.body)) : undefined; } catch { return; }
  }
  set(scope: PushTarget['scope'], recipient: string, patch: Partial<Relationship>, updated = Date.now()) {
    const previous = this.get(scope, recipient);
    const state: Relationship = { ...previous, updated: Math.max(previous?.updated ?? 0, updated), times: { ...previous?.times } }, key = JSON.stringify([scope, recipient]);
    for (const [field, value] of Object.entries(patch)) if (value !== undefined && !['updated', 'times'].includes(field) && (previous?.times?.[field] ?? 0) <= updated) {
      Object.assign(state, { [field]: value }); state.times![field] = updated;
    }
    this.cache.delete(key); this.cache.set(key, state);
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
    try { this.db?.prepare('INSERT INTO qq_relationships VALUES (?,?,?,?) ON CONFLICT(account,scope,recipient) DO UPDATE SET body=excluded.body').run(this.account, scope, recipient, JSON.stringify(state)); } catch { /* Facts are still available in this process. */ }
  }
  close() { this.db?.close(); this.db = undefined; }
}
