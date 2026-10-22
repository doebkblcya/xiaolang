import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatText } from '../src/log-format.js';
import { createApp } from '../src/app.js';
import { createReporter } from '../src/logging.js';
import { emitLog } from '../src/contracts.js';
import type { Log } from '../src/contracts.js';
import { Failure } from '../src/errors.js';
import { config, deferred, event, FakeAdapter, FakeModel } from './fixtures.js';

test('process events correlate intake, trigger, queue, model and confirmed reply without prompts or reasoning', async t => {
  const entries: Log[] = [];
  const settings = config();
  settings.persona = 'private-system-prompt';
  const app = await createApp(settings, { adapter: new FakeAdapter(), report: entry => entries.push(entry),
    model: new FakeModel(async () => ({ role: 'assistant', content: '真实回复🐺', reasoning_content: 'hidden-reasoning' })) });
  t.after(() => app.stop());
  app.ctx.intake.receive(event('Hello', 1, null));
  await app.ctx.chat.idle();
  const process = entries.filter(entry => entry.code !== 'application_ready');
  assert.deepEqual(process.map(entry => entry.code), ['message_received', 'trigger_matched', 'turn_queued', 'turn_started',
    'model_started', 'model_completed', 'reply_generated', 'send_started', 'send_confirmed', 'turn_completed']);
  assert.equal(process[0]?.scope, 'private');
  assert.equal(process[0]?.preview, 'Hello');
  assert.equal(process[1]?.reason, 'private');
  assert.ok(process[0]?.messageId);
  assert.equal(process[0]?.messageId, process[1]?.messageId);
  const turn = process[1]!.turn;
  assert.ok(turn);
  assert.ok(process.slice(1).every(entry => entry.turn === turn));
  assert.equal(process.find(entry => entry.code === 'reply_generated')?.preview, '真实回复🐺');
  assert.ok(process.some(entry => entry.code === 'send_confirmed' && entry.receipt));
  assert.ok(process.some(entry => entry.code === 'turn_started' && entry.waitMs! >= 0));
  assert.ok(process.some(entry => entry.code === 'model_completed' && entry.durationMs! >= 0));
  assert.ok(!JSON.stringify(process).includes('private-system-prompt'));
  assert.ok(!JSON.stringify(process).includes('hidden-reasoning'));
});

test('ignored and duplicate messages report the actual reason without changing trigger behavior', async t => {
  const entries: Log[] = [];
  const settings = config();
  settings.groupIds = ['100'];
  const model = new FakeModel();
  const app = await createApp(settings, { model, adapter: new FakeAdapter(), report: entry => entries.push(entry) });
  t.after(() => app.stop());
  app.ctx.intake.receive(event('群里闲聊', 1));
  app.ctx.intake.receive(event('群里闲聊', 1));
  app.ctx.intake.receive(event('小狼', 2, 101));
  app.ctx.intake.receive(event('小狼', 3, 100, 123456789));
  app.ctx.intake.receive({});
  await app.ctx.chat.idle();
  assert.deepEqual(entries.filter(entry => entry.code === 'message_ignored').map(entry => entry.reason),
    ['no_trigger', 'duplicate', 'group_not_allowed', 'own_message', 'account_mismatch']);
  assert.equal(model.requests.length, 0);
  await app.stopChat();
  app.ctx.intake.receive(event('小狼', 4));
  assert.ok(entries.some(entry => entry.reason === 'chat_disabled'));
});

test('queue wait and send uncertainty stay observable and never claim a failed suffix was delivered', async t => {
  const entries: Log[] = [];
  const gate = deferred();
  const started = deferred();
  let requests = 0;
  const settings = config(); settings.limits.replyChars = 2;
  const adapter = new FakeAdapter();
  let sends = 0;
  adapter.reply = async () => { if (++sends === 2) throw new Failure('transport_timeout', true); return { id: String(sends) }; };
  const app = await createApp(settings, { adapter, report: entry => entries.push(entry), model: new FakeModel(async () => {
    if (!requests++) { started.resolve(); await gate.promise; }
    return { role: 'assistant', content: '甲乙丙丁' };
  }) });
  t.after(() => app.stop());
  app.ctx.intake.receive(event('first', 1, null));
  await started.promise;
  app.ctx.intake.receive(event('second', 2, null));
  assert.equal(entries.filter(entry => entry.code === 'turn_queued').length, 2);
  assert.equal(entries.filter(entry => entry.code === 'turn_started').length, 1);
  gate.resolve();
  await app.ctx.chat.idle();
  const firstTurn = entries.find(entry => entry.code === 'trigger_matched')!.turn;
  const first = entries.filter(entry => entry.turn === firstTurn);
  assert.equal(first.filter(entry => entry.code === 'send_confirmed').length, 1);
  assert.ok(first.some(entry => entry.code === 'send_unknown' && entry.part === 2 && entry.errorCode === 'transport_timeout'));
  assert.ok(first.some(entry => entry.state === 'unknown'));
  assert.ok(!first.some(entry => entry.code === 'turn_completed'));
  assert.equal(entries.filter(entry => entry.code === 'turn_started').length, 2);
});

