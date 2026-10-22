import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderManager, reminderTime, nextReminderTime } from '../src/reminders.js';
import { SessionQueue } from '../src/scheduler.js';
import { SqliteStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { normalize } from '../src/messages.js';
import type { PushTarget } from '../src/contracts.js';
import { Failure } from '../src/errors.js';
import { config, deferred, event, FakeAdapter, FakeModel } from './fixtures.js';

class PushAdapter extends FakeAdapter {
  pushes: { target: PushTarget; text: string; sequence: number }[] = [];
  gate?: Promise<void>;
  failure?: Failure;
  async push(target: PushTarget, text: string, sequence: number) {
    this.pushes.push({ target, text, sequence });
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    return { id: `push-${sequence}` };
  }
}
const start = Date.parse('2026-10-18T00:00:00Z');
const signal = () => new AbortController().signal;

test('reminder time requires a real future date with timezone; repeated tasks skip missed periods', () => {
  assert.equal(reminderTime('2026-10-19T08:00:00+08:00', start), start + 86400000);
  for (const value of ['2026-10-19 08:00', '2026-02-30T08:00:00Z', '2027-02-30T08:00:00Z', '2026-10-19T08:00:00+14:30']) assert.throws(() => reminderTime(value, start), { code: 'invalid_reminder_time' });
  assert.throws(() => reminderTime('2026-10-17T08:00:00+08:00', start), { code: 'reminder_time_in_past' });
  assert.equal(nextReminderTime(start, 'daily', start + 3.5 * 86400000), start + 4 * 86400000);
  assert.equal(nextReminderTime(start, 'weekly', start + 8 * 86400000), start + 14 * 86400000);
  assert.equal(nextReminderTime(start, 'once', start), null);
});

test('tools create idempotent reminders bound to the actual sender and conversation, and cancel with scoped authorization', async () => {
  const adapter = new PushAdapter();
  const app = await createApp(config(), { adapter, model: new FakeModel() });
  try {
    const own = app.ctx.store.admit(normalize(event('提醒', 1, 100, '201'), adapter, [])!)!;
    const other = app.ctx.store.admit(normalize(event('我是201', 2, 100, '202'), adapter, [])!)!;
    const admin = app.ctx.store.admit(normalize(event('管理', 3, 100, '200'), adapter, [])!)!;
    const otherChat = { ...own, session: 'other-chat' };
    const call = (name: string, args: unknown) => ({ id: 'test', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
    const args = { at: new Date(Date.now() + 60000).toISOString().replace('.000', '').replace(/\.\d{3}Z$/, 'Z'), text: '喝水', repeat: 'daily' };
    const created = await app.ctx.tools.execute(call('create_reminder', args), own, signal()) as { id: string; recipient: string };
    assert.equal(created.recipient, '100');
    assert.equal((await app.ctx.tools.execute(call('create_reminder', args), own, signal()) as { id: string }).id, created.id);
    assert.equal(app.ctx.reminders.list(other).total, 0); assert.equal(app.ctx.reminders.list(admin).total, 1);
    assert.throws(() => app.ctx.reminders.cancel(created.id, other), { code: 'reminder_not_found' });
    assert.throws(() => app.ctx.reminders.cancel(created.id, otherChat), { code: 'reminder_not_found' });
    assert.equal(app.ctx.reminders.cancel(created.id, admin).state, 'cancelled');
    await assert.rejects(app.ctx.tools.execute(call('create_reminder', { ...args, recipient: 'another-group' }), own, signal()), { code: 'invalid_tool_arguments' });
    assert.ok(app.ctx.xiaolangRuntime.status().plugins.some(plugin => plugin.id === 'xiaolang-reminders' && plugin.state === 'active'));
  } finally { await app.stop(); }
});

test('due reminders share the chat queue, persist confirmed sends into history and advance repeats without a model', async () => {
  let now = start;
  const adapter = new PushAdapter(), queue = new SessionQueue(1, 10, 60000), history = new SqliteStore(':memory:');
  const manager = new ReminderManager(':memory:', adapter, queue, history, [], undefined, () => now);
  const message = history.admit(normalize(event('提醒', 1, null), adapter, [])!)!;
  const task = manager.create({ at: new Date(now + 1000).toISOString().replace('.000', ''), text: '喝水', repeat: 'daily' }, message);
  const gate = deferred(); const blocker = queue.enqueue(message.session, () => gate.promise);
  now += 1000; manager.tick(); await Promise.resolve();
  assert.equal(adapter.pushes.length, 0);
  assert.equal((manager.list().items as { state: string }[])[0]?.state, 'queued');
  gate.resolve(); await blocker; await manager.idle();
  assert.equal(adapter.pushes.length, 1); assert.equal(adapter.pushes[0]?.text, '⏰ 提醒你：喝水');
  const view = (manager.list().items as { id: string; state: string; nextAt: string; lastRun: { state: string; receipt: string } }[])[0]!;
  assert.equal(view.id, task.id); assert.equal(view.state, 'scheduled'); assert.equal(view.lastRun.state, 'sent'); assert.ok(view.lastRun.receipt);
  assert.equal(Date.parse(view.nextAt), now + 86400000);
  assert.equal(history.records({ limit: 10 }).at(-1)?.text, '⏰ 提醒你：喝水');
  manager.tick(); await manager.idle(); assert.equal(adapter.pushes.length, 1);
  manager.cancel(task.id); now += 2 * 86400000; manager.tick(); await manager.idle(); assert.equal(adapter.pushes.length, 1);
  await manager.close(); await queue.close(); history.close();
});

test('restart resumes queued intents, but an interrupted send stays unknown and is never automatically resent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-reminder-'));
  const path = join(directory, 'state.sqlite'), adapter = new PushAdapter(), history = new SqliteStore(path), queue = new SessionQueue(1, 10, 60000);
  let now = start;
  let manager = new ReminderManager(path, adapter, queue, history, [], undefined, () => now);
  try {
    const message = history.admit(normalize(event('提醒', 1, null), adapter, [])!)!;
    const first = manager.create({ at: '2026-10-18T00:00:01Z', text: '已开始' }, message);
    const second = manager.create({ at: '2026-10-18T00:00:02Z', text: '还未发送' }, message);
    await manager.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE reminders SET state='sending' WHERE id=?").run(first.id as string);
    db.prepare("UPDATE reminders SET state='queued' WHERE id=?").run(second.id as string);
    for (const [id, due, state] of [[first.id, start + 1000, 'sending'], [second.id, start + 2000, 'queued']] as const) db.prepare('INSERT INTO reminder_runs(reminder_id,due,state,time) VALUES (?,?,?,?)').run(String(id), due, state, start);
    db.close(); now += 3000;
    manager = new ReminderManager(path, adapter, queue, history, [], undefined, () => now);
    manager.tick(); await manager.idle(); manager.tick(); await manager.idle();
    assert.equal(adapter.pushes.length, 1); assert.match(adapter.pushes[0]!.text, /还未发送/);
    const items = manager.list().items as { id: string; state: string; errorCode: string }[];
    assert.equal(items.find(item => item.id === first.id)?.state, 'unknown');
    assert.equal(items.find(item => item.id === first.id)?.errorCode, 'process_interrupted');
    assert.equal(items.find(item => item.id === second.id)?.state, 'completed');
  } finally { await manager.close(); await queue.close(); history.close(); await rm(directory, { recursive: true, force: true }); }
});

