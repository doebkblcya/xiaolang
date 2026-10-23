import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { HistoryReader, ConversationView, TimelineItem, Message, ModelMessage, SendRecord, SendReceipt, Segment, Store, ToolCall, Turn, TurnDetail, TurnState, TurnView } from './contracts.js';
import { render, segmentText, messageKey } from './messages.js';
import { Failure } from './errors.js';
import { deleteData } from './data-deletion.js';
import type { DataCleanup } from './data-cleanup.js';

export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string, private cleanups: Map<string, DataCleanup> = new Map()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get()!;
    if (Number(version.user_version) > 1) { this.db.close(); throw new Failure('unsupported_database_version'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
        session TEXT NOT NULL, direction TEXT NOT NULL, source_seq INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_tombstones(key TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session, seq);
      CREATE TABLE IF NOT EXISTS chat_sessions (session TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,alias TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);
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
    if (!this.db.prepare('PRAGMA table_info(chat_sessions)').all().some(column => column.name === 'display_name')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    }
    if (!this.db.prepare('PRAGMA table_info(sends)').all().some(column => column.name === 'reference')) this.db.exec('ALTER TABLE sends ADD COLUMN reference TEXT');
    if (!this.db.prepare('PRAGMA table_info(sends)').all().some(column => column.name === 'receipt_data')) this.db.exec('ALTER TABLE sends ADD COLUMN receipt_data TEXT');
    this.db.exec("CREATE INDEX IF NOT EXISTS messages_platform_index ON messages(session,json_extract(payload,'$.metadata.index')); CREATE INDEX IF NOT EXISTS sends_reference ON sends(reference);");
    for (const row of this.db.prepare('SELECT DISTINCT session FROM messages').all()) this.ensureConversation(String(row.session));
  }
  private ensureConversation(session: string) {
    this.db.prepare('INSERT OR IGNORE INTO chat_sessions(session,id) VALUES (?,?)').run(session, createHash('sha256').update(session).digest('hex'));
  }
  close(): void { this.db.close(); }
  private resolveReferences(message: Message): Message {
    const resolve = (parts: Segment[], depth = 0): Segment[] => parts.map(part => {
      if (depth > 4) return { type: 'unsupported', kind: '嵌套引用' };
      if (part.type === 'bundle') return { ...part, items: part.items.map(item => ({ ...item, segments: resolve(item.segments, depth + 1) })) };
      if (part.type !== 'reply') return part;
      if (this.db.prepare('SELECT 1 FROM message_tombstones WHERE key=?').get(messageKey(message.session, part.messageId))) return { type: 'reply', messageId: part.messageId, unavailable: true };
      const row = this.db.prepare(`SELECT seq,payload,direction FROM messages WHERE session=? AND direction='in'
        AND (json_extract(payload,'$.metadata.index')=? OR json_extract(payload,'$.id')=?) ORDER BY seq DESC LIMIT 1`).get(message.session, part.messageId, part.messageId)
        ?? this.db.prepare(`SELECT m.seq,m.payload,m.direction,s.text AS quote_text FROM messages m JOIN turns t ON m.key='reply:'||t.id
          JOIN sends s ON s.turn_id=t.id WHERE m.session=? AND s.state='sent' AND (s.reference=? OR s.platform_id=?) LIMIT 1`).get(message.session, part.messageId, part.messageId)
        ?? this.db.prepare("SELECT seq,payload,direction FROM messages WHERE session=? AND direction='out' AND json_extract(payload,'$.reference')=? LIMIT 1").get(message.session, part.messageId);
      const source = row ? JSON.parse(String(row.payload)) : undefined;
      return { ...part, ...(row ? { seq: Number(row.seq), sender: row.direction === 'in' ? source.sender : message.account,
        name: row.direction === 'in' ? source.name : '小狼' } : {}),
        segments: part.segments?.length ? resolve(part.segments, depth + 1) : source ? row!.direction === 'in'
          ? resolve((source.segments as Segment[]).filter(p => p.type !== 'reply'), depth + 1) : [{ type: 'text', text: String(row?.quote_text ?? source.text ?? '').slice(0, 50000) }] : undefined };
    });
    return { ...message, segments: resolve(message.segments) };
  }
  records(query: { after?: number; before?: number; fence?: number; session?: string; limit: number; incoming?: boolean }) {
    const rows = this.db.prepare(`SELECT seq,direction,session,payload,source_seq FROM messages WHERE seq>? AND seq<?
      AND (? IS NULL OR (direction='in' AND seq<?) OR (direction='out' AND source_seq<?))
      AND (? IS NULL OR session=?) AND (?=0 OR direction='in') ORDER BY seq ${query.after !== undefined ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(query.after ?? 0, query.before ?? Number.MAX_SAFE_INTEGER, query.fence ?? null, query.fence ?? null, query.fence ?? null,
        query.session ?? null, query.session ?? null, query.incoming ? 1 : 0, Math.min(500, Math.max(1, query.limit)));
    return (query.after !== undefined ? rows : rows.reverse()).flatMap(row => {
      const source = row.direction === 'in' ? row : this.db.prepare('SELECT payload FROM messages WHERE seq=?').get(Number(row.source_seq));
      if (!source) return [];
      const message = this.resolveReferences(JSON.parse(String(source.payload)) as Message);
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
  deleteData(input: unknown) { return deleteData(this.db, input, this.cleanups.values()); }
  admit(message: Message): Message | undefined {
    if (this.db.prepare('SELECT 1 FROM message_tombstones WHERE key=?').get(message.key)) return;
    if (message.metadata?.index) {
      if (this.db.prepare("SELECT 1 FROM messages WHERE session=? AND direction='in' AND json_extract(payload,'$.metadata.index')=?").get(message.session, message.metadata.index)) return;
      const previous = this.db.prepare("SELECT json_extract(payload,'$.metadata.index') idx FROM messages WHERE key=?").get(message.key);
      if (previous?.idx && previous.idx !== message.metadata.index) message = { ...message, key: messageKey(message.session, JSON.stringify([message.id, message.metadata.index])) };
      if (this.db.prepare('SELECT 1 FROM message_tombstones WHERE key=?').get(message.key)) return;
    }
    this.ensureConversation(message.session);
    const result = this.db.prepare('INSERT OR IGNORE INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,\'in\',0,?)')
      .run(message.key, message.session, JSON.stringify(message));
    if (result.changes && !message.group && message.name.trim() && message.name !== message.sender) {
      this.db.prepare('UPDATE chat_sessions SET display_name=? WHERE session=?').run(message.name, message.session);
    }
    return Number(result.changes) ? this.resolveReferences({ ...message, seq: Number(result.lastInsertRowid) }) : undefined;
  }
  history(message: Message, limit: number): ModelMessage[] {
    const rows = this.db.prepare(`SELECT direction,payload FROM messages
      WHERE session=? AND key!=? AND ((direction='in' AND seq<?) OR (direction='out' AND source_seq<?))
      ORDER BY seq DESC LIMIT ?`).all(message.session, message.key, message.seq, message.seq, limit);
    return rows.reverse().flatMap(row => {
      if (row.direction === 'in') return [{ role: 'user' as const, content: render(this.resolveReferences(JSON.parse(String(row.payload)) as Message)) }];
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
  saveReceipt(turn: string, part: number, receipt: SendReceipt): void {
    this.db.prepare('UPDATE sends SET reference=COALESCE(?,reference),receipt_data=? WHERE turn_id=? AND part=?').run(receipt.reference ?? null, JSON.stringify(receipt), turn, part);
  }
  delivered(turn: Turn, text: string, protocol: ModelMessage[], platformIds: string[]): void {
    this.db.prepare('INSERT INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,\'out\',?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload')
      .run(`reply:${turn.id}`, turn.message.session, turn.message.seq, JSON.stringify({ text, protocol, platformIds, sentAt: Date.now() }));
  }
  pushDelivered(source: number, execution: string, text: string, receipt: string, time: number, reference?: string): void {
    const row = this.db.prepare("SELECT session FROM messages WHERE seq=? AND direction='in'").get(source);
    if (!row) throw new Failure('reminder_source_missing');
    this.db.prepare("INSERT OR IGNORE INTO messages(key,session,direction,source_seq,payload) VALUES (?,?,'out',?,?)")
      .run(`reminder:${execution}`, String(row.session), source, JSON.stringify({ text, protocol: [{ role: 'assistant', content: text }], platformIds: [receipt], sentAt: time, reference }));
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
  private conversationView(row: Record<string, unknown>): ConversationView {
    const message = JSON.parse(String(row.source)) as Message;
    const payload = JSON.parse(String(row.payload));
    const body = row.direction === 'in' ? segmentText(message.segments, false) : String(payload.text ?? '');
    return { id: String(row.id), alias: String(row.alias), version: Number(row.version), scope: message.group ? 'group' : 'private',
      recipient: message.group ?? message.sender, name: String(row.display_name || (message.group ? `群聊 ${message.group}` : message.name)),
      platform: message.platform, account: message.account, lastSeq: Number(row.seq), preview: body.slice(0, 120), messages: Number(row.total) };
  }
  private conversationRows() {
    return `WITH latest AS (SELECT session,MAX(seq) AS seq,COUNT(*) AS total FROM messages GROUP BY session)
      SELECT c.id,c.alias,c.version,c.display_name,m.seq,m.direction,m.payload,s.payload AS source,l.total
      FROM latest l JOIN chat_sessions c ON c.session=l.session JOIN messages m ON m.seq=l.seq
      JOIN messages s ON s.seq=CASE WHEN m.direction='in' THEN m.seq ELSE m.source_seq END`;
  }
  conversations(query = '', scope = '', before?: number): Awaited<ReturnType<HistoryReader['conversations']>> {
    if (typeof query !== 'string' || query.length > 200 || !['', 'group', 'private'].includes(scope) || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new Failure('invalid_history_query');
    const rows = this.db.prepare(this.conversationRows() + ` WHERE (? IS NULL OR m.seq<?)
      AND (?='' OR CASE WHEN json_extract(s.payload,'$.group') IS NULL THEN 'private' ELSE 'group' END=?)
      AND (?='' OR instr(lower(c.alias||' '||c.display_name||' '||COALESCE(json_extract(s.payload,'$.group'),'')||' '||json_extract(s.payload,'$.sender')||' '||json_extract(s.payload,'$.name')),lower(?))>0)
      ORDER BY m.seq DESC LIMIT 51`).all(before ?? null, before ?? null, scope, scope, query.trim(), query.trim());
    const items = rows.slice(0, 50).map(row => this.conversationView(row));
    return { items, next: rows.length > 50 ? items.at(-1)!.lastSeq : null };
  }
  cacheConversationName(id: string, name: string): void {
    if (!/^[a-f0-9]{64}$/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n\0]/.test(name)) return;
    this.db.prepare('UPDATE chat_sessions SET display_name=? WHERE id=? AND display_name!=?').run(name.trim(), id, name.trim());
  }
  private conversation(id: string): { session: string; view: ConversationView } {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Failure('invalid_history_query');
    const row = this.db.prepare(this.conversationRows() + ' WHERE c.id=?').get(id);
    const entry = this.db.prepare('SELECT session FROM chat_sessions WHERE id=?').get(id);
    if (!row || !entry) throw new Failure('conversation_not_found');
    return { session: String(entry.session), view: this.conversationView(row) };
  }
  renameConversation(id: string, alias: string, version: number): ConversationView {
    if (typeof alias !== 'string' || alias.length > 80 || /[\r\n\0]/.test(alias) || !Number.isSafeInteger(version) || version < 0) throw new Failure('invalid_conversation_request');
    this.conversation(id);
    if (!this.db.prepare('UPDATE chat_sessions SET alias=?,version=version+1 WHERE id=? AND version=?').run(alias.trim(), id, version).changes) throw new Failure('conversation_conflict');
    return this.conversation(id).view;
  }
  message(id: string, seq: number): ReturnType<HistoryReader['message']> {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Failure('invalid_history_query');
    const conversation = this.conversation(id), record = this.record(seq);
    if (!record || record.session !== conversation.session || record.direction !== 'in') throw new Failure('message_not_found');
    const turn = this.db.prepare('SELECT id,state,reason FROM turns WHERE message_key=?').get(record.message.key);
    return { message: record.message, ...(turn ? { turn: { id: String(turn.id), state: String(turn.state), reason: String(turn.reason) } } : {}) };
  }
  timeline(id: string, before?: number): Awaited<ReturnType<HistoryReader['timeline']>> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Failure('invalid_history_query');
    const conversation = this.conversation(id);
    const rows = this.db.prepare(`SELECT m.seq,m.key,m.direction,m.payload,s.payload AS source,t.id AS turn_id,t.state,t.reason,t.updated,
      f.text AS feedback,f.state AS feedback_state FROM messages m
      JOIN messages s ON s.seq=CASE WHEN m.direction='in' THEN m.seq ELSE m.source_seq END
      LEFT JOIN turns t ON (m.direction='in' AND t.message_key=m.key) OR (m.direction='out' AND m.key='reply:'||t.id)
      LEFT JOIN sends f ON m.direction='in' AND f.turn_id=t.id AND f.part=-1
      WHERE m.session=? AND m.seq<? ORDER BY m.seq DESC LIMIT 51`).all(conversation.session, before ?? Number.MAX_SAFE_INTEGER);
    const selected = rows.slice(0, 50);
    const items: TimelineItem[] = selected.reverse().map(row => {
      const message = this.resolveReferences(JSON.parse(String(row.source)) as Message), payload = JSON.parse(String(row.payload));
      const incoming = row.direction === 'in';
      const knownName = incoming ? this.db.prepare(`SELECT json_extract(payload,'$.name') AS name FROM messages
        WHERE session=? AND direction='in' AND json_extract(payload,'$.sender')=?
        AND trim(json_extract(payload,'$.name'))!='' AND json_extract(payload,'$.name')!=json_extract(payload,'$.sender')
        ORDER BY seq DESC LIMIT 1`).get(conversation.session, message.sender)?.name : undefined;
      return { seq: Number(row.seq), direction: incoming ? 'in' : 'out', time: incoming ? message.time : Number(payload.sentAt ?? row.updated ?? message.time),
        sender: incoming ? message.sender : message.account, name: incoming ? String(knownName ?? message.name) : '小狼',
        text: incoming ? message.text : String(payload.text ?? ''), segments: incoming ? message.segments : [],
        kind: incoming ? 'message' : String(row.key).startsWith('reminder:') ? 'reminder' : 'reply',
        ...(!incoming && row.turn_id ? { parts: this.db.prepare("SELECT text FROM sends WHERE turn_id=? AND part>=0 AND state='sent' ORDER BY part").all(String(row.turn_id)).map(part => String(part.text)) } : {}),
        ...(row.turn_id ? { turn: { id: String(row.turn_id), state: String(row.state), reason: String(row.reason) } } : {}),
        ...(row.feedback ? { feedback: { text: String(row.feedback), state: String(row.feedback_state) } } : {}) };
    });
    return { conversation: conversation.view, items, next: rows.length > 50 ? items[0]!.seq : null };
  }
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