test('model and tool failures preserve stages; tool inputs, results and intermediate reasoning are absent', async t => {
  const entries: Log[] = [];
  const app = await createApp(config(), { adapter: new FakeAdapter(), report: entry => entries.push(entry), model: new FakeModel(async messages => {
    if (messages.at(-1)?.role === 'tool') throw new Failure('model_timeout');
    return { role: 'assistant', content: 'intermediate-private', reasoning_content: 'secret-reasoning',
      tool_calls: [{ id: 'tool1', type: 'function', function: { name: 'test_read', arguments: '{"value":"secret-argument"}' } }] };
  }) });
  t.after(() => app.stop());
  app.ctx.tools.register({ name: 'test_read', description: 'test', effect: 'read',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    execute: async () => { throw new Failure('tool_test_failed'); } });
  app.ctx.intake.receive(event('hello', 1, null));
  await app.ctx.chat.idle();
  assert.ok(entries.some(entry => entry.code === 'tool_failed' && entry.tool === 'test_read'));
  assert.ok(entries.some(entry => entry.code === 'model_failed' && entry.step === 2 && entry.errorCode === 'model_timeout'));
  assert.ok(entries.some(entry => entry.code === 'model_timeout' && entry.state === 'failed'));
  for (const value of ['secret-argument', 'secret-reasoning', 'intermediate-private']) assert.ok(!JSON.stringify(entries).includes(value));
});

test('logging bounds Unicode previews, redacts credentials before truncation, and strips extra fields and terminal controls', () => {
  const entries: Log[] = [];
  const report = createReporter({ settings: { previewChars: 24 }, secrets: ['long-secret-value'], report: entry => entries.push(entry) });
  report({ code: 'received', preview: 'long-secret-value🐺🐺\n\u001b[31m', errorCode: 'Bearer access-secret',
    prompt: 'hidden-prompt', arguments: 'hidden-arguments' } as Log);
  const serialized = JSON.stringify(entries);
  for (const value of ['long-secret-value', 'access-secret', 'hidden-prompt', 'hidden-arguments', '\u001b']) assert.ok(!serialized.includes(value));
  assert.ok(entries[0]?.preview?.includes('[REDACTED]🐺🐺'));
  assert.ok(!entries[0]?.preview?.includes('\n'));
  const hidden: Log[] = [];
  createReporter({ settings: { content: false }, report: entry => hidden.push(entry) })({ code: 'received', preview: 'private-text' });
  assert.equal(hidden[0]?.preview, undefined);
});

test('unified console formatting preserves legacy settings and sink failures never interrupt chat', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-log-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'console-logger', module: './console-logger/index.mjs', config: { format: 'text' } }] };
  const app = await createApp(settings, { model: new FakeModel(), adapter: new FakeAdapter(), report: () => { throw new Error('broken observer'); } });
  t.after(() => app.stop());
  const lines: string[] = [];
  app.ctx.logOutput.write = entry => { lines.push(formatText(entry)); };
  app.ctx.intake.receive(event('Hello', 1, null));
  await app.ctx.chat.idle();
  assert.ok(lines.some(line => line.includes('收到消息') && line.includes('Hello')));
  assert.ok(lines.some(line => line.includes('QQ 已确认发送') && line.includes('回执=')));
  assert.ok(lines.some(line => line.includes('本轮完成') && line.includes('耗时=')));
  app.ctx.logOutput.write = () => { throw new Error('broken output'); };
  app.ctx.intake.receive(event('again', 2, null));
  await app.ctx.chat.idle();
  emitLog(app.ctx, { code: 'test' });
  assert.equal((app.ctx.adapter as FakeAdapter).sent.length, 2);
});