test('clear QQ rejection and uncertain transport stop a repeating reminder; disconnected QQ may retry before any send', async () => {
  for (const failure of [new Failure('qq_push_permission_denied'), new Failure('qq_send_unknown', true), new Failure('qq_not_ready')]) {
    let now = start;
    const adapter = new PushAdapter(); adapter.failure = failure;
    const queue = new SessionQueue(1, 10, 60000), history = new SqliteStore(':memory:');
    const manager = new ReminderManager(':memory:', adapter, queue, history, [], undefined, () => now);
    const message = history.admit(normalize(event('提醒'), adapter, [])!)!;
    manager.create({ at: '2026-10-18T00:00:01Z', text: '提醒', repeat: 'weekly' }, message);
    now += 2000; manager.tick(); await manager.idle();
    const item = (manager.list().items as { state: string; errorCode: string }[])[0]!;
    assert.equal(item.state, failure.code === 'qq_not_ready' ? 'scheduled' : failure.unknownOutcome ? 'unknown' : 'failed');
    assert.equal(item.errorCode, failure.code);
    now += 60000; adapter.failure = undefined; manager.tick(); await manager.idle();
    assert.equal(adapter.pushes.length, failure.code === 'qq_not_ready' ? 2 : 1);
    await manager.close(); await queue.close(); history.close();
  }
});
