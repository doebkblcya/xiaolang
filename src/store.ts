import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryReader, Message, ModelMessage, SendRecord, Store, ToolCall, Turn, TurnDetail, TurnState, TurnView } from './contracts.js';
import { render } from './messages.js';
import { Failure } from './errors.js';

export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get()!;
    if (Number(version.user_version) > 1) { this.db.close(); throw new Failure('unsupported_database_version'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
        session TEXT NOT NULL, direction TEXT NOT NULL, source_seq INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session, seq);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, message_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
        reason TEXT NOT NULL, code TEXT, draft TEXT, protocol TEXT, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sends (
        turn_id TEXT NOT NULL REFERENCES turns(id), part INTEGER NOT NULL,
        text TEXT NOT NULL, state TEXT NOT NULL, platform_id TEXT,
        PRIMARY KEY(turn_id, part)
      );
      CREATE TABLE IF NOT EXISTS tools (
        turn_id TEXT NOT NULL REFERENCES turns(id), call_id TEXT NOT NULL,
        name TEXT NOT NULL, arguments TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
        PRIMARY KEY(turn_id, call_id)
      );
      PRAGMA user_version=1;
      UPDATE sends SET state='unknown' WHERE state='sending';
      UPDATE tools SET state='unknown' WHERE state='running';
      UPDATE turns SET state=CASE WHEN state='sending' OR EXISTS
        (SELECT 1 FROM tools WHERE tools.turn_id=turns.id AND tools.state='unknown') THEN 'unknown' ELSE 'cancelled' END,
        code='process_interrupted' WHERE state IN ('queued','running','sending');
    `);
  }
  close(): void { this.db.close(); }
  records(query: { after?: number; before?: number; fence?: number; session?: string; limit: number; incoming?: boolean }) {
    const rows = this.db.prepare(`SELECT seq,direction,session,payload,source_seq FROM messages WHERE seq>? AND seq<?
      AND (? IS NULL OR (direction='in' AND seq<?) OR (direction='out' AND source_seq<?))
      AND (? IS NULL OR session=?) AND (?=0 OR direction='in') ORDER BY seq ${query.after !== undefined ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(query.after ?? 0, query.before ?? Number.MAX_SAFE_INTEGER, query.fence ?? null, query.fence ?? null, query.fence ?? null,
        query.session ?? null, query.session ?? null, query.incoming ? 1 : 0, Math.min(500, Math.max(1, query.limit)));
    return (query.after !== undefined ? rows : rows.reverse()).flatMap(row => {
      const source = row.direction === 'in' ? row : this.db.prepare('SELECT payload FROM messages WHERE seq=?').get(Number(row.source_seq));
      if (!source) return [];
      const message = JSON.parse(String(source.payload)) as Message;
      if (row.direction === 'out') {
        const sentAt = (JSON.parse(String(row.payload)) as { sentAt?: number }).sentAt;
        if (typeof sentAt === 'number') message.time = sentAt;
      }
      message.seq = row.direction === 'in' ? Number(row.seq) : Number(row.source_seq);
      return [{ seq: Number(row.seq), direction: row.direction as 'in' | 'out', session: String(row.session), message,
        text: row.direction === 'in' ? render(message) : String((JSON.parse(String(row.payload)) as { text: string }).text) }];
    });
  }
  record(seq: number) { return this.records({ after: seq - 1, before: seq + 1, limit: 1 })[0]; }
  admit(message: Message): Message | undefined {
    const result = this.db.prepare('INSERT OR IGNORE INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,\'in\',0,?)')
      .run(message.key, message.session, JSON.stringify(message));
    return Number(result.changes) ? { ...message, seq: Number(result.lastInsertRowid) } : undefined;
  }
  history(message: Message, limit: number): ModelMessage[] {
    const rows = this.db.prepare(`SELECT direction,payload FROM messages
      WHERE session=? AND key!=? AND ((direction='in' AND seq<?) OR (direction='out' AND source_seq<?))
      ORDER BY seq DESC LIMIT ?`).all(message.session, message.key, message.seq, message.seq, limit);
    return rows.reverse().flatMap(row => {
      if (row.direction === 'in') return [{ role: 'user' as const, content: render(JSON.parse(String(row.payload)) as Message) }];
      const data = JSON.parse(String(row.payload)) as { protocol: ModelMessage[] };
      return data.protocol;
    });
  }
  createTurn(message: Message, reason: string): Turn {
    const id = randomUUID();
    this.db.prepare('INSERT INTO turns(id,message_key,state,reason,updated) VALUES (?,?,\'queued\',?,?)')
      .run(id, message.key, reason, Date.now());
    return { id, message, reason };
  }
  state(id: string, state: TurnState, code?: string): void {
    this.db.prepare('UPDATE turns SET state=?,code=?,updated=? WHERE id=?').run(state, code ?? null, Date.now(), id);
  }
  draft(id: string, text: string, protocol: ModelMessage[]): void {
    this.db.prepare('UPDATE turns SET draft=?,protocol=?,updated=? WHERE id=?').run(text, JSON.stringify(protocol), Date.now(), id);
  }
  prepareSend(id: string, parts: string[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare('INSERT INTO sends(turn_id,part,text,state) VALUES (?,?,?,\'pending\')');
      parts.forEach((text, part) => statement.run(id, part, text));
      this.state(id, 'sending');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  streamIntent(id: string, part: number, text: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO sends(turn_id,part,text,state) VALUES (?,?,?,'sending') ON CONFLICT(turn_id,part) DO UPDATE SET text=excluded.text,state='sending'").run(id, part, text);
      this.state(id, 'sending');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sendState(id: string, part: number, state: SendRecord['state'], platformId?: string): void {
    this.db.prepare('UPDATE sends SET state=?,platform_id=? WHERE turn_id=? AND part=?').run(state, platformId ?? null, id, part);
  }
  delivered(turn: Turn, text: string, protocol: ModelMessage[], platformIds: string[]): void {
    this.db.prepare('INSERT INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,\'out\',?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload')
      .run(`reply:${turn.id}`, turn.message.session, turn.message.seq, JSON.stringify({ text, protocol, platformIds }));
  }
  pushDelivered(source: number, execution: string, text: string, receipt: string, time: number): void {
    const row = this.db.prepare("SELECT session FROM messages WHERE seq=? AND direction='in'").get(source);
    if (!row) throw new Failure('reminder_source_missing');
    this.db.prepare("INSERT OR IGNORE INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,'out',?,?)")
      .run(`reminder:${execution}`, String(row.session), source, JSON.stringify({ text, protocol: [{ role: 'assistant', content: text }], platformIds: [receipt], sentAt: time }));
  }
  confirmSend(turn: Turn, part: number, platformId: string, text: string, protocol: ModelMessage[], platformIds: string[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sendState(turn.id, part, 'sent', platformId);
      this.delivered(turn, text, protocol, platformIds);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  toolStart(turn: string, call: ToolCall): void {
    this.db.prepare('INSERT INTO tools(turn_id,call_id,name,arguments,state) VALUES (?,?,?,?,\'running\')')
      .run(turn, call.id, call.function.name, call.function.arguments);
  }
  toolEnd(turn: string, call: string, state: string, result: string): void {
    this.db.prepare('UPDATE tools SET state=?,result=? WHERE turn_id=? AND call_id=?').run(state, result, turn, call);
  }
  prepareFeedback(turn: string, text: string): boolean {
    // Reserved part -1 is a diagnostic notice, never an assistant answer in model history.
    // Claim once durably, and never append a notice after any normal send intent exists.
    const result = this.db.prepare(`INSERT INTO sends(turn_id,part,text,state)
      SELECT ?,-1,?,'sending' WHERE NOT EXISTS (SELECT 1 FROM sends WHERE turn_id=?)
      ON CONFLICT(turn_id,part) DO NOTHING`).run(turn, text, turn);
    return Number(result.changes) === 1;
  }
  inspectTurn(id: string) { return this.db.prepare('SELECT * FROM turns WHERE id=?').get(id); }
  inspectSends(id: string) { return this.db.prepare('SELECT * FROM sends WHERE turn_id=? ORDER BY part').all(id); }
  inspectTools(id: string) { return this.db.prepare('SELECT * FROM tools WHERE turn_id=?').all(id); }
  counts(): Record<string, number> {
    return Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM turns GROUP BY state').all().map(row => [String(row.state), Number(row.count)]));
  }
  private view(row: Record<string, unknown>, maximum: number): TurnView {
    const message = JSON.parse(String(row.payload)) as Message;
    const delivered = row.delivered ? JSON.parse(String(row.delivered)) as { text: string } : undefined;
    const input = message.text;
    const reply = delivered?.text ?? '';
    const trim = (text: string) => Array.from(text).slice(0, maximum).join('');
    return { id: String(row.id), seq: Number(row.seq), state: String(row.state), reason: String(row.reason),
      errorCode: row.code === null ? null : String(row.code), received: message.time, updated: Number(row.updated),
      scope: message.group ? 'group' : 'private', sender: message.name, group: message.group,
      input: trim(input), reply: trim(reply), inputTruncated: Array.from(input).length > maximum, replyTruncated: Array.from(reply).length > maximum };
  }
  recent(limit = 25, before?: number, failures = false): ReturnType<HistoryReader['recent']> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new Failure('invalid_history_query');
    const rows = this.db.prepare(`SELECT t.id,t.state,t.reason,t.code,t.updated,m.seq,m.payload,o.payload AS delivered
      FROM turns t JOIN messages m ON m.key=t.message_key LEFT JOIN messages o ON o.key='reply:'||t.id
      WHERE (? IS NULL OR m.seq<?) AND (?=0 OR t.state IN ('failed','unknown','expired','cancelled'))
      ORDER BY m.seq DESC LIMIT ?`).all(before ?? null, before ?? null, failures ? 1 : 0, limit + 1);
    const items = rows.slice(0, limit).map(row => this.view(row, 500));
    return { items, next: rows.length > limit ? items.at(-1)!.seq : null };
  }
  detail(id: string): TurnDetail | undefined {
    const row = this.db.prepare(`SELECT t.id,t.state,t.reason,t.code,t.updated,m.seq,m.payload,o.payload AS delivered
      FROM turns t JOIN messages m ON m.key=t.message_key LEFT JOIN messages o ON o.key='reply:'||t.id WHERE t.id=?`).get(id);
    if (!row) return;
    return { ...this.view(row, 10000),
      sends: this.db.prepare('SELECT part,text,state,platform_id FROM sends WHERE turn_id=? ORDER BY part').all(id)
        .map(send => ({ part: Number(send.part) < 0 ? 1 : Number(send.part) + 1, kind: Number(send.part) < 0 ? 'feedback' as const : 'reply' as const,
          text: Array.from(String(send.text)).slice(0, 4000).join(''), state: String(send.state), receipt: send.platform_id === null ? null : String(send.platform_id) })),
      tools: this.db.prepare('SELECT name,state FROM tools WHERE turn_id=? ORDER BY rowid').all(id).map(tool => ({ name: String(tool.name), state: String(tool.state) })),
    };
  }
}
