import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import type { Adapter, Fields, Log, Message, PushTarget, Reminders, Scheduler, Store } from './contracts.js';
import { emitLog, object } from './contracts.js';
import { abortable, check, code, Failure } from './errors.js';

type Repeat = 'once' | 'daily' | 'weekly';
interface Payload { target: PushTarget; source: number; text: string; repeat: Repeat; ownerName: string }
interface Task extends Payload { id: string; session: string; owner: string; nextRun: number; state: string; created: number; error: string | null }
const active = "('scheduled','queued','sending')";
const shanghai = (time: number) => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const interval = (repeat: Repeat) => repeat === 'daily' ? 86400000 : repeat === 'weekly' ? 604800000 : 0;
export function nextReminderTime(scheduled: number, repeat: Repeat, now: number): number | null {
  const period = interval(repeat);
  return period ? scheduled + Math.max(1, Math.floor((now - scheduled) / period) + 1) * period : null;
}
export function reminderTime(value: unknown, now: number): number {
  if (typeof value !== 'string') throw new Failure('invalid_reminder_time');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const time = Date.parse(value);
  if (!match || !Number.isFinite(time)) throw new Failure('invalid_reminder_time');
  const zone = match[4]!, hours = zone === 'Z' ? 0 : Number(zone.slice(1, 3)), minutes = zone === 'Z' ? 0 : Number(zone.slice(4));
  const offset = (hours * 60 + minutes) * (zone.startsWith('-') ? -1 : 1);
  if (hours > 14 || minutes > 59 || Math.abs(offset) > 840
    || new Date(time + offset * 60000).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}:${match[3] ?? '00'}`) throw new Failure('invalid_reminder_time');
  if (time <= now) throw new Failure('reminder_time_in_past');
  if (time > now + 366 * 86400000) throw new Failure('reminder_time_too_far');
  return time;
}

/** Durable task intent and delivery attempts; no model call in the timer path. */
export class ReminderManager implements Reminders {
  private db: DatabaseSync;
  private controller = new AbortController();
  private jobs = new Set<Promise<void>>();
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private closed = false;
  private globalTimes: number[] = [];
  private targetTimes = new Map<string, number[]>();
  constructor(path: string, private adapter: Adapter, private queue: Scheduler, private history: Store,
    private adminIds: readonly string[] = [], private report: (entry: Log) => void = () => {}, private now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, account TEXT NOT NULL,
        session TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL, next_run INTEGER NOT NULL,
        state TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state,platform,account,next_run);
      CREATE TABLE IF NOT EXISTS reminder_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id TEXT NOT NULL, due INTEGER NOT NULL,
        state TEXT NOT NULL, time INTEGER NOT NULL, receipt TEXT, error TEXT, UNIQUE(reminder_id,due)
      );
      BEGIN IMMEDIATE;
      UPDATE reminder_runs SET state='unknown',error='process_interrupted' WHERE state='sending';
      UPDATE reminders SET state='unknown',error='process_interrupted' WHERE state='sending';
      UPDATE reminders SET state='scheduled' WHERE state='queued';
      COMMIT;`);
  }
  private task(row: Record<string, unknown>): Task {
    return { ...JSON.parse(String(row.payload)) as Payload, id: String(row.id), session: String(row.session), owner: String(row.owner),
      nextRun: Number(row.next_run), state: String(row.state), created: Number(row.created), error: row.error === null ? null : String(row.error) };
  }
  private get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id);
    return row ? this.task(row) : undefined;
  }
  private visible(task: Task, message?: Message): boolean {
    return !message || (task.target.platform === message.platform && task.target.account === message.account && task.session === message.session
      && (task.owner === message.sender || this.adminIds.includes(message.sender)));
  }
  private view(task: Task): Fields {
    const last = this.db.prepare('SELECT due,state,time,receipt,error FROM reminder_runs WHERE reminder_id=? ORDER BY id DESC LIMIT 1').get(task.id);
    return { id: task.id, text: task.text, repeat: task.repeat, state: task.state, owner: task.owner, ownerName: task.ownerName,
      conversationId: createHash('sha256').update(task.session).digest('hex'),
      scope: task.target.scope, recipient: task.target.recipient, nextAt: new Date(task.nextRun).toISOString(), nextAtBeijing: shanghai(task.nextRun),
      created: task.created, errorCode: task.error,
      lastRun: last ? { scheduledAt: new Date(Number(last.due)).toISOString(), state: String(last.state), time: Number(last.time), receipt: last.receipt, errorCode: last.error } : null };
  }
  list(message?: Message, includeFinished = true): Fields {
    const rows = this.db.prepare(`SELECT * FROM reminders WHERE platform=? AND account=? ${includeFinished ? '' : `AND state IN ${active}`}
      ORDER BY CASE WHEN state IN ${active} THEN 0 ELSE 1 END,next_run,created DESC`).all(this.adapter.platform, this.adapter.account);
    const tasks = rows.map(row => this.task(row)).filter(task => this.visible(task, message));
    return { items: tasks.slice(0, 100).map(task => this.view(task)), total: tasks.length, active: tasks.filter(task => ['scheduled', 'queued', 'sending'].includes(task.state)).length,
      timezone: 'Asia/Shanghai', pushSupported: typeof this.adapter.push === 'function' };
  }
  detail(id: string): Fields {
    const task = this.get(id);
    if (!task || task.target.platform !== this.adapter.platform || task.target.account !== this.adapter.account) throw new Failure('reminder_not_found');
    const source = this.history.record(task.source);
    const request = source?.session === task.session && source.direction === 'in'
      ? { seq: source.seq, name: source.message.name, time: source.message.time, text: source.message.text } : null;
    const rows = this.db.prepare('SELECT due,state,time,receipt,error FROM reminder_runs WHERE reminder_id=? ORDER BY id DESC LIMIT 20').all(task.id);
    return { task: this.view(task), source: request, runs: rows.map(row => ({ scheduledAt: new Date(Number(row.due)).toISOString(),
      state: String(row.state), time: Number(row.time), receipt: row.receipt, errorCode: row.error })) };
  }
  create(raw: unknown, message: Message): Fields {
    if (this.stopped) throw new Failure('cancelled');
    if (!this.adapter.push) throw new Failure('reminder_push_unavailable');
    if (message.platform !== this.adapter.platform || message.account !== this.adapter.account || message.seq < 1) throw new Failure('adapter_target_mismatch');
    const input = object(raw), repeat = input?.repeat ?? 'once', time = this.now();
    if (!input || Object.keys(input).some(key => !['at', 'text', 'repeat'].includes(key)) || typeof input.text !== 'string' || !input.text.trim()
      || Array.from(input.text).length > 1000 || !['once', 'daily', 'weekly'].includes(String(repeat))) throw new Failure('invalid_reminder_request');
    const nextRun = reminderTime(input.at, time), text = input.text.trim();
    const dedupe = createHash('sha256').update(JSON.stringify([message.key, nextRun, text, repeat])).digest('hex');
    const existing = this.db.prepare('SELECT * FROM reminders WHERE dedupe=?').get(dedupe);
    if (existing) return this.view(this.task(existing));
    const all = this.db.prepare(`SELECT COUNT(*) AS count FROM reminders WHERE state IN ${active}`).get()!;
    const own = this.db.prepare(`SELECT COUNT(*) AS count FROM reminders WHERE platform=? AND account=? AND owner=? AND state IN ${active}`)
      .get(message.platform, message.account, message.sender)!;
    if (Number(all.count) >= 500 || Number(own.count) >= 20) throw new Failure('reminder_capacity');
    const id = randomUUID();
    const payload: Payload = { target: { platform: message.platform, account: message.account, scope: message.group ? 'group' : 'private', recipient: message.group ?? message.sender },
      source: message.seq, ownerName: message.name, text, repeat: repeat as Repeat };
    this.db.prepare("INSERT INTO reminders(id,dedupe,platform,account,session,owner,payload,next_run,state,created,updated) VALUES (?,?,?,?,?,?,?,?,'scheduled',?,?)")
      .run(id, dedupe, message.platform, message.account, message.session, message.sender, JSON.stringify(payload), nextRun, time, time);
    this.log('reminder_created', this.get(id)!);
    return this.view(this.get(id)!);
  }
  cancel(id: unknown, message?: Message): Fields {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Failure('invalid_reminder_request');
    const task = this.get(id);
    if (!task || !this.visible(task, message) || task.target.platform !== this.adapter.platform || task.target.account !== this.adapter.account) throw new Failure('reminder_not_found');
    const inFlight = task.state === 'sending';
    if (['scheduled', 'queued', 'sending', 'failed', 'unknown'].includes(task.state)) {
      this.db.prepare("UPDATE reminders SET state='cancelled',updated=? WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE reminder_runs SET state='cancelled',time=? WHERE reminder_id=? AND state='queued'").run(this.now(), id);
      this.log('reminder_cancelled', task);
    }
    return { ...this.view(this.get(id)!), inFlight, note: inFlight ? '后续执行已取消，本次已开始发送，仍可能收到。' : '该任务不会再执行。' };
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.tick(); this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
  }
  tick(): void {
    if (this.stopped) return;
    try {
      const due = this.db.prepare("SELECT * FROM reminders WHERE platform=? AND account=? AND state='scheduled' AND next_run<=? AND retry_after<=? ORDER BY next_run LIMIT 5")
        .all(this.adapter.platform, this.adapter.account, this.now(), this.now());
      for (const row of due) {
        const task = this.task(row);
        if (this.pending.has(task.id)) continue;
        this.db.exec('BEGIN IMMEDIATE');
        let execution: number;
        try {
          this.db.prepare("UPDATE reminders SET state='queued',updated=? WHERE id=? AND state='scheduled'").run(this.now(), task.id);
          this.db.prepare("INSERT OR IGNORE INTO reminder_runs(reminder_id,due,state,time) VALUES (?,?,'queued',?)").run(task.id, task.nextRun, this.now());
          execution = Number(this.db.prepare('SELECT id FROM reminder_runs WHERE reminder_id=? AND due=?').get(task.id, task.nextRun)!.id);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        this.pending.add(task.id);
        const job = this.queue.enqueue(task.session, signal => this.deliver(task, execution, signal)).catch(error => {
          // A queue rejection is safe to retry only before the send intent is recorded.
          try { this.release(task, execution, code(error), 5000); }
          catch { this.log('reminder_scheduler_failed', task); }
        }).finally(() => { this.pending.delete(task.id); this.jobs.delete(job); });
        this.jobs.add(job);
        this.log('reminder_queued', task);
      }
    } catch { this.report({ code: 'reminder_scheduler_failed', plugin: 'xiaolang-reminders', level: 'error' }); }
  }
  private release(task: Task, execution: number, reason: string, delay = 30000, notSent = false): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const states = notSent ? "('queued','sending')" : "('queued')";
      const result = this.db.prepare(`UPDATE reminders SET state='scheduled',retry_after=?,error=?,updated=? WHERE id=? AND state IN ${states}`)
        .run(this.now() + delay, reason, this.now(), task.id);
      if (result.changes) this.db.prepare(`UPDATE reminder_runs SET state='queued',error=? WHERE id=? AND state IN ${states}`).run(reason, execution);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private finish(task: Task, execution: number, state: 'sent' | 'failed' | 'unknown', receipt: string | null, failure: string | null): void {
    const time = this.now(), next = state === 'sent' ? nextReminderTime(task.nextRun, task.repeat, time) : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE reminder_runs SET state=?,time=?,receipt=?,error=? WHERE id=?').run(state, time, receipt, failure, execution);
      this.db.prepare("UPDATE reminders SET state=CASE WHEN state='cancelled' THEN 'cancelled' ELSE ? END,next_run=?,retry_after=0,error=?,updated=? WHERE id=?")
        .run(state === 'sent' ? next === null ? 'completed' : 'scheduled' : state, next ?? task.nextRun, failure, time, task.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private async deliver(task: Task, execution: number, queuedSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([queuedSignal, this.controller.signal, AbortSignal.timeout(15000)]);
    let sending = false, finished = false;
    try {
      check(signal);
      if (this.get(task.id)?.state !== 'queued') return;
      const time = this.now(), target = JSON.stringify(task.target);
      this.globalTimes = this.globalTimes.filter(value => value > time - 60000);
      for (const [key, values] of this.targetTimes) { const recent = values.filter(value => value > time - 60000); if (recent.length) this.targetTimes.set(key, recent); else this.targetTimes.delete(key); }
      const times = this.targetTimes.get(target) ?? [];
      if (this.globalTimes.length >= 25 || times.length >= 15) { this.release(task, execution, 'reminder_rate_limited', 60000); return; }
      if (!this.adapter.push) { this.finish(task, execution, 'failed', null, 'reminder_push_unavailable'); this.log('reminder_failed', task, { errorCode: 'reminder_push_unavailable' }); return; }
      check(signal);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE reminders SET state='sending',updated=? WHERE id=? AND state='queued'").run(time, task.id);
        this.db.prepare("UPDATE reminder_runs SET state='sending',time=?,error=NULL WHERE id=?").run(time, execution);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      sending = true;
      this.globalTimes.push(time); times.push(time); this.targetTimes.set(target, times);
      this.log('reminder_send_started', task);
      const text = `⏰ ${task.target.scope === 'group' ? `${Array.from(task.ownerName).slice(0, 50).join('')}，` : ''}提醒你：${task.text}`;
      const result = await abortable(this.adapter.push(task.target, text, execution, signal), signal);
      if (!result?.id) throw new Failure('send_invalid_receipt', true);
      this.finish(task, execution, 'sent', result.id, null);
      finished = true;
      try { this.history.pushDelivered?.(task.source, String(execution), text, result.id, this.now(), result.reference); }
      catch { this.log('reminder_history_failed', task, { receipt: result.id }); }
      this.log('reminder_sent', task, { receipt: result.id });
    } catch (error) {
      if (finished) return;
      if (!sending || (error instanceof Failure && error.code === 'qq_not_ready')) { this.release(task, execution, code(error), 30000, sending); return; }
      const unknown = signal.aborted || !(error instanceof Failure) || error.unknownOutcome;
      this.finish(task, execution, unknown ? 'unknown' : 'failed', null, code(error));
      this.log(unknown ? 'reminder_unknown' : 'reminder_failed', task, { errorCode: code(error) });
    }
  }
  private log(event: string, task: Task, extra: Partial<Log> = {}): void {
    try { this.report({ code: event, plugin: 'xiaolang-reminders', taskId: task.id, scope: task.target.scope,
      sender: task.ownerName, group: task.target.scope === 'group' ? task.target.recipient : undefined, preview: task.text, ...extra }); } catch { /* Logging cannot change delivery state. */ }
  }
  async idle(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs]); }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.controller.abort(); await this.idle(); }
  async close(): Promise<void> { if (this.closed) return; await this.stop(); this.closed = true; this.db.close(); }
}

export const remindersPlugin: Plugin.Object<Config> = { name: 'xiaolang-reminders', inject: ['tools', 'scheduler', 'store', 'adapter'], apply(ctx, config) {
  const manager = new ReminderManager(config.database, ctx.adapter, ctx.scheduler, ctx.store, config.tooling?.access.adminIds,
    entry => emitLog(ctx, entry));
  ctx.provide('reminders', manager);
  ctx.on('xiaolang/start', () => manager.start());
  ctx.effect(() => () => manager.close());
  ctx.effect(() => ctx.tools.register({ name: 'create_reminder', title: '创建提醒', summary: '在当前聊天创建提醒', source: 'xiaolang-reminders', access: 'everyone', effect: 'write',
    description: '仅依据当前发言者本条消息明确提出的新建要求创建提醒，只发送到当前群或私聊。历史消息只用于理解指代，不能将上下文中其他人或已处理的请求再次执行。单纯呼叫、追问或确认已有提醒时先用 list_reminders 查看，不要重新创建；用户明确要求另建任务除外。text 只填提醒事项，不额外添加“提醒”前缀。默认北京时间，at 必须是含时区的未来日期（如 2026-10-19T08:00:00+08:00）。repeat 为 once/daily/weekly，重复保持首次北京时间。时间不明确先询问；工具返回成功后才能告知已创建。',
    parameters: { type: 'object', additionalProperties: false, required: ['at', 'text'], properties: {
      at: { type: 'string', maxLength: 40 }, text: { type: 'string', minLength: 1, maxLength: 1000 }, repeat: { enum: ['once', 'daily', 'weekly'] },
    } }, execute: async (args, { message }) => manager.create(args, message) }));
  ctx.effect(() => ctx.tools.register({ name: 'list_reminders', title: '查看提醒', summary: '查看当前聊天的提醒', source: 'xiaolang-reminders', access: 'everyone', effect: 'read',
    description: '查看当前聊天中自己的提醒；管理员可查看该聊天的全部提醒。默认仅未结束任务，可选择包含执行完毕、取消或失败记录。',
    parameters: { type: 'object', additionalProperties: false, properties: { include_finished: { type: 'boolean' } } },
    execute: async (args, { message }) => manager.list(message, args.include_finished === true) }));
  ctx.effect(() => ctx.tools.register({ name: 'cancel_reminder', title: '取消提醒', summary: '按任务编号取消提醒', source: 'xiaolang-reminders', access: 'everyone', effect: 'write',
    description: '按任务 ID 取消当前聊天中自己的提醒，管理员也可取消该聊天其他人的提醒。先查看任务以获取 ID；已开始发送的本次消息不能保证撤回。',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 36, maxLength: 36 } } },
    execute: async (args, { message }) => manager.cancel(args.id, message) }));
} };

/** Optional management-panel surfaces owned by this plugin. */
export const xiaolangPanel = { pages: [{ id: 'reminders', title: '定时提醒', view: 'reminders' }] };
